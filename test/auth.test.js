const test = require('node:test');
const assert = require('node:assert/strict');
const { createMemoryDb } = require('../src/db/memory');
const { createTelegramAuth, parseLoginStart, signSession, verifySession } = require('../src/telegramAuth');
const { requireUser, requireAdmin } = require('../src/auth');

const SESSION_SECRET = 'test-session-secret-that-is-long-enough';

function fakeTelegram() {
  const messages = [];
  return {
    messages,
    async getMe() {
      return { id: 8764384354, username: 'Pax_services_bot' };
    },
    async sendMessage(service, chatId, html) {
      messages.push({ service, chatId, html });
    },
  };
}

async function seeded() {
  const db = createMemoryDb();
  const telegram = fakeTelegram();
  const botId = await db.createBot({
    bot_name: 'User bot',
    token_encrypted: 'enc',
    webhook_secret: 'secret',
  });
  await db.createAppUser({
    telegram_user_id: '977476515',
    telegram_username: 'yidan',
    telegram_display_name: 'Yi Dan',
    role: 'user',
    bot_id: botId,
  });
  await db.createAppUser({
    telegram_user_id: '2132609363',
    telegram_username: 'kishore',
    telegram_display_name: 'Kishore',
    role: 'admin',
  });
  const auth = createTelegramAuth({ db, telegram, sessionSecret: SESSION_SECRET });
  return { db, telegram, auth, botId };
}

function requestWith(token) {
  return { headers: token ? { authorization: `Bearer ${token}` } : {} };
}

function runMiddleware(middleware, req) {
  return new Promise((resolve) => {
    const res = {
      statusCode: null,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ status: this.statusCode, body, passed: false }); },
    };
    middleware(req, res, () => resolve({ status: 200, passed: true, req }));
  });
}

test('Telegram login challenge authenticates a provisioned user', async () => {
  const { auth, telegram, botId } = await seeded();
  const started = await auth.startLogin();
  assert.match(started.login_url, /^https:\/\/t\.me\/Pax_services_bot\?start=login_/);

  const completed = await auth.completeFromUpdate('PSA', {
    message: {
      text: `/start login_${started.challenge_id}`,
      chat: { id: 977476515, type: 'private' },
      from: { id: 977476515, username: 'yidan', first_name: 'Yi', last_name: 'Dan' },
    },
  });
  assert.equal(completed.handled, 'telegram_login');
  assert.equal(telegram.messages.length, 1);

  const session = await auth.finishLogin(started.challenge_id, started.verifier);
  assert.equal(session.status, 'authenticated');
  const user = await auth.verifyUser(requestWith(session.access_token));
  assert.equal(user.telegram_user_id, '977476515');
  assert.equal(user.role, 'user');
  assert.equal(user.bot_id, botId);
});

test('unknown Telegram identities fail closed and create a pending request', async () => {
  const { db, auth } = await seeded();
  const started = await auth.startLogin();
  await auth.completeFromUpdate('PSA', {
    message: {
      text: `/start login_${started.challenge_id}`,
      chat: { id: 555, type: 'private' },
      from: { id: 555, username: 'new_user', first_name: 'New' },
    },
  });
  const result = await auth.finishLogin(started.challenge_id, started.verifier);
  assert.equal(result.status, 'pending_approval');
  assert.equal(await auth.verifyUser(requestWith('invalid')), null);
  const requests = await db.listTelegramAccessRequests({ status: 'pending' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].telegram_user_id, '555');
});

test('a challenge cannot be polled without its browser verifier', async () => {
  const { auth } = await seeded();
  const started = await auth.startLogin();
  await assert.rejects(
    () => auth.finishLogin(started.challenge_id, 'wrong-verifier'),
    (error) => error.statusCode === 401
  );
});

test('login start parser only accepts private Telegram start messages', () => {
  assert.equal(parseLoginStart({ message: {
    text: '/start login_abcdefghijklmnopqrstuvwxyz',
    chat: { id: 1, type: 'group' },
    from: { id: 1 },
  } }), null);
  assert.equal(parseLoginStart({ message: {
    text: '/start something_else',
    chat: { id: 1, type: 'private' },
    from: { id: 1 },
  } }), null);
});

test('signed sessions reject tampering and expiration', () => {
  const now = Date.now();
  const token = signSession(SESSION_SECRET, '123', now, 60);
  assert.equal(verifySession(SESSION_SECRET, token, now).sub, '123');
  assert.equal(verifySession(SESSION_SECRET, `${token}x`, now), null);
  assert.equal(verifySession(SESSION_SECRET, token, now + 61_000), null);
});

test('route guards require a valid Telegram session and preserve admin RBAC', async () => {
  const { auth } = await seeded();
  const missing = await runMiddleware(requireUser(auth.verifyUser), requestWith(null));
  assert.equal(missing.status, 401);

  const userToken = signSession(SESSION_SECRET, '977476515', Date.now(), 60);
  const asUser = await runMiddleware(requireAdmin(auth.verifyUser), requestWith(userToken));
  assert.equal(asUser.status, 403);

  const adminToken = signSession(SESSION_SECRET, '2132609363', Date.now(), 60);
  const asAdmin = await runMiddleware(requireAdmin(auth.verifyUser), requestWith(adminToken));
  assert.equal(asAdmin.passed, true);
  assert.equal(asAdmin.req.appUser.role, 'admin');
});
