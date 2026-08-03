const test = require('node:test');
const assert = require('node:assert/strict');
const { getConfiguredBots } = require('../scripts/set-webhook');

test('webhook configuration includes every explicitly configured bot', () => {
  assert.deepEqual(getConfiguredBots({
    TELEGRAM_TOKEN_WHCL: 'whcl-token',
    TELEGRAM_TOKEN_PSA: 'psa-token',
    TELEGRAM_LOGIN_BOT_TOKEN: 'login-token',
  }), [['WHCL', 'whcl-token'], ['PSA', 'psa-token'], ['LOGIN', 'login-token']]);
});

test('webhook configuration rejects one token assigned to multiple routes', () => {
  assert.throws(() => getConfiguredBots({
    TELEGRAM_BOT_TOKEN: 'same-token',
    TELEGRAM_TOKEN_WHCL: 'same-token',
  }), /only one webhook URL/);
});
