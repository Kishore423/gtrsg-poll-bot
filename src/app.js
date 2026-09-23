// Wires the configured Express app from environment variables. Used by both the
// Vercel serverless entry (api/index.js) and the local dev server
// (src/localServer.js).

const { createServer } = require('./server');
const { createTelegramClient } = require('./telegram');
const { createMemoryDb } = require('./db/memory');
const { createTelegramAuth } = require('./telegramAuth');
const { decryptToken } = require('./crypto');

function isUnconfiguredVercel() {
  const hasProductionCredential = Boolean(process.env.DATABASE_URL || process.env.TELEGRAM_BOT_TOKEN ||
    process.env.SUPABASE_URL || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.CRON_SECRET);
  return Boolean(process.env.VERCEL) && !hasProductionCredential;
}

function buildDb() {
  if (process.env.LOCAL_READ_ONLY === 'true') {
    const connectionString = process.env.LOCAL_READONLY_DATABASE_URL;
    if (!connectionString) {
      throw new Error('LOCAL_READONLY_DATABASE_URL is required when LOCAL_READ_ONLY=true.');
    }
    const { createPostgresDb, createSql } = require('./db/postgres');
    return createPostgresDb({ sql: createSql(connectionString, { max: 1 }), readOnly: true });
  }
  // DB_DRIVER=memory runs without a database (local dev / tests). Default is
  // Postgres (Vercel). Require lazily so the memory path needs no pg install.
  if (process.env.DB_DRIVER === 'memory' || isUnconfiguredVercel()) return createMemoryDb();
  const { createPostgresDb } = require('./db/postgres');
  return createPostgresDb();
}

function buildAppFromEnv() {
  const localReadOnly = process.env.LOCAL_READ_ONLY === 'true';
  const unconfiguredPreview = isUnconfiguredVercel();
  const db = buildDb();
  const appUrl = process.env.APP_URL || process.env.VERCEL_URL && `https://${process.env.VERCEL_URL}`;
  const telegram = createTelegramClient({
    tokens: {
      PRIMARY: process.env.TELEGRAM_BOT_TOKEN,
      WHCL: process.env.TELEGRAM_TOKEN_WHCL || process.env.TELEGRAM_BOT_TOKEN,
      PSA: process.env.TELEGRAM_TOKEN_PSA || process.env.TELEGRAM_BOT_TOKEN,
      LOGIN: process.env.TELEGRAM_LOGIN_BOT_TOKEN,
    },
    resolveToken: async (botId) => {
      if (!db.getBot) return null;
      const bot = await db.getBot(botId);
      if (!bot || bot.enabled === false) return null;
      return decryptToken(bot.token_encrypted);
    },
  });

  const auth = createTelegramAuth({
    db,
    telegram,
    sessionSecret: process.env.APP_SESSION_SECRET,
    authBotKey: 'LOGIN',
    loginWebhookUrl: appUrl && `${appUrl.replace(/\/$/, '')}/api/telegram/login`,
    loginWebhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET,
  });
  const options = {
    labelService: process.env.LABEL_SERVICE_IN_POLL === 'true',
    confirmationHour: Number(process.env.CONFIRMATION_HOUR || 9),
    confirmationTimezoneOffset: process.env.CONFIRMATION_TIMEZONE_OFFSET || '+08:00',
    verifyUser: localReadOnly
      ? async () => ({
        id: 'local-readonly-admin',
        telegram_user_id: null,
        telegram_username: 'local_readonly',
        telegram_display_name: 'Local read-only admin',
        profile_photo_data: null,
        deployment_sheets_enabled: true,
        role: 'admin',
        bot_id: null,
      })
      : auth.verifyUser,
    requestTelegramOtp: auth.requestOtp,
    verifyTelegramOtp: auth.verifyOtp,
    issueActionAuthorization: auth.issueActionAuthorization,
    verifyActionAuthorization: auth.verifyActionAuthorization,
    startImpersonation: auth.startImpersonation,
    syncTelegramUserIdentity: auth.syncUserIdentity,
    completeTelegramLogin: auth.completeFromUpdate,
    requireAdminAuth: localReadOnly || (!unconfiguredPreview && process.env.REQUIRE_ADMIN_AUTH !== 'false' && process.env.DB_DRIVER !== 'memory'),
    enableLegacyWorkflow: unconfiguredPreview || process.env.ENABLE_LEGACY_WORKFLOW === 'true' || process.env.DB_DRIVER === 'memory',
    demoPreview: unconfiguredPreview,
    appUrl,
    telegramWebhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET,
    cronSecret: process.env.CRON_SECRET,
    clearPollsPassword: process.env.CLEAR_POLLS_PASSWORD,
    localReadOnly,
  };

  if (options.requireAdminAuth && !localReadOnly && !process.env.APP_SESSION_SECRET) {
    throw new Error('APP_SESSION_SECRET is required in production.');
  }
  if (options.requireAdminAuth && !localReadOnly && !process.env.TELEGRAM_LOGIN_BOT_TOKEN) {
    throw new Error('TELEGRAM_LOGIN_BOT_TOKEN is required in production.');
  }
  if (options.requireAdminAuth && !localReadOnly && !process.env.TELEGRAM_WEBHOOK_SECRET) {
    throw new Error('TELEGRAM_WEBHOOK_SECRET is required in production.');
  }
  if (options.requireAdminAuth && !localReadOnly && !process.env.CRON_SECRET) {
    throw new Error('CRON_SECRET is required in production.');
  }

  return createServer(db, telegram, options);
}

module.exports = { buildAppFromEnv };
