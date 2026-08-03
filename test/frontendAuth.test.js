const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadAuthClient(nodes) {
  const storage = new Map();
  const window = {
    fetch: async () => ({ status: 200 }),
    setTimeout,
  };
  const context = {
    Headers,
    document: { getElementById: (id) => nodes[id] || null },
    sessionStorage: {
      getItem: (key) => storage.get(key) || null,
      removeItem: (key) => storage.delete(key),
      setItem: (key, value) => storage.set(key, value),
    },
    window,
  };
  vm.runInNewContext(
    readFileSync(join(__dirname, '..', 'public', 'telegram-auth.js'), 'utf8'),
    context,
  );
  return window.gtrsgAuth;
}

test('navbar renders the admin-managed Telegram display name', () => {
  const nodes = {
    'nav-user': { hidden: true },
    'nav-user-name': { textContent: '', title: '' },
    'nav-user-avatar': { textContent: '' },
  };
  const auth = loadAuthClient(nodes);

  auth.renderUser({
    telegram_display_name: 'Yi Dan',
    telegram_username: 'different_handle',
  });

  assert.equal(nodes['nav-user'].hidden, false);
  assert.equal(nodes['nav-user-name'].textContent, 'Yi Dan');
  assert.equal(nodes['nav-user-name'].title, 'Yi Dan');
  assert.equal(nodes['nav-user-avatar'].textContent, 'Y');
});
