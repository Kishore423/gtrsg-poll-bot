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
  const classes = new Set();
  const nodes = {
    'nav-user': { hidden: true },
    'nav-user-name': { textContent: '', title: '' },
    'nav-user-avatar': {
      textContent: '',
      style: {},
      classList: { toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name) },
    },
  };
  const auth = loadAuthClient(nodes);

  auth.renderUser({
    telegram_display_name: 'Yi Dan',
    telegram_username: 'different_handle',
    profile_photo_data: 'data:image/png;base64,cGhvdG8=',
  });

  assert.equal(nodes['nav-user'].hidden, false);
  assert.equal(nodes['nav-user-name'].textContent, 'Yi Dan');
  assert.equal(nodes['nav-user-name'].title, 'Yi Dan');
  assert.equal(nodes['nav-user-avatar'].textContent, 'Y');
  assert.match(nodes['nav-user-avatar'].style.backgroundImage, /data:image\/png/);
  assert.equal(classes.has('has-photo'), true);
});

test('every signed-in page includes the shared account actions', () => {
  for (const file of ['index.html', 'polls.html', 'admin.html']) {
    const html = readFileSync(join(__dirname, '..', 'public', file), 'utf8');
    assert.match(html, /id="nav-upload-photo"/);
    assert.match(html, /id="nav-profile-photo-input"/);
    assert.match(html, /id="nav-sign-out"/);
  }
});

test('profile viewer controls are created by the shared auth client', () => {
  const source = readFileSync(join(__dirname, '..', 'public', 'telegram-auth.js'), 'utf8');
  assert.match(source, /id="close-profile-viewer"/);
  assert.match(source, /id="delete-profile-photo"/);
  assert.match(source, /method: 'DELETE'/);
});
