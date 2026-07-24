const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { encryptToken, decryptToken, maskToken, generateWebhookSecret } = require('../src/crypto');

const KEY = crypto.randomBytes(32).toString('base64');
const TOKEN = 'fake-token-for-encryption-tests-only';

test('encryptToken/decryptToken round-trips a bot token', () => {
  const stored = encryptToken(TOKEN, KEY);
  assert.notEqual(stored, TOKEN);
  assert.doesNotMatch(stored, /encryption-tests/); // plaintext must not appear in storage
  assert.equal(decryptToken(stored, KEY), TOKEN);
});

test('encryptToken uses a fresh IV so identical tokens differ at rest', () => {
  assert.notEqual(encryptToken(TOKEN, KEY), encryptToken(TOKEN, KEY));
});

test('decryptToken rejects a tampered ciphertext (GCM auth tag)', () => {
  const [iv, tag, ciphertext] = encryptToken(TOKEN, KEY).split(':');
  const flipped = Buffer.from(ciphertext, 'base64');
  flipped[0] ^= 0xff;
  const tampered = [iv, tag, flipped.toString('base64')].join(':');
  assert.throws(() => decryptToken(tampered, KEY));
});

test('decryptToken fails with the wrong key', () => {
  const stored = encryptToken(TOKEN, KEY);
  const otherKey = crypto.randomBytes(32).toString('base64');
  assert.throws(() => decryptToken(stored, otherKey));
});

test('a malformed or wrong-sized key is rejected with a helpful message', () => {
  assert.throws(() => encryptToken(TOKEN, Buffer.alloc(16).toString('base64')), /32 bytes/);
  assert.throws(() => encryptToken(TOKEN, ''), /BOT_TOKEN_ENC_KEY is required/);
  assert.throws(() => decryptToken('not-a-valid-blob', KEY), /malformed/);
});

test('maskToken never reveals a usable token', () => {
  assert.equal(maskToken(TOKEN), '••••a7aOo'.slice(0, 4) + TOKEN.slice(-4));
  assert.doesNotMatch(maskToken(TOKEN), /encryption-tests/);
  assert.equal(maskToken(''), '••••');
});

test('generateWebhookSecret returns a unique Telegram-safe secret', () => {
  const a = generateWebhookSecret();
  const b = generateWebhookSecret();
  assert.notEqual(a, b);
  assert.match(a, /^[A-Za-z0-9_-]{1,256}$/);
});
