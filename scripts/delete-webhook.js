require('dotenv').config();
const { createTelegramClient } = require('../src/telegram');
const { getConfiguredBots } = require('./set-webhook');
const { decryptToken } = require('../src/crypto');

async function main() {
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
  let removedDbBots = false;
  if (db?.listBots) {
    try {
      const bots = (await db.listBots()).filter((bot) => bot.enabled !== false);
      if (bots.length) {
        removedDbBots = true;
        for (const bot of bots) {
          await telegram.call(bot.id, 'deleteWebhook', { drop_pending_updates: false });
          console.log(`${bot.id}: webhook removed`);
        }
      }
    } finally {
      if (db.close) await db.close();
    }
  }
  const tokens = { PRIMARY: process.env.TELEGRAM_BOT_TOKEN,
    WHCL: process.env.TELEGRAM_TOKEN_WHCL, PSA: process.env.TELEGRAM_TOKEN_PSA,
    LOGIN: process.env.TELEGRAM_LOGIN_BOT_TOKEN };
  const legacyTelegram = createTelegramClient({ tokens });
  const configured = getConfiguredBots(process.env)
    .filter(([service]) => !removedDbBots || service === 'LOGIN');
  if (!configured.length && !removedDbBots) {
    throw new Error('Set a polling bot token or TELEGRAM_LOGIN_BOT_TOKEN.');
  }
  for (const [service] of configured) {
    await legacyTelegram.call(service, 'deleteWebhook', { drop_pending_updates: false });
    console.log(`${service}: webhook removed`);
  }
}

main().catch((error) => { console.error(error.message); process.exit(1); });
