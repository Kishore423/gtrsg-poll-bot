const test = require('node:test');
const assert = require('node:assert/strict');
const { createTelegramClient } = require('../src/telegram');

test('Telegram client retries transient failures and returns the successful result', async () => {
  let calls = 0;
  const client = createTelegramClient({ tokens: { PRIMARY: 'token' }, fetchImpl: async () => {
    calls += 1;
    return new Response(JSON.stringify(calls < 3
      ? { ok: false, error_code: 500, description: 'temporary' }
      : { ok: true, result: { id: 1 } }), { headers: { 'Content-Type': 'application/json' } });
  } });
  assert.deepEqual(await client.call('PRIMARY', 'getMe', {}), { id: 1 });
  assert.equal(calls, 3);
});

test('Telegram client does not retry permanent API errors', async () => {
  let calls = 0;
  const client = createTelegramClient({ tokens: { PRIMARY: 'token' }, fetchImpl: async () => {
    calls += 1;
    return new Response(JSON.stringify({ ok: false, error_code: 400, description: 'bad request' }),
      { headers: { 'Content-Type': 'application/json' } });
  } });
  await assert.rejects(client.call('PRIMARY', 'sendPoll', {}), /400 bad request/);
  assert.equal(calls, 1);
});
