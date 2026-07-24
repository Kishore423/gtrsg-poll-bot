const test = require('node:test');
const assert = require('node:assert/strict');
const { createMemoryDb } = require('../src/db/memory');
const {
  sendDuePolls,
  sendDueConfirmations,
  nextWeekRange,
  runWeeklySend,
} = require('../src/scheduler');

function makeTelegram() {
  const polls = [];
  const messages = [];
  let seq = 0;
  return {
    polls,
    messages,
    async sendPoll(service, chatId, question, options) {
      seq += 1;
      polls.push({ service, chatId, question, options });
      return { poll_id: `MOCK-${seq}`, message_id: seq };
    },
    async sendMessage(service, chatId, html) {
      messages.push({ service, chatId, html });
    },
  };
}

async function seededDb() {
  const db = createMemoryDb();
  await db.setTarget('WHCL', { chat_id: '-100whcl', title: 'WHCL', active: true });
  await db.setTarget('PSA', { chat_id: '-100psa', title: 'PSA', active: true });
  return db;
}

test('sendDuePolls sends one poll per date+service and marks rows sent', async () => {
  const db = await seededDb();
  await db.insertSlot({ slot_date: '2026-07-12', time_start: '0430', time_end: '0830', slot_count: 1, service: 'WHCL' });
  await db.insertSlot({ slot_date: '2026-07-12', time_start: '0800', time_end: '1300', slot_count: 1, service: 'WHCL' });
  await db.insertSlot({ slot_date: '2026-07-13', time_start: '1700', time_end: '2200', slot_count: 2, service: 'WHCL' });

  const tg = makeTelegram();
  const polls = await sendDuePolls(db, tg);

  assert.equal(polls.length, 2);
  assert.equal(tg.polls[0].chatId, '-100whcl');
  assert.equal(tg.polls[0].question, 'Sun, 12Jul26 - 1 slot for 0430-0830, 1 slot for 0800-1300');
  assert.equal(tg.polls[1].question, 'Mon, 13Jul26 - 2 slots for 1700-2200');
  assert.deepEqual(await db.listUnsentSlots(), []);
});

test('sendDuePolls stores the provider poll id and capacities for later votes', async () => {
  const db = await seededDb();
  await db.insertSlot({ slot_date: '2026-07-12', time_start: '0430', time_end: '0830', slot_count: 1, service: 'WHCL' });
  await db.insertSlot({ slot_date: '2026-07-12', time_start: '1700', time_end: '2200', slot_count: 2, service: 'WHCL' });
  const tg = makeTelegram();
  await sendDuePolls(db, tg);

  const poll = await db.getPollByProviderPollId('MOCK-1');
  assert.ok(poll);
  assert.equal(poll.group_chat_id, '-100whcl');
  assert.deepEqual(poll.options, ['0430-0830', '1700-2200']);
  assert.deepEqual(poll.capacities, { '0430-0830': 1, '1700-2200': 2 });
});

test('sendDuePolls skips services with no linked group and leaves their slots unsent', async () => {
  const db = createMemoryDb();
  await db.setTarget('WHCL', { chat_id: '-100whcl', title: 'WHCL', active: true });
  await db.insertSlot({ slot_date: '2026-07-12', time_start: '0430', time_end: '0830', slot_count: 1, service: 'WHCL' });
  await db.insertSlot({ slot_date: '2026-07-12', time_start: '0800', time_end: '1300', slot_count: 1, service: 'PSA' });

  const tg = makeTelegram();
  const polls = await sendDuePolls(db, tg);

  assert.equal(polls.length, 1);
  assert.equal(polls[0].service, 'WHCL');
  assert.deepEqual((await db.listUnsentSlots()).map((s) => s.service), ['PSA']);
});

test('sendDuePolls does not re-send already-sent slots', async () => {
  const db = await seededDb();
  await db.insertSlot({ slot_date: '2026-07-12', time_start: '0430', time_end: '0830', slot_count: 1, service: 'WHCL' });
  const tg = makeTelegram();
  await sendDuePolls(db, tg);
  await sendDuePolls(db, tg);
  assert.equal(tg.polls.length, 1);
});

test('sendDuePolls filters by service and by slot_date', async () => {
  const db = await seededDb();
  await db.insertSlot({ slot_date: '2026-07-12', time_start: '0430', time_end: '0830', slot_count: 1, service: 'WHCL' });
  await db.insertSlot({ slot_date: '2026-07-13', time_start: '0800', time_end: '1300', slot_count: 1, service: 'PSA' });

  const tg = makeTelegram();
  const byService = await sendDuePolls(db, tg, { service: 'PSA' });
  assert.equal(byService.length, 1);
  assert.equal(byService[0].service, 'PSA');
  assert.deepEqual((await db.listUnsentSlots()).map((s) => s.service), ['WHCL']);
});

test('nextWeekRange covers the Monday-Sunday week after the send date', () => {
  assert.deepEqual(nextWeekRange(new Date('2026-07-10T16:00:00+08:00')), {
    start: '2026-07-13',
    end: '2026-07-19',
  });
  assert.deepEqual(nextWeekRange(new Date('2026-07-13T09:00:00+08:00')), {
    start: '2026-07-20',
    end: '2026-07-26',
  });
});

