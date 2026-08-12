const {
  buildManagedConfirmationMessage,
  managedMention,
  CONFIRMATION_NOTIFY_HANDLES,
} = require('./pollBuilder');
const { eventDatesForReleaseDate, managedTimingForEvent } = require('./scheduleRules');
const { zonedDateTimeToUtc } = require('./scheduleResolver');

const SERVICE_LABELS = { WHCL: 'Wheelchair', PSA: 'PSA', PRIMARY: 'General' };
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const REHEARSAL_TAG_PREFIX = 'rehearsal:';
const REHEARSAL_START_TAG_PREFIX = 'rehearsal-start:';
const REHEARSAL_CLEAR_TAG_PREFIX = 'rehearsal-clear:';

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

function addDays(dateText, days) {
  const value = new Date(`${dateText}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + Number(days));
  return value.toISOString().slice(0, 10);
}

function nextReleaseDateForSchedule(schedule, now = new Date()) {
  const timezone = schedule.timezone || 'Asia/Singapore';
  const today = localDateAt(now, timezone);
  const releaseDay = Number(schedule.poll_release_day_of_week);
  const releaseTime = String(schedule.poll_release_time || '17:00').slice(0, 5);
  let releaseDate = addDays(today, (releaseDay - weekday(today) + 7) % 7);
  if (zonedDateTimeToUtc(releaseDate, releaseTime, timezone) <= now) {
    releaseDate = addDays(releaseDate, 7);
  }
  return releaseDate;
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

function utcIso(localDateTime, timeZone) {
  return zonedDateTimeToUtc(
    localDateTime.slice(0, 10),
    localDateTime.slice(11, 16),
    timeZone
  ).toISOString();
}

function templatePayloadForEvent(schedule, eventDate, releaseDate = null) {
  const shifts = normalizeShifts(schedule.shifts);
  const service = schedule.service || schedule.bot_id || 'WHCL';
  const timezone = schedule.timezone || 'Asia/Singapore';
  const releaseTime = String(schedule.poll_release_time || '17:00').slice(0, 5);
  const timing = managedTimingForEvent({
    service,
    eventDate,
    releaseDate,
    gapWeeks: schedule.gap_weeks,
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
  return {
    telegram_group_id: schedule.telegram_group_id,
    weekly_schedule_id: schedule.id,
    event_date: eventDate,
    title,
    poll_title: title,
    poll_question: question,
    specific_release_at: utcIso(timing.releaseAt, timezone),
    close_at: utcIso(timing.closeAt, timezone),
    resolved_release_at: utcIso(timing.releaseAt, timezone),
    resolved_confirmation_at: utcIso(timing.confirmationAt, timezone),
    timezone,
    confirmation_header: 'Confirmed slots',
    confirmation_footer: 'take note pls',
    show_waiting_list: false,
    show_empty_shifts: false,
    is_custom: false,
    operational_tags: [],
    shifts,
  };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (char) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char])
  );
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
  lines.push(CONFIRMATION_NOTIFY_HANDLES);
  return lines.join('\n').trim();
}

function groupTelegramMessages(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.service}|${row.telegram_chat_id}`;
    if (!groups.has(key)) {
      groups.set(key, {
        service: row.service,
        telegramChatId: row.telegram_chat_id,
        pollMessageIds: new Set(),
        messageIds: new Set(),
      });
    }
    const group = groups.get(key);
    if (row.telegram_message_id) {
      group.pollMessageIds.add(Number(row.telegram_message_id));
      group.messageIds.add(Number(row.telegram_message_id));
    }
    if (row.confirmation_message_id) {
      group.messageIds.add(Number(row.confirmation_message_id));
    }
  }
  return [...groups.values()];
}

async function deleteTestMessages(telegram, rows) {
  for (const group of groupTelegramMessages(rows)) {
    for (const messageId of group.pollMessageIds) {
      try {
        await telegram.stopPoll(group.service, group.telegramChatId, messageId);
      } catch {
        // A manually deleted or already-closed poll cannot be stopped. Deleting
        // the known message IDs below remains idempotent.
      }
    }
    const ids = [...group.messageIds];
    for (let offset = 0; offset < ids.length; offset += 100) {
      if (telegram.deleteMessages) {
        await telegram.deleteMessages(
          group.service,
          group.telegramChatId,
          ids.slice(offset, offset + 100)
        );
      }
    }
  }
}

