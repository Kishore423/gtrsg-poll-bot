// Local dev server (npm start). On Vercel the app runs serverless via
// api/index.js instead; this is only for running on your own machine.
//
// Tip: `DB_DRIVER=memory npm start` runs the whole UI with no database, though
// data resets on restart and Telegram sending needs real bot tokens.
require('dotenv').config();
const { buildAppFromEnv } = require('./app');

const port = process.env.PORT || 3000;
const app = buildAppFromEnv();
const server = app.listen(port, () => {
  const baseUrl = process.env.APP_URL || `http://localhost:${port}`;
  console.log(`GTRSG poll bot running at ${baseUrl}`);
});
server.on('error', (err) => {
  console.error('Fatal: web server failed to start:', err.message);
  process.exit(1);
});
