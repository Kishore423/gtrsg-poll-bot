// Starts the current app against live Supabase data in a transaction-read-only
// local viewer. HTTP mutations are blocked by src/server.js.
require('dotenv').config({ quiet: true });
require('dotenv').config({ path: '.env.readonly', override: true, quiet: true });

if (process.env.LOCAL_READ_ONLY !== 'true') {
  throw new Error('Run "npm run setup:local-readonly" first to create .env.readonly.');
}

const { buildAppFromEnv } = require('../src/app');
const port = Number(process.env.PORT || 3001);
const app = buildAppFromEnv();

const server = app.listen(port, () => {
  console.log(`Local read-only production view running at http://localhost:${port}`);
});
server.on('error', (error) => {
  console.error(`Unable to start local read-only server: ${error.message}`);
  process.exitCode = 1;
});
