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
const { buildConfirmationMessage, NOT_AVAILABLE_OPTION, escapeHtml } = require('./pollBuilder');
const { buildConfirmationState } = require('./confirmation');
const { processTelegramUpdate } = require('./processUpdate');
const { resolvePollSchedule } = require('./scheduleResolver');
const {
  addLocalDays,
  eventDatesForReleaseDate,
  managedTimingForEvent,
} = require('./scheduleRules');
const { runScheduledPolls, runScheduledConfirmations, runScheduledClosures } = require('./productionScheduler');
const { scopeGroups, assertGroupAccess, filterRowsByUserBot } = require('./tenancy');
const { encryptToken, decryptToken, generateWebhookSecret } = require('./crypto');
const { buildDeploymentWorkbook } = require('./deploymentWorkbook');

const SERVICES = ['PRIMARY', 'WHCL', 'PSA', 'LOGIN'];
const ROUTED_SERVICES = ['WHCL', 'PSA'];

function isValidTime(value) {
  return typeof value === 'string' && /^\d{2}:?\d{2}$/.test(value);
}

// RFC-4180 CSV cell: quote when it contains a comma, quote, or newline.
function csvCell(value) {
  const str = String(value ?? '');
  return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

// "2026-08-03" -> "3-Aug" for deployment-sheet column headers.
const SHEET_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function formatSheetDate(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '').slice(0, 10));
  if (!match) return String(iso || '');
  return `${Number(match[3])}-${SHEET_MONTHS[Number(match[2]) - 1]}`;
}

