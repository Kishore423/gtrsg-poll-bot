const nativeFetch = window.gtrsgAuth.nativeFetch;
let currentUser = null;

const statusEl = document.getElementById('status');
const authOverlay = document.getElementById('auth-overlay');
const usersBody = document.getElementById('users-body');
const addUserForm = document.getElementById('add-user-form');
const editUserDialog = document.getElementById('edit-user-dialog');
const editUserForm = document.getElementById('edit-user-form');
const editUserBotHandle = document.getElementById('edit-user-bot-handle');
const editUserStatus = document.getElementById('edit-user-status');
let currentUsers = new Map();

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
  currentUsers = new Map(result.map((user) => [String(user.id), user]));
  usersBody.innerHTML = result.map((user) => {
    const bot = user.bot || {};
    return `<tr>
      <td>${telegramLabel(user)}<br><span class="muted">ID ${escapeHtml(user.telegram_user_id || '-')}</span></td>
      <td>${escapeHtml(user.role === 'admin' ? 'Admin' : 'User')}</td>
      <td>${bot.id ? escapeHtml(bot.bot_name || '-') : '<span class="muted">No bot</span>'}</td>
      <td>${bot.telegram_username ? `@${escapeHtml(bot.telegram_username)}` : '<span class="muted">-</span>'}</td>
      <td>${user.enabled === false ? 'Disabled' : 'Enabled'}</td>
      <td><span class="row-actions">
        <button type="button" class="secondary" data-edit-user="${escapeHtml(user.id)}">Edit</button>
        <button type="button" class="danger-link" data-delete-user="${escapeHtml(user.id)}">Delete</button>
      </span></td>
    </tr>`;
  }).join('');

  usersBody.querySelectorAll('[data-edit-user]').forEach((button) => {
    button.addEventListener('click', async () => {
      const user = currentUsers.get(button.dataset.editUser);
      if (!user) return;
      const bot = user.bot || {};
      editUserForm.elements.id.value = user.id;
      editUserForm.elements.telegram_user_id.value = user.telegram_user_id || '';
      editUserForm.elements.telegram_username.value = user.telegram_username || '';
      editUserForm.elements.telegram_display_name.value = user.telegram_display_name || '';
      editUserForm.elements.role.value = user.role || 'user';
      editUserForm.elements.enabled.checked = user.enabled !== false;
      editUserForm.elements.bot_name.value = bot.bot_name || '';
      editUserForm.elements.bot_name.disabled = !bot.id;
      editUserBotHandle.textContent = bot.telegram_username
        ? `Bot handle: @${bot.telegram_username}`
        : 'No bot is assigned to this user.';
      editUserStatus.textContent = '';
      editUserDialog.showModal();
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

editUserForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const formData = new FormData(editUserForm);
  const id = formData.get('id');
  const body = Object.fromEntries(formData.entries());
  body.enabled = editUserForm.elements.enabled.checked;
  if (editUserForm.elements.bot_name.disabled) delete body.bot_name;
  editUserStatus.textContent = 'Saving user details...';
  editUserStatus.className = 'status';
  const response = await fetch(`/api/admin/users/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    editUserStatus.textContent = `Error: ${result.error}`;
    editUserStatus.className = 'status error';
    return;
  }
  editUserDialog.close();
  setStatus('User and bot details updated.', 'success');
  await loadUsers();
});

document.getElementById('cancel-edit-user').addEventListener('click', () => editUserDialog.close());

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
