const test = require('node:test');
const assert = require('node:assert/strict');
const {
  runScheduledPolls,
  runScheduledConfirmations,
  sendScheduledConfirmationImmediately,
  generateScheduledPollsFromTemplates,
  startTemplateRehearsal,
  finalizeReadyTemplateRehearsals,
} = require('../src/productionScheduler');

test('weekly rehearsal sends the actual future batch without creating test-labelled polls', async () => {
  const created = [];
  const prepared = [];
  const claimed = new Map();
  const sent = [];
  const db = {
    async isPollDateExcluded() { return false; },
    async getActivePollForDate() { return null; },
    async createScheduledEvent(payload) {
      created.push(payload);
      const id = `poll-${created.length}`;
      claimed.set(id, {
        id,
        event_id: `event-${created.length}`,
        claim_token: `claim-${created.length}`,
        service: 'PSA',
        telegram_chat_id: '-1001',
        poll_question: payload.poll_question,
        poll_options: payload.shifts.map((shift) => shift.label),
      });
      return id;
    },
    async prepareTemplateRehearsal(value) { prepared.push(value); },
    async claimSpecificPoll(id) { return claimed.get(id); },
    async completePollSend() { return true; },
    async failPollSend() { throw new Error('unexpected send failure'); },
    async listTemplateRehearsalPolls() { return []; },
    async resetTemplateRehearsal() { throw new Error('unexpected reset'); },
  };
  const telegram = {
    async sendPoll(service, chatId, question) {
      sent.push({ service, chatId, question });
      return { poll_id: `tg-${sent.length}`, message_id: sent.length };
    },
  };
  const schedule = {
    id: 'schedule-1',
    telegram_group_id: 'group-1',
    poll_release_day_of_week: 3,
    poll_release_time: '17:00',
    confirmation_day_of_week: 5,
    confirmation_time: '12:00',
    gap_weeks: 0,
    timezone: 'Asia/Singapore',
    shifts: [{ label: '0730-1500', start_time: '07:30', end_time: '15:00', capacity: 2 }],
  };
  const result = await startTemplateRehearsal(db, telegram, {
    group: { id: 'group-1', group_name: 'PSA group', service: 'PSA', bot_id: 'bot-1' },
    schedule,
    clearAfterMinutes: 5,
    now: new Date('2099-01-01T00:00:00Z'),
  });

  assert.equal(result.poll_count, 7);
  assert.equal(created.length, 7);
  assert.equal(sent.length, 7);
  assert.equal(prepared.length, 1);
  assert.equal(prepared[0].pollIds.length, 7);
  assert.equal(prepared[0].clearAt, '2099-01-01T00:05:00.000Z');
  assert.equal('confirmationAt' in prepared[0], false);
  assert.equal('closeAt' in prepared[0], false);
  assert.ok(created.every((payload) => payload.is_custom === false));
  assert.ok(created.every((payload) => payload.operational_tags.length === 0));
  assert.ok(created.every((payload) => !payload.title.includes('[TEST]') && !payload.poll_question.includes('[TEST]')));
  assert.deepEqual(created.map((payload) => payload.event_date), [
    '2099-01-12', '2099-01-13', '2099-01-14', '2099-01-15',
    '2099-01-16', '2099-01-17', '2099-01-18',
  ]);
  assert.equal(result.actual_release_at, '2099-01-07T09:00:00.000Z');
});

test('completed rehearsal closes Telegram polls and preserves stored production timings', async () => {
  const stopped = [];
  let reset;
  const db = {
    async listReadyTemplateRehearsals() {
      return [{
        batch_id: 'batch-1',
        poll_id: 'poll-1',
        event_id: 'event-1',
        event_date: '2099-01-12',
        telegram_message_id: 77,
        telegram_chat_id: '-1001',
        service: 'PSA',
        timezone: 'Asia/Singapore',
        gap_weeks: 0,
        poll_release_day_of_week: 3,
        poll_release_time: '17:00',
        confirmation_day_of_week: 5,
        confirmation_time: '12:00',
        resolved_release_at: '2099-01-07T09:00:00.000Z',
      }];
    },
    async resetTemplateRehearsal(batchId) { reset = { batchId }; },
  };
  const telegram = { async stopPoll(...args) { stopped.push(args); } };

  const result = await finalizeReadyTemplateRehearsals(db, telegram);
  assert.deepEqual(stopped, [['PSA', '-1001', 77]]);
  assert.equal(reset.batchId, 'batch-1');
  assert.deepEqual(Object.keys(reset), ['batchId']);
  assert.equal(result[0].actual_release_at, '2099-01-07T09:00:00.000Z');
});

