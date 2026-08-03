const { buildManagedConfirmationMessage } = require('./pollBuilder');
const { eventDatesForReleaseDate, managedTimingForEvent } = require('./scheduleRules');
const { zonedDateTimeToUtc } = require('./scheduleResolver');

const SERVICE_LABELS = { WHCL: 'Wheelchair', PSA: 'PSA', PRIMARY: 'General' };
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function localDateAt(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function weekday(dateText) {
  return new Date(`${dateText}T00:00:00Z`).getUTCDay();
}

function releaseDueToday(now, releaseDay, releaseTime, timeZone) {
  const localToday = localDateAt(now, timeZone);
  if (weekday(localToday) !== Number(releaseDay)) return null;
  const releaseAt = zonedDateTimeToUtc(localToday, releaseTime, timeZone);
  return releaseAt <= now ? { releaseDate: localToday, releaseAt } : null;
}

function normalizeShifts(shifts) {
  return (Array.isArray(shifts) ? shifts : []).map((shift) => ({
    label: shift.label,
    start_time: String(shift.start_time || '').slice(0, 5),
    end_time: String(shift.end_time || '').slice(0, 5),
    capacity: Number(shift.capacity),
  })).filter((shift) => shift.label && /^\d{2}:\d{2}$/.test(shift.start_time) &&
    /^\d{2}:\d{2}$/.test(shift.end_time) && Number.isInteger(shift.capacity) && shift.capacity >= 0);
}

function pollTextForEvent({ groupName, eventDate, shifts }) {
  const d = new Date(`${eventDate}T00:00:00`);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const datePrefix = `${days[d.getDay()]}, ${d.getDate()}${months[d.getMonth()]}${String(d.getFullYear()).slice(-2)}`;
  const shiftSummaries = shifts.map((shift) => {
    const unit = shift.capacity === 1 ? 'slot' : 'slots';
    return `${shift.capacity} ${unit} for ${shift.label}`;
  });
  return {
    title: `${groupName} - ${datePrefix} Slots`,
    question: `${datePrefix} - ${shiftSummaries.join(', ')}`,
  };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (char) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char])
  );
}

function managedMention(voter) {
  if (voter.telegram_username && /^[A-Za-z0-9_]{5,32}$/.test(voter.telegram_username)) {
    return `@${escapeHtml(voter.telegram_username)}`;
  }
  const name = voter.display_name || 'Unknown user';
  const nameWithAt = name.startsWith('@') ? name : `@${name}`;
  if (voter.telegram_user_id) {
    return `<a href="tg://user?id=${escapeHtml(voter.telegram_user_id)}">${escapeHtml(nameWithAt)}</a>`;
  }
  return escapeHtml(nameWithAt);
}

function formatEventDate(eventDate) {
  const date = new Date(`${eventDate}T00:00:00`);
  return `${DAY_NAMES[date.getDay()]} ${date.getDate()} ${MONTH_NAMES[date.getMonth()]}`;
}

function buildPsaBatchConfirmationMessage(items, { header = 'Confirmed slots', footer = 'take note pls' } = {}) {
  const sorted = [...items].sort((a, b) => String(a.eventDate).localeCompare(String(b.eventDate)));
  const lines = [
    '<b>PSA</b>',
    `<b>${escapeHtml(header || 'Confirmed slots')}</b>`,
    '',
  ];

  for (const item of sorted) {
    lines.push(`<b>${escapeHtml(formatEventDate(item.eventDate))}</b>`);
    const shifts = new Map();
    for (const row of item.allocations) {
      if (!shifts.has(row.shift_id)) {
        shifts.set(row.shift_id, { label: row.label, confirmed: [] });
      }
      if (row.status === 'confirmed') shifts.get(row.shift_id).confirmed.push(row);
    }
    let dateHasConfirmed = false;
    for (const shift of shifts.values()) {
      if (!shift.confirmed.length) continue;
      dateHasConfirmed = true;
      lines.push(`${escapeHtml(shift.label)}hrs ${shift.confirmed.map(managedMention).join(' ')}`);
    }
    if (!dateHasConfirmed) lines.push('No confirmed slots');
    lines.push('');
  }

  if (footer) lines.push(escapeHtml(footer));
  return lines.join('\n').trim();
}

function pollEventDateKey(poll) {
  if (poll.event_date) return String(poll.event_date).slice(0, 10);
  const match = /^([A-Za-z]{3}),\s+(\d{1,2})([A-Za-z]{3})(\d{2})\b/.exec(poll.poll_question || '');
  if (!match) return '9999-12-31';
  const monthIndex = MONTH_NAMES.findIndex((month) => month.toLowerCase() === match[3].toLowerCase());
  if (monthIndex === -1) return '9999-12-31';
  return `20${match[4]}-${String(monthIndex + 1).padStart(2, '0')}-${String(match[2]).padStart(2, '0')}`;
}

