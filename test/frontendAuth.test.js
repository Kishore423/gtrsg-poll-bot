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

test('Home and Polls expose an Admin nav item only through role-gated markup', () => {
  for (const file of ['index.html', 'polls.html']) {
    const html = readFileSync(join(__dirname, '..', 'public', file), 'utf8');
    assert.match(html, /<li[^>]*data-admin-nav[^>]*hidden[^>]*><a href="\/admin">Admin<\/a><\/li>/);
  }

  const pollsSource = readFileSync(join(__dirname, '..', 'public', 'polls.js'), 'utf8');
  assert.match(pollsSource, /element\.hidden = user\?\.role !== 'admin'/);
  assert.match(pollsSource, /renderRoleNavigation\(currentUser\)/);
});

test('profile viewer controls are created by the shared auth client', () => {
  const source = readFileSync(join(__dirname, '..', 'public', 'telegram-auth.js'), 'utf8');
  assert.match(source, /id="close-profile-viewer"/);
  assert.match(source, /id="delete-profile-photo"/);
  assert.match(source, /method: 'DELETE'/);
});

test('admin Home scopes managed groups through a display-name user search', () => {
  const html = readFileSync(join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const source = readFileSync(join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(html, /id="admin-managed-user-search"/);
  assert.match(html, /id="admin-managed-user-options"/);
  assert.match(source, /telegram_display_name/);
  assert.match(source, /String\(group\.bot_id\) === String\(selectedUser\.bot_id\)/);
});

test('managed group labels use only the stored Telegram group name', () => {
  const source = readFileSync(join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(source, /function managedGroupOptionLabel\(group\) \{\s*return group\.group_name \|\| '';\s*\}/);
  assert.doesNotMatch(source, /return `\$\{name\} \(\$\{label\}\)`/);
});

test('managed workflows stay bound to the clicked group without duplicate selectors', () => {
  const html = readFileSync(join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const theme = readFileSync(join(__dirname, '..', 'public', 'theme.css'), 'utf8');
  const source = readFileSync(join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.doesNotMatch(html, /id="unified-group-select"/);
  assert.doesNotMatch(html, /class="managed-group-select"/);
  assert.doesNotMatch(html, /data-group-workflow="test"/);
  assert.match(html, /type="hidden" id="weekly-send-group"/);
  assert.match(html, /type="hidden" name="telegram_group_id"/);
  assert.match(html, /id="weekly-send-test"/);
  assert.match(html, /id="send-test-poll"/);
  assert.equal((html.match(/class="secondary workflow-action"/g) || []).length, 3);
  assert.match(html, /data-lucide="calendar-range"/);
  assert.match(html, /data-lucide="calendar-x-2"/);
  assert.match(html, /data-lucide="square-pen"/);
  assert.match(theme, /\.group-dialog-actions\s*\{[\s\S]*?grid-template-columns:\s*1fr/);
  assert.doesNotMatch(source, /class="danger-link delete-group"/);
  assert.doesNotMatch(source, /querySelectorAll\('\.delete-group'\)/);
  assert.ok(
    html.indexOf('</main>') < html.indexOf('id="group-action-dialog"'),
    'viewport dialog must be outside the transformed main element',
  );
});

test('shared dimensional theme and icon runtime load on every application page', () => {
  for (const page of ['index.html', 'polls.html', 'admin.html']) {
    const html = readFileSync(join(__dirname, '..', 'public', page), 'utf8');
    assert.match(html, /href="\/theme\.css"/);
    assert.match(html, /src="\/vendor\/lucide\.min\.js"/);
    assert.match(html, /src="\/theme\.js"/);
    assert.match(html, /class="brand-mark"/);
  }

  const theme = readFileSync(join(__dirname, '..', 'public', 'theme.css'), 'utf8');
  const runtime = readFileSync(join(__dirname, '..', 'public', 'theme.js'), 'utf8');
  assert.match(theme, /perspective:/);
  assert.match(theme, /prefers-reduced-motion:\s*reduce/);
  assert.match(runtime, /\[data-lucide\]:not\(svg\)/);
  assert.doesNotMatch(runtime, /node\.matches\?\.\('\[data-lucide\]'\)/);
});

test('admin provisioning and sign-in require only a Telegram handle', () => {
  const admin = readFileSync(join(__dirname, '..', 'public', 'admin.html'), 'utf8');
  for (const page of ['index.html', 'polls.html', 'admin.html']) {
    const html = readFileSync(join(__dirname, '..', 'public', page), 'utf8');
    assert.match(html, /Telegram handle/);
    assert.doesNotMatch(html, /Telegram ID or handle/);
    assert.doesNotMatch(html, /@username or numeric ID/);
  }
  assert.doesNotMatch(admin, /name="telegram_user_id"/);
  assert.equal((admin.match(/name="telegram_username"/g) || []).length, 2);
  assert.equal((admin.match(/name="bot_token"/g) || []).length, 2);
  assert.doesNotMatch(admin, /name="bot_name"/);
  assert.match(admin, /id="edit-user-bot-name" readonly/);
  assert.match(admin, /id="edit-user-bot-handle" readonly/);
  assert.match(admin, /id="refresh-bot-identities"/);
  assert.match(admin, /BotFather token \(optional\)/);
  assert.match(admin, /Leave blank to assign later/);
});

test('Postgres app user roster does not overwrite user handles with bot handles', () => {
  const source = readFileSync(join(__dirname, '..', 'src', 'db', 'postgres.js'), 'utf8');
  const listAppUsers = source.match(/async listAppUsers\(\) \{([\s\S]*?)\n    \},/);

  assert.ok(listAppUsers, 'listAppUsers implementation should exist');
  assert.match(listAppUsers[1], /u\.telegram_username/);
  assert.doesNotMatch(listAppUsers[1], /b\.telegram_username/);
  assert.doesNotMatch(listAppUsers[1], /join bots/i);
});

test('dynamic icon hydration ignores generated Lucide SVGs', () => {
  let observerCallback;
  let renderCount = 0;
  const context = {
    document: {
      body: { classList: { add() {} } },
    },
    MutationObserver: class {
      constructor(callback) {
        observerCallback = callback;
      }

      observe() {}
    },
    window: {
      lucide: {
        createIcons() {
          renderCount += 1;
        },
      },
    },
  };

  vm.runInNewContext(
    readFileSync(join(__dirname, '..', 'public', 'theme.js'), 'utf8'),
    context,
  );
  assert.equal(renderCount, 1);

  observerCallback([{
    addedNodes: [{
      nodeType: 1,
      matches: () => false,
      querySelector: () => null,
    }],
  }]);
  assert.equal(renderCount, 1);

  observerCallback([{
    addedNodes: [{
      nodeType: 1,
      matches: () => true,
      querySelector: () => null,
    }],
  }]);
  assert.equal(renderCount, 2);
});

test('weekly and one-off forms expose editable confirmation timing', () => {
  const html = readFileSync(join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const source = readFileSync(join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(html, /select name="confirmation_day_of_week"/);
  assert.match(html, /data-name="confirmation_time"/);
  assert.match(html, /input type="date" name="confirmation_date" required/);
  assert.match(html, /data-name="one_off_confirmation_time"/);
  assert.doesNotMatch(source, /body\.confirmation_time = '12:00'/);
  assert.match(source, /Confirmation date and time must be after release date and time/);
});

test('weekly default and one-off scheduling show group-specific success popups', () => {
  const html = readFileSync(join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const source = readFileSync(join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(html, /id="action-feedback-dialog"/);
  assert.match(html, /id="action-feedback-message"/);
  assert.match(source, /Default template saved for \$\{group\?\.group_name/);
  assert.match(source, /One-off poll scheduled for \$\{group\.group_name\}/);
  assert.match(source, /actionFeedbackMessage\.textContent = message/);
});