test('confirmation scheduler clears due rehearsals without changing production timing fields', async () => {
  let confirmationStatus = 'scheduled';
  let resetArgs;
  const rehearsalRow = {
    batch_id: 'batch-1',
    poll_id: 'poll-1',
    event_id: 'event-1',
    event_date: '2099-01-12',
    telegram_message_id: 77,
    telegram_chat_id: '-1001',
    service: 'WHCL',
    resolved_release_at: '2099-01-07T09:00:00.000Z',
    close_at: '2099-01-11T00:00:00.000Z',
    resolved_send_at: '2099-01-09T04:00:00.000Z',
    clear_at: '2000-01-01T00:00:00.000Z',
  };
  const db = {
    async claimDueConfirmations() { return []; },
    async listDueTemplateRehearsalBatchIds() { return ['batch-1']; },
    async listTemplateRehearsalPolls() { return [{ ...rehearsalRow, confirmation_status: confirmationStatus }]; },
    async claimTemplateRehearsalConfirmations() {
      return [{
        id: 'confirmation-1',
        event_id: 'event-1',
        scheduled_poll_id: 'poll-1',
        claim_token: 'claim-1',
        service: 'WHCL',
        telegram_chat_id: '-1001',
        header_text: 'Confirmed slots',
        footer_text: 'take note pls',
        resolved_send_at: rehearsalRow.resolved_send_at,
      }];
    },
    async getAllocation() { return []; },
    async getEventDate() { return rehearsalRow.event_date; },
    async completeConfirmationSend() { confirmationStatus = 'sent'; return true; },
    async failConfirmationSend() { throw new Error('unexpected confirmation failure'); },
    async listReadyTemplateRehearsals() {
      return confirmationStatus === 'sent' ? [{ ...rehearsalRow, confirmation_status: 'sent' }] : [];
    },
    async resetTemplateRehearsal(...args) { resetArgs = args; },
  };
  const telegram = {
    async sendMessage() { return { message_id: 88 }; },
    async stopPoll() {},
  };

  assert.deepEqual(await runScheduledConfirmations(db, telegram), ['confirmation-1']);
  assert.deepEqual(resetArgs, ['batch-1']);
});

test('scheduled poll completion stores Telegram identifiers through its claim', async () => {
  const completed = [];
  const db = {
    async claimDuePolls() { return [{ id: 'p', claim_token: 'c', service: 'PRIMARY', telegram_chat_id: '-1', poll_question: 'Q', poll_options: ['A', 'B'] }]; },
    async completePollSend(...args) { completed.push(args); return true; },
    async failPollSend() { throw new Error('unexpected failure'); },
  };
  const telegram = { async sendPoll() { return { poll_id: 'tg-poll', message_id: 7 }; } };
  assert.deepEqual(await runScheduledPolls(db, telegram), ['p']);
  assert.deepEqual(completed[0], ['p', 'c', 'tg-poll', 7]);
});