function sortClaimedPollsForSending(polls) {
  return [...polls].sort((a, b) =>
    pollEventDateKey(a).localeCompare(pollEventDateKey(b)) ||
    String(a.resolved_release_at || '').localeCompare(String(b.resolved_release_at || '')) ||
    String(a.service || '').localeCompare(String(b.service || '')) ||
    String(a.id || '').localeCompare(String(b.id || ''))
  );
}

async function generateScheduledPollsFromTemplates(db, now = new Date()) {
  if (!db.listManagedWeeklySchedules || !db.createScheduledEvent) return [];
  const created = [];
  const schedules = await db.listManagedWeeklySchedules();
  for (const schedule of schedules) {
    if (!schedule.enabled) continue;
    const shifts = normalizeShifts(schedule.shifts);
    if (!shifts.length) continue;
    const service = schedule.service || schedule.bot_id || 'WHCL';
    const timezone = schedule.timezone || 'Asia/Singapore';
    const releaseTime = String(schedule.poll_release_time || '17:00').slice(0, 5);
    const dueRelease = releaseDueToday(
      now,
      schedule.poll_release_day_of_week,
      releaseTime,
      timezone
    );
    if (!dueRelease) continue;
    const { releaseDate } = dueRelease;

    for (const eventDate of eventDatesForReleaseDate(service, releaseDate)) {
      const excluded = db.isPollDateExcluded &&
        await db.isPollDateExcluded(schedule.telegram_group_id, eventDate);
      if (excluded) continue;
      const existing = db.getActivePollForDate &&
        await db.getActivePollForDate(schedule.telegram_group_id, eventDate);
      if (existing) continue;

      const timing = managedTimingForEvent({
        service,
        eventDate,
        releaseDate,
        releaseDay: schedule.poll_release_day_of_week,
        releaseTime,
        confirmationDay: schedule.confirmation_day_of_week,
        confirmationTime: String(schedule.confirmation_time || '').slice(0, 5),
      });
      const { title, question } = pollTextForEvent({
        groupName: schedule.group_name || 'GTRSG',
        eventDate,
        shifts,
      });
      const payload = {
        telegram_group_id: schedule.telegram_group_id,
        weekly_schedule_id: schedule.id,
        event_date: eventDate,
        title,
        poll_title: title,
        poll_question: question,
        specific_release_at: timing.releaseAt,
        close_at: zonedDateTimeToUtc(timing.closeAt.slice(0, 10), timing.closeAt.slice(11, 16), timezone).toISOString(),
        resolved_release_at: zonedDateTimeToUtc(timing.releaseAt.slice(0, 10), timing.releaseAt.slice(11, 16), timezone).toISOString(),
        resolved_confirmation_at: zonedDateTimeToUtc(timing.confirmationAt.slice(0, 10), timing.confirmationAt.slice(11, 16), timezone).toISOString(),
        timezone,
        confirmation_header: 'Confirmed slots',
        confirmation_footer: 'take note pls',
        show_waiting_list: false,
        show_empty_shifts: false,
        is_custom: false,
        operational_tags: [],
        shifts,
      };
      const id = await db.createScheduledEvent(payload, null);
      created.push({ id, telegram_group_id: schedule.telegram_group_id, event_date: eventDate });
    }
  }
  return created;
}

async function runScheduledPolls(db, telegram, limit = 10) {
  if (!db.claimDuePolls) return [];
  await generateScheduledPollsFromTemplates(db);
  const completed = [];
  for (const poll of sortClaimedPollsForSending(await db.claimDuePolls(limit))) {
    try {
      const result = await telegram.sendPoll(poll.service, poll.telegram_chat_id,
        poll.poll_question, poll.poll_options);
      if (!await db.completePollSend(poll.id, poll.claim_token, result.poll_id, result.message_id)) {
        throw new Error('Poll claim was no longer valid after Telegram send');
      }
      completed.push(poll.id);
    } catch (error) {
      await db.failPollSend(poll.id, poll.claim_token, error.message);
    }
  }
  return completed;
}

async function sendSingleConfirmation(db, telegram, confirmation) {
  const allocations = await db.getAllocation(confirmation.event_id);
  const eventDate = db.getEventDate ? await db.getEventDate(confirmation.event_id) : null;
  const html = buildManagedConfirmationMessage(allocations, {
    header: confirmation.header_text,
    footer: confirmation.footer_text,
    // Product rule: the confirmation tags only confirmed people, never the
    // waiting list (forced off regardless of the stored flag).
    showWaitingList: false,
    showEmptyShifts: false,
    eventDate,
    serviceLabel: SERVICE_LABELS[confirmation.service] || confirmation.service,
  });
  let messageId = confirmation.telegram_message_id;
  let wasEdit = false;
  if (messageId) {
    try {
      await telegram.editMessage(confirmation.service, confirmation.telegram_chat_id, messageId, html);
      wasEdit = true;
    } catch {
      const message = await telegram.sendMessage(confirmation.service,
        confirmation.telegram_chat_id, `<b>Updated confirmation</b>\n\n${html}`);
      messageId = message.message_id;
    }
  } else {
    const message = await telegram.sendMessage(confirmation.service,
      confirmation.telegram_chat_id, html);
    messageId = message.message_id;
  }
  if (!await db.completeConfirmationSend(confirmation.id, confirmation.claim_token,
    messageId, html, wasEdit)) throw new Error('Confirmation claim is no longer valid');
  return confirmation.id;
}

