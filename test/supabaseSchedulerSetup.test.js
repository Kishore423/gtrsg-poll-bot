const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

test('Supabase scheduler setup registers a protected every-minute production trigger', () => {
  const source = readFileSync(
    join(__dirname, '..', 'scripts', 'setup-supabase-scheduler.js'),
    'utf8'
  );
  const packageJson = require('../package.json');

  assert.equal(packageJson.scripts['scheduler:setup'], 'node scripts/setup-supabase-scheduler.js');
  assert.match(source, /create extension if not exists pg_cron/);
  assert.match(source, /create extension if not exists pg_net/);
  assert.match(source, /vault\.decrypted_secrets/);
  assert.match(source, /\/api\/cron\/scheduler/);
  assert.match(source, /Authorization/);
  assert.match(source, /'\* \* \* \* \*'/);
  assert.doesNotMatch(source, /Bearer [A-Za-z0-9_-]{20,}/);
});
