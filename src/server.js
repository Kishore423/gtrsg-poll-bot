const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const { requireUser, requireAdmin } = require('./auth');
const {
  sendDuePolls,
  getWeeklySendSettings,
  getAllWeeklySchedules,
  runWeeklySend,
  sendDueConfirmations,
} = require('./scheduler');
const { buildConfirmationMessage, NOT_AVAILABLE_OPTION } = require('./pollBuilder');
const { buildConfirmationState } = require('./confirmation');
const { processTelegramUpdate } = require('./processUpdate');
const { resolvePollSchedule } = require('./scheduleResolver');
const { managedTimingForEvent } = require('./scheduleRules');
const { runScheduledPolls, runScheduledConfirmations, runScheduledClosures } = require('./productionScheduler');
const { scopeGroups, assertGroupAccess, filterRowsByUserBot } = require('./tenancy');

const SERVICES = ['PRIMARY', 'WHCL', 'PSA'];
const ROUTED_SERVICES = ['WHCL', 'PSA'];

function isValidTime(value) {
  return typeof value === 'string' && /^\d{2}:?\d{2}$/.test(value);
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function resolveTelegramGroupService(group, fallback = 'PRIMARY') {
  if (ROUTED_SERVICES.includes(group?.service)) return group.service;
  if (ROUTED_SERVICES.includes(group?.bot_id)) return group.bot_id;
  return group?.bot_id || group?.service || fallback;
}

// db: repository (memory or postgres). telegram: Telegram client.
// options: { labelService, confirmationHour, confirmationTimezoneOffset,
//            webUsername, webPassword, telegramWebhookSecret, cronSecret }
function createServer(db, telegram, options = {}) {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // Serve index.html for the root path. express.static handles /index.html and
  // /app.js fine by name, but may not auto-index bare / in Vercel serverless.
  // Read the file at startup (module load) so path resolution is reliable.
  const indexHtmlPath = path.join(__dirname, '..', 'public', 'index.html');
  const indexHtml = fs.existsSync(indexHtmlPath)
    ? fs.readFileSync(indexHtmlPath, 'utf8')
    : null;
  app.get('/', (req, res) => {
    if (indexHtml) return res.type('html').send(indexHtml);
    res.redirect('/index.html');
  });

  app.get('/api/auth-config', (req, res) => {
    res.json({ required: !!options.requireAdminAuth, legacyEnabled: options.enableLegacyWorkflow !== false,
      demoPreview: !!options.demoPreview });
  });

  // Password sign-in is retired: the browser completes Microsoft SSO directly with
  // Supabase (signInWithOAuth) and sends the resulting access token as a Bearer.

  app.post('/api/auth/refresh', async (req, res) => {
    if (!options.requireAdminAuth) return res.json({ disabled: true });
    try {
      const session = await options.refreshSession(req.body?.refresh_token);
      res.json({ access_token: session.access_token, refresh_token: session.refresh_token,
        expires_at: session.expires_at });
    } catch {
      res.status(401).json({ error: 'Session expired' });
    }
  });

  // Tells the caller who they are, so the UI can scope itself and decide whether to
  // show the Admin link. Unprovisioned callers get the 403 from requireUser.
  app.get('/api/me', requireUser(options.verifyUser || (async () => null)), (req, res) => {
    res.json({ email: req.appUser.email, role: req.appUser.role, bot_id: req.appUser.bot_id });
  });

  if (options.requireAdminAuth) {
    const protect = requireUser(options.verifyUser);
    const protectAdmin = requireAdmin(options.verifyUser);
    app.use((req, res, next) => {
      if (!req.path.startsWith('/api/') || req.path.startsWith('/api/auth/') ||
          req.path.startsWith('/api/telegram/') || req.path.startsWith('/api/cron/')) return next();
      // Admin routes need the stricter gate; everything else just needs a
      // provisioned user. Both fail closed.
      if (req.path.startsWith('/api/admin/')) return protectAdmin(req, res, next);
      return protect(req, res, next);
    });
  }

  const wrap = (fn) => (req, res) => fn(req, res).catch((err) => {
    console.error(`${req.method} ${req.path} failed:`, err);
    if (!res.headersSent) res.status(err.statusCode || 500).json({
      error: err.statusCode ? err.message : 'Server error. Check logs.',
    });
  });

  // ---- Slots ----------------------------------------------------------------
  app.get('/api/slots', wrap(async (req, res) => {
    if (options.enableLegacyWorkflow === false) return res.status(410).json({ error: 'Legacy workflow is disabled' });
    res.json(await db.listUpcomingSlots());
  }));

  app.post('/api/slots', wrap(async (req, res) => {
    if (options.enableLegacyWorkflow === false) return res.status(410).json({ error: 'Legacy workflow is disabled' });
    const { slot_date, time_start, time_end, slot_count, service } = req.body || {};
    if (typeof slot_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(slot_date)) {
      return res.status(400).json({ error: 'slot_date must be an ISO date string (YYYY-MM-DD)' });
    }
    if (!isValidTime(time_start) || !isValidTime(time_end)) {
      return res.status(400).json({ error: 'time_start and time_end must be HHMM or HH:MM' });
    }
    const count = Number(slot_count);
    if (!Number.isInteger(count) || count < 1) {
      return res.status(400).json({ error: 'slot_count must be a positive integer' });
    }
    if (service !== undefined && !['WHCL', 'PSA'].includes(service)) {
      return res.status(400).json({ error: 'service must be WHCL or PSA' });
    }
    const id = await db.insertSlot({
      slot_date,
      time_start: time_start.replace(':', ''),
      time_end: time_end.replace(':', ''),
      slot_count: count,
      service: service || 'WHCL',
    });
    res.status(201).json({ id });
  }));

  app.delete('/api/slots/:id', wrap(async (req, res) => {
    if (options.enableLegacyWorkflow === false) return res.status(410).json({ error: 'Legacy workflow is disabled' });
    await db.deleteSlot(Number(req.params.id));
    res.status(204).end();
  }));

  // ---- Polls & results ------------------------------------------------------
  app.get('/api/polls', wrap(async (req, res) => {
    if (options.enableLegacyWorkflow === false) return res.status(410).json({ error: 'Legacy workflow is disabled' });
    const polls = await db.listPolls();
    const out = [];
    for (const poll of polls) {
      const capacities = poll.capacities || {};
      const votes = await db.getVotesForPoll(poll.id);
      const confirmation = buildConfirmationState(poll, votes, {
        confirmationHour: options.confirmationHour,
        timezoneOffset: options.confirmationTimezoneOffset,
      });

      const byOption = new Map();
      for (const name of Object.keys(capacities)) {
        if (name !== NOT_AVAILABLE_OPTION) byOption.set(name, []);
      }
      for (const v of votes) {
        if (v.option_name === NOT_AVAILABLE_OPTION) continue;
        if (!byOption.has(v.option_name)) byOption.set(v.option_name, []);
        byOption.get(v.option_name).push({ id: v.voter_id, name: v.display_name || v.voter_id });
      }

      out.push({
        id: poll.id,
        slot_date: poll.slot_date,
        service: poll.service,
        question: poll.question,
        confirmed_at: poll.confirmed_at,
        filled_slots: confirmation.filledSlots,
        total_slots: confirmation.totalSlots,
        confirmation_window_open: confirmation.windowOpen,
        shift_started: confirmation.shiftStarted,
        can_confirm: confirmation.canConfirm,
        options: [...byOption.entries()].map(([name, voters]) => ({
          name,
          capacity: capacities[name] ?? null,
          voters,
        })),
      });
    }
    res.json(out);
  }));

  // Sends the first-come list now (partial allowed). Server derives the winners.
  app.post('/api/polls/:id/confirm', wrap(async (req, res) => {
    if (options.enableLegacyWorkflow === false) return res.status(410).json({ error: 'Legacy workflow is disabled' });
    const poll = await db.getPollById(Number(req.params.id));
    if (!poll) return res.status(404).json({ error: 'Poll not found' });
    const confirmation = buildConfirmationState(poll, await db.getVotesForPoll(poll.id), {
      confirmationHour: options.confirmationHour,
      timezoneOffset: options.confirmationTimezoneOffset,
    });
    if (confirmation.assignments.length === 0) {
      return res.status(400).json({ error: 'poll has no confirmable slot options' });
    }
    if (confirmation.shiftStarted) {
      return res.status(409).json({ error: 'the earliest shift has already started' });
    }
    const { html } = buildConfirmationMessage(poll.slot_date, confirmation.assignments);
    await telegram.sendMessage(poll.service, poll.group_chat_id, html);
    await db.markPollConfirmed(poll.id);
    res.json({ sent: true });
  }));

  // Manual send. Body { slot_date?, service? } narrows it.
  app.post('/api/trigger-now', wrap(async (req, res) => {
    if (options.enableLegacyWorkflow === false) return res.status(410).json({ error: 'Legacy workflow is disabled' });
    const { slot_date, service } = req.body || {};
    if (slot_date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(slot_date))) {
      return res.status(400).json({ error: 'slot_date must be an ISO date string (YYYY-MM-DD)' });
    }
    if (service !== undefined && !['WHCL', 'PSA'].includes(service)) {
      return res.status(400).json({ error: 'service must be WHCL or PSA' });
    }
    const polls = await sendDuePolls(db, telegram, { ...options, slotDate: slot_date, service });
    res.json({ sent: polls.length, polls: polls.map((p) => ({ service: p.service, question: p.question })) });
  }));

  // ---- Weekly schedule ------------------------------------------------------
  app.get('/api/schedule', wrap(async (req, res) => {
    if (options.enableLegacyWorkflow === false) return res.status(410).json({ error: 'Legacy workflow is disabled' });
    res.json(await getAllWeeklySchedules(db));
  }));

  app.put('/api/schedule', wrap(async (req, res) => {
    if (options.enableLegacyWorkflow === false) return res.status(410).json({ error: 'Legacy workflow is disabled' });
    const { service, day, time } = req.body || {};
    if (!['WHCL', 'PSA'].includes(service)) {
      return res.status(400).json({ error: 'service must be WHCL or PSA' });
    }
    const dayNum = Number(day);
    if (!Number.isInteger(dayNum) || dayNum < 0 || dayNum > 6) {
      return res.status(400).json({ error: 'day must be 0 (Sunday) through 6 (Saturday)' });
    }
    if (typeof time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
      return res.status(400).json({ error: 'time must be HH:MM (24-hour)' });
    }
    await db.setSetting(`poll_send_day_${service}`, dayNum);
    await db.setSetting(`poll_send_time_${service}`, time);
    res.json(await getWeeklySendSettings(db, service));
  }));

  // ---- Targets (which group each bot is linked to) --------------------------
  app.get('/api/targets', wrap(async (req, res) => {
    if (options.enableLegacyWorkflow === false) return res.status(410).json({ error: 'Legacy workflow is disabled' });
    res.json(await db.listTargets());
  }));

  app.get('/api/scheduled-polls', wrap(async (req, res) => {
    const rows = db.listScheduledPolls ? await db.listScheduledPolls() : [];
    res.json(filterRowsByUserBot(rows, req.appUser));
  }));

  const requireClearPollsPassword = (req, res) => {
    if (!options.clearPollsPassword) return true;
    const supplied = String(req.body?.clear_password || '');
    if (supplied === String(options.clearPollsPassword)) return true;
    res.status(403).json({ error: 'Clear polls password is incorrect' });
    return false;
  };

  app.delete('/api/scheduled-polls', wrap(async (req, res) => {
    if (!db.deleteAllScheduledPolls) return res.status(501).json({ error: 'Supabase production database is required' });
    if (!requireClearPollsPassword(req, res)) return;
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : null;
    if (req.appUser && req.appUser.role !== 'admin' && !ids) {
      return res.status(403).json({ error: 'Admin access required to clear all scheduled polls' });
    }
    if (ids) {
      const uniqueIds = [...new Set(ids.map((id) => String(id)))];
      if (uniqueIds.length === 0 || uniqueIds.some((id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))) {
        return res.status(400).json({ error: 'Valid poll IDs are required' });
      }
      if (!db.deleteScheduledPollsByIds) return res.status(501).json({ error: 'Supabase production database is required' });
      if (req.appUser && req.appUser.role !== 'admin') {
        if (!db.getScheduledPollDetails) return res.status(501).json({ error: 'Supabase production database is required' });
        for (const id of uniqueIds) {
          const details = await db.getScheduledPollDetails(id);
          if (!details) return res.status(404).json({ error: 'Poll not found' });
          await assertGroupAccess(db, req.appUser, details.poll.telegram_group_id);
        }
      }
      const rows = await db.deleteScheduledPollsByIds(uniqueIds);
      return res.json({ deleted: rows.length, ids: rows.map((row) => row.id) });
    }
    const rows = await db.deleteAllScheduledPolls();
    res.json({ deleted: rows.length, ids: rows.map((row) => row.id) });
  }));

  app.get('/api/telegram-groups', wrap(async (req, res) => {
    res.json(db.listTelegramGroups ? await db.listTelegramGroups(scopeGroups(req.appUser)) : []);
  }));

  app.post('/api/telegram-groups', wrap(async (req, res) => {
    if (!db.createTelegramGroup) return res.status(501).json({ error: 'Supabase production database is required' });
    const { telegram_chat_id, group_name, service, bot_id } = req.body || {};
    if (!/^-?\d+$/.test(String(telegram_chat_id)) || typeof group_name !== 'string' || !group_name.trim()) {
      return res.status(400).json({ error: 'A Telegram chat ID and group name are required' });
    }
    if (service && !['WHCL', 'PSA'].includes(service)) return res.status(400).json({ error: 'Invalid service' });
    const resolvedBotId = req.appUser && req.appUser.role !== 'admin'
      ? req.appUser.bot_id
      : bot_id || service || 'PRIMARY';
    if (!resolvedBotId) return res.status(403).json({ error: 'Your account does not have a bot assigned' });
    const id = await db.createTelegramGroup({ telegram_chat_id, group_name: group_name.trim(), service, bot_id: resolvedBotId });
    res.status(201).json({ id });
  }));

  app.delete('/api/telegram-groups/:id', wrap(async (req, res) => {
    if (!db.deleteTelegramGroup) return res.status(501).json({ error: 'Supabase production database is required' });
    await assertGroupAccess(db, req.appUser, req.params.id);
    await db.deleteTelegramGroup(req.params.id);
    res.status(204).end();
  }));

  app.post('/api/telegram-groups/:id/verify', wrap(async (req, res) => {
    const group = await assertGroupAccess(db, req.appUser, req.params.id);
    const service = resolveTelegramGroupService(group);
    let me;
    let membership;
    try {
      me = await telegram.getMe(service);
      membership = await telegram.call(service, 'getChatMember', {
        chat_id: group.telegram_chat_id, user_id: me.id,
      });
    } catch (error) {
      return res.status(502).json({
        error: `Could not verify ${service} bot for this group: ${error.message}`,
        service,
      });
    }
    const present = !['left', 'kicked'].includes(membership.status);
    const can_post_messages = membership.can_post_messages ?? ['creator', 'administrator', 'member'].includes(membership.status);
    if (present && can_post_messages) {
      try {
        await telegram.sendMessage(service, group.telegram_chat_id,
          `🤖 <b>Bot Verification Successful</b>\n\nThis bot (service: <b>${service}</b>) is successfully linked and has posting permissions in this group.`);
      } catch (err) {
        console.error(`Verification message failed for ${group.group_name}:`, err.message);
      }
    }
    res.json({ present, status: membership.status, can_post_messages });
  }));

  app.get('/api/weekly-schedules', wrap(async (req, res) => {
    const rows = db.listManagedWeeklySchedules ? await db.listManagedWeeklySchedules() : [];
    res.json(filterRowsByUserBot(rows, req.appUser));
  }));

  app.put('/api/weekly-schedules', wrap(async (req, res) => {
    if (!db.upsertManagedWeeklySchedule) return res.status(501).json({ error: 'Supabase production database is required' });
    const body = req.body || {};
    for (const key of ['poll_release_day_of_week', 'confirmation_day_of_week']) {
      if (!Number.isInteger(Number(body[key])) || Number(body[key]) < 0 || Number(body[key]) > 6) {
        return res.status(400).json({ error: `${key} must be 0 through 6` });
      }
      body[key] = Number(body[key]);
    }
    if (!body.telegram_group_id || !/^([01]\d|2[0-3]):[0-5]\d$/.test(body.poll_release_time || '') ||
        !/^([01]\d|2[0-3]):[0-5]\d$/.test(body.confirmation_time || '')) {
      return res.status(400).json({ error: 'Group and valid release/confirmation times are required' });
    }
    await assertGroupAccess(db, req.appUser, body.telegram_group_id);
    body.timezone = body.timezone || 'Asia/Singapore';
    body.enabled = body.enabled !== false;
    const shifts = Array.isArray(body.shifts) ? body.shifts : [];
    for (const shift of shifts) {
      if (!shift.label || shift.label.length > 100 || !/^\d{2}:\d{2}$/.test(shift.start_time || '') ||
          !/^\d{2}:\d{2}$/.test(shift.end_time || '') ||
          !Number.isInteger(Number(shift.capacity)) || Number(shift.capacity) < 0) {
        return res.status(400).json({ error: 'Every shift needs a label, valid times, and non-negative capacity' });
      }
      shift.capacity = Number(shift.capacity);
    }
    body.shifts = shifts;
    res.json(await db.upsertManagedWeeklySchedule(body));
  }));

  app.delete('/api/weekly-schedules/:id', wrap(async (req, res) => {
    if (!db.deleteManagedWeeklySchedule) return res.status(501).json({ error: 'Supabase production database is required' });
    if (req.appUser && req.appUser.role !== 'admin' && db.getWeeklySchedule) {
      const schedule = await db.getWeeklySchedule(req.params.id);
      if (!schedule) return res.status(404).json({ error: 'Weekly schedule not found' });
      await assertGroupAccess(db, req.appUser, schedule.telegram_group_id);
    }
    await db.deleteManagedWeeklySchedule(req.params.id);
    res.status(204).end();
  }));

  app.get('/api/poll-exclusions', wrap(async (req, res) => {
    if (!db.listPollExclusions) return res.status(501).json({ error: 'Supabase production database is required' });
    const groupId = req.query.telegram_group_id || null;
    if (groupId) {
      await assertGroupAccess(db, req.appUser, groupId);
      return res.json(await db.listPollExclusions(groupId));
    }
    if (req.appUser && req.appUser.role !== 'admin') {
      const groups = db.listTelegramGroups ? await db.listTelegramGroups(scopeGroups(req.appUser)) : [];
      const rows = [];
      for (const group of groups) rows.push(...await db.listPollExclusions(group.id));
      return res.json(rows);
    }
    res.json(await db.listPollExclusions(null));
  }));

  app.post('/api/poll-exclusions', wrap(async (req, res) => {
    if (!db.upsertPollExclusion) return res.status(501).json({ error: 'Supabase production database is required' });
    const telegramGroupId = String(req.body?.telegram_group_id || '');
    const eventDate = String(req.body?.event_date || '');
    const parsedDate = /^\d{4}-\d{2}-\d{2}$/.test(eventDate) ? new Date(`${eventDate}T00:00:00Z`) : null;
    if (!telegramGroupId || !parsedDate || Number.isNaN(parsedDate.getTime()) ||
        parsedDate.toISOString().slice(0, 10) !== eventDate) {
      return res.status(400).json({ error: 'Telegram group and a valid event date are required' });
    }
    await assertGroupAccess(db, req.appUser, telegramGroupId);
    res.status(201).json(await db.upsertPollExclusion({
      telegram_group_id: telegramGroupId,
      event_date: eventDate,
    }));
  }));

  app.delete('/api/poll-exclusions/:id', wrap(async (req, res) => {
    if (!db.deletePollExclusion) return res.status(501).json({ error: 'Supabase production database is required' });
    if (req.appUser && req.appUser.role !== 'admin' && db.listPollExclusions) {
      const groups = db.listTelegramGroups ? await db.listTelegramGroups(scopeGroups(req.appUser)) : [];
      const scoped = [];
      for (const group of groups) scoped.push(...await db.listPollExclusions(group.id));
      if (!scoped.some((item) => String(item.id) === String(req.params.id))) {
        return res.status(404).json({ error: 'Skipped event date not found' });
      }
    }
    const row = await db.deletePollExclusion(req.params.id);
    if (!row) return res.status(404).json({ error: 'Skipped event date not found' });
    res.json({ deleted: row.id });
  }));

  app.post('/api/scheduled-polls', wrap(async (req, res) => {
    if (!db.createScheduledEvent) return res.status(501).json({ error: 'Supabase production database is required' });
    const body = req.body || {};
    const weekly = body.weekly_schedule_id ? await db.getWeeklySchedule(body.weekly_schedule_id) : null;
    const group = body.telegram_group_id && db.getTelegramGroup ? await db.getTelegramGroup(body.telegram_group_id) : null;
    const service = group ? resolveTelegramGroupService(group, body.service || 'WHCL') : body.service || 'WHCL';
    const isCustom = Boolean(body.is_custom);
    const isTest = Boolean(body.is_test);
    if (body.event_date && weekly) {
      const timing = managedTimingForEvent({
        service,
        eventDate: body.event_date,
        releaseDay: weekly.poll_release_day_of_week,
        releaseTime: String(weekly.poll_release_time).slice(0, 5),
      });
      body.specific_release_at = body.send_immediately ? body.specific_release_at : timing.releaseAt;
      body.close_at = timing.closeAt;
      body.confirmation_at = isTest && body.confirmation_at ? body.confirmation_at : timing.confirmationAt;
    }
    if (body.send_immediately && !weekly && !body.specific_release_at &&
        body.specific_release_day_of_week === undefined && !body.specific_release_time) {
      body.specific_release_at = new Date().toISOString();
    }
    const resolved = resolvePollSchedule({ ...body, weekly_schedule: weekly });
    const shifts = Array.isArray(body.shifts) ? body.shifts : [];
    if (!body.telegram_group_id || !body.event_date || !body.poll_question || shifts.length === 0 || shifts.length > 10) {
      return res.status(400).json({ error: 'Group, event date, poll question, and shifts are required' });
    }
    await assertGroupAccess(db, req.appUser, body.telegram_group_id);
    if (weekly && String(weekly.telegram_group_id) !== String(body.telegram_group_id)) {
      return res.status(404).json({ error: 'Weekly schedule not found' });
    }
    for (const shift of shifts) {
      if (!shift.label || shift.label.length > 100 || !/^\d{2}:\d{2}$/.test(shift.start_time || '') ||
          !/^\d{2}:\d{2}$/.test(shift.end_time || '') ||
          !Number.isInteger(Number(shift.capacity)) || Number(shift.capacity) < 0) {
        return res.status(400).json({ error: 'Every shift needs a label, valid times, and non-negative capacity' });
      }
      shift.capacity = Number(shift.capacity);
    }
    // Handle existing poll for this group+date
    if (!isTest && db.getActivePollForDate) {
      const existing = await db.getActivePollForDate(body.telegram_group_id, body.event_date);
      if (existing) {
        if (isCustom && !existing.is_custom && ['draft','scheduled','failed'].includes(existing.status)) {
          // Custom poll overrides an un-sent default — delete it so it disappears from the list
          await db.deleteScheduledPoll(existing.id);
        } else if (isCustom && existing.is_custom) {
          return res.status(409).json({
            error: `A custom poll already exists for this group on ${body.event_date} (status: ${existing.status}). Cancel it first before creating a new one.`,
            existing_poll_id: existing.id,
          });
        } else if (!isCustom && existing.is_custom) {
          return res.status(409).json({
            error: `A custom poll already exists for this group on ${body.event_date}. The default poll is suppressed — use the custom poll instead.`,
            existing_poll_id: existing.id,
          });
        } else {
          // Default vs default or already-sent — block
          return res.status(409).json({
            error: `A poll already exists for this group on ${body.event_date} (status: ${existing.status}). Cancel it first.`,
            existing_poll_id: existing.id,
          });
        }
      }
    }
    const payload = { ...body, shifts, poll_title: body.poll_title || body.poll_question,
      resolved_release_at: resolved.releaseAt.toISOString(), close_at: resolved.closeAt.toISOString(),
      resolved_confirmation_at: resolved.confirmationAt.toISOString(), timezone: resolved.timezone,
      is_custom: isCustom,
      operational_tags: isTest ? ['test'] : (body.operational_tags || []) };
    const id = await db.createScheduledEvent(payload, req.adminUser?.id || null);
    res.status(201).json({ id, schedule_source: resolved.source, is_custom: isCustom,
      resolved_release_at: payload.resolved_release_at,
      resolved_confirmation_at: payload.resolved_confirmation_at });
  }));


  app.post('/api/scheduled-polls/trigger-scheduler', wrap(async (req, res) => {
    const polls = await runScheduledPolls(db, telegram);
    const closures = await runScheduledClosures(db, telegram);
    const confirmations = await runScheduledConfirmations(db, telegram);
    res.json({ polls: polls.length, closures: closures.length, confirmations: confirmations.length });
  }));

  app.post('/api/scheduled-polls/:id/:action', wrap(async (req, res) => {
    if (!['cancel', 'retry', 'send-now', 'send-confirmation-now'].includes(req.params.action)) return res.status(404).end();
    const action = req.params.action.replace(/-/g, '_');
    if (action === 'send_now') {
      if (req.appUser && req.appUser.role !== 'admin' && db.getScheduledPollDetails) {
        const details = await db.getScheduledPollDetails(req.params.id);
        if (!details) return res.status(404).json({ error: 'Poll not found' });
        await assertGroupAccess(db, req.appUser, details.poll.telegram_group_id);
      }
      const { sendScheduledPollImmediately } = require('./productionScheduler');
      const result = await sendScheduledPollImmediately(db, telegram, req.params.id);
      if (!result) return res.status(409).json({ error: 'Poll status does not allow this action' });
      return res.json(result);
    }
    if (action === 'send_confirmation_now') {
      if (req.appUser && req.appUser.role !== 'admin' && db.getScheduledPollDetails) {
        const details = await db.getScheduledPollDetails(req.params.id);
        if (!details) return res.status(404).json({ error: 'Poll not found' });
        await assertGroupAccess(db, req.appUser, details.poll.telegram_group_id);
      }
      const { sendScheduledConfirmationImmediately } = require('./productionScheduler');
      const result = await sendScheduledConfirmationImmediately(db, telegram, req.params.id);
      if (!result) return res.status(409).json({ error: 'No due confirmation found for this poll' });
      return res.json(result);
    }
    if (req.appUser && req.appUser.role !== 'admin' && db.getScheduledPollDetails) {
      const details = await db.getScheduledPollDetails(req.params.id);
      if (!details) return res.status(404).json({ error: 'Poll not found' });
      await assertGroupAccess(db, req.appUser, details.poll.telegram_group_id);
    }
    const poll = db.updateScheduledPollAction && await db.updateScheduledPollAction(req.params.id, action);
    if (!poll) return res.status(409).json({ error: 'Poll status does not allow this action' });
    res.json(poll);
  }));

  app.get('/api/scheduled-polls/:id/details', wrap(async (req, res) => {
    const details = db.getScheduledPollDetails && await db.getScheduledPollDetails(req.params.id);
    if (!details) return res.status(404).json({ error: 'Poll not found' });
    await assertGroupAccess(db, req.appUser, details.poll.telegram_group_id);
    res.json(details);
  }));

  app.delete('/api/scheduled-polls/:id', wrap(async (req, res) => {
    if (!requireClearPollsPassword(req, res)) return;
    if (req.appUser && req.appUser.role !== 'admin' && db.getScheduledPollDetails) {
      const details = await db.getScheduledPollDetails(req.params.id);
      if (!details) return res.status(404).json({ error: 'Poll not found' });
      await assertGroupAccess(db, req.appUser, details.poll.telegram_group_id);
    }
    const row = db.deleteScheduledPoll && await db.deleteScheduledPoll(req.params.id);
    if (!row) return res.status(409).json({ error: 'Poll cannot be deleted (must be cancelled, closed, sent, or failed)' });
    res.json({ deleted: row.id });
  }));

  app.post('/api/confirmations/:id/retry', wrap(async (req, res) => {
    const confirmation = db.retryConfirmation && await db.retryConfirmation(req.params.id);
    if (!confirmation) return res.status(409).json({ error: 'Confirmation is not failed' });
    res.json(confirmation);
  }));

  // ---- Telegram webhook -----------------------------------------------------
  // Legacy service routes remain supported during migration. New per-user bots
  // use /api/telegram/:botId and validate against that bot's own webhook secret.
  app.post('/api/telegram/:service', wrap(async (req, res) => {
    const routeParam = String(req.params.service || '');
    const legacyService = routeParam.toUpperCase();
    let service = legacyService;
    let botRef = null;
    let webhookSecret = options.telegramWebhookSecret;

    if (!SERVICES.includes(legacyService)) {
      if (!db.getBot) return res.status(404).end();
      const bot = await db.getBot(routeParam);
      if (!bot || bot.enabled === false) return res.status(404).end();
      service = bot.id;
      botRef = bot.id;
      webhookSecret = bot.webhook_secret;
    }

    if (webhookSecret) {
      const got = req.headers['x-telegram-bot-api-secret-token'];
      if (!got || !safeEqual(got, webhookSecret)) return res.status(401).end();
    }
    if (!Number.isSafeInteger(req.body?.update_id)) {
      return res.status(400).json({ error: 'Invalid Telegram update' });
    }

    const result = await processTelegramUpdate(db, service, req.body, { botRef });
    if (result.summary) console.log(result.summary);
    // Always 200 so Telegram doesn't retry.
    res.status(200).json({ ok: true });
  }));

  // ---- Cron endpoints (invoked by Vercel Cron) ------------------------------
  const cronGuard = (req, res) => {
    if (!options.cronSecret) return true;
    const auth = req.headers.authorization || '';
    if (auth === `Bearer ${options.cronSecret}`) return true;
    res.status(401).end();
    return false;
  };

  // Vercel Cron issues GET requests; allow both.
  app.all('/api/cron/weekly', wrap(async (req, res) => {
    if (!cronGuard(req, res)) return;
    const [legacy, scheduled] = await Promise.all([
      runWeeklySend(db, telegram, options), runScheduledPolls(db, telegram),
    ]);
    res.json({ sent: legacy.length + scheduled.length });
  }));

  app.all('/api/cron/confirmations', wrap(async (req, res) => {
    if (!cronGuard(req, res)) return;
    const [legacy, scheduled] = await Promise.all([
      sendDueConfirmations(db, telegram, options), runScheduledConfirmations(db, telegram),
    ]);
    res.json({ sent: legacy.length + scheduled.length });
  }));

  app.all('/api/cron/scheduler', wrap(async (req, res) => {
    if (!cronGuard(req, res)) return;
    const polls = await runScheduledPolls(db, telegram);
    const closures = await runScheduledClosures(db, telegram);
    const confirmations = await runScheduledConfirmations(db, telegram);
    res.json({ polls: polls.length, closures: closures.length, confirmations: confirmations.length });
  }));

  return app;
}

module.exports = { createServer, resolveTelegramGroupService };
