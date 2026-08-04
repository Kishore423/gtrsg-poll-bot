const nativeFetch = window.gtrsgAuth.nativeFetch;
let currentUser = null;

const statusEl = document.getElementById('status');
const authOverlay = document.getElementById('auth-overlay');
const usersBody = document.getElementById('users-body');
const addUserForm = document.getElementById('add-user-form');
const editUserDialog = document.getElementById('edit-user-dialog');
const editUserForm = document.getElementById('edit-user-form');
const editUserTelegramHandle = document.getElementById('edit-user-telegram-handle');
const editUserBotName = document.getElementById('edit-user-bot-name');
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
    return { ok: false, syncErrors: 0 };
  }
  currentUsers = new Map(result.map((user) => [String(user.id), user]));
  usersBody.innerHTML = result.map((user) => {
    const bot = user.bot || {};
    return `<tr>
      <td>${telegramLabel(user)}<br><span class="muted">${
        user.telegram_user_id
          ? `Telegram ID ${escapeHtml(user.telegram_user_id)}`
          : 'Awaiting Login_bot Start'
      }</span></td>
      <td>${escapeHtml(user.role === 'admin' ? 'Admin' : 'User')}</td>
      <td>${bot.id ? escapeHtml(bot.bot_name || '-') : '<span class="muted">No bot</span>'}</td>
      <td>${bot.telegram_username ? `@${escapeHtml(bot.telegram_username)}` : '<span class="muted">-</span>'}</td>
      <td>${user.enabled === false ? 'Disabled' : 'Enabled'}</td>
      <td><span class="row-actions">
        <button type="button" class="secondary" data-edit-user="${escapeHtml(user.id)}"><i data-lucide="pencil" aria-hidden="true"></i> Edit</button>
        <button type="button" class="danger-link" data-delete-user="${escapeHtml(user.id)}"><i data-lucide="trash-2" aria-hidden="true"></i> Delete</button>
      </span></td>
    </tr>`;
  }).join('');

  usersBody.querySelectorAll('[data-edit-user]').forEach((button) => {
    button.addEventListener('click', async () => {
      const user = currentUsers.get(button.dataset.editUser);
      if (!user) return;
      const bot = user.bot || {};
      editUserForm.elements.id.value = user.id;
      editUserTelegramHandle.value = user.telegram_username ? `@${user.telegram_username}` : '-';
      editUserForm.elements.telegram_display_name.value = user.telegram_display_name || '';
      editUserForm.elements.role.value = user.role || 'user';
      editUserForm.elements.enabled.checked = user.enabled !== false;
      editUserForm.elements.bot_token.value = '';
      editUserForm.elements.bot_token.disabled = Boolean(bot.id);
      editUserBotName.value = bot.id ? bot.bot_name || '-' : 'No bot assigned';
      editUserBotHandle.value = bot.telegram_username ? `@${bot.telegram_username}` : '-';
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
  return {
    ok: true,
    syncErrors: result.filter((user) => user.sync_error || user.bot?.sync_error).length,
  };
}

editUserForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const id = editUserForm.elements.id.value;
  const body = {
    telegram_display_name: editUserForm.elements.telegram_display_name.value,
    role: editUserForm.elements.role.value,
    enabled: editUserForm.elements.enabled.checked,
    bot_token: editUserForm.elements.bot_token.value,
  };
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
document.getElementById('refresh-bot-identities').addEventListener('click', async () => {
  setStatus('Refreshing user and bot identities from Telegram...');
  const outcome = await loadUsers();
  if (!outcome?.ok) return;
  if (outcome.syncErrors) {
    setStatus(`Unable to refresh ${outcome.syncErrors} Telegram identity. Cached values are shown.`, 'error');
    return;
  }
  setStatus('User handles, bot names, and bot handles refreshed from Telegram.', 'success');
});

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
  setStatus(
    result.bot_id
      ? 'Telegram user and bot added. Ask them to open Login_bot and press Start to activate sign-in.'
      : 'Telegram user added without a bot. You can assign one later from Edit. Ask them to open Login_bot and press Start to activate sign-in.',
    'success'
  );
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
