const test = require('node:test');
const assert = require('node:assert/strict');
const { buildConfirmationState, confirmationDueAt } = require('../src/confirmation');

const poll = {
  slot_date: '2026-07-12',
  capacities: { '0430-0830': 1, '1700-2200': 2 },
};

function vote(option_name, voter_id, voted_at_ms) {
  return { option_name, voter_id, display_name: `name-${voter_id}`, voted_at_ms };
}

test('confirmation state selects exactly the earliest voters up to capacity', () => {
  const state = buildConfirmationState(poll, [
    vote('1700-2200', 'first', 1000),
    vote('1700-2200', 'second', 2000),
    vote('1700-2200', 'waitlist', 3000),
    vote('0430-0830', 'early', 500),
  ], { now: new Date('2026-07-07T00:00:00+08:00') });

  assert.equal(state.allFilled, true);
  assert.equal(state.totalSlots, 3);
  assert.equal(state.filledSlots, 3);
  assert.deepEqual(state.assignments, [
    { option_name: '0430-0830', capacity: 1, voters: [{ id: 'early', name: 'name-early' }] },
    {
      option_name: '1700-2200',
      capacity: 2,
      voters: [{ id: 'first', name: 'name-first' }, { id: 'second', name: 'name-second' }],
    },
  ]);
});

test('auto-send window opens at 08:00 the day before the slot date', () => {
  const before = buildConfirmationState(poll, [], { now: new Date('2026-07-11T07:59:59+08:00') });
  const atDeadline = buildConfirmationState(poll, [], { now: new Date('2026-07-11T08:00:00+08:00') });

  assert.equal(before.windowOpen, false);
  assert.equal(atDeadline.windowOpen, true);
  assert.deepEqual(atDeadline.deadlineAt, new Date('2026-07-11T08:00:00+08:00'));
});

test('managers can confirm manually any time before the earliest shift', () => {
  const early = buildConfirmationState(poll, [], { now: new Date('2026-07-07T00:00:00+08:00') });
  const afterShiftStart = buildConfirmationState(poll, [], { now: new Date('2026-07-12T05:00:00+08:00') });

  assert.equal(early.canConfirm, true);
  assert.equal(afterShiftStart.canConfirm, false);
});

test('confirmationDueAt honours a custom hour', () => {
  assert.deepEqual(
    confirmationDueAt('2026-07-12', { confirmationHour: 10 }),
    new Date('2026-07-11T10:00:00+08:00')
  );
});