test('upsertVoterVote keeps arrival order and handles retraction', async () => {
  const db = await seededDb();
  await db.insertSlot({ slot_date: '2026-07-12', time_start: '0430', time_end: '0830', slot_count: 2, service: 'WHCL' });
  const tg = makeTelegram();
  await sendDuePolls(db, tg);
  const poll = await db.getPollByProviderPollId('MOCK-1');

  await db.upsertVoterVote(poll.id, { voter_id: '1', option_names: ['0430-0830'], voted_at_ms: 1000, display_name: 'A' });
  await db.upsertVoterVote(poll.id, { voter_id: '2', option_names: ['0430-0830'], voted_at_ms: 2000, display_name: 'B' });
  // '1' re-sends the same selection; must keep original arrival (1000), not jump.
  await db.upsertVoterVote(poll.id, { voter_id: '1', option_names: ['0430-0830'], voted_at_ms: 5000, display_name: 'A' });

  let voters = (await db.getVotesForPoll(poll.id)).map((v) => v.voter_id);
  assert.deepEqual(voters, ['1', '2']);

  // '1' retracts entirely.
  await db.upsertVoterVote(poll.id, { voter_id: '1', option_names: [], voted_at_ms: 6000 });
  voters = (await db.getVotesForPoll(poll.id)).map((v) => v.voter_id);
  assert.deepEqual(voters, ['2']);
});

test('day-before 8am confirmation sends the first-come list with unfilled marked', async () => {
  const db = await seededDb();
  await db.insertSlot({ slot_date: '2026-07-12', time_start: '0430', time_end: '0830', slot_count: 1, service: 'WHCL' });
  await db.insertSlot({ slot_date: '2026-07-12', time_start: '1700', time_end: '2200', slot_count: 2, service: 'WHCL' });
  const tg = makeTelegram();
  await sendDuePolls(db, tg);
  const poll = await db.getPollByProviderPollId('MOCK-1');
  await db.upsertVoterVote(poll.id, { voter_id: '1', option_names: ['1700-2200'], voted_at_ms: 1000, display_name: 'Alice' });

  const early = await sendDueConfirmations(db, tg, {}, new Date('2026-07-11T07:59:00+08:00'));
  assert.equal(early.length, 0);

  const now = new Date('2026-07-11T08:00:00+08:00');
  const first = await sendDueConfirmations(db, tg, {}, now);
  const second = await sendDueConfirmations(db, tg, {}, now);

  assert.equal(first.length, 1);
  assert.equal(second.length, 0);
  assert.equal(tg.messages.length, 1);
  assert.match(tg.messages[0].html, /0430-0830hrs — Unfilled \(0\/1\)/);
  assert.match(tg.messages[0].html, /1700-2200hrs <a href="tg:\/\/user\?id=1">@Alice<\/a>/);
});

test('runWeeklySend only sends for services whose configured day is today', async () => {
  const db = await seededDb();
  // Wednesday 2026-07-15; next week is 20-26 Jul.
  await db.setSetting('poll_send_day_WHCL', 3); // Wednesday
  await db.setSetting('poll_send_day_PSA', 5); // Friday
  await db.insertSlot({ slot_date: '2026-07-14', time_start: '0430', time_end: '0830', slot_count: 1, service: 'WHCL' });
  await db.insertSlot({ slot_date: '2026-07-21', time_start: '0430', time_end: '0830', slot_count: 1, service: 'WHCL' });
  await db.insertSlot({ slot_date: '2026-07-21', time_start: '0800', time_end: '1300', slot_count: 1, service: 'PSA' });

  const tg = makeTelegram();
  const sent = await runWeeklySend(db, tg, {}, new Date('2026-07-15T17:00:00+08:00'));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].service, 'WHCL');
  assert.deepEqual((await db.listUnsentSlots()).map((s) => s.service), ['WHCL', 'PSA']);
});

test('runWeeklySend sends PSA slots for the following two weeks', async () => {
  const db = await seededDb();
  await db.setSetting('poll_send_day_PSA', 3);
  await db.setSetting('poll_send_day_WHCL', 5);
  await db.insertSlot({ slot_date: '2026-07-21', time_start: '0800', time_end: '1300', slot_count: 1, service: 'PSA' });
  await db.insertSlot({ slot_date: '2026-07-30', time_start: '0800', time_end: '1300', slot_count: 1, service: 'PSA' });
  await db.insertSlot({ slot_date: '2026-08-03', time_start: '0800', time_end: '1300', slot_count: 1, service: 'PSA' });

  const tg = makeTelegram();
  const sent = await runWeeklySend(db, tg, {}, new Date('2026-07-15T17:00:00+08:00'));

  assert.equal(sent.length, 2);
  assert.deepEqual(sent.map((poll) => poll.slot_date), ['2026-07-21', '2026-07-30']);
  assert.deepEqual((await db.listUnsentSlots()).map((s) => s.slot_date), ['2026-08-03']);
});