async function resetTestPollBatch(db, telegram, pollId, now = new Date()) {
  if (!db.getPollResetBatch || !db.resetPollBatchForProduction) {
    const error = new Error('Test batch reset requires the Supabase production database');
    error.statusCode = 501;
    throw error;
  }
  const rows = await db.getPollResetBatch(pollId);
  if (!rows.length) {
    const error = new Error('Poll not found');
    error.statusCode = 404;
    throw error;
  }
  if (rows.some((row) => !row.resolved_release_at || new Date(row.resolved_release_at) <= now)) {
    const error = new Error('Only polls sent early for testing can be reset. The saved production release must still be in the future.');
    error.statusCode = 409;
    throw error;
  }
  await deleteTestMessages(telegram, rows);
  await db.resetPollBatchForProduction(rows.map((row) => row.poll_id));
  const dates = rows.map((row) => String(row.event_date).slice(0, 10)).sort();
  return {
    poll_count: rows.length,
    event_start: dates[0],
    event_end: dates[dates.length - 1],
    actual_release_at: rows.map((row) => row.resolved_release_at).sort()[0],
  };
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

    for (const eventDate of eventDatesForReleaseDate(
      service,
      releaseDate,
      schedule.gap_weeks
    )) {
      const excluded = db.isPollDateExcluded &&
        await db.isPollDateExcluded(schedule.telegram_group_id, eventDate);
      if (excluded) continue;
      const existing = db.getActivePollForDate &&
        await db.getActivePollForDate(schedule.telegram_group_id, eventDate);
      if (existing) continue;

      const payload = templatePayloadForEvent(schedule, eventDate, releaseDate);
      const id = await db.createScheduledEvent(payload, null);
      created.push({ id, telegram_group_id: schedule.telegram_group_id, event_date: eventDate });
    }
  }
  return created;
}

