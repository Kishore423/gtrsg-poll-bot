require('dotenv').config();
const { createTelegramClient } = require('../src/telegram');
const { getConfiguredBots } = require('./set-webhook');

async function main() {
  const tokens = { PRIMARY: process.env.TELEGRAM_BOT_TOKEN,
    WHCL: process.env.TELEGRAM_TOKEN_WHCL, PSA: process.env.TELEGRAM_TOKEN_PSA };
  const telegram = createTelegramClient({ tokens });
  const configured = getConfiguredBots(process.env);
  if (!configured.length) throw new Error('Set TELEGRAM_BOT_TOKEN or the service-specific bot tokens.');
  for (const [service] of configured) {
    await telegram.call(service, 'deleteWebhook', { drop_pending_updates: false });
    console.log(`${service}: webhook removed`);
  }
}

main().catch((error) => { console.error(error.message); process.exit(1); });
