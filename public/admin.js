const nativeFetch = window.gtrsgAuth.nativeFetch;
let currentUser = null;

const statusEl = document.getElementById('status');
const authOverlay = document.getElementById('auth-overlay');
const usersBody = document.getElementById('users-body');
const addUserForm = document.getElementById('add-user-form');
const editUserDialog = document.getElementById('edit-user-dialog');
const editUserForm = document.getElementById('edit-user-form');
const editUserTelegramHandle = document.getElementById('edit-user-telegram-handle');
const editUserBotTokenLabel = document.getElementById('edit-user-bot-token-label');
const editUserBotName = document.getElementById('edit-user-bot-name');
const editUserBotHandle = document.getElementById('edit-user-bot-handle');
const editUserStatus = document.getElementById('edit-user-status');
const removeUserBotButton = document.getElementById('remove-user-bot');
let currentUsers = new Map();
let editingUserHasBot = false;

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

function botIdentityLabel(bot) {
  if (!bot) return 'Telegram bot';
  const name = bot.bot_name || 'Telegram bot';
  const handle = bot.telegram_username ? `@${bot.telegram_username}` : 'no public handle';
  const id = bot.telegram_bot_id ? `Telegram ID ${bot.telegram_bot_id}` : 'Telegram ID unavailable';
  return `${name} (${handle}, ${id})`;
}

async function loadUsers({ refresh = false } = {}) {
  const response = await fetch(
    refresh ? '/api/admin/telegram-identities/refresh' : '/api/admin/users',
    {
      method: refresh ? 'POST' : 'GET',
      cache: 'no-store',
    }
  );
  const result = await response.json().catch(() => []);
  if (!response.ok) {
    setStatus(result.error || 'Unable to load users', 'error');
    return {
      ok: false,
      userSyncUnavailable: 0,
      userSyncErrors: 0,
      botSyncErrors: 0,
    };
  }
  currentUsers = new Map(result.map((user) => [String(user.id), user]));
  usersBody.innerHTML = result.map((user) => {
    const bot = user.bot || {};
    const canViewAsUser = user.enabled !== false
      && Boolean(user.telegram_user_id)
      && Boolean(user.login_bot_verified_at);
    const viewAsUserTitle = user.enabled === false
      ? 'Enable this user before testing their account'
      : 'This user must verify with Login_bot before their account can be tested';
    return `<tr>
      <td>${telegramLabel(user)}<br><span class="muted">${
        user.login_bot_verified_at
          ? `Verified by Login_bot &middot; Telegram ID ${escapeHtml(user.telegram_user_id)}`
          : 'Awaiting Login_bot handle verification'
      }</span></td>
      <td>${escapeHtml(user.role === 'admin' ? 'Admin' : 'User')}</td>
      <td>${bot.id ? escapeHtml(bot.bot_name || '-') : '<span class="muted">No bot</span>'}</td>
      <td>${bot.telegram_username ? `@${escapeHtml(bot.telegram_username)}` : '<span class="muted">-</span>'}</td>
      <td>${user.enabled === false ? 'Disabled' : 'Enabled'}</td>
      <td><span class="row-actions">
        ${String(user.id) === String(currentUser?.id) ? '' : `
          <button type="button" class="secondary" data-view-user="${escapeHtml(user.id)}"
            ${canViewAsUser ? '' : `disabled title="${viewAsUserTitle}"`}>
            <i data-lucide="user-round-search" aria-hidden="true"></i> View as user
          </button>`}
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
      editUserForm.elements.bot_token.disabled = false;
      editingUserHasBot = Boolean(bot.id);
      editUserBotTokenLabel.textContent = editingUserHasBot
        ? 'Replace assigned bot with BotFather token'
        : 'Assign BotFather token';
      editUserForm.elements.bot_token.placeholder = editingUserHasBot
        ? 'Leave blank to keep the current bot'
        : 'Paste a token to assign a bot';
      editUserBotName.value = bot.id ? bot.bot_name || '-' : 'No bot assigned';
      editUserBotHandle.value = bot.telegram_username ? `@${bot.telegram_username}` : '-';
      if (removeUserBotButton) removeUserBotButton.hidden = !editingUserHasBot;
      editUserStatus.textContent = '';
      editUserDialog.showModal();
    });
  });

  usersBody.querySelectorAll('[data-view-user]').forEach((button) => {
    button.addEventListener('click', async () => {
      const userViewWindow = window.open('/', '_blank');
      button.disabled = true;
      setStatus('Opening user view...');
      try {
        const response = await fetch('/api/admin/impersonation', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_id: button.dataset.viewUser }),
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || 'Unable to open user view');
        window.gtrsgAuth.startImpersonation(result, userViewWindow || window);
        button.disabled = false;
        setStatus('User view opened in a separate tab.', 'success');
      } catch (error) {
        userViewWindow?.close();
        button.disabled = false;
        setStatus(`Error: ${error.message}`, 'error');
      }
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
    userSyncUnavailable: result.filter((user) => user.sync_unavailable).length,
    userSyncErrors: result.filter((user) => user.sync_error).length,
    botSyncErrors: new Set(
      result.filter((user) => user.bot?.sync_error).map((user) => String(user.bot.id))
    ).size,
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
  if (editingUserHasBot && body.bot_token
      && !window.confirm("Replace this user's assigned Telegram bot? The previous bot and its groups will be disabled.")) {
    return;
  }
  editUserStatus.textContent = body.bot_token
    ? 'Checking the bot token with Telegram and saving...'
    : 'Saving user details...';
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
  if (result.replacement_warning) {
    setStatus(result.replacement_warning, 'error');
  } else {
    setStatus(
      body.bot_token
        ? editingUserHasBot
          ? `${botIdentityLabel(result.bot)} assigned. The previous bot and its groups were disabled.`
          : `${botIdentityLabel(result.bot)} assigned.`
        : 'User details updated.',
      'success'
    );
  }
  await loadUsers();
});

if (removeUserBotButton) {
  removeUserBotButton.addEventListener('click', async () => {
    const id = editUserForm.elements.id.value;
    if (!id) return;
    if (!window.confirm("Remove this user's assigned bot? The bot and its groups will be disabled and freed so it can be assigned to another user.")) {
      return;
    }
    editUserStatus.textContent = 'Removing the assigned bot...';
    editUserStatus.className = 'status';
    const response = await fetch(`/api/admin/users/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ remove_bot: true }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      editUserStatus.textContent = `Error: ${result.error}`;
      editUserStatus.className = 'status error';
      return;
    }
    editUserDialog.close();
    setStatus('Bot removed. It is now free to assign to another user.', 'success');
    await loadUsers();
  });
}

