const nativeFetch = window.fetch.bind(window);
let authSession = JSON.parse(sessionStorage.getItem('gtrsg-auth') || 'null');
let currentUser = null;

window.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  const headers = new Headers(init.headers || (typeof input === 'string' ? undefined : input.headers));
  if (url.startsWith('/api/') && authSession?.access_token) headers.set('Authorization', `Bearer ${authSession.access_token}`);
  return nativeFetch(input, { ...init, headers });
};

const statusEl = document.getElementById('status');
const authOverlay = document.getElementById('auth-overlay');
const authError = document.getElementById('auth-error');
const msSignInBtn = document.getElementById('ms-sign-in');
const authForm = document.getElementById('auth-form');
const authEmailInput = document.getElementById('auth-email');
const authTokenInput = document.getElementById('auth-token');
const otpStep = document.getElementById('otp-step');
const sendOtpBtn = document.getElementById('send-otp');
const verifyOtpBtn = document.getElementById('verify-otp');
const usersBody = document.getElementById('users-body');
const addUserForm = document.getElementById('add-user-form');

function setAuthMessage(message = '', kind = 'error') {
  authError.textContent = message;
  authError.className = `auth-error ${message && kind === 'success' ? 'success' : ''}`.trim();
}

function setStatus(message, kind = '') {
  statusEl.textContent = message || '';
  statusEl.className = `status ${kind}`.trim();
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"]/g, (char) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
}

async function sendEmailOtp() {
  const email = authEmailInput?.value.trim();
  if (!email) {
    setAuthMessage('Enter your approved email address.');
    return;
  }
  setAuthMessage('');
  if (sendOtpBtn) sendOtpBtn.disabled = true;
  const response = await nativeFetch('/api/auth/send-otp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    setAuthMessage(result.error || 'Unable to send code.');
    if (sendOtpBtn) sendOtpBtn.disabled = false;
    return;
  }
  if (otpStep) otpStep.hidden = false;
  if (verifyOtpBtn) verifyOtpBtn.hidden = false;
  if (sendOtpBtn) {
    sendOtpBtn.textContent = 'Resend code';
    sendOtpBtn.disabled = false;
  }
  authTokenInput?.focus();
  setAuthMessage('Code sent. Check your email inbox. You can resend after 60 seconds if it does not arrive.', 'success');
}

async function verifyEmailOtp() {
  const email = authEmailInput?.value.trim();
  const token = authTokenInput?.value.trim();
  if (!email || !token) {
    setAuthMessage('Enter your email and one-time code.');
    return;
  }
  setAuthMessage('');
  if (verifyOtpBtn) verifyOtpBtn.disabled = true;
  const response = await nativeFetch('/api/auth/verify-otp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, token }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    setAuthMessage(result.error || 'Invalid or expired code.');
    if (verifyOtpBtn) verifyOtpBtn.disabled = false;
    return;
  }
  authSession = result;
  sessionStorage.setItem('gtrsg-auth', JSON.stringify(result));
  authOverlay.hidden = true;
  await loadAdminAfterAuth();
}

function captureSessionFromRedirect() {
  if (!window.location.hash.includes('access_token')) return false;
  const params = new URLSearchParams(window.location.hash.slice(1));
  authSession = {
    access_token: params.get('access_token'),
    refresh_token: params.get('refresh_token'),
    expires_at: Number(params.get('expires_at')) || null,
  };
  sessionStorage.setItem('gtrsg-auth', JSON.stringify(authSession));
  history.replaceState(null, '', window.location.pathname + window.location.search);
  return true;
}

function showLogin(message = '') {
  authOverlay.hidden = false;
  setAuthMessage(message);
  if (sendOtpBtn) sendOtpBtn.disabled = false;
  if (verifyOtpBtn) verifyOtpBtn.disabled = false;
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
    const enabledText = user.enabled === false ? 'Disabled' : 'Enabled';
    return `<tr>
      <td><strong>${escapeHtml(user.email)}</strong></td>
      <td>
        <select data-user-role="${escapeHtml(user.id)}">
          <option value="user" ${user.role === 'user' ? 'selected' : ''}>User</option>
          <option value="admin" ${user.role === 'admin' ? 'selected' : ''}>Admin</option>
        </select>
      </td>
      <td>${bot.id ? `<input value="${escapeHtml(bot.bot_name || '')}" data-bot-name="${escapeHtml(bot.id)}" />` : '<span class="muted">No bot</span>'}</td>
      <td>${bot.telegram_username ? `@${escapeHtml(bot.telegram_username)}` : '<span class="muted">-</span>'}</td>
      <td>${enabledText}</td>
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
      setStatus(response.ok ? 'Role updated.' : `Error: ${(await response.json()).error}`, response.ok ? 'success' : 'error');
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
  setStatus('Adding user...', '');
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
  setStatus('User added and bot webhook registered.', 'success');
  await loadUsers();
});

async function loadAdminAfterAuth() {
  const me = await fetch('/api/me');
  if (!me.ok) return showLogin('Admin access required.');
  currentUser = await me.json();
  if (currentUser.role !== 'admin') {
    window.location.href = '/';
    return;
  }
  authOverlay.hidden = true;
  await loadUsers();
}

async function bootstrap() {
  captureSessionFromRedirect();
  const config = await (await nativeFetch('/api/auth-config')).json();
  sendOtpBtn?.addEventListener('click', sendEmailOtp);
  authForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    await verifyEmailOtp();
  });
  if (config.required && !authSession?.access_token) return showLogin();
  if (!config.required) {
    currentUser = { role: 'admin' };
    authOverlay.hidden = true;
    await loadUsers();
    return;
  }
  await loadAdminAfterAuth();
}

bootstrap().catch((error) => setStatus(`Error: ${error.message}`, 'error'));
