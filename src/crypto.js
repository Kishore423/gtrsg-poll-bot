const crypto = require('crypto');

// Telegram bot tokens are stored in the database (one bot per user), so they are
// encrypted at rest with AES-256-GCM. GCM is authenticated: tampering with the
// stored ciphertext fails decryption rather than silently returning garbage.
//
// BOT_TOKEN_ENC_KEY must be a base64-encoded 32-byte key and must stay stable --
// rotating or losing it makes every stored token undecryptable (recoverable only
// by re-pasting the tokens from BotFather).

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12; // 96-bit nonce, the recommended size for GCM

function loadKey(rawKey = process.env.BOT_TOKEN_ENC_KEY) {
  if (!rawKey) {
    throw new Error('BOT_TOKEN_ENC_KEY is required to encrypt/decrypt bot tokens.');
  }
  const key = Buffer.from(rawKey, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `BOT_TOKEN_ENC_KEY must decode to ${KEY_BYTES} bytes (got ${key.length}). ` +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"'
    );
  }
  return key;
}

// Returns "iv:tag:ciphertext", all base64.
function encryptToken(plaintext, rawKey) {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new Error('Cannot encrypt an empty bot token.');
  }
  const key = loadKey(rawKey);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(':');
}

function decryptToken(stored, rawKey) {
  if (typeof stored !== 'string') throw new Error('Encrypted token must be a string.');
  const parts = stored.split(':');
  if (parts.length !== 3) throw new Error('Encrypted token is malformed.');
  const key = loadKey(rawKey);
  const [iv, tag, ciphertext] = parts.map((part) => Buffer.from(part, 'base64'));
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

// Bot tokens must never reach the browser. Show only the last 4 characters so an
// admin can tell two bots apart without exposing anything usable.
function maskToken(plaintext) {
  if (typeof plaintext !== 'string' || plaintext.length < 4) return '••••';
  return `••••${plaintext.slice(-4)}`;
}

function generateWebhookSecret() {
  // Telegram allows A-Z a-z 0-9 _ - (1-256 chars); hex is safely inside that.
  return crypto.randomBytes(32).toString('hex');
}

module.exports = { encryptToken, decryptToken, maskToken, generateWebhookSecret };
