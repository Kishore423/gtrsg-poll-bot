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
      WHCL: process.env.TELEGRAM_TOKEN_WHCL, PSA: process.env.TELEGRAM_TOKEN_PSA },
    resolveToken: async (botId) => {
      if (!db?.getBot) return null;
      const bot = await db.getBot(botId);
      if (!bot || bot.enabled === false) return null;
      return decryptToken(bot.token_encrypted);
    },
  });
  if (db?.listBots) {
    try {
      const bots = (await db.listBots()).filter((bot) => bot.enabled !== false);
      if (bots.length) {
        for (const bot of bots) {
          await telegram.call(bot.id, 'deleteWebhook', { drop_pending_updates: false });
          console.log(`${bot.id}: webhook removed`);
        }
        return;
      }
    } finally {
      if (db.close) await db.close();
    }
  }
  const tokens = { PRIMARY: process.env.TELEGRAM_BOT_TOKEN,
    WHCL: process.env.TELEGRAM_TOKEN_WHCL, PSA: process.env.TELEGRAM_TOKEN_PSA };
  const legacyTelegram = createTelegramClient({ tokens });
  const configured = getConfiguredBots(process.env);
  if (!configured.length) throw new Error('Set TELEGRAM_BOT_TOKEN or the service-specific bot tokens.');
  for (const [service] of configured) {
    await legacyTelegram.call(service, 'deleteWebhook', { drop_pending_updates: false });
    console.log(`${service}: webhook removed`);
  }
}

main().catch((error) => { console.error(error.message); process.exit(1); });