async function collectDeploymentRoster(db, appUser, requestedBotId = null, requestedGroupId = null) {
  let rows = filterRowsByUserBot(await db.listScheduledPolls(), appUser);
  if (requestedBotId) rows = rows.filter((row) => String(row.bot_id) === requestedBotId);
  if (requestedGroupId) {
    rows = rows.filter((row) => String(row.telegram_group_id) === requestedGroupId);
  }

  const seenEvents = new Set();
  const events = [];
  for (const row of rows) {
    if (!row.event_id || seenEvents.has(row.event_id)) continue;
    seenEvents.add(row.event_id);
    events.push({ event_id: row.event_id, event_date: String(row.event_date || '').slice(0, 10) });
  }
  const dates = [...new Set(events.map((event) => event.event_date).filter(Boolean))].sort();

  const people = new Map();
  for (const event of events) {
    const confirmed = (await db.getAllocation(event.event_id))
      .filter((row) => row.status === 'confirmed')
      .sort((a, b) => (a.display_order - b.display_order)
        || ((a.confirmed_position || 0) - (b.confirmed_position || 0)));
    for (const row of confirmed) {
      const handle = row.telegram_username ? `@${row.telegram_username}` : '';
      const key = row.telegram_user_id || handle || row.display_name || 'unknown';
      if (!people.has(key)) {
        people.set(key, {
          name: row.display_name || handle || 'Unknown',
          handle,
          shifts: {},
        });
      }
      const person = people.get(key);
      person.shifts[event.event_date] = person.shifts[event.event_date]
        ? `${person.shifts[event.event_date]} ; ${row.label || ''}`
        : (row.label || '');
    }
  }

  return {
    dates,
    people: [...people.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
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

function validateProfilePhotoData(value) {
  const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(value || ''));
  if (!match) {
    const error = new Error('Profile picture must be a JPEG, PNG, or WebP image');
    error.statusCode = 400;
    throw error;
  }
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > 200 * 1024) {
    const error = new Error('Profile picture must be 200 KB or smaller');
    error.statusCode = 400;
    throw error;
  }
  return `data:image/${match[1]};base64,${match[2]}`;
}

// db: repository (memory or postgres). telegram: Telegram client.
// options: { labelService, confirmationHour, confirmationTimezoneOffset,
//            webUsername, webPassword, telegramWebhookSecret, cronSecret }
function createServer(db, telegram, options = {}) {
  const app = express();
  app.use(express.json({ limit: '300kb' }));
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
  app.get('/admin', (req, res) => {
    const adminHtmlPath = path.join(__dirname, '..', 'public', 'admin.html');
    if (fs.existsSync(adminHtmlPath)) return res.type('html').send(fs.readFileSync(adminHtmlPath, 'utf8'));
    res.redirect('/admin.html');
  });

  app.get('/api/auth-config', (req, res) => {
    res.json({ required: !!options.requireAdminAuth, legacyEnabled: options.enableLegacyWorkflow !== false,
      demoPreview: !!options.demoPreview, provider: 'telegram' });
  });

  app.post('/api/auth/telegram/otp/request', async (req, res) => {
    if (!options.requireAdminAuth) return res.json({ disabled: true });
    try {
      res.status(202).json(await options.requestTelegramOtp(req.body?.identifier));
    } catch (error) {
      const payload = { error: error.message || 'Unable to send Telegram code' };
      if (error.retryAfter) payload.retry_after = error.retryAfter;
      if (error.botUsername) payload.bot_username = error.botUsername;
      res.status(error.statusCode || 500).json(payload);
    }
  });

  app.post('/api/auth/telegram/otp/verify', async (req, res) => {
    if (!options.requireAdminAuth) return res.json({ disabled: true });
    try {
      res.json(await options.verifyTelegramOtp(
        req.body?.challenge_id,
        req.body?.verifier,
        req.body?.code
      ));
    } catch (error) {
      res.status(error.statusCode || 401).json({
        error: error.message || 'Unable to verify Telegram code',
      });
    }
  });

  // Tells the caller who they are, so the UI can scope itself and decide whether to
  // show the Admin link. Unprovisioned callers get the 403 from requireUser.
  app.get('/api/me', requireUser(options.verifyUser || (async () => null)), (req, res) => {
    res.json({
      telegram_user_id: req.appUser.telegram_user_id,
      telegram_username: req.appUser.telegram_username,
      telegram_display_name: req.appUser.telegram_display_name,
      profile_photo_data: req.appUser.profile_photo_data,
      role: req.appUser.role,
      bot_id: req.appUser.bot_id,
    });
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

  app.patch('/api/me/profile-photo', wrap(async (req, res) => {
    if (!db.setAppUserProfilePhoto) {
      return res.status(501).json({ error: 'Supabase production database is required' });
    }
    const profilePhotoData = validateProfilePhotoData(req.body?.profile_photo_data);
    const user = await db.setAppUserProfilePhoto(req.appUser.id, profilePhotoData);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ profile_photo_data: user.profile_photo_data });
  }));

  app.delete('/api/me/profile-photo', wrap(async (req, res) => {
    if (!db.setAppUserProfilePhoto) {
      return res.status(501).json({ error: 'Supabase production database is required' });
    }
    const user = await db.setAppUserProfilePhoto(req.appUser.id, null);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ deleted: true });
  }));

  function publicBot(bot) {
    if (!bot) return null;
    return {
      id: bot.id,
      bot_name: bot.bot_name,
      telegram_username: bot.telegram_username,
      telegram_bot_id: bot.telegram_bot_id,
      enabled: bot.enabled,
      name_synced_at: bot.name_synced_at,
      created_at: bot.created_at,
    };
  }

  async function syncBotIdentity(botId) {
    if (!db.getBot || !db.setBotTelegramIdentity) return null;
    const bot = await db.getBot(botId);
    if (!bot || bot.enabled === false) return bot && publicBot(bot);
    const [me, name] = await Promise.all([
      telegram.getMe(botId),
      telegram.getMyName(botId).catch(() => null),
    ]);
    return publicBot(await db.setBotTelegramIdentity(botId, {
      bot_name: name?.name || bot.bot_name || me.first_name,
      telegram_username: me.username || null,
      telegram_bot_id: me.id,
    }));
  }

  function isUnavailablePrivateTelegramChat(error) {
    return Number(error?.telegramCode) === 400
      && /chat not found/i.test(String(error?.message || ''));
  }

  async function registerBotWebhook(botId, secret, client = telegram, clientBotId = botId) {
    if (!options.appUrl) return null;
    const url = `${String(options.appUrl).replace(/\/$/, '')}/api/telegram/${botId}`;
    await client.setWebhook(clientBotId, url, secret);
    return url;
  }

  function telegramClientForToken(token) {
    return options.createTelegramClientForToken
      ? options.createTelegramClientForToken(token)
      : require('./telegram').createTelegramClient({ tokens: { BOT: token } });
  }

  function duplicateTelegramBotError(identity = null) {
    const label = identity?.telegram_username
      ? ` @${identity.telegram_username}`
      : identity?.telegram_bot_id
        ? ` with Telegram ID ${identity.telegram_bot_id}`
        : '';
    const error = new Error(
      `Telegram bot${label} is already assigned in the application. Remove its current assignment before assigning it to a different user.`
    );
    error.statusCode = 409;
    return error;
  }

  async function inspectBotToken(botToken) {
    const token = String(botToken || '').trim();
    if (!token) {
      const error = new Error('Paste a BotFather token first');
      error.statusCode = 400;
      throw error;
    }
    const tempTelegram = telegramClientForToken(token);
    let me;
    let name;
    try {
      [me, name] = await Promise.all([
        tempTelegram.getMe('BOT'),
        tempTelegram.getMyName('BOT').catch(() => null),
      ]);
    } catch (cause) {
      const telegramCode = Number(cause?.telegramCode);
      const error = new Error(
        telegramCode === 401
          ? 'Telegram rejected this BotFather token. Copy the current token from BotFather and try again.'
          : `Telegram could not verify this BotFather token: ${cause.message}`
      );
      error.statusCode = telegramCode > 0 && telegramCode < 500 ? 400 : 502;
      error.cause = cause;
      throw error;
    }
    if (!me?.id || !me?.username || me.is_bot === false) {
      const error = new Error('Telegram did not return a valid bot identity for this token');
      error.statusCode = 400;
      throw error;
    }
    return {
      token,
      tempTelegram,
      identity: {
        bot_name: name?.name || me.first_name || me.username,
        telegram_username: me.username,
        telegram_bot_id: String(me.id),
      },
    };
  }

  async function findBotByTelegramIdentity(identity) {
    if (!db.listBots) return null;
    return (await db.listBots()).find((bot) =>
      String(bot.telegram_bot_id || '') === String(identity.telegram_bot_id)) || null;
  }

  // The app_user id that currently owns a bot row, or null if the bot is
  // unowned (an orphan left behind after a replace/remove).
  async function botOwnerUserId(botId) {
    if (!db.listAppUsers) return null;
    const owner = (await db.listAppUsers()).find((user) =>
      String(user.bot_id || '') === String(botId));
    return owner ? owner.id : null;
  }

  async function createBotFromToken(botToken) {
    const inspected = await inspectBotToken(botToken);
    const existing = await findBotByTelegramIdentity(inspected.identity);
    if (existing) {
      // A bot row for this Telegram bot already exists. Block only when another
      // user still owns it; otherwise it is an orphan from a previous
      // replace/remove and can be reused so the same bot can be reassigned.
      if (await botOwnerUserId(existing.id)) throw duplicateTelegramBotError(inspected.identity);
      if (db.reactivateBot) {
        const webhookSecret = generateWebhookSecret();
        await db.reactivateBot(existing.id, {
          token_encrypted: encryptToken(inspected.token),
          webhook_secret: webhookSecret,
        });
        await registerBotWebhook(existing.id, webhookSecret, inspected.tempTelegram, 'BOT');
        return {
          id: existing.id,
          identity: inspected.identity,
          rollback: async () => {
            if (inspected.tempTelegram.deleteWebhook) {
              await inspected.tempTelegram.deleteWebhook('BOT', true).catch(() => null);
            }
          },
        };
      }
      throw duplicateTelegramBotError(inspected.identity);
    }
    const webhookSecret = generateWebhookSecret();
    let botId;
    try {
      botId = await db.createBot({
        ...inspected.identity,
        token_encrypted: encryptToken(inspected.token),
        webhook_secret: webhookSecret,
      });
    } catch (error) {
      if (error?.code === '23505'
          && error?.constraint === 'bots_telegram_bot_id_key') {
        throw duplicateTelegramBotError(inspected.identity);
      }
      throw error;
    }
    const rollback = async () => {
      if (inspected.tempTelegram.deleteWebhook) {
        await inspected.tempTelegram.deleteWebhook('BOT', true).catch(() => null);
      }
      if (db.deleteBot) await db.deleteBot(botId).catch(() => null);
    };
    try {
      await registerBotWebhook(botId, webhookSecret, inspected.tempTelegram, 'BOT');
    } catch (error) {
      await rollback();
      throw error;
    }
    return {
      id: botId,
      identity: inspected.identity,
      rollback,
    };
  }

  async function adminUserRoster({ syncIdentities = false } = {}) {
    const storedUsers = await db.listAppUsers();
    const users = syncIdentities ? await Promise.all(storedUsers.map(async (user) => {
      if (!options.syncTelegramUserIdentity
          || !user.telegram_user_id
          || !user.login_bot_verified_at) return user;
      try {
        return await options.syncTelegramUserIdentity(user) || user;
      } catch (error) {
        if (isUnavailablePrivateTelegramChat(error)) {
          return { ...user, sync_unavailable: true };
        }
        return { ...user, sync_error: error.message };
      }
    })) : storedUsers;
    const bots = db.listBots ? await db.listBots() : [];
    const syncedBots = syncIdentities ? await Promise.all(bots.map(async (bot) => {
      try {
        return await syncBotIdentity(bot.id) || publicBot(bot);
      } catch (error) {
        return { ...publicBot(bot), sync_error: error.message };
      }
    })) : bots.map(publicBot);
    const botMap = new Map(syncedBots.map((bot) => [String(bot.id), bot]));
    return users.map((user) => {
      const { profile_photo_data: omittedProfilePhoto, ...publicUser } = user;
      return {
        ...publicUser,
        bot: user.bot_id ? botMap.get(String(user.bot_id)) || null : null,
      };
    });
  }

  app.get('/api/admin/users', wrap(async (req, res) => {
    if (!db.listAppUsers) return res.status(501).json({ error: 'Supabase production database is required' });
    res.set('Cache-Control', 'no-store');
    res.json(await adminUserRoster());
  }));

  app.post('/api/admin/telegram-identities/refresh', wrap(async (req, res) => {
    if (!db.listAppUsers) return res.status(501).json({ error: 'Supabase production database is required' });
    res.set('Cache-Control', 'no-store');
    res.json(await adminUserRoster({ syncIdentities: true }));
  }));

  app.get('/api/admin/bots', wrap(async (req, res) => {
    if (!db.listBots) return res.status(501).json({ error: 'Supabase production database is required' });
    const bots = await db.listBots();
    const synced = [];
    for (const bot of bots) {
      try {
        synced.push(await syncBotIdentity(bot.id) || publicBot(bot));
      } catch (error) {
        synced.push({ ...publicBot(bot), sync_error: error.message });
      }
    }
    res.json(synced);
  }));

  app.post('/api/admin/bots/inspect-token', wrap(async (req, res) => {
    const inspected = await inspectBotToken(req.body?.bot_token);
    const existingBot = await findBotByTelegramIdentity(inspected.identity);
    let assignedTo = null;
    if (existingBot && db.listAppUsers) {
      const assignedUser = (await db.listAppUsers()).find((user) =>
        String(user.bot_id || '') === String(existingBot.id));
      assignedTo = assignedUser
        ? assignedUser.telegram_display_name || assignedUser.telegram_username || 'an existing user'
        : 'an existing bot record';
    }
    res.set('Cache-Control', 'no-store');
    res.json({
      ...inspected.identity,
      // Only a bot still owned by a user blocks assignment; an orphaned bot row
      // (no owner) is reusable, so it is not reported as already assigned.
      already_assigned: Boolean(assignedTo && assignedTo !== 'an existing bot record'),
      assigned_to: assignedTo,
    });
  }));

  app.post('/api/admin/users', wrap(async (req, res) => {
    if (!db.createAppUser) return res.status(501).json({ error: 'Supabase production database is required' });
    const telegramUsername = String(req.body?.telegram_username || '').trim().replace(/^@/, '') || null;
    const telegramDisplayName = String(req.body?.telegram_display_name || '').trim() || null;
    const role = String(req.body?.role || 'user');
    if (!telegramUsername || !/^[A-Za-z0-9_]{5,32}$/.test(telegramUsername)) {
      return res.status(400).json({ error: 'A valid Telegram handle is required' });
    }
    if (!['admin', 'user'].includes(role)) return res.status(400).json({ error: 'Role must be admin or user' });
    if (db.listAppUsers) {
      const existing = (await db.listAppUsers()).find((user) =>
        String(user.telegram_username || '').toLowerCase() === telegramUsername.toLowerCase());
      if (existing) return res.status(409).json({ error: 'This Telegram account is already provisioned' });
    }
    const botToken = String(req.body?.bot_token || '').trim();
    const provisionedBot = botToken ? await createBotFromToken(botToken) : null;
    let userId;
    try {
      userId = await db.createAppUser({
        role,
        bot_id: provisionedBot?.id || null,
        telegram_user_id: null,
        telegram_username: telegramUsername,
        telegram_display_name: telegramDisplayName,
      });
    } catch (error) {
      if (provisionedBot) await provisionedBot.rollback();
      throw error;
    }
    res.status(201).json({
      id: userId,
      telegram_user_id: null,
      telegram_username: telegramUsername,
      role,
      bot_id: provisionedBot?.id || null,
      bot: provisionedBot ? {
        id: provisionedBot.id,
        ...provisionedBot.identity,
        enabled: true,
      } : null,
    });
  }));

  app.patch('/api/admin/users/:id', wrap(async (req, res) => {
    if (!db.listAppUsers || !db.updateAppUser) {
      return res.status(501).json({ error: 'Supabase production database is required' });
    }
    const users = await db.listAppUsers();
    const current = users.find((user) => String(user.id) === String(req.params.id));
    if (!current) return res.status(404).json({ error: 'User not found' });
    if (req.body?.bot_name !== undefined || req.body?.bot_handle !== undefined) {
      return res.status(400).json({
        error: 'Bot name and handle are managed in Telegram and cannot be changed here',
      });
    }
    const telegramUserId = current.telegram_user_id ? String(current.telegram_user_id) : null;
    const telegramUsername = current.telegram_username || null;
    if (req.body?.telegram_username !== undefined) {
      const submittedUsername = String(req.body.telegram_username || '').trim().replace(/^@/, '') || null;
      if (submittedUsername !== telegramUsername) {
        return res.status(400).json({
          error: 'The user Telegram handle is managed in Telegram and cannot be changed here',
        });
      }
    }
    const telegramDisplayName = String(
      req.body?.telegram_display_name ?? current.telegram_display_name ?? ''
    ).trim() || null;
    const role = String(req.body?.role ?? current.role);
    const enabled = req.body?.enabled === undefined ? current.enabled !== false : Boolean(req.body.enabled);
    if (telegramDisplayName && telegramDisplayName.length > 80) {
      return res.status(400).json({ error: 'Display name must be 80 characters or fewer' });
    }
    if (!['admin', 'user'].includes(role)) {
      return res.status(400).json({ error: 'Role must be admin or user' });
    }
    const botToken = String(req.body?.bot_token || '').trim();
    let row = await db.updateAppUser(req.params.id, {
      telegram_user_id: telegramUserId,
      telegram_username: telegramUsername,
      telegram_display_name: telegramDisplayName,
      role,
      enabled,
    });
    if (!row) return res.status(404).json({ error: 'User not found' });
    if (req.body?.remove_bot === true) {
      // Unassign the user's bot. The bot row is kept (not hard-deleted, to
      // preserve poll history and avoid an FK cascade that would drop its
      // groups/polls) but disabled and left unowned, so its Telegram bot ID is
      // free for reassignment via createBotFromToken's orphan reuse.
      if (current.bot_id) {
        if (db.replaceAppUserBot) await db.replaceAppUserBot(req.params.id, null);
        else if (db.setAppUserBot) await db.setAppUserBot(req.params.id, null);
        if (db.getBot) {
          const oldBot = await db.getBot(current.bot_id);
          if (oldBot?.token_encrypted) {
            try {
              const oldTelegram = telegramClientForToken(decryptToken(oldBot.token_encrypted));
              if (oldTelegram.deleteWebhook) await oldTelegram.deleteWebhook('BOT', true);
            } catch { /* best-effort webhook removal */ }
          }
        }
      }
      return res.json({ ...row, bot_id: null, bot: null, bot_removed: true });
    }
    let replacementWarning = null;
    if (botToken) {
      if (!db.replaceAppUserBot && !db.setAppUserBot) {
        return res.status(501).json({ error: 'Supabase production database is required' });
      }
      const provisionedBot = await createBotFromToken(botToken);
      let assignment;
      try {
        assignment = db.replaceAppUserBot
          ? await db.replaceAppUserBot(req.params.id, provisionedBot.id)
          : await db.setAppUserBot(req.params.id, provisionedBot.id);
      } catch (error) {
        await provisionedBot.rollback();
        throw error;
      }
      row = { ...row, bot_id: assignment.bot_id };
      if (assignment.old_bot_id && assignment.old_bot_id !== assignment.bot_id && db.getBot) {
        const oldBot = await db.getBot(assignment.old_bot_id);
        if (oldBot?.token_encrypted) {
          try {
            const oldTelegram = telegramClientForToken(decryptToken(oldBot.token_encrypted));
            if (oldTelegram.deleteWebhook) await oldTelegram.deleteWebhook('BOT', true);
          } catch (error) {
            replacementWarning = `The old bot was disabled, but its Telegram webhook could not be removed: ${error.message}`;
          }
        }
      }
    }
    const effectiveBotId = row.bot_id || current.bot_id;
    let bot = effectiveBotId && db.getBot ? publicBot(await db.getBot(effectiveBotId)) : null;
    res.json({ ...row, bot, replacement_warning: replacementWarning });
  }));

  app.delete('/api/admin/users/:id', wrap(async (req, res) => {
    if (!db.deleteAppUser) return res.status(501).json({ error: 'Supabase production database is required' });
    const row = await db.deleteAppUser(req.params.id);
    if (!row) return res.status(404).json({ error: 'User not found' });
    if (row.bot_id && db.deleteBot) await db.deleteBot(row.bot_id);
    res.json({ deleted: row.id });
  }));

  app.patch('/api/admin/bots/:id', wrap(async (req, res) => {
    res.status(405).json({
      error: 'Bot name and handle are managed in Telegram. Refresh the Admin roster after changing them there.',
    });
  }));

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

  // Deployment sheet: a pivoted roster (one row per person, one column per event
  // date; each cell is that person's confirmed shift that day), tenant-scoped to
  // the caller's bot. CSV remains available for integrations; the UI downloads
  // the formatted Excel workbook below.
  app.get('/api/confirmed-slots.csv', wrap(async (req, res) => {
    if (!db.listScheduledPolls || !db.getAllocation) {
      return res.status(501).json({ error: 'Supabase production database is required' });
    }
    const requestedBotId = req.appUser?.role === 'admin' && req.query.bot_id
      ? String(req.query.bot_id)
      : null;
    const requestedGroupId = req.query.telegram_group_id
      ? String(req.query.telegram_group_id)
      : null;
    if (requestedGroupId) await assertGroupAccess(db, req.appUser, requestedGroupId);
    const { dates, people } = await collectDeploymentRoster(
      db,
      req.appUser,
      requestedBotId,
      requestedGroupId
    );
    const header = ['Name', 'Telegram handle', ...dates.map(formatSheetDate)];
    const lines = [header];
    for (const person of people) {
      lines.push([
        person.name,
        person.handle,
        ...dates.map((date) => person.shifts[date] || ''),
      ]);
    }

    const csv = lines.map((cols) => cols.map(csvCell).join(',')).join('\r\n');
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition',
      `attachment; filename="deployment-sheet-${new Date().toISOString().slice(0, 10)}.csv"`);
    // BOM so Excel reads UTF-8 handles/names correctly.
    res.send(`﻿${csv}`);
  }));

  app.get('/api/confirmed-slots.xlsx', wrap(async (req, res) => {
    if (!db.listScheduledPolls || !db.getAllocation) {
      return res.status(501).json({ error: 'Supabase production database is required' });
    }
    const requestedBotId = req.appUser?.role === 'admin' && req.query.bot_id
      ? String(req.query.bot_id)
      : null;
    const requestedGroupId = req.query.telegram_group_id
      ? String(req.query.telegram_group_id)
      : null;
    if (requestedGroupId) await assertGroupAccess(db, req.appUser, requestedGroupId);
    const roster = await collectDeploymentRoster(
      db,
      req.appUser,
      requestedBotId,
      requestedGroupId
    );
    const workbook = await buildDeploymentWorkbook({ ...roster, formatDate: formatSheetDate });
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set('Content-Disposition',
      `attachment; filename="deployment-sheet-${new Date().toISOString().slice(0, 10)}.xlsx"`);
    res.send(workbook);
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
    if (!db.listTelegramGroups) return res.json([]);
    const requestedBotId = req.appUser?.role === 'admin' && req.query.bot_id
      ? String(req.query.bot_id)
      : null;
    const groupScope = requestedBotId ? { botId: requestedBotId } : scopeGroups(req.appUser);
    let groups = await db.listTelegramGroups(groupScope);

    if (requestedBotId && req.query.refresh === '1' && db.setTelegramGroupEnabledByChatAndBot) {
      const me = await telegram.getMe(requestedBotId);
      const membershipRows = await Promise.all(groups.map(async (group) => {
        const membership = await telegram.call(requestedBotId, 'getChatMember', {
          chat_id: group.telegram_chat_id,
          user_id: me.id,
        });
        const active = !['left', 'kicked'].includes(membership.status);
        if (!active) {
          await db.setTelegramGroupEnabledByChatAndBot(
            group.telegram_chat_id,
            requestedBotId,
            false,
          );
        }
        return active ? group : null;
      }));
      groups = membershipRows.filter(Boolean);
    }

    res.json(groups);
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
    if (!present) {
      return res.status(409).json({
        error: `The bot is no longer a member of ${group.group_name}`,
        present,
        status: membership.status,
        can_post_messages,
      });
    }
    if (!can_post_messages) {
      return res.status(409).json({
        error: `The bot does not have permission to post in ${group.group_name}`,
        present,
        status: membership.status,
        can_post_messages,
      });
    }
    let verificationMessage;
    try {
      verificationMessage = await telegram.sendMessage(
        service,
        group.telegram_chat_id,
        `<b>Bot verification successful</b>\n\nThis bot can send messages to <b>${escapeHtml(group.group_name)}</b>.`
      );
    } catch (err) {
      return res.status(502).json({
        error: `Telegram did not accept the verification message for ${group.group_name}: ${err.message}`,
        present,
        status: membership.status,
        can_post_messages,
      });
    }
    res.json({
      present,
      status: membership.status,
      can_post_messages,
      message_sent: true,
      message_id: verificationMessage?.message_id || null,
      group_name: group.group_name,
    });
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
    body.gap_weeks = Number(body.gap_weeks ?? 0);
    if (!Number.isInteger(body.gap_weeks) || body.gap_weeks < 0 || body.gap_weeks > 12) {
      return res.status(400).json({ error: 'gap_weeks must be a whole number from 0 through 12' });
    }
    if (!body.telegram_group_id || !/^([01]\d|2[0-3]):[0-5]\d$/.test(body.poll_release_time || '') ||
        !/^([01]\d|2[0-3]):[0-5]\d$/.test(body.confirmation_time || '')) {
      return res.status(400).json({ error: 'Group and valid release/confirmation times are required' });
    }
    const group = await assertGroupAccess(db, req.appUser, body.telegram_group_id);
    const service = resolveTelegramGroupService(group, 'WHCL');
    const referenceReleaseDate = addLocalDays(
      '2030-01-07',
      (body.poll_release_day_of_week + 6) % 7
    );
    const referenceEventDate = eventDatesForReleaseDate(
      service,
      referenceReleaseDate,
      body.gap_weeks
    )[0];
    try {
      managedTimingForEvent({
        service,
        eventDate: referenceEventDate,
        releaseDate: referenceReleaseDate,
        releaseDay: body.poll_release_day_of_week,
        releaseTime: body.poll_release_time,
        gapWeeks: body.gap_weeks,
        confirmationDay: body.confirmation_day_of_week,
        confirmationTime: body.confirmation_time,
      });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
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
        gapWeeks: weekly.gap_weeks,
        confirmationDay: weekly.confirmation_day_of_week,
        confirmationTime: String(weekly.confirmation_time).slice(0, 5),
        validateAfterRelease: !(isTest && body.send_immediately),
      });
      body.specific_release_at = body.send_immediately ? body.specific_release_at : timing.releaseAt;
      body.close_at = timing.closeAt;
      body.confirmation_at = (isCustom || isTest) && body.confirmation_at
        ? body.confirmation_at
        : timing.confirmationAt;
    }
    if (body.send_immediately && !weekly && !body.specific_release_at &&
        body.specific_release_day_of_week === undefined && !body.specific_release_time) {
      body.specific_release_at = new Date().toISOString();
    }
    let resolved;
    try {
      resolved = resolvePollSchedule({ ...body, weekly_schedule: weekly });
    } catch (error) {
      error.statusCode = 400;
      throw error;
    }
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

    const loginResult = options.completeTelegramLogin
      ? await options.completeTelegramLogin(service, req.body)
      : null;
    const result = loginResult || (service === 'LOGIN'
      ? { handled: 'ignored_login_bot_update' }
      : await processTelegramUpdate(db, service, req.body, { botRef }));
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
