const crypto = require('crypto');

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_SECONDS = 12 * 60 * 60;

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function bearerToken(req) {
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  return match ? match[1] : null;
}

function signSession(secret, telegramUserId, nowMs, ttlSeconds) {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const issuedAt = Math.floor(nowMs / 1000);
  const payload = base64url(JSON.stringify({
    sub: String(telegramUserId),
    iat: issuedAt,
    exp: issuedAt + ttlSeconds,
    v: 1,
  }));
  const body = `${header}.${payload}`;
  const signature = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${signature}`;
}

function verifySession(secret, token, nowMs) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;
  const body = `${header}.${payload}`;
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  if (!safeEqual(signature, expected)) return null;

  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (claims.v !== 1 || !claims.sub || Number(claims.exp) <= Math.floor(nowMs / 1000)) return null;
    return claims;
  } catch {
    return null;
  }
}

function parseLoginStart(update) {
  const message = update?.message;
  if (!message || message.chat?.type !== 'private' || !message.from?.id) return null;
  const match = /^\/start(?:@\w+)?\s+login_([A-Za-z0-9_-]{20,48})$/.exec(
    String(message.text || '').trim()
  );
  if (!match) return null;
  return {
    challengeId: match[1],
    chatId: message.chat.id,
    telegramUserId: String(message.from.id),
    telegramUsername: message.from.username || null,
    displayName: [message.from.first_name, message.from.last_name].filter(Boolean).join(' ') || 'Telegram user',
  };
}

function createTelegramAuth({
  db,
  telegram,
  sessionSecret,
  authBotKey = 'PSA',
  now = () => Date.now(),
  challengeTtlMs = CHALLENGE_TTL_MS,
  sessionTtlSeconds = SESSION_TTL_SECONDS,
} = {}) {
  if (!db) throw new Error('Telegram auth requires a database');
  if (sessionSecret && Buffer.byteLength(sessionSecret) < 32) {
    throw new Error('APP_SESSION_SECRET must be at least 32 characters');
  }

  async function startLogin() {
    if (!sessionSecret || !telegram) throw new Error('Telegram login is not configured');
    const id = crypto.randomBytes(18).toString('base64url');
    const verifier = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(now() + challengeTtlMs).toISOString();
    await db.createTelegramLoginChallenge({
      id,
      verifier_hash: sha256(verifier),
      expires_at: expiresAt,
    });
    const bot = await telegram.getMe(authBotKey);
    if (!bot?.username) throw new Error('The Telegram login bot needs a username');
    return {
      challenge_id: id,
      verifier,
      expires_at: expiresAt,
      bot_username: bot.username,
      login_url: `https://t.me/${bot.username}?start=login_${id}`,
    };
  }

  async function completeFromUpdate(service, update) {
    if (String(service).toUpperCase() !== String(authBotKey).toUpperCase()) return null;
    const login = parseLoginStart(update);
    if (!login) return null;
    const challenge = await db.completeTelegramLoginChallenge(login.challengeId, {
      telegram_user_id: login.telegramUserId,
      telegram_username: login.telegramUsername,
      telegram_display_name: login.displayName,
    });
    if (!challenge) {
      await telegram.sendMessage(authBotKey, login.chatId,
        'This sign-in request has expired. Return to the website and start again.');
      return { handled: 'telegram_login_expired' };
    }
    await telegram.sendMessage(authBotKey, login.chatId,
      '<b>Sign-in confirmed.</b>\nReturn to the GTRSG Poll Bot website to continue.');
    return { handled: 'telegram_login' };
  }

  async function finishLogin(challengeId, verifier) {
    const challenge = await db.getTelegramLoginChallenge(challengeId);
    if (!challenge || !safeEqual(challenge.verifier_hash, sha256(verifier))) {
      const error = new Error('Invalid sign-in request');
      error.statusCode = 401;
      throw error;
    }
    if (new Date(challenge.expires_at).getTime() <= now()) {
      const error = new Error('This sign-in request has expired');
      error.statusCode = 410;
      throw error;
    }
    if (!challenge.telegram_user_id) return { status: 'waiting_for_telegram' };

    const user = await db.getAppUserByTelegramId(challenge.telegram_user_id);
    if (!user || user.enabled === false) {
      await db.upsertTelegramAccessRequest({
        telegram_user_id: challenge.telegram_user_id,
        telegram_username: challenge.telegram_username,
        telegram_display_name: challenge.telegram_display_name,
      });
      return {
        status: 'pending_approval',
        telegram_username: challenge.telegram_username,
        telegram_display_name: challenge.telegram_display_name,
      };
    }

    if (db.setAppUserTelegramIdentity) {
      await db.setAppUserTelegramIdentity(user.id, {
        telegram_user_id: challenge.telegram_user_id,
        telegram_username: challenge.telegram_username,
        telegram_display_name: challenge.telegram_display_name,
      });
    }
    const accessToken = signSession(
      sessionSecret,
      challenge.telegram_user_id,
      now(),
      sessionTtlSeconds
    );
    return {
      status: 'authenticated',
      access_token: accessToken,
      expires_at: Math.floor(now() / 1000) + sessionTtlSeconds,
    };
  }

  async function verifyUser(req) {
    if (!sessionSecret) return null;
    const claims = verifySession(sessionSecret, bearerToken(req), now());
    if (!claims) return null;
    const appUser = await db.getAppUserByTelegramId(claims.sub);
    if (!appUser || appUser.enabled === false) return null;
    return {
      id: appUser.id,
      telegram_user_id: String(appUser.telegram_user_id),
      telegram_username: appUser.telegram_username || null,
      telegram_display_name: appUser.telegram_display_name || null,
      role: appUser.role,
      bot_id: appUser.bot_id || null,
    };
  }

  return { startLogin, completeFromUpdate, finishLogin, verifyUser };
}

module.exports = {
  createTelegramAuth,
  parseLoginStart,
  signSession,
  verifySession,
};