document.getElementById('cancel-edit-user').addEventListener('click', () => editUserDialog.close());
document.getElementById('refresh-bot-identities').addEventListener('click', async () => {
  setStatus('Refreshing user and bot identities from Telegram...');
  const outcome = await loadUsers({ refresh: true });
  if (!outcome?.ok) return;
  if (outcome.userSyncErrors || outcome.botSyncErrors) {
    const failures = [];
    if (outcome.userSyncErrors) {
      failures.push(`${outcome.userSyncErrors} user ${outcome.userSyncErrors === 1 ? 'handle' : 'handles'}`);
    }
    if (outcome.botSyncErrors) {
      failures.push(`${outcome.botSyncErrors} bot ${outcome.botSyncErrors === 1 ? 'identity' : 'identities'}`);
    }
    setStatus(`Unable to refresh ${failures.join(' and ')}. Cached values are shown.`, 'error');
    return;
  }
  if (outcome.userSyncUnavailable) {
    const count = outcome.userSyncUnavailable;
    setStatus(
      `Bot identities refreshed. ${count} ${count === 1 ? 'user needs' : 'users need'} to open Login_bot and press Start before ${count === 1 ? 'their handle can' : 'their handles can'} be refreshed. Cached handles are shown.`
    );
    return;
  }
  setStatus('User handles, bot names, and bot handles refreshed from Telegram.', 'success');
});

addUserForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const body = Object.fromEntries(new FormData(addUserForm).entries());
  setStatus(
    body.bot_token
      ? 'Checking the bot token with Telegram and adding the user...'
      : 'Adding Telegram user...',
    ''
  );
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
      ? `Telegram user added and ${botIdentityLabel(result.bot)} assigned. Ask them to open Login_bot and press Start to activate sign-in.`
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
