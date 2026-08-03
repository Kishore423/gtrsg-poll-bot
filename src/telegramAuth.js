const crypto = require('crypto');

const OTP_TTL_MS = 5 * 60 * 1000;
const OTP_RESEND_COOLDOWN_MS = 60 * 1000;
const OTP_SEND_WINDOW_MS = 60 * 60 * 1000;
const OTP_MAX_SENDS_PER_WINDOW = 5;
const OTP_MAX_ATTEMPTS = 5;
const SESSION_TTL_SECONDS = 12 * 60 * 60;

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function hmac(secret, value) {
  return crypto.createHmac('sha256', secret).update(String(value)).digest('hex');
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

function normalizeTelegramIdentifier(value) {
  const identifier = String(value || '').trim().replace(/^@/, '');
  if (/^\d{5,20}$/.test(identifier)) return identifier;
  if (/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(identifier)) return identifier.toLowerCase();
  return null;
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

function authError(message, statusCode = 401, extra = {}) {
  const error = new Error(message);
  error.statusCode = statusCode;
  Object.assign(error, extra);
  return error;
}

function parsePrivateStart(update) {
  const message = update?.message;
  if (!message || message.chat?.type !== 'private' || !message.from?.id) return null;
  if (!/^\/start(?:@\w+)?(?:\s.*)?$/.test(String(message.text || '').trim())) return null;
  return {
    chatId: message.chat.id,
    telegramUserId: String(message.from.id),
  };
}

function createTelegramAuth({
  db,
  telegram,
  sessionSecret,
  authBotKey = 'LOGIN',
  loginWebhookUrl = null,
  loginWebhookSecret = null,
  now = () => Date.now(),
  otpTtlMs = OTP_TTL_MS,
  otpResendCooldownMs = OTP_RESEND_COOLDOWN_MS,
  otpSendWindowMs = OTP_SEND_WINDOW_MS,
  otpMaxSendsPerWindow = OTP_MAX_SENDS_PER_WINDOW,
  otpMaxAttempts = OTP_MAX_ATTEMPTS,
  sessionTtlSeconds = SESSION_TTL_SECONDS,
  generateOtp = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0'),
} = {}) {
  if (!db) throw new Error('Telegram auth requires a database');
  if (sessionSecret && Buffer.byteLength(sessionSecret) < 32) {
    throw new Error('APP_SESSION_SECRET must be at least 32 characters');
  }
  let loginWebhookPromise = null;

  async function ensureLoginWebhook() {
    if (!loginWebhookUrl || !loginWebhookSecret || !telegram?.setWebhook) return;
    if (!loginWebhookPromise) {
      loginWebhookPromise = telegram
        .setWebhook(authBotKey, loginWebhookUrl, loginWebhookSecret)
        .catch((error) => {
          loginWebhookPromise = null;
          throw error;
        });
    }
    await loginWebhookPromise;
  }

  async function requestOtp(rawIdentifier) {
    if (!sessionSecret || !telegram) throw new Error('Telegram login is not configured');
    const identifier = normalizeTelegramIdentifier(rawIdentifier);
    if (!identifier) {
      throw authError('Enter a valid Telegram ID or handle', 400);
    }

    await ensureLoginWebhook();
    const user = db.getAppUserByTelegramIdentifier
      ? await db.getAppUserByTelegramIdentifier(identifier)
      : await db.getAppUserByTelegramId(identifier);
    const deliveryBotKey = authBotKey;
    const bot = await telegram.getMe(deliveryBotKey);
    if (!bot?.username) throw new Error('The Telegram login bot needs a username');

    if (user && db.getLatestSentTelegramLoginChallenge) {
      const latest = await db.getLatestSentTelegramLoginChallenge(user.telegram_user_id);
      const waitMs = latest ? otpResendCooldownMs - (now() - new Date(latest.sent_at).getTime()) : 0;
      if (waitMs > 0) {
        throw authError('Please wait before requesting another code', 429, {
          retryAfter: Math.ceil(waitMs / 1000),
          botUsername: bot.username,
        });
      }
      if (db.countSentTelegramLoginChallengesSince) {
        const windowStart = new Date(now() - otpSendWindowMs).toISOString();
        const sentCount = await db.countSentTelegramLoginChallengesSince(
          user.telegram_user_id,
          windowStart
        );
        if (sentCount >= otpMaxSendsPerWindow) {
          throw authError('Too many codes requested. Please try again later', 429, {
            retryAfter: Math.ceil(otpSendWindowMs / 1000),
            botUsername: bot.username,
          });
        }
      }
    }

    const id = crypto.randomBytes(18).toString('base64url');
    const verifier = crypto.randomBytes(32).toString('base64url');
    const otp = generateOtp();
    const createdAt = new Date(now()).toISOString();
    const expiresAt = new Date(now() + otpTtlMs).toISOString();
    if (user) {
      await db.createTelegramLoginChallenge({
        id,
        verifier_hash: sha256(verifier),
        telegram_user_id: user.telegram_user_id,
        otp_hash: hmac(sessionSecret, `${id}:${otp}`),
        expires_at: expiresAt,
        created_at: createdAt,
      });
      try {
        await telegram.sendMessage(deliveryBotKey, user.telegram_user_id,
          `<b>Your Gops poll sign-in code</b>\n\n<code>${otp}</code>\n\n` +
          'This code expires in 5 minutes. Do not share it with anyone.');
        if (db.markTelegramLoginChallengeSent) {
          await db.markTelegramLoginChallengeSent(id, createdAt);
        }
      } catch {
        // Keep the response generic so this endpoint cannot enumerate approved users.
      }
    }

    return {
      challenge_id: id,
      verifier,
      expires_at: expiresAt,
      bot_username: bot.username,
      setup_url: `https://t.me/${bot.username}?start=login_setup`,
    };
  }

  async function verifyOtp(challengeId, verifier, rawCode) {
    const code = String(rawCode || '').trim();
    if (!challengeId || !verifier || !/^\d{6}$/.test(code)) {
      throw authError('Enter the six-digit code sent to Telegram', 400);
    }
    const attempt = await db.consumeTelegramLoginChallenge({
      id: String(challengeId),
      verifier_hash: sha256(verifier),
      otp_hash: hmac(sessionSecret, `${challengeId}:${code}`),
      max_attempts: otpMaxAttempts,
      now: new Date(now()).toISOString(),
    });
    if (!attempt || attempt.matched !== true || !attempt.telegram_user_id) {
      throw authError('The code is incorrect or has expired');
    }

    const user = await db.getAppUserByTelegramId(attempt.telegram_user_id);
    if (!user || user.enabled === false) {
      throw authError('This Telegram account is not approved');
    }
    const accessToken = signSession(
      sessionSecret,
      user.telegram_user_id,
      now(),
      sessionTtlSeconds
    );
    return {
      status: 'authenticated',
      access_token: accessToken,
      expires_at: Math.floor(now() / 1000) + sessionTtlSeconds,
    };
  }

  async function completeFromUpdate(service, update) {
    const start = parsePrivateStart(update);
    if (!start) return null;
    const user = await db.getAppUserByTelegramId(start.telegramUserId);
    if (!user) return null;
    if (String(service).toUpperCase() !== String(authBotKey).toUpperCase()) return null;
    await telegram.sendMessage(service, start.chatId,
      '<b>Telegram sign-in is ready.</b>\nReturn to the Gops poll website and request a code.');
    return { handled: 'telegram_login_setup' };
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
      profile_photo_data: appUser.profile_photo_data || null,
      role: appUser.role,
      bot_id: appUser.bot_id || null,
    };
  }

  return { requestOtp, verifyOtp, completeFromUpdate, verifyUser };
}

module.exports = {
  createTelegramAuth,
  normalizeTelegramIdentifier,
  parsePrivateStart,
  signSession,
  verifySession,
};