async function sendPsaBatchConfirmation(db, telegram, confirmations) {
  const items = [];
  for (const confirmation of confirmations) {
    items.push({
      confirmation,
      eventDate: db.getEventDate ? await db.getEventDate(confirmation.event_id) : null,
      allocations: await db.getAllocation(confirmation.event_id),
    });
  }
  const html = buildPsaBatchConfirmationMessage(items, {
    header: confirmations[0]?.header_text || 'Confirmed slots',
    footer: confirmations[0]?.footer_text || 'take note pls',
  });
  const message = await telegram.sendMessage(confirmations[0].service, confirmations[0].telegram_chat_id, html);
  const completed = [];
  for (const confirmation of confirmations) {
    if (!await db.completeConfirmationSend(confirmation.id, confirmation.claim_token,
      message.message_id, html, false)) {
      throw new Error('Confirmation claim is no longer valid');
    }
    completed.push(confirmation.id);
  }
  return completed;
}

function psaBatchKey(confirmation) {
  return [
    confirmation.service,
    confirmation.telegram_chat_id,
    confirmation.resolved_send_at || '',
    confirmation.header_text || '',
    confirmation.footer_text || '',
  ].join('|');
}

async function runScheduledConfirmations(db, telegram, limit = 50) {
  if (!db.claimDueConfirmations) return [];
  const completed = [];
  const confirmations = await db.claimDueConfirmations(limit);
  const psaGroups = new Map();
  const singles = [];
  for (const confirmation of confirmations) {
    if (confirmation.service === 'PSA') {
      const key = psaBatchKey(confirmation);
      if (!psaGroups.has(key)) psaGroups.set(key, []);
      psaGroups.get(key).push(confirmation);
    } else {
      singles.push(confirmation);
    }
  }

  for (const confirmation of singles) {
    try {
      completed.push(await sendSingleConfirmation(db, telegram, confirmation));
    } catch (error) {
      await db.failConfirmationSend(confirmation.id, confirmation.claim_token, error.message);
    }
  }

  for (const confirmations of psaGroups.values()) {
    try {
      completed.push(...await sendPsaBatchConfirmation(db, telegram, confirmations));
    } catch (error) {
      for (const confirmation of confirmations) {
        await db.failConfirmationSend(confirmation.id, confirmation.claim_token, error.message);
      }
    }
  }
  return completed;
}

async function runScheduledClosures(db, telegram, limit = 10) {
  if (!db.claimDuePollClosures) return [];
  const completed = [];
  for (const poll of await db.claimDuePollClosures(limit)) {
    try {
      await telegram.stopPoll(poll.service, poll.telegram_chat_id, poll.telegram_message_id);
      await db.completePollClose(poll.id, poll.claim_token);
      completed.push(poll.id);
    } catch (error) {
      await db.completePollClose(poll.id, poll.claim_token, error.message);
    }
  }
  return completed;
}

async function sendScheduledPollImmediately(db, telegram, pollId) {
  if (!db.claimSpecificPoll) return null;
  const poll = await db.claimSpecificPoll(pollId);
  if (!poll) return null;
  try {
    const result = await telegram.sendPoll(poll.service, poll.telegram_chat_id,
      poll.poll_question, poll.poll_options);
    if (!await db.completePollSend(poll.id, poll.claim_token, result.poll_id, result.message_id)) {
      throw new Error('Poll claim was no longer valid after Telegram send');
    }
    return { success: true };
  } catch (error) {
    await db.failPollSend(poll.id, poll.claim_token, error.message);
    throw error;
  }
}

async function sendScheduledConfirmationImmediately(db, telegram, pollId) {
  if (!db.claimSpecificConfirmation) return null;
  const originalClaimDueConfirmations = db.claimDueConfirmations;
  db.claimDueConfirmations = async () => {
    if (db.claimSpecificConfirmationBatch) {
      const confirmations = await db.claimSpecificConfirmationBatch(pollId);
      if (confirmations?.length) return confirmations;
    }
    const confirmation = await db.claimSpecificConfirmation(pollId);
    return confirmation ? [confirmation] : [];
  };
  try {
    const completed = await runScheduledConfirmations(db, telegram, 1);
    return completed.length ? { success: true, confirmations: completed.length } : null;
  } finally {
    db.claimDueConfirmations = originalClaimDueConfirmations;
  }
}

module.exports = {
  runScheduledPolls,
  runScheduledConfirmations,
  runScheduledClosures,
  sendScheduledPollImmediately,
  sendScheduledConfirmationImmediately,
  generateScheduledPollsFromTemplates,
};
