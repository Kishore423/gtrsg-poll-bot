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

function releaseDateForEvent(eventDate, releaseDay, gapWeeks = 0) {
  const eventMonday = mondayOfWeek(eventDate);
  const releaseWeekMonday = addLocalDays(eventMonday, -(Number(gapWeeks || 0) + 1) * 7);
  return addLocalDays(releaseWeekMonday, (Number(releaseDay) + 6) % 7);
}

function mondayOfWeek(dateText) {
  return addLocalDays(dateText, -((weekday(dateText) + 6) % 7));
}

function eventWeekDateTime(eventDate, targetDay, targetTime) {
  const eventMonday = mondayOfWeek(eventDate);
  const priorWeekMonday = addLocalDays(eventMonday, -7);
  const date = addLocalDays(priorWeekMonday, (Number(targetDay) + 6) % 7);
  return `${date}T${String(targetTime).slice(0, 5)}`;
}

function managedTimingForEvent({
  service,
  eventDate,
  releaseDay = DEFAULT_RELEASE_DAY,
  releaseTime = DEFAULT_RELEASE_TIME,
  releaseDate: explicitReleaseDate,
  gapWeeks = 0,
  confirmationDay,
  confirmationTime,
  validateAfterRelease = true,
}) {
  const normalizedService = service === 'PSA' ? 'PSA' : 'WHCL';
  const releaseDate = explicitReleaseDate || releaseDateForEvent(eventDate, releaseDay, gapWeeks);
  const releaseAt = `${releaseDate}T${releaseTime}`;
  const configuredConfirmationAt = confirmationDay !== undefined && confirmationTime
    ? eventWeekDateTime(
      eventDate,
      confirmationDay,
      confirmationTime
    )
    : null;

  if (normalizedService === 'PSA') {
    const cutoffAt = eventWeekDateTime(
      eventDate,
      PSA_CUTOFF_DAY,
      PSA_CUTOFF_TIME
    );
    const timing = {
      releaseAt,
      closeAt: cutoffAt,
      confirmationAt: configuredConfirmationAt || `${cutoffAt.slice(0, 10)}T${PSA_CONFIRMATION_TIME}`,
    };
    if (validateAfterRelease && timing.closeAt <= releaseAt) {
      throw new RangeError('PSA release must be before Friday 08:00 in the week before the event week');
    }
    if (validateAfterRelease && timing.confirmationAt <= releaseAt) {
      throw new RangeError('Confirmation date and time must be after release date and time');
    }
    return timing;
  }

  const cutoffDate = addLocalDays(eventDate, -WHCL_CUTOFF_DAYS_BEFORE_EVENT);
  const timing = {
    releaseAt,
    closeAt: `${cutoffDate}T${WHCL_CUTOFF_TIME}`,
    confirmationAt: configuredConfirmationAt || `${cutoffDate}T${WHCL_CUTOFF_TIME}`,
  };
  if (validateAfterRelease && timing.closeAt <= releaseAt) {
    throw new RangeError('Release date and time must be before the event cutoff');
  }
  if (validateAfterRelease && timing.confirmationAt <= releaseAt) {
    throw new RangeError('Confirmation date and time must be after release date and time');
  }
  return timing;
}

function nextWeekRange(from = new Date(), gapWeeks = 0) {
  const base = new Date(from);
  base.setHours(0, 0, 0, 0);
  const daysUntilMonday = ((8 - base.getDay()) % 7) || 7;
  const monday = new Date(
    base.getTime() + (daysUntilMonday + Number(gapWeeks || 0) * 7) * 24 * 60 * 60 * 1000
  );
  const sunday = new Date(monday.getTime() + 6 * 24 * 60 * 60 * 1000);
  const iso = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { start: iso(monday), end: iso(sunday) };
}

function releaseRangeForService(service, from = new Date(), gapWeeks = 0) {
  return nextWeekRange(from, gapWeeks);
}

function eventDatesForReleaseDate(service, releaseDate, gapWeeks = 0) {
  const daysUntilMonday = ((1 - weekday(releaseDate) + 7) % 7) || 7;
  const start = addLocalDays(releaseDate, daysUntilMonday + Number(gapWeeks || 0) * 7);
  return Array.from({ length: 7 }, (_, index) => addLocalDays(start, index));
}

module.exports = {
  DEFAULT_RELEASE_DAY,
  DEFAULT_RELEASE_TIME,
  addLocalDays,
  eventDatesForReleaseDate,
  managedTimingForEvent,
  nextWeekRange,
  releaseRangeForService,
};
