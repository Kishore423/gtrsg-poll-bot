// Registers each bot's webhook so Telegram delivers votes / group events to the
// deployed site. Run after the first Vercel deploy and whenever the URL changes:
//   APP_URL=https://your-app.vercel.app \
//   TELEGRAM_TOKEN_WHCL=... TELEGRAM_TOKEN_PSA=... TELEGRAM_LOGIN_BOT_TOKEN=... \
//   TELEGRAM_WEBHOOK_SECRET=... node scripts/set-webhook.js
require('dotenv').config();
const { createTelegramClient } = require('../src/telegram');
const { decryptToken } = require('../src/crypto');

function getConfiguredBots(env) {
  const configured = [
    ['PRIMARY', env.TELEGRAM_BOT_TOKEN],
    ['WHCL', env.TELEGRAM_TOKEN_WHCL],
    ['PSA', env.TELEGRAM_TOKEN_PSA],
    ['LOGIN', env.TELEGRAM_LOGIN_BOT_TOKEN],
  ].filter(([, token]) => Boolean(token));
  const seen = new Map();
  for (const [service, token] of configured) {
    if (seen.has(token)) {
      throw new Error(`The same Telegram token is configured for ${seen.get(token)} and ${service}; each bot can have only one webhook URL.`);
    }
    seen.set(token, service);
  }
  return configured;
}

async function main() {
  const publicUrl = process.env.APP_URL;
  if (!publicUrl) throw new Error('Set APP_URL to your deployed https URL.');

  let db = null;
  if (process.env.DATABASE_URL) {
    const { createPostgresDb } = require('../src/db/postgres');
    db = createPostgresDb();
  }

  const telegram = createTelegramClient({
    tokens: { PRIMARY: process.env.TELEGRAM_BOT_TOKEN,
      WHCL: process.env.TELEGRAM_TOKEN_WHCL, PSA: process.env.TELEGRAM_TOKEN_PSA,
      LOGIN: process.env.TELEGRAM_LOGIN_BOT_TOKEN },
    resolveToken: async (botId) => {
      if (!db?.getBot) return null;
      const bot = await db.getBot(botId);
      if (!bot || bot.enabled === false) return null;
      return decryptToken(bot.token_encrypted);
    },
  });

  let registeredDbBots = false;
  if (db?.listBots) {
    try {
      const bots = (await db.listBots()).filter((bot) => bot.enabled !== false);
      if (bots.length) {
        registeredDbBots = true;
        for (const bot of bots) {
          if (!bot.webhook_secret && db.getBot) {
            const full = await db.getBot(bot.id);
            bot.webhook_secret = full?.webhook_secret;
          }
          if (!bot.webhook_secret) throw new Error(`Bot ${bot.id} has no webhook secret.`);
          const url = `${publicUrl.replace(/\/$/, '')}/api/telegram/${bot.id}`;
          await telegram.setWebhook(bot.id, url, bot.webhook_secret);
          const [me, name] = await Promise.all([
            telegram.getMe(bot.id),
            telegram.getMyName(bot.id).catch(() => null),
          ]);
          if (db.setBotTelegramIdentity) {
            await db.setBotTelegramIdentity(bot.id, {
              bot_name: name?.name || bot.bot_name || me.first_name,
              telegram_username: me.username || null,
              telegram_bot_id: me.id,
            });
          }
          console.log(`${bot.id}: webhook set to ${url} (bot @${me.username})`);
        }
      }
    } finally {
      if (db.close) await db.close();
    }
  }

  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) throw new Error('Set TELEGRAM_WEBHOOK_SECRET.');

  // Register a webhook for EVERY configured token. A service token that merely
  // falls back to the PRIMARY token is skipped: the same bot must not have two
  // webhook URLs (the second setWebhook would overwrite the first).
  const configured = getConfiguredBots(process.env)
    .filter(([service]) => !registeredDbBots || service === 'LOGIN');
  if (configured.length === 0 && !registeredDbBots) {
    throw new Error('Set a polling bot token and TELEGRAM_LOGIN_BOT_TOKEN.');
  }
  for (const [service] of configured) {
    const url = `${publicUrl.replace(/\/$/, '')}/api/telegram/${service.toLowerCase()}`;
    await telegram.setWebhook(service, url, secret);
    const me = await telegram.getMe(service);
    console.log(`${service}: webhook set to ${url} (bot @${me.username})`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Failed to set webhooks:', err.message);
    process.exit(1);
  });
}

module.exports = { getConfiguredBots, main };
