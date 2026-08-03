const test = require('node:test');
const assert = require('node:assert/strict');
const { createMemoryDb } = require('../src/db/memory');
const {
  createTelegramAuth,
  normalizeTelegramIdentifier,
  parsePrivateStart,
  signSession,
  verifySession,
} = require('../src/telegramAuth');
const { requireUser, requireAdmin } = require('../src/auth');

const SESSION_SECRET = 'test-session-secret-that-is-long-enough';

function fakeTelegram() {
  const messages = [];
  return {
    messages,
    async getMe(service) {
      return { id: 8764384354, username: service === 'PSA' ? 'Pax_services_bot' : 'User_login_bot' };
    },
    async sendMessage(service, chatId, html) {
      messages.push({ service, chatId: String(chatId), html });
    },
  };
}

async function seeded({ nowMs = Date.now() } = {}) {
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
  let clock = nowMs;
  const auth = createTelegramAuth({
    db,
    telegram,
    sessionSecret: SESSION_SECRET,
    now: () => clock,
    generateOtp: () => '123456',
  });
  return {
    db,
    telegram,
    auth,
    botId,
    advance(ms) { clock += ms; },
  };
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

test('Telegram OTP authenticates an approved handle through its immutable Telegram ID', async () => {
  const { auth, telegram, botId } = await seeded();
  const started = await auth.requestOtp('@YiDan');
  assert.equal(started.bot_username, 'User_login_bot');
  assert.equal(telegram.messages.length, 1);
  assert.equal(telegram.messages[0].service, botId);
  assert.equal(telegram.messages[0].chatId, '977476515');
  assert.match(telegram.messages[0].html, /123456/);

  const session = await auth.verifyOtp(started.challenge_id, started.verifier, '123456');
  assert.equal(session.status, 'authenticated');
  const user = await auth.verifyUser(requestWith(session.access_token));
  assert.equal(user.telegram_user_id, '977476515');
  assert.equal(user.role, 'user');
  assert.equal(user.bot_id, botId);
});

test('numeric Telegram IDs can request OTPs without using mutable handles', async () => {
  const { auth, telegram } = await seeded();
  await auth.requestOtp('2132609363');
  assert.equal(telegram.messages[0].service, 'PSA');
  assert.equal(telegram.messages[0].chatId, '2132609363');
});

test('unknown Telegram identifiers receive a generic challenge but no message or session', async () => {
  const { auth, telegram } = await seeded();
  const started = await auth.requestOtp('@unknown_user');
  assert.equal(started.bot_username, 'Pax_services_bot');
  assert.equal(telegram.messages.length, 0);
  await assert.rejects(
    () => auth.verifyOtp(started.challenge_id, started.verifier, '123456'),
    (error) => error.statusCode === 401
  );
});

test('OTP challenges enforce browser binding, attempt limits, and single use', async () => {
  const { auth, advance } = await seeded();
  const wrongBrowser = await auth.requestOtp('yidan');
  await assert.rejects(
    () => auth.verifyOtp(wrongBrowser.challenge_id, 'wrong-verifier', '123456'),
    (error) => error.statusCode === 401
  );

  const limited = await auth.requestOtp('kishore');
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await assert.rejects(
      () => auth.verifyOtp(limited.challenge_id, limited.verifier, '000000'),
      (error) => error.statusCode === 401
    );
  }
  await assert.rejects(
    () => auth.verifyOtp(limited.challenge_id, limited.verifier, '123456'),
    (error) => error.statusCode === 401
  );

  advance(61_000);
  const valid = await auth.requestOtp('yidan');
  await auth.verifyOtp(valid.challenge_id, valid.verifier, '123456');
  await assert.rejects(
    () => auth.verifyOtp(valid.challenge_id, valid.verifier, '123456'),
    (error) => error.statusCode === 401
  );
});

test('successfully sent OTPs have a one-minute resend cooldown', async () => {
  const context = await seeded();
  await context.auth.requestOtp('yidan');
  await assert.rejects(
    () => context.auth.requestOtp('yidan'),
    (error) => error.statusCode === 429 && error.retryAfter === 60
  );
  context.advance(61_000);
  await context.auth.requestOtp('yidan');
  assert.equal(context.telegram.messages.length, 2);
});

test('successfully sent OTPs are limited to five per hour', async () => {
  const context = await seeded();
  for (let request = 0; request < 5; request += 1) {
    await context.auth.requestOtp('yidan');
    context.advance(61_000);
  }
  await assert.rejects(
    () => context.auth.requestOtp('yidan'),
    (error) => error.statusCode === 429 && error.retryAfter === 3600
  );
  assert.equal(context.telegram.messages.length, 5);
});

test('plain private /start enrolls an approved user with the delivery bot', async () => {
  const { auth, telegram, botId } = await seeded();
  assert.equal(parsePrivateStart({ message: {
    text: '/start',
    chat: { id: 977476515, type: 'group' },
    from: { id: 977476515 },
  } }), null);
  const result = await auth.completeFromUpdate(botId, {
    message: {
      text: '/start login_setup',
      chat: { id: 977476515, type: 'private' },
      from: { id: 977476515 },
    },
  });
  assert.equal(result.handled, 'telegram_login_setup');
  assert.match(telegram.messages[0].html, /sign-in is ready/);
});

test('plain private /start ignores unknown users and the wrong delivery bot', async () => {
  const { auth, telegram } = await seeded();
  const unknown = await auth.completeFromUpdate('PSA', {
    message: {
      text: '/start login_setup',
      chat: { id: 555555555, type: 'private' },
      from: { id: 555555555 },
    },
  });
  const wrongBot = await auth.completeFromUpdate('PSA', {
    message: {
      text: '/start login_setup',
      chat: { id: 977476515, type: 'private' },
      from: { id: 977476515 },
    },
  });
  assert.equal(unknown, null);
  assert.equal(wrongBot, null);
  assert.equal(telegram.messages.length, 0);
});

test('Telegram identifiers are normalized and invalid values are rejected', () => {
  assert.equal(normalizeTelegramIdentifier('@Example_User'), 'example_user');
  assert.equal(normalizeTelegramIdentifier('2132609363'), '2132609363');
  assert.equal(normalizeTelegramIdentifier('bad handle'), null);
  assert.equal(normalizeTelegramIdentifier('abc'), null);
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