test('scheduled poll sends claimed rows in event-date order even when the database returns them jumbled', async () => {
  const sent = [];
  const db = {
    async claimDuePolls() {
      return [
        { id: 'p3', claim_token: 'c3', service: 'PSA', telegram_chat_id: '-1', poll_question: 'Thu, 23Jul26 - 1 slot for 0800-1700', poll_options: ['A', 'B'] },
        { id: 'p1', claim_token: 'c1', service: 'PSA', telegram_chat_id: '-1', poll_question: 'Mon, 20Jul26 - 1 slot for 0800-1700', poll_options: ['A', 'B'] },
        { id: 'p2', claim_token: 'c2', service: 'PSA', telegram_chat_id: '-1', poll_question: 'Tue, 21Jul26 - 1 slot for 0800-1700', poll_options: ['A', 'B'] },
      ];
    },
    async completePollSend() { return true; },
    async failPollSend() { throw new Error('unexpected failure'); },
  };
  const telegram = {
    async sendPoll(service, chatId, question) {
      sent.push(question);
      return { poll_id: `tg-${sent.length}`, message_id: sent.length };
    },
  };
  assert.deepEqual(await runScheduledPolls(db, telegram), ['p1', 'p2', 'p3']);
  assert.deepEqual(sent.map((question) => question.slice(0, 10)), ['Mon, 20Jul', 'Tue, 21Jul', 'Thu, 23Jul']);
});

test('confirmation edits the existing message', async () => {
  const completed = [];
  const db = {
    async claimDueConfirmations() { return [{ id: 'm', event_id: 'e', claim_token: 'c', service: 'PRIMARY', telegram_chat_id: '-1', telegram_message_id: 8, header_text: 'Header' }]; },
    async getAllocation() { return [{ shift_id: 's', label: 'AM', capacity: 1, status: 'confirmed', confirmed_position: 1, telegram_user_id: '5', display_name: 'Alice' }]; },
    async completeConfirmationSend(...args) { completed.push(args); return true; },
    async failConfirmationSend() { throw new Error('unexpected failure'); },
  };
  let edited = false;
  const telegram = { async editMessage() { edited = true; } };
  assert.deepEqual(await runScheduledConfirmations(db, telegram), ['m']);
  assert.equal(edited, true);
  assert.equal(completed[0][4], true);
});

test('confirmation edit failure falls back to one update message', async () => {
  const completed = [];
  const db = {
    async claimDueConfirmations() { return [{ id: 'm', event_id: 'e', claim_token: 'c', service: 'PRIMARY', telegram_chat_id: '-1', telegram_message_id: 8 }]; },
    async getAllocation() { return [{ shift_id: 's', label: 'AM', capacity: 1, status: null }]; },
    async completeConfirmationSend(...args) { completed.push(args); return true; },
    async failConfirmationSend() { throw new Error('unexpected failure'); },
  };
  let sent = 0;
  const telegram = { async editMessage() { throw new Error('too old'); }, async sendMessage() { sent += 1; return { message_id: 9 }; } };
  assert.deepEqual(await runScheduledConfirmations(db, telegram), ['m']);
  assert.equal(sent, 1);
  assert.equal(completed[0][2], 9);
  assert.equal(completed[0][4], false);
});

test('managed confirmation includes service title and omits empty and waiting list entries', async () => {
  const sent = [];
  const db = {
    async claimDueConfirmations() {
      return [{
        id: 'm',
        event_id: 'e',
        claim_token: 'c',
        service: 'WHCL',
        telegram_chat_id: '-1',
        header_text: 'Confirmed slots',
        footer_text: '',
        show_empty_shifts: true,
      }];
    },
    async getEventDate() { return '2026-07-20'; },
    async getAllocation() {
      return [
        { shift_id: 's1', label: '0800-1700', capacity: 1, status: 'confirmed', telegram_user_id: '5', display_name: 'Alice' },
        { shift_id: 's1', label: '0800-1700', capacity: 1, status: 'waiting_list', telegram_user_id: '6', display_name: 'Bob' },
        { shift_id: 's2', label: '1700-2200', capacity: 1, status: null },
      ];
    },
    async completeConfirmationSend() { return true; },
    async failConfirmationSend() { throw new Error('unexpected failure'); },
  };
  const telegram = { async sendMessage(service, chatId, html) { sent.push(html); return { message_id: 9 }; } };
  assert.deepEqual(await runScheduledConfirmations(db, telegram), ['m']);
  assert.match(sent[0], /^<b>Wheelchair<\/b>/);
  assert.match(sent[0], /<b>Confirmed slots for Mon 20 Jul<\/b>/);
  assert.match(sent[0], /0800-1700hrs/);
  assert.doesNotMatch(sent[0], /Waiting list/);
  assert.doesNotMatch(sent[0], /1700-2200/);
  assert.doesNotMatch(sent[0], /Unfilled/);
});

