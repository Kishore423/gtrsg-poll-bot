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

test('Telegram client resolves dynamic bot tokens and supports name sync calls', async () => {
  const seen = [];
  const client = createTelegramClient({
    resolveToken: async (botId) => `token-for-${botId}`,
    fetchImpl: async (url, init) => {
      seen.push({ url, body: JSON.parse(init.body) });
      const method = /\/([^/]+)$/.exec(url)[1];
      const result = method === 'getMyName' ? { name: 'User bot' } : true;
      return new Response(JSON.stringify({ ok: true, result }), {
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });

  assert.deepEqual(await client.getMyName('bot-123'), { name: 'User bot' });
  assert.equal(await client.getChat('bot-123', '998877'), true);
  assert.equal(await client.setMyName('bot-123', 'New bot name'), true);
  assert.match(seen[0].url, /bottoken-for-bot-123\/getMyName$/);
  assert.match(seen[1].url, /bottoken-for-bot-123\/getChat$/);
  assert.deepEqual(seen[1].body, { chat_id: '998877' });
  assert.deepEqual(seen[2].body, { name: 'New bot name' });
});
