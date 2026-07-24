const DEFAULT_RELEASE_DAY = 3; // Wednesday
const DEFAULT_RELEASE_TIME = '17:00';
const PSA_CUTOFF_DAY = 5; // Friday
const PSA_CUTOFF_TIME = '08:00';
const PSA_CONFIRMATION_TIME = '12:00';
const WHCL_CUTOFF_DAYS_BEFORE_EVENT = 1;
const WHCL_CUTOFF_TIME = '08:00';

function addLocalDays(dateText, days) {
  const [year, month, day] = dateText.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function weekday(dateText) {
  return new Date(`${dateText}T00:00:00Z`).getUTCDay();
}

function releaseDateForEvent(eventDate, releaseDay) {
  const diff = (weekday(eventDate) - Number(releaseDay) + 7) % 7;
  return addLocalDays(eventDate, -diff);
}

function nextWeekdayOnOrAfter(dateText, targetDay) {
  const diff = (Number(targetDay) - weekday(dateText) + 7) % 7;
  return addLocalDays(dateText, diff);
}

function managedTimingForEvent({
  service,
  eventDate,
  releaseDay = DEFAULT_RELEASE_DAY,
  releaseTime = DEFAULT_RELEASE_TIME,
  releaseDate: explicitReleaseDate,
}) {
  const normalizedService = service === 'PSA' ? 'PSA' : 'WHCL';
  const releaseDate = explicitReleaseDate || releaseDateForEvent(eventDate, releaseDay);
  const releaseAt = `${releaseDate}T${releaseTime}`;

  if (normalizedService === 'PSA') {
    const cutoffDate = nextWeekdayOnOrAfter(releaseDate, PSA_CUTOFF_DAY);
    return {
      releaseAt,
      closeAt: `${cutoffDate}T${PSA_CUTOFF_TIME}`,
      confirmationAt: `${cutoffDate}T${PSA_CONFIRMATION_TIME}`,
    };
  }

  const cutoffDate = addLocalDays(eventDate, -WHCL_CUTOFF_DAYS_BEFORE_EVENT);
  return {
    releaseAt,
    closeAt: `${cutoffDate}T${WHCL_CUTOFF_TIME}`,
    confirmationAt: `${cutoffDate}T${WHCL_CUTOFF_TIME}`,
  };
}

function nextWeekRange(from = new Date()) {
  const base = new Date(from);
  base.setHours(0, 0, 0, 0);
  const daysUntilMonday = ((8 - base.getDay()) % 7) || 7;
  const monday = new Date(base.getTime() + daysUntilMonday * 24 * 60 * 60 * 1000);
  const sunday = new Date(monday.getTime() + 6 * 24 * 60 * 60 * 1000);
  const iso = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { start: iso(monday), end: iso(sunday) };
}

function nextTwoWeekRange(from = new Date()) {
  const range = nextWeekRange(from);
  return { start: range.start, end: addLocalDays(range.start, 13) };
}

function releaseRangeForService(service, from = new Date()) {
  return service === 'PSA' ? nextTwoWeekRange(from) : nextWeekRange(from);
}

function eventDatesForReleaseDate(service, releaseDate) {
  const daysUntilMonday = ((1 - weekday(releaseDate) + 7) % 7) || 7;
  const start = addLocalDays(releaseDate, daysUntilMonday);
  const count = service === 'PSA' ? 14 : 7;
  return Array.from({ length: count }, (_, index) => addLocalDays(start, index));
}

module.exports = {
  DEFAULT_RELEASE_DAY,
  DEFAULT_RELEASE_TIME,
  addLocalDays,
  eventDatesForReleaseDate,
  managedTimingForEvent,
  nextWeekRange,
  nextTwoWeekRange,
  releaseRangeForService,
};
