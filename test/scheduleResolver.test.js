const test = require('node:test');
const assert = require('node:assert/strict');
const { resolvePollSchedule, zonedDateTimeToUtc } = require('../src/scheduleResolver');

const now = new Date('2026-07-06T00:00:00Z'); // Monday 08:00 SGT
const times = { close_at: '2026-07-10T12:00:00Z', confirmation_at: '2026-07-10T13:00:00Z' };

test('specific release datetime overrides all defaults', () => {
  const result = resolvePollSchedule({ ...times, specific_release_at: '2026-07-09T09:00:00Z',
    specific_release_day_of_week: 5, specific_release_time: '17:00',
    weekly_schedule: { enabled: true, poll_release_day_of_week: 3, poll_release_time: '10:00' } }, now);
  assert.equal(result.source, 'specific_datetime');
  assert.equal(result.releaseAt.toISOString(), '2026-07-09T09:00:00.000Z');
});

test('specific weekday overrides weekly schedule', () => {
  const result = resolvePollSchedule({ ...times, specific_release_day_of_week: 2,
    specific_release_time: '17:00', timezone: 'Asia/Singapore',
    weekly_schedule: { enabled: true, poll_release_day_of_week: 5, poll_release_time: '17:00' } }, now);
  assert.equal(result.source, 'specific_weekday');
  assert.equal(result.releaseAt.toISOString(), '2026-07-07T09:00:00.000Z');
});

test('weekly default is used only when no specific schedule exists', () => {
  const result = resolvePollSchedule({ ...times, timezone: 'Asia/Singapore', weekly_schedule: {
    enabled: true, poll_release_day_of_week: 5, poll_release_time: '17:00', timezone: 'Asia/Singapore',
  } }, now);
  assert.equal(result.source, 'weekly_default');
  assert.equal(result.releaseAt.toISOString(), '2026-07-10T09:00:00.000Z');
});

test('weekly confirmation fallback is resolved and frozen with the poll', () => {
  const result = resolvePollSchedule({ close_at: '2026-07-10T10:00:00Z', timezone: 'Asia/Singapore', weekly_schedule: {
    enabled: true, poll_release_day_of_week: 5, poll_release_time: '17:00',
    confirmation_day_of_week: 6, confirmation_time: '12:00', timezone: 'Asia/Singapore',
  } }, now);
  assert.equal(result.confirmationAt.toISOString(), '2026-07-11T04:00:00.000Z');
  const frozen = result.confirmationAt.toISOString();
  assert.equal(frozen, '2026-07-11T04:00:00.000Z');
});

test('missing schedule and invalid chronology are rejected', () => {
  assert.throws(() => resolvePollSchedule(times, now), /No release schedule/);
  assert.throws(() => resolvePollSchedule({ ...times, specific_release_at: '2026-07-11T09:00:00Z' }, now), /Closing time/);
});

test('past release is rejected unless send immediately is explicit', () => {
  assert.throws(() => resolvePollSchedule({ ...times, specific_release_at: '2026-07-05T09:00:00Z' }, now), /future/);
  const result = resolvePollSchedule({ ...times, specific_release_at: '2026-07-05T09:00:00Z', send_immediately: true }, now);
  assert.equal(result.releaseAt, now);
});

test('immediate test confirmation can be before the normal close time', () => {
  const result = resolvePollSchedule({
    specific_release_at: '2026-07-05T09:00:00Z',
    send_immediately: true,
    is_test: true,
    close_at: '2026-07-10T12:00:00Z',
    confirmation_at: '2026-07-06T00:05:00Z',
  }, now);
  assert.equal(result.releaseAt, now);
  assert.equal(result.closeAt.toISOString(), '2026-07-10T12:00:00.000Z');
  assert.equal(result.confirmationAt.toISOString(), '2026-07-06T00:05:00.000Z');
});

test('normal immediate polls still confirm after the close time', () => {
  const result = resolvePollSchedule({
    specific_release_at: '2026-07-05T09:00:00Z',
    send_immediately: true,
    close_at: '2026-07-10T12:00:00Z',
    confirmation_at: '2026-07-06T00:05:00Z',
  }, now);
  assert.equal(result.releaseAt, now);
  assert.equal(result.confirmationAt.toISOString(), '2026-07-10T12:05:00.000Z');
});

test('timezone conversion handles Singapore and rejects a DST gap', () => {
  assert.equal(zonedDateTimeToUtc('2026-07-10', '17:00', 'Asia/Singapore').toISOString(), '2026-07-10T09:00:00.000Z');
  assert.throws(() => zonedDateTimeToUtc('2026-03-08', '02:30', 'America/New_York'), /does not exist/);
});
