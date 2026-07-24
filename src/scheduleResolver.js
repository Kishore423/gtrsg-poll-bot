const DAY_MS = 86400000;

function partsAt(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function zonedDateTimeToUtc(dateText, timeText, timeZone) {
  const normalizedTimeText = timeText.slice(0, 5);
  const [year, month, day] = dateText.split('-').map(Number);
  const [hour, minute] = normalizedTimeText.split(':').map(Number);
  let guess = Date.UTC(year, month - 1, day, hour, minute);
  for (let i = 0; i < 3; i += 1) {
    const p = partsAt(new Date(guess), timeZone);
    const represented = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute));
    guess += Date.UTC(year, month - 1, day, hour, minute) - represented;
  }
  const result = new Date(guess);
  const p = partsAt(result, timeZone);
  const pad = (s) => String(s).padStart(2, '0');
  const formattedDate = `${p.year}-${pad(p.month)}-${pad(p.day)}`;
  const formattedTime = `${pad(p.hour)}:${pad(p.minute)}`;
  if (formattedDate !== dateText || formattedTime !== normalizedTimeText) {
    throw new Error(`Local time ${dateText} ${timeText} does not exist in ${timeZone}`);
  }
  return result;
}

function localDateAt(date, timeZone) {
  const p = partsAt(date, timeZone);
  const pad = (s) => String(s).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

function addLocalDays(dateText, days) {
  const [y, m, d] = dateText.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function weekday(dateText) { return new Date(`${dateText}T00:00:00Z`).getUTCDay(); }

function nextWeekdayDate(fromDate, targetDay, timeText, timeZone) {
  const local = localDateAt(fromDate, timeZone);
  let delta = (targetDay - weekday(local) + 7) % 7;
  let candidate = zonedDateTimeToUtc(addLocalDays(local, delta), timeText, timeZone);
  if (candidate <= fromDate) {
    delta += 7;
    candidate = zonedDateTimeToUtc(addLocalDays(local, delta), timeText, timeZone);
  }
  return candidate;
}

function parseDateTime(value, timeZone) {
  if (typeof value !== 'string') return new Date(NaN);
  const local = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/.exec(value);
  return local ? zonedDateTimeToUtc(local[1], local[2], timeZone) : new Date(value);
}

function resolvePollSchedule(input, now = new Date()) {
  const timezone = input.timezone || 'Asia/Singapore';
  let releaseAt;
  let source;
  if (input.specific_release_at) {
    releaseAt = parseDateTime(input.specific_release_at, timezone);
    source = 'specific_datetime';
  } else if (input.specific_release_day_of_week !== undefined && input.specific_release_time) {
    releaseAt = nextWeekdayDate(now, Number(input.specific_release_day_of_week), input.specific_release_time, timezone);
    source = 'specific_weekday';
  } else if (input.weekly_schedule?.enabled) {
    releaseAt = nextWeekdayDate(now, Number(input.weekly_schedule.poll_release_day_of_week),
      input.weekly_schedule.poll_release_time, input.weekly_schedule.timezone || timezone);
    source = 'weekly_default';
  } else {
    throw new Error('No release schedule is configured');
  }
  if (Number.isNaN(releaseAt.getTime())) throw new Error('Invalid release date and time');
  if (releaseAt <= now && !input.send_immediately) throw new Error('Release time must be in the future');
  if (input.send_immediately) releaseAt = now;

  let closeAt = parseDateTime(input.close_at, timezone);
  let confirmationAt = input.confirmation_at
    ? parseDateTime(input.confirmation_at, timezone)
    : input.weekly_schedule?.enabled
      ? nextWeekdayDate(releaseAt, Number(input.weekly_schedule.confirmation_day_of_week),
        input.weekly_schedule.confirmation_time, input.weekly_schedule.timezone || timezone)
      : new Date(NaN);

  if (input.send_immediately) {
    if (Number.isNaN(closeAt.getTime()) || closeAt <= releaseAt) {
      closeAt = new Date(releaseAt.getTime() + 15 * 60 * 1000);
    }
    const allowsTestConfirmationBeforeClose = Boolean(input.is_test && input.confirmation_at);
    if (!allowsTestConfirmationBeforeClose && (Number.isNaN(confirmationAt.getTime()) || confirmationAt <= closeAt)) {
      confirmationAt = new Date(closeAt.getTime() + 5 * 60 * 1000);
    }
  }

  if (Number.isNaN(closeAt.getTime()) || closeAt <= releaseAt) throw new Error('Closing time must be after release time');
  if (Number.isNaN(confirmationAt.getTime()) || confirmationAt < releaseAt) {
    throw new Error('Confirmation time must be at or after release time');
  }
  return { releaseAt, closeAt, confirmationAt, source, timezone };
}

module.exports = { resolvePollSchedule, zonedDateTimeToUtc, nextWeekdayDate, parseDateTime };