test('dedicated bot confirmations never expose the internal bot UUID as a title', async () => {
  const botId = '757d5ebc-6fd1-4723-89af-7e497e2c221a';
  const sent = [];
  const db = {
    async claimDueConfirmations() {
      return [{
        id: 'm',
        event_id: 'e',
        claim_token: 'c',
        service: botId,
        telegram_chat_id: '-1',
        header_text: 'Confirmed slots',
        footer_text: 'take note pls',
      }];
    },
    async getEventDate() { return '2026-08-07'; },
    async getAllocation() { return []; },
    async completeConfirmationSend() { return true; },
    async failConfirmationSend() { throw new Error('unexpected failure'); },
  };
  const telegram = {
    async sendMessage(service, chatId, html) {
      sent.push(html);
      return { message_id: 9 };
    },
  };

  assert.deepEqual(await runScheduledConfirmations(db, telegram), ['m']);
  assert.doesNotMatch(sent[0], new RegExp(botId));
  assert.match(sent[0], /^<b>Confirmed slots for (?:tomor, )?Fri 7 Aug<\/b>/);
});

test('Wheelchair confirmations send one message per date in event-date order even when claimed jumbled', async () => {
  const sent = [];
  const eventDates = { e1: '2026-07-20', e2: '2026-07-21', e3: '2026-07-23' };
  const db = {
    async claimDueConfirmations() {
      return [
        { id: 'm3', event_id: 'e3', claim_token: 'c3', service: 'WHCL', telegram_chat_id: '-1', header_text: 'Confirmed slots', footer_text: '' },
        { id: 'm1', event_id: 'e1', claim_token: 'c1', service: 'WHCL', telegram_chat_id: '-1', header_text: 'Confirmed slots', footer_text: '' },
        { id: 'm2', event_id: 'e2', claim_token: 'c2', service: 'WHCL', telegram_chat_id: '-1', header_text: 'Confirmed slots', footer_text: '' },
      ];
    },
    async getEventDate(eventId) { return eventDates[eventId]; },
    async getAllocation() { return [{ shift_id: 's1', label: '0800-1700', capacity: 1, status: 'confirmed', telegram_user_id: '5', display_name: 'Alice' }]; },
    async completeConfirmationSend() { return true; },
    async failConfirmationSend() { throw new Error('unexpected failure'); },
  };
  const telegram = { async sendMessage(service, chatId, html) { sent.push(html); return { message_id: sent.length }; } };
  const completed = await runScheduledConfirmations(db, telegram);
  assert.deepEqual(completed, ['m1', 'm2', 'm3']);
  assert.deepEqual(
    sent.map((html) => /for (\w+ \d+ \w+)</.exec(html)[1]),
    ['Mon 20 Jul', 'Tue 21 Jul', 'Thu 23 Jul'],
  );
});

test('PSA due confirmations are grouped into one batch message', async () => {
  const completed = [];
  const sent = [];
  const db = {
    async claimDueConfirmations() {
      return [
        {
          id: 'm1',
          event_id: 'e1',
          claim_token: 'c1',
          service: 'PSA',
          telegram_chat_id: '-1',
          header_text: 'Confirmed slots',
          footer_text: 'take note pls',
          resolved_send_at: '2026-07-17T04:00:00.000Z',
        },
        {
          id: 'm2',
          event_id: 'e2',
          claim_token: 'c2',
          service: 'PSA',
          telegram_chat_id: '-1',
          header_text: 'Confirmed slots',
          footer_text: 'take note pls',
          resolved_send_at: '2026-07-17T04:00:00.000Z',
        },
      ];
    },
    async getEventDate(eventId) {
      return eventId === 'e1' ? '2026-07-20' : '2026-07-21';
    },
    async getAllocation(eventId) {
      return eventId === 'e1'
        ? [{ shift_id: 's1', label: '0800-1700', capacity: 1, status: 'confirmed', telegram_user_id: '5', display_name: 'Alice' }]
        : [{ shift_id: 's2', label: '2200-0300', capacity: 1, status: 'confirmed', telegram_user_id: '6', display_name: 'Bob' }];
    },
    async completeConfirmationSend(...args) { completed.push(args); return true; },
    async failConfirmationSend() { throw new Error('unexpected failure'); },
  };
  const telegram = { async sendMessage(service, chatId, html) { sent.push({ service, chatId, html }); return { message_id: 99 }; } };
  assert.deepEqual(await runScheduledConfirmations(db, telegram), ['m1', 'm2']);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].service, 'PSA');
  assert.match(sent[0].html, /^<b>PSA<\/b>/);
  assert.match(sent[0].html, /<b>Mon 20 Jul<\/b>/);
  assert.match(sent[0].html, /0800-1700hrs/);
  assert.match(sent[0].html, /<b>Tue 21 Jul<\/b>/);
  assert.match(sent[0].html, /2200-0300hrs/);
  assert.equal(completed.length, 2);
  assert.equal(completed[0][2], 99);
  assert.equal(completed[1][2], 99);
});

