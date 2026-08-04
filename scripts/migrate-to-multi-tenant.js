#!/usr/bin/env node
require('dotenv').config({ path: '.env.local' });
require('dotenv').config();

const { createPostgresDb } = require('../src/db/postgres');
const { createTelegramClient } = require('../src/telegram');
const { encryptToken, generateWebhookSecret } = require('../src/crypto');

const USERS = [
  // These immutable IDs were observed by the polling bots. Seeding them maps
  // historical ownership but does not verify Login_bot enrollment.
  {
    telegram_user_id: '1012500255',
    telegram_username: 'sonia_mala',
    telegram_display_name: 'Sonia',
    role: 'user',
    service: 'PSA',
  },
  {
    telegram_user_id: '977476515',
    telegram_username: 'Y6yyyyyyyyyyuu',
    telegram_display_name: 'Yi Dan Wang',
    role: 'user',
    service: null,
  },
  {
    telegram_user_id: '5620259623',
    telegram_username: 'ht1193',
    telegram_display_name: 'Howell',
    role: 'user',
    service: 'WHCL',
  },
  {
    telegram_user_id: '2132609363',
    telegram_username: 'kishorek888',
    telegram_display_name: 'Kishore',
    role: 'admin',
    service: null,
  },
];

const SERVICE_TOKENS = {
  WHCL: process.env.TELEGRAM_TOKEN_WHCL,
  PSA: process.env.TELEGRAM_TOKEN_PSA,
};

function assertEnv() {
  const missing = ['DATABASE_URL', 'BOT_TOKEN_ENC_KEY'].filter((key) => !process.env[key]);
  if (!SERVICE_TOKENS.WHCL) missing.push('TELEGRAM_TOKEN_WHCL');
  if (!SERVICE_TOKENS.PSA) missing.push('TELEGRAM_TOKEN_PSA');
  if (missing.length) throw new Error(`Missing required env: ${missing.join(', ')}`);
}

async function ensureBot(db, service, token) {
  const telegram = createTelegramClient({ tokens: { BOT: token } });
  const me = await telegram.getMe('BOT');
  const nameResult = await telegram.getMyName('BOT').catch(() => null);
  const botName = nameResult?.name || me.first_name || me.username || `${service} bot`;
  const telegramBotId = me.id ? String(me.id) : null;
  const existing = (await db.listBots()).find((bot) =>
    String(bot.telegram_bot_id || '') === String(telegramBotId || ''));

  if (existing) {
    await db.setBotTelegramIdentity(existing.id, {
      bot_name: botName,
      telegram_username: me.username || existing.telegram_username || null,
      telegram_bot_id: telegramBotId,
    });
    return existing.id;
  }

  return db.createBot({
    bot_name: botName,
    telegram_username: me.username || null,
    telegram_bot_id: telegramBotId,
    token_encrypted: encryptToken(token),
    webhook_secret: generateWebhookSecret(),
  });
}

async function ensureUser(db, {
  telegram_user_id,
  telegram_username,
  telegram_display_name,
  role,
  botId,
}) {
  const existing = (await db.listAppUsers()).find((user) =>
    String(user.telegram_user_id) === String(telegram_user_id));
  if (!existing) {
    const id = await db.createAppUser({
      telegram_user_id,
      telegram_username,
      telegram_display_name,
      role,
      bot_id: botId || null,
    });
    await db.setAppUserEnabled(id, true);
    return id;
  }
  await db.setAppUserTelegramIdentity(existing.id, {
    telegram_user_id,
    telegram_username,
    telegram_display_name,
  });
  await db.setAppUserRole(existing.id, role);
  await db.setAppUserBot(existing.id, botId || null);
  await db.setAppUserEnabled(existing.id, true);
  return existing.id;
}

async function main() {
  assertEnv();
  const db = createPostgresDb();
  try {
    const botIds = {};
    for (const [service, token] of Object.entries(SERVICE_TOKENS)) {
      botIds[service] = await ensureBot(db, service, token);
      const groups = await db.assignTelegramGroupsToBot(service, botIds[service]);
      console.log(`${service}: bot ${botIds[service]}, migrated ${groups.length} group(s)`);
    }

    for (const user of USERS) {
      const botId = user.service ? botIds[user.service] : null;
      await ensureUser(db, { ...user, botId });
      console.log(
        `User ready: @${user.telegram_username} (${user.role})${botId ? ` -> ${botId}` : ''}`,
      );
    }
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
