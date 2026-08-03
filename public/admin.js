const nativeFetch = window.gtrsgAuth.nativeFetch;
let currentUser = null;

const statusEl = document.getElementById('status');
const authOverlay = document.getElementById('auth-overlay');
const usersBody = document.getElementById('users-body');
const addUserForm = document.getElementById('add-user-form');

function setStatus(message, kind = '') {
  statusEl.textContent = message || '';
  statusEl.className = `status ${kind}`.trim();
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function telegramLabel(user) {
  const name = user.telegram_display_name || user.telegram_username || 'Telegram user';
  const handle = user.telegram_username ? `@${user.telegram_username}` : '';
  return `<strong>${escapeHtml(name)}</strong>${handle ? `<br><span class="muted">${escapeHtml(handle)}</span>` : ''}`;
}

async function loadUsers() {
  const response = await fetch('/api/admin/users');
  const result = await response.json().catch(() => []);
  if (!response.ok) {
    setStatus(result.error || 'Unable to load users', 'error');
    return;
  }
  usersBody.innerHTML = result.map((user) => {
    const bot = user.bot || {};
    return `<tr>
      <td>${telegramLabel(user)}<br><span class="muted">ID ${escapeHtml(user.telegram_user_id || '-')}</span></td>
      <td>
        <select data-user-role="${escapeHtml(user.id)}">
          <option value="user" ${user.role === 'user' ? 'selected' : ''}>User</option>
          <option value="admin" ${user.role === 'admin' ? 'selected' : ''}>Admin</option>
        </select>
      </td>
      <td>${bot.id ? `<input value="${escapeHtml(bot.bot_name || '')}" data-bot-name="${escapeHtml(bot.id)}" />` : '<span class="muted">No bot</span>'}</td>
      <td>${bot.telegram_username ? `@${escapeHtml(bot.telegram_username)}` : '<span class="muted">-</span>'}</td>
      <td>${user.enabled === false ? 'Disabled' : 'Enabled'}</td>
      <td><span class="row-actions">
        ${bot.id ? `<button type="button" class="secondary" data-save-bot="${escapeHtml(bot.id)}">Save bot name</button>` : ''}
        <button type="button" class="secondary" data-toggle-user="${escapeHtml(user.id)}" data-enabled="${user.enabled !== false}">${user.enabled === false ? 'Enable' : 'Disable'}</button>
        <button type="button" class="danger-link" data-delete-user="${escapeHtml(user.id)}">Delete</button>
      </span></td>
    </tr>`;
  }).join('');

  usersBody.querySelectorAll('[data-user-role]').forEach((select) => {
    select.addEventListener('change', async () => {
      const response = await fetch(`/api/admin/users/${select.dataset.userRole}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: select.value }),
      });
      const result = await response.json().catch(() => ({}));
      setStatus(response.ok ? 'Role updated.' : `Error: ${result.error}`, response.ok ? 'success' : 'error');
      await loadUsers();
    });
  });

  usersBody.querySelectorAll('[data-save-bot]').forEach((button) => {
    button.addEventListener('click', async () => {
      const input = usersBody.querySelector(`[data-bot-name="${CSS.escape(button.dataset.saveBot)}"]`);
      const response = await fetch(`/api/admin/bots/${button.dataset.saveBot}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bot_name: input.value }),
      });
      const result = await response.json().catch(() => ({}));
      setStatus(response.ok ? 'Bot name synced with Telegram.' : `Error: ${result.error}`, response.ok ? 'success' : 'error');
      await loadUsers();
    });
  });

  usersBody.querySelectorAll('[data-toggle-user]').forEach((button) => {
    button.addEventListener('click', async () => {
      const response = await fetch(`/api/admin/users/${button.dataset.toggleUser}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: button.dataset.enabled !== 'true' }),
      });
      const result = await response.json().catch(() => ({}));
      setStatus(response.ok ? 'User updated.' : `Error: ${result.error}`, response.ok ? 'success' : 'error');
      await loadUsers();
    });
  });

  usersBody.querySelectorAll('[data-delete-user]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (!window.confirm('Delete this user and its linked bot mapping?')) return;
      const response = await fetch(`/api/admin/users/${button.dataset.deleteUser}`, { method: 'DELETE' });
      const result = await response.json().catch(() => ({}));
      setStatus(response.ok ? 'User deleted.' : `Error: ${result.error}`, response.ok ? 'success' : 'error');
      await loadUsers();
    });
  });
}

addUserForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const body = Object.fromEntries(new FormData(addUserForm).entries());
  setStatus('Adding Telegram user...', '');
  const response = await fetch('/api/admin/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    setStatus(`Error: ${result.error}`, 'error');
    return;
  }
  addUserForm.reset();
  setStatus('Telegram user added and bot webhook registered.', 'success');
  await loadUsers();
});

async function loadAdminAfterAuth() {
  const me = await fetch('/api/me');
  if (!me.ok) return window.gtrsgAuth.showLogin('Admin access required.');
  currentUser = await me.json();
  window.gtrsgAuth.renderUser(currentUser);
  if (currentUser.role !== 'admin') {
    window.location.href = '/';
    return;
  }
  authOverlay.hidden = true;
  await loadUsers();
}

async function bootstrap() {
  window.gtrsgAuth.init();
  const config = await (await nativeFetch('/api/auth-config')).json();
  if (config.required && !window.gtrsgAuth.hasSession()) {
    window.gtrsgAuth.showLogin();
    return;
  }
  if (!config.required) {
    currentUser = { role: 'admin' };
    authOverlay.hidden = true;
    await loadUsers();
    return;
  }
  await loadAdminAfterAuth();
}

bootstrap().catch((error) => setStatus(`Error: ${error.message}`, 'error'));