test('specific confirmation trigger claims only the requested poll confirmation', async () => {
  let claimedPollId;
  const db = {
    async claimSpecificConfirmation(pollId) {
      claimedPollId = pollId;
      return { id: 'm', event_id: 'e', claim_token: 'c', service: 'PSA', telegram_chat_id: '-1' };
    },
    async getAllocation() {
      return [{ shift_id: 's', label: '0800-1700', capacity: 1, status: 'confirmed', telegram_user_id: '5', display_name: 'Alice' }];
    },
    async completeConfirmationSend() { return true; },
    async failConfirmationSend() { throw new Error('unexpected failure'); },
  };
  const sent = [];
  const telegram = { async sendMessage(service, chatId, html) { sent.push(html); return { message_id: 9 }; } };
  assert.deepEqual(await sendScheduledConfirmationImmediately(db, telegram, 'poll-1'), { success: true, confirmations: 1 });
  assert.equal(claimedPollId, 'poll-1');
  assert.match(sent[0], /^<b>PSA<\/b>/);
});

test('test confirmation header includes the event date', async () => {
  const db = {
    async claimDueConfirmations() {
      return [{
        id: 'm',
        event_id: 'e',
        claim_token: 'c',
        service: 'WHCL',
        telegram_chat_id: '-1',
        header_text: 'Confirmed slots (TEST)',
        footer_text: '',
      }];
    },
    async getEventDate() { return '2026-07-20'; },
    async getAllocation() {
      return [{ shift_id: 's', label: '0800-1700', capacity: 1, status: 'confirmed', telegram_user_id: '5', display_name: 'Alice' }];
    },
    async completeConfirmationSend() { return true; },
    async failConfirmationSend() { throw new Error('unexpected failure'); },
  };
  const sent = [];
  const telegram = { async sendMessage(service, chatId, html) { sent.push(html); return { message_id: 9 }; } };
  assert.deepEqual(await runScheduledConfirmations(db, telegram), ['m']);
  assert.match(sent[0], /<b>Confirmed slots \(TEST\) for Mon 20 Jul<\/b>/);
});

test('automatic template generation creates missing WHCL polls and skips excluded event dates', async () => {
  const created = [];
  const db = {
    async listManagedWeeklySchedules() {
      return [{
        id: 'schedule-1',
        telegram_group_id: 'group-1',
        group_name: 'Wheelchair group',
        service: 'WHCL',
        bot_id: 'WHCL',
        enabled: true,
        poll_release_day_of_week: 3,
        poll_release_time: '17:00',
        confirmation_day_of_week: 4,
        confirmation_time: '10:30',
        timezone: 'Asia/Singapore',
        shifts: [{ label: '0800-1700', start_time: '08:00', end_time: '17:00', capacity: 1 }],
      }];
    },
    async getActivePollForDate(groupId, eventDate) {
      return eventDate === '2026-07-24' ? { id: 'existing' } : null;
    },
    async isPollDateExcluded(groupId, eventDate) {
      return eventDate === '2026-07-23';
    },
    async createScheduledEvent(payload) {
      created.push(payload);
      return `poll-${created.length}`;
    },
  };
  const result = await generateScheduledPollsFromTemplates(db, new Date('2026-07-15T09:01:00Z'));
  assert.equal(result.length, 5);
  assert.deepEqual(created.map((payload) => payload.event_date), [
    '2026-07-20',
    '2026-07-21',
    '2026-07-22',
    '2026-07-25',
    '2026-07-26',
  ]);
  assert.equal(created[0].resolved_release_at, '2026-07-15T09:00:00.000Z');
  assert.equal(created[0].resolved_confirmation_at, '2026-07-16T02:30:00.000Z');
  const wedPoll = created.find((payload) => payload.event_date === '2026-07-22');
  assert.equal(wedPoll.resolved_release_at, '2026-07-15T09:00:00.000Z');
  assert.equal(wedPoll.close_at, '2026-07-21T00:00:00.000Z');
  assert.equal(created[0].poll_question, 'Mon, 20Jul26 - 1 slot for 0800-1700');
  assert.equal(created[0].show_empty_shifts, false);
});

