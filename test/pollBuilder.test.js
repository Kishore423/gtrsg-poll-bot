const test = require('node:test');
const assert = require('node:assert/strict');
const {
  formatDateHeader,
  buildPollsFromSlots,
  buildConfirmationMessage,
  managedMention,
  NOT_AVAILABLE_OPTION,
} = require('../src/pollBuilder');

test('formatDateHeader matches the existing manual poll format', () => {
  assert.equal(formatDateHeader('2026-07-12'), 'Sun, 12Jul26');
  assert.equal(formatDateHeader('2026-07-05'), 'Sun, 05Jul26');
});

test('buildPollsFromSlots builds one poll per date with correct question text', () => {
  const rows = [
    { id: 1, slot_date: '2026-07-12', time_start: '0430', time_end: '0830', slot_count: 1 },
    { id: 2, slot_date: '2026-07-12', time_start: '0800', time_end: '1300', slot_count: 1 },
    { id: 3, slot_date: '2026-07-12', time_start: '1700', time_end: '2200', slot_count: 1 },
    { id: 4, slot_date: '2026-07-12', time_start: '2200', time_end: '0300', slot_count: 1 },
  ];

  const polls = buildPollsFromSlots(rows);

  assert.equal(polls.length, 1);
  assert.equal(
    polls[0].question,
    'Sun, 12Jul26 - 1 slot for 0430-0830, 1 slot for 0800-1300, 1 slot for 1700-2200, 1 slot for 2200-0300'
  );
  assert.deepEqual(polls[0].options, ['0430-0830', '0800-1300', '1700-2200', '2200-0300']);
  assert.deepEqual(polls[0].rowIds, [1, 2, 3, 4]);
  assert.deepEqual(polls[0].capacities, {
    '0430-0830': 1,
    '0800-1300': 1,
    '1700-2200': 1,
    '2200-0300': 1,
  });
});

test('buildPollsFromSlots pluralizes "slots" when count > 1', () => {
  const rows = [
    { id: 1, slot_date: '2026-07-12', time_start: '0430', time_end: '0830', slot_count: 3 },
  ];

  const polls = buildPollsFromSlots(rows);

  assert.equal(polls[0].question, 'Sun, 12Jul26 - 3 slots for 0430-0830');
});

test('buildPollsFromSlots groups multiple dates into separate polls, sorted by date', () => {
  const rows = [
    { id: 1, slot_date: '2026-07-13', time_start: '0800', time_end: '1300', slot_count: 1 },
    { id: 2, slot_date: '2026-07-12', time_start: '0430', time_end: '0830', slot_count: 1 },
  ];

  const polls = buildPollsFromSlots(rows);

  assert.equal(polls.length, 2);
  assert.equal(polls[0].slot_date, '2026-07-12');
  assert.equal(polls[1].slot_date, '2026-07-13');
});

test('buildPollsFromSlots dedupes identical time ranges within the same date', () => {
  const rows = [
    { id: 1, slot_date: '2026-07-12', time_start: '0430', time_end: '0830', slot_count: 1 },
    { id: 2, slot_date: '2026-07-12', time_start: '0430', time_end: '0830', slot_count: 2 },
  ];

  const polls = buildPollsFromSlots(rows);

  assert.deepEqual(polls[0].options, ['0430-0830', NOT_AVAILABLE_OPTION]);
  assert.deepEqual(polls[0].rowIds, [1, 2]);
  // Duplicate ranges pool their capacity.
  assert.equal(polls[0].capacities['0430-0830'], 3);
});

test('buildPollsFromSlots pads single-option days to two options (Telegram minimum)', () => {
  const rows = [
    { id: 1, slot_date: '2026-07-12', time_start: '0430', time_end: '0830', slot_count: 1 },
  ];

  const polls = buildPollsFromSlots(rows);

  assert.deepEqual(polls[0].options, ['0430-0830', NOT_AVAILABLE_OPTION]);
});

test('buildPollsFromSlots returns nothing for an empty input', () => {
  assert.deepEqual(buildPollsFromSlots([]), []);
});

test('buildPollsFromSlots prefixes the service name when labelService is set', () => {
  const rows = [
    { id: 1, slot_date: '2026-07-12', time_start: '0430', time_end: '0830', slot_count: 1, service: 'WHCL' },
    { id: 2, slot_date: '2026-07-12', time_start: '0800', time_end: '1300', slot_count: 1, service: 'PSA' },
  ];

  const labelled = buildPollsFromSlots(rows, { labelService: true });
  assert.equal(labelled[0].question, '[PSA] Sun, 12Jul26 - 1 slot for 0800-1300');
  assert.equal(labelled[1].question, '[Wheelchair] Sun, 12Jul26 - 1 slot for 0430-0830');

  const plain = buildPollsFromSlots(rows);
  assert.ok(plain.every((p) => !p.question.startsWith('[')));
});

test('buildConfirmationMessage formats assignments as Telegram HTML mentions', () => {
  const { html } = buildConfirmationMessage('2026-07-12', [
    { option_name: '0430-0830', capacity: 1, voters: [{ id: '11', name: 'Alice' }] },
    { option_name: '1700-2200', capacity: 2, voters: [{ id: '22', name: 'Bob' }, { id: '33', name: 'Carol' }] },
    { option_name: '2200-0300', capacity: 1, voters: [] },
  ]);

  assert.equal(
    html,
    'Confirmed slots for Sun 12 Jul\n\n' +
      '0430-0830hrs <a href="tg://user?id=11">@Alice</a>\n' +
      '1700-2200hrs <a href="tg://user?id=22">@Bob</a> <a href="tg://user?id=33">@Carol</a>\n' +
      '2200-0300hrs — Unfilled (0/1)\n' +
      'take note pls'
  );
});

test('buildConfirmationMessage escapes HTML in voter names', () => {
  const { html } = buildConfirmationMessage('2026-07-12', [
    { option_name: '0430-0830', capacity: 1, voters: [{ id: '11', name: 'A<b>&"x' }] },
  ]);
  assert.match(html, /<a href="tg:\/\/user\?id=11">@A&lt;b&gt;&amp;&quot;x<\/a>/);
});

test('buildConfirmationMessage says "tomor" when the slot date is tomorrow', () => {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const iso = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`;

  const { html } = buildConfirmationMessage(iso, [
    { option_name: '0430-0830', capacity: 1, voters: [{ id: '11', name: 'Alice' }] },
  ]);

  assert.ok(html.startsWith('Confirmed slots for tomor, '));
});

test('managed confirmations mention the immutable Telegram account instead of its handle', () => {
  assert.equal(
    managedMention({
      telegram_user_id: '123456789',
      telegram_username: 'alice_handle',
      display_name: 'Alice Tan',
    }),
    '<a href="tg://user?id=123456789">Alice Tan</a>'
  );
});
