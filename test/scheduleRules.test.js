const test = require('node:test');
const assert = require('node:assert/strict');
const {
  managedTimingForEvent,
  eventDatesForReleaseDate,
  nextTwoWeekRange,
  releaseRangeForService,
} = require('../src/scheduleRules');

test('managed PSA timing cuts off Friday 8am and confirms Friday noon', () => {
  assert.deepEqual(managedTimingForEvent({
    service: 'PSA',
    eventDate: '2026-07-20',
    releaseDay: 3,
    releaseTime: '17:00',
  }), {
    releaseAt: '2026-07-15T17:00',
    closeAt: '2026-07-17T08:00',
    confirmationAt: '2026-07-17T12:00',
  });
});

test('managed wheelchair timing cuts off day before event at 8am', () => {
  assert.deepEqual(managedTimingForEvent({
    service: 'WHCL',
    eventDate: '2026-07-20',
    releaseDay: 3,
    releaseTime: '17:00',
  }), {
    releaseAt: '2026-07-15T17:00',
    closeAt: '2026-07-19T08:00',
    confirmationAt: '2026-07-19T08:00',
  });
});

test('managed timing can use a batch release date for generated polls', () => {
  assert.deepEqual(managedTimingForEvent({
    service: 'WHCL',
    eventDate: '2026-07-22',
    releaseDate: '2026-07-15',
    releaseDay: 3,
    releaseTime: '17:00',
  }), {
    releaseAt: '2026-07-15T17:00',
    closeAt: '2026-07-21T08:00',
    confirmationAt: '2026-07-21T08:00',
  });
});

test('managed timing uses the configured weekly confirmation after release', () => {
  assert.deepEqual(managedTimingForEvent({
    service: 'WHCL',
    eventDate: '2026-07-20',
    releaseDay: 3,
    releaseTime: '17:00',
    confirmationDay: 4,
    confirmationTime: '10:30',
  }), {
    releaseAt: '2026-07-15T17:00',
    closeAt: '2026-07-19T08:00',
    confirmationAt: '2026-07-16T10:30',
  });
  assert.equal(managedTimingForEvent({
    service: 'PSA',
    eventDate: '2026-07-20',
    releaseDay: 3,
    releaseTime: '17:00',
    confirmationDay: 3,
    confirmationTime: '17:00',
  }).confirmationAt, '2026-07-22T17:00');
});

test('PSA weekly release covers the following two weeks', () => {
  assert.deepEqual(nextTwoWeekRange(new Date('2026-07-15T17:00:00+08:00')), {
    start: '2026-07-20',
    end: '2026-08-02',
  });
  assert.deepEqual(releaseRangeForService('PSA', new Date('2026-07-15T17:00:00+08:00')), {
    start: '2026-07-20',
    end: '2026-08-02',
  });
  assert.deepEqual(releaseRangeForService('WHCL', new Date('2026-07-15T17:00:00+08:00')), {
    start: '2026-07-20',
    end: '2026-07-26',
  });
});

test('release date expands to WHCL 7 days and PSA 14 days', () => {
  assert.deepEqual(eventDatesForReleaseDate('WHCL', '2026-07-15'), [
    '2026-07-20',
    '2026-07-21',
    '2026-07-22',
    '2026-07-23',
    '2026-07-24',
    '2026-07-25',
    '2026-07-26',
  ]);
  const psa = eventDatesForReleaseDate('PSA', '2026-07-15');
  assert.equal(psa.length, 14);
  assert.equal(psa[0], '2026-07-20');
  assert.equal(psa[13], '2026-08-02');
});
