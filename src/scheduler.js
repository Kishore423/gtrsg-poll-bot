const { buildPollsFromSlots, buildConfirmationMessage } = require('./pollBuilder');
const { buildConfirmationState } = require('./confirmation');
const {
  DEFAULT_RELEASE_DAY,
  DEFAULT_RELEASE_TIME,
  nextWeekRange,
  releaseRangeForService,
} = require('./scheduleRules');

// Weekly send defaults: Wednesday 17:00 Singapore time. Wheelchair covers the
// Every legacy release is limited to the following Monday-Sunday week.
const DEFAULT_SEND_DAY = DEFAULT_RELEASE_DAY;
const DEFAULT_SEND_TIME = DEFAULT_RELEASE_TIME;
const SCHEDULE_SERVICES = ['WHCL', 'PSA'];

// Sends one Telegram poll per date+service for unsent slots, routing each to the
// group its service's bot was added to (db target). Idempotent: already-sent
// rows are excluded and marked sent after sending.
// filters: { labelService, slotDate, dateRange, service }
async function sendDuePolls(db, telegram, { labelService = false, slotDate, dateRange, service } = {}) {
  let rows = await db.listUnsentSlots();
  if (slotDate) rows = rows.filter((r) => r.slot_date === slotDate);
  if (dateRange) rows = rows.filter((r) => r.slot_date >= dateRange.start && r.slot_date <= dateRange.end);
  if (service) rows = rows.filter((r) => (r.service || 'WHCL') === service);

  const polls = buildPollsFromSlots(rows, { labelService });
  const sent = [];
  for (const poll of polls) {
    const target = await db.getTarget(poll.service);
    if (!target) {
      console.warn(
        `No Telegram group linked for service ${poll.service} - add that bot to its group first. ` +
          `Skipping "${poll.question}".`
      );
      continue;
    }
    const { poll_id, message_id } = await telegram.sendPoll(
      poll.service,
      target.chat_id,
      poll.question,
      poll.options
    );
    await db.insertPoll({
      slot_date: poll.slot_date,
      service: poll.service,
      question: poll.question,
      provider_poll_id: poll_id,
      group_chat_id: target.chat_id,
      options: poll.options,
      capacities: poll.capacities,
    });
    await db.markSlotsSent(poll.rowIds);
    sent.push({ ...poll, message_id });
  }
  return sent;
}

// Per-service weekly settings, with defaults.
async function getWeeklySendSettings(db, service) {
  const day = Number((await db.getSetting(`poll_send_day_${service}`)) ?? DEFAULT_SEND_DAY);
  const time = (await db.getSetting(`poll_send_time_${service}`)) || DEFAULT_SEND_TIME;
  return { service, day, time };
}

async function getAllWeeklySchedules(db) {
  const out = [];
  for (const service of SCHEDULE_SERVICES) out.push(await getWeeklySendSettings(db, service));
  return out;
}

// Called by the weekly Vercel cron. Sends next week's polls for every service
// whose configured send day matches `now` (Singapore weekday). Idempotent.
async function runWeeklySend(db, telegram, options = {}, now = new Date()) {
  const sgtWeekday = Number(
    new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Singapore', weekday: 'short' })
      .format(now)
      .replace(/Sun|Mon|Tue|Wed|Thu|Fri|Sat/, (d) =>
        ({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[d])
      )
  );
  const sent = [];
  for (const service of SCHEDULE_SERVICES) {
    const { day } = await getWeeklySendSettings(db, service);
    if (day !== sgtWeekday) continue;
    const range = releaseRangeForService(service, now);
    const polls = await sendDuePolls(db, telegram, { ...options, service, dateRange: range });
    sent.push(...polls);
  }
  return sent;
}

// Called by the daily Vercel cron (and safe to call anytime). Sends the
// confirmation for every unconfirmed poll whose 08:00 day-before deadline has
// passed, taking the first `capacity` voters per option - filled or not.
async function sendDueConfirmations(db, telegram, options = {}, now = new Date()) {
  const sent = [];
  for (const poll of await db.listPolls()) {
    if (poll.confirmed_at) continue;
    const votes = await db.getVotesForPoll(poll.id);
    const confirmation = buildConfirmationState(poll, votes, {
      now,
      confirmationHour: options.confirmationHour,
      timezoneOffset: options.confirmationTimezoneOffset,
    });
    if (!confirmation.windowOpen || confirmation.shiftStarted) continue;

    const { html } = buildConfirmationMessage(poll.slot_date, confirmation.assignments);
    await telegram.sendMessage(poll.service, poll.group_chat_id, html);
    await db.markPollConfirmed(poll.id);
    sent.push(poll);
    console.log(`Day-before confirmation sent for poll ${poll.id} (${poll.question})`);
  }
  return sent;
}

module.exports = {
  sendDuePolls,
  nextWeekRange,
  getWeeklySendSettings,
  getAllWeeklySchedules,
  runWeeklySend,
  sendDueConfirmations,
  DEFAULT_SEND_DAY,
  DEFAULT_SEND_TIME,
  SCHEDULE_SERVICES,
};
