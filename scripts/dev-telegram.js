// Local end-to-end test harness for the Telegram bots WITHOUT deploying.
// Runs the real UI + a live Telegram connection using long-polling (getUpdates)
// instead of webhooks, so you can add a bot to a group and try the whole flow
// from your own machine. Data lives in memory and resets on restart.
//
//   TELEGRAM_TOKEN_WHCL=... node scripts/dev-telegram.js
//   (optionally TELEGRAM_TOKEN_PSA=... to poll both bots)
//
// Then open http://localhost:3000, add @your_bot to a group, and go.
require('dotenv').config();
const { createServer } = require('../src/server');
const { createMemoryDb } = require('../src/db/memory');
const { createTelegramClient } = require('../src/telegram');
const { processTelegramUpdate } = require('../src/processUpdate');

const SERVICES = ['WHCL', 'PSA'];
const ALLOWED = ['poll_answer', 'my_chat_member', 'message'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pollLoop(db, telegram, service) {
  // Long-polling and webhooks are mutually exclusive; clear any webhook first.
  await telegram.call(service, 'deleteWebhook', { drop_pending_updates: false });
  const me = await telegram.call(service, 'getMe');
  console.log(`[${service}] polling as @${me.username} — add it to your ${service} group`);

  let offset = 0;
  for (;;) {
    try {
      const updates = await telegram.call(service, 'getUpdates', {
        offset,
        timeout: 30,
        allowed_updates: ALLOWED,
      });
      for (const update of updates) {
        offset = update.update_id + 1;
        const result = await processTelegramUpdate(db, service, update);
        if (result.summary) console.log(`[${service}] ${result.summary}`);
      }
    } catch (err) {
      console.error(`[${service}] poll error: ${err.message}`);
      await sleep(3000);
    }
  }
}

async function main() {
  const tokens = { WHCL: process.env.TELEGRAM_TOKEN_WHCL, PSA: process.env.TELEGRAM_TOKEN_PSA };
  const active = SERVICES.filter((s) => tokens[s]);
  if (active.length === 0) throw new Error('Set TELEGRAM_TOKEN_WHCL (and/or _PSA) first.');

  const db = createMemoryDb();
  const telegram = createTelegramClient({ tokens });
  const options = {
    labelService: process.env.LABEL_SERVICE_IN_POLL === 'true',
    confirmationHour: Number(process.env.CONFIRMATION_HOUR || 8),
    confirmationTimezoneOffset: process.env.CONFIRMATION_TIMEZONE_OFFSET || '+08:00',
    enableLegacyWorkflow: true,
  };

  const port = process.env.PORT || 3000;
  createServer(db, telegram, options).listen(port, () => {
    console.log(`UI running at http://localhost:${port}  (in-memory; resets on restart)`);
  });

  await Promise.all(active.map((s) => pollLoop(db, telegram, s)));
}

main().catch((err) => {
  console.error('dev-telegram failed:', err.message);
  process.exit(1);
});
