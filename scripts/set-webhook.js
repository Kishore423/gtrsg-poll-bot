// Registers each bot's webhook so Telegram delivers votes / group events to the
// deployed site. Run after the first Vercel deploy and whenever the URL changes:
//   APP_URL=https://your-app.vercel.app \
//   TELEGRAM_TOKEN_WHCL=... TELEGRAM_TOKEN_PSA=... \
//   TELEGRAM_WEBHOOK_SECRET=... node scripts/set-webhook.js
require('dotenv').config();
const { createTelegramClient } = require('../src/telegram');

function getConfiguredBots(env) {
  const configured = [
    ['PRIMARY', env.TELEGRAM_BOT_TOKEN],
    ['WHCL', env.TELEGRAM_TOKEN_WHCL],
    ['PSA', env.TELEGRAM_TOKEN_PSA],
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
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) throw new Error('Set TELEGRAM_WEBHOOK_SECRET.');

  const telegram = createTelegramClient({
    tokens: { PRIMARY: process.env.TELEGRAM_BOT_TOKEN,
      WHCL: process.env.TELEGRAM_TOKEN_WHCL, PSA: process.env.TELEGRAM_TOKEN_PSA },
  });

  // Register a webhook for EVERY configured token. A service token that merely
  // falls back to the PRIMARY token is skipped: the same bot must not have two
  // webhook URLs (the second setWebhook would overwrite the first).
  const configured = getConfiguredBots(process.env);
  if (configured.length === 0) {
    throw new Error('Set TELEGRAM_BOT_TOKEN and/or TELEGRAM_TOKEN_WHCL / TELEGRAM_TOKEN_PSA.');
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