test('automatic PSA generation uses the group gap and creates only one event week', async () => {
  const created = [];
  const db = {
    async listManagedWeeklySchedules() {
      return [{
        id: 'schedule-psa',
        telegram_group_id: 'group-psa',
        group_name: 'PSA group',
        service: 'PSA',
        enabled: true,
        poll_release_day_of_week: 3,
        poll_release_time: '17:00',
        gap_weeks: 1,
        confirmation_day_of_week: 5,
        confirmation_time: '12:00',
        timezone: 'Asia/Singapore',
        shifts: [{ label: '0800-1700', start_time: '08:00', end_time: '17:00', capacity: 1 }],
      }];
    },
    async getActivePollForDate() { return null; },
    async isPollDateExcluded() { return false; },
    async createScheduledEvent(payload) {
      created.push(payload);
      return `poll-${created.length}`;
    },
  };

  const result = await generateScheduledPollsFromTemplates(
    db,
    new Date('2026-08-05T09:01:00Z')
  );

  assert.equal(result.length, 7);
  assert.deepEqual(created.map((poll) => poll.event_date), [
    '2026-08-17',
    '2026-08-18',
    '2026-08-19',
    '2026-08-20',
    '2026-08-21',
    '2026-08-22',
    '2026-08-23',
  ]);
  assert.equal(created[0].resolved_release_at, '2026-08-05T09:00:00.000Z');
  assert.equal(created[0].close_at, '2026-08-14T00:00:00.000Z');
  assert.equal(created[0].resolved_confirmation_at, '2026-08-14T04:00:00.000Z');
});

test('automatic template generation does not backfill after the configured release day', async () => {
  let created = 0;
  const db = {
    async listManagedWeeklySchedules() {
      return [{
        id: 'schedule-1', telegram_group_id: 'group-1', group_name: 'Wheelchair group',
        service: 'WHCL', enabled: true, poll_release_day_of_week: 3,
        poll_release_time: '17:00', timezone: 'Asia/Singapore',
        shifts: [{ label: '0800-1700', start_time: '08:00', end_time: '17:00', capacity: 1 }],
      }];
    },
    async createScheduledEvent() { created += 1; },
  };

  assert.deepEqual(await generateScheduledPollsFromTemplates(
    db, new Date('2026-07-21T09:01:00Z')
  ), []);
  assert.equal(created, 0);
});

test('automatic template generation waits until release time on the configured day', async () => {
  let created = 0;
  const db = {
    async listManagedWeeklySchedules() {
      return [{
        id: 'schedule-1', telegram_group_id: 'group-1', group_name: 'Wheelchair group',
        service: 'WHCL', enabled: true, poll_release_day_of_week: 3,
        poll_release_time: '17:00', timezone: 'Asia/Singapore',
        shifts: [{ label: '0800-1700', start_time: '08:00', end_time: '17:00', capacity: 1 }],
      }];
    },
    async createScheduledEvent() { created += 1; },
  };

  assert.deepEqual(await generateScheduledPollsFromTemplates(
    db, new Date('2026-07-22T08:59:00Z')
  ), []);
  assert.equal(created, 0);
});