async function runScheduledPolls(db, telegram, limit = 10) {
  if (!db.claimDuePolls) return [];
  await generateScheduledPollsFromTemplates(db);
  const completed = await runDueTemplateRehearsalStarts(db, telegram);
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

async function runDueTemplateRehearsalStarts(db, telegram) {
  if (!db.listDueTemplateRehearsalStartBatchIds || !db.listTemplateRehearsalPolls) return [];
  const completed = [];
  for (const batchId of await db.listDueTemplateRehearsalStartBatchIds()) {
    const rows = await db.listTemplateRehearsalPolls(batchId);
    rows.sort((a, b) => String(a.event_date).localeCompare(String(b.event_date)));
    for (const row of rows) {
      if (row.telegram_poll_id || !['draft', 'scheduled', 'failed'].includes(row.status)) continue;
      try {
        const result = await sendScheduledPollImmediately(db, telegram, row.poll_id);
        if (result) completed.push(row.poll_id);
      } catch (_) {
        // sendScheduledPollImmediately records the failure for the next minute retry.
      }
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
    serviceLabel: SERVICE_LABELS[confirmation.service] || '',
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

async function sendClaimedConfirmations(db, telegram, confirmations) {
  const completed = [];
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

  // Non-PSA (e.g. Wheelchair) confirmations send one Telegram message per event
  // date. Sort by event date so those per-date messages arrive earliest-first
  // instead of in database claim order, which otherwise looks jumbled — most
  // visibly when several test dates confirm together.
  const singleItems = [];
  for (const confirmation of singles) {
    singleItems.push({
      confirmation,
      eventDate: db.getEventDate ? await db.getEventDate(confirmation.event_id) : null,
    });
  }
  singleItems.sort((a, b) => String(a.eventDate || '').localeCompare(String(b.eventDate || '')));
  for (const { confirmation } of singleItems) {
    try {
      completed.push(await sendSingleConfirmation(db, telegram, confirmation));
    } catch (error) {
      await db.failConfirmationSend(confirmation.id, confirmation.claim_token, error.message);
    }
  }

  // PSA groups by resolved send time, so a test batch whose per-poll send times
  // differ can split into several messages. Order those messages by their
  // earliest event date too, so the batches themselves are not jumbled.
  const psaBatches = [];
  for (const confirmations of psaGroups.values()) {
    let earliest = null;
    for (const confirmation of confirmations) {
      const eventDate = db.getEventDate ? await db.getEventDate(confirmation.event_id) : null;
      if (eventDate && (earliest === null || String(eventDate) < earliest)) earliest = String(eventDate);
    }
    psaBatches.push({ confirmations, earliest: earliest || '' });
  }
  psaBatches.sort((a, b) => a.earliest.localeCompare(b.earliest));
  for (const { confirmations } of psaBatches) {
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

async function runScheduledConfirmations(db, telegram, limit = 50) {
  if (!db.claimDueConfirmations) return [];
  const completed = await sendClaimedConfirmations(
    db,
    telegram,
    await db.claimDueConfirmations(limit)
  );
  if (db.listDueTemplateRehearsalBatchIds && db.claimTemplateRehearsalConfirmations) {
    for (const batchId of await db.listDueTemplateRehearsalBatchIds()) {
      const result = await sendTemplateRehearsalConfirmation(db, telegram, batchId);
      if (result?.confirmation_ids) completed.push(...result.confirmation_ids);
    }
  }
  if (db.listReadyTemplateRehearsals && db.resetTemplateRehearsal) {
    await finalizeReadyTemplateRehearsals(db, telegram);
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

function rehearsalBatchIdFromTag(tag) {
  return String(tag || '').startsWith(REHEARSAL_TAG_PREFIX) &&
    !String(tag || '').startsWith(REHEARSAL_START_TAG_PREFIX) &&
    !String(tag || '').startsWith(REHEARSAL_CLEAR_TAG_PREFIX)
    ? String(tag).slice(REHEARSAL_TAG_PREFIX.length)
    : null;
}

async function resetTemplateRehearsalBatch(db, telegram, batchId, rows = null) {
  const polls = rows || await db.listTemplateRehearsalPolls(batchId);
  if (!polls.length) return null;
  await deleteTestMessages(telegram, polls);
  await db.resetTemplateRehearsal(batchId);
  return {
    batch_id: batchId,
    poll_count: polls.length,
    actual_release_at: polls.map((item) => item.resolved_release_at).filter(Boolean).sort()[0] || null,
  };
}

async function finalizeReadyTemplateRehearsals(db, telegram) {
  const rows = await db.listReadyTemplateRehearsals();
  const batches = new Map();
  for (const row of rows) {
    if (!batches.has(row.batch_id)) batches.set(row.batch_id, []);
    batches.get(row.batch_id).push(row);
  }
  const reset = [];
  for (const [batchId, polls] of batches) {
    reset.push(await resetTemplateRehearsalBatch(db, telegram, batchId, polls));
  }
  return reset.filter(Boolean);
}

async function startTemplateRehearsal(db, telegram, {
  group,
  schedule,
  startAt,
  clearAfterMinutes = 5,
  createdBy = null,
  now = new Date(),
}) {
  if (!db.prepareTemplateRehearsal || !db.listTemplateRehearsalPolls || !db.resetTemplateRehearsal) {
    const error = new Error('Template rehearsals require the Supabase production database');
    error.statusCode = 501;
    throw error;
  }
  const delay = Number(clearAfterMinutes);
  if (!Number.isInteger(delay) || delay < 1 || delay > 60) {
    const error = new RangeError('Rehearsal clear time must be between 1 and 60 minutes');
    error.statusCode = 400;
    throw error;
  }
  const rehearsalStartAt = new Date(startAt);
  if (!startAt || Number.isNaN(rehearsalStartAt.getTime()) || rehearsalStartAt <= now) {
    const error = new RangeError('Choose a rehearsal start date and time in the future');
    error.statusCode = 400;
    throw error;
  }
  const clearAt = new Date(rehearsalStartAt.getTime() + delay * 60 * 1000);
  const shifts = normalizeShifts(schedule.shifts);
  if (!shifts.length) {
    const error = new RangeError('Save at least one template shift before starting a rehearsal');
    error.statusCode = 400;
    throw error;
  }

  const scheduleWithGroup = {
    ...schedule,
    group_name: group.group_name,
    service: group.service || schedule.service,
    bot_id: group.bot_id || schedule.bot_id,
    shifts,
  };
  const releaseDate = nextReleaseDateForSchedule(scheduleWithGroup, now);
  const eventDates = eventDatesForReleaseDate(
    scheduleWithGroup.service || scheduleWithGroup.bot_id,
    releaseDate,
    schedule.gap_weeks
  );
  const plans = [];
  for (const eventDate of eventDates) {
    if (db.isPollDateExcluded && await db.isPollDateExcluded(group.id, eventDate)) continue;
    const payload = templatePayloadForEvent(scheduleWithGroup, eventDate, releaseDate);
    if (new Date(payload.resolved_release_at) <= clearAt) {
      const error = new RangeError('The rehearsal must finish before the actual production release');
      error.statusCode = 400;
      throw error;
    }
    const existing = db.getActivePollForDate && await db.getActivePollForDate(group.id, eventDate);
    if (existing) {
      const reusable = !existing.is_custom &&
        String(existing.weekly_schedule_id || '') === String(schedule.id) &&
        ['draft', 'scheduled', 'failed'].includes(existing.status) &&
        !existing.telegram_poll_id &&
        !(existing.operational_tags || []).some((tag) => rehearsalBatchIdFromTag(tag));
      if (!reusable) {
        const error = new Error(`The actual batch cannot be rehearsed because ${eventDate} already has an active or custom poll.`);
        error.statusCode = 409;
        throw error;
      }
      plans.push({ id: existing.id, eventDate, payload });
    } else {
      plans.push({ id: null, eventDate, payload });
    }
  }
  if (!plans.length) {
    const error = new Error('Every date in this batch is skipped, so there are no polls to rehearse');
    error.statusCode = 409;
    throw error;
  }

  const candidates = [];
  for (const plan of plans) {
    candidates.push({
      id: plan.id || await db.createScheduledEvent(plan.payload, createdBy),
      eventDate: plan.eventDate,
    });
  }
  const batchId = require('crypto').randomUUID();
  await db.prepareTemplateRehearsal({
    batchId,
    pollIds: candidates.map((item) => item.id),
    startAt: rehearsalStartAt.toISOString(),
    clearAt: clearAt.toISOString(),
  });
  return {
    batch_id: batchId,
    poll_count: candidates.length,
    event_start: candidates[0].eventDate,
    event_end: candidates[candidates.length - 1].eventDate,
    start_at: rehearsalStartAt.toISOString(),
    clear_at: clearAt.toISOString(),
    actual_release_at: templatePayloadForEvent(
      scheduleWithGroup,
      candidates[0].eventDate,
      releaseDate
    ).resolved_release_at,
  };
}

async function sendTemplateRehearsalConfirmation(db, telegram, batchId) {
  const rows = await db.listTemplateRehearsalPolls(batchId);
  if (!rows.length) return null;
  const clearAt = rows[0].clear_at && new Date(rows[0].clear_at);
  if (!clearAt || Number.isNaN(clearAt.getTime()) || clearAt > new Date()) {
    return null;
  }
  const claimed = await db.claimTemplateRehearsalConfirmations(batchId);
  const confirmationIds = await sendClaimedConfirmations(db, telegram, claimed);
  const resets = await finalizeReadyTemplateRehearsals(db, telegram);
  const reset = resets.find((item) => item.batch_id === batchId);
  return confirmationIds.length || reset ? {
    success: true,
    confirmations: confirmationIds.length,
    confirmation_ids: confirmationIds,
    reset: Boolean(reset),
  } : null;
}

module.exports = {
  runScheduledPolls,
  runScheduledConfirmations,
  runScheduledClosures,
  sendScheduledPollImmediately,
  sendScheduledConfirmationImmediately,
  generateScheduledPollsFromTemplates,
  startTemplateRehearsal,
  sendTemplateRehearsalConfirmation,
  finalizeReadyTemplateRehearsals,
  resetTemplateRehearsalBatch,
  resetTestPollBatch,
  deleteTestMessages,
  templatePayloadForEvent,
};
