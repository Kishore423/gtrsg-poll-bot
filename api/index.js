// Vercel serverless entry. vercel.json rewrites every path to here, so the one
// Express app handles the UI, management APIs, Telegram webhooks, and cron.
const { buildAppFromEnv } = require('../src/app');

module.exports = buildAppFromEnv();
