(function setupTelegramAuth() {
  const nativeFetch = window.fetch.bind(window);
  const sessionKey = 'gtrsg-auth';
  const challengeKey = 'gtrsg-telegram-login';
  let session = JSON.parse(sessionStorage.getItem(sessionKey) || 'null');
  let pollTimer = null;

  const elements = () => ({
    overlay: document.getElementById('auth-overlay'),
    button: document.getElementById('telegram-sign-in'),
    message: document.getElementById('auth-error'),
  });

  function setMessage(message = '', kind = '') {
    const { message: element } = elements();
    if (!element) return;
    element.textContent = message;
    element.className = `auth-error ${kind}`.trim();
  }

  function showLogin(message = '') {
    const { overlay, button } = elements();
    if (overlay) overlay.hidden = false;
    if (button) {
      button.disabled = false;
      button.textContent = 'Continue with Telegram';
    }
    setMessage(message);
  }

  function clearSession() {
    session = null;
    sessionStorage.removeItem(sessionKey);
  }

  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const isManagementApi = url.startsWith('/api/') && !url.startsWith('/api/auth/');
    const headers = new Headers(init.headers || (typeof input === 'string' ? undefined : input.headers));
    if (isManagementApi && session?.access_token) {
      headers.set('Authorization', `Bearer ${session.access_token}`);
    }
    const response = await nativeFetch(input, { ...init, headers });
    if (isManagementApi && response.status === 401) {
      clearSession();
      showLogin('Your session expired. Sign in with Telegram again.');
    }
    return response;
  };

  async function checkChallenge(challenge) {
    const response = await nativeFetch('/api/auth/telegram/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(challenge),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      sessionStorage.removeItem(challengeKey);
      clearInterval(pollTimer);
      showLogin(result.error || 'Unable to complete Telegram sign-in.');
      return;
    }
    if (result.status === 'waiting_for_telegram') {
      setMessage('Approve the sign-in in Telegram, then return to this page.', 'success');
      return;
    }
    if (result.status === 'pending_approval') {
      sessionStorage.removeItem(challengeKey);
      clearInterval(pollTimer);
      const identity = result.telegram_username
        ? `@${result.telegram_username}`
        : result.telegram_display_name || 'This Telegram account';
      showLogin(`${identity} is awaiting administrator approval.`);
      return;
    }
    if (result.status === 'authenticated') {
      session = result;
      sessionStorage.setItem(sessionKey, JSON.stringify(result));
      sessionStorage.removeItem(challengeKey);
      clearInterval(pollTimer);
      const { overlay } = elements();
      if (overlay) overlay.hidden = true;
      window.location.reload();
    }
  }

  function pollChallenge(challenge) {
    clearInterval(pollTimer);
    checkChallenge(challenge);
    pollTimer = setInterval(() => checkChallenge(challenge), 1500);
  }

  async function startLogin() {
    const { button } = elements();
    const popup = window.open('about:blank', 'gtrsg-telegram-login');
    if (button) {
      button.disabled = true;
      button.textContent = 'Opening Telegram...';
    }
    setMessage('');
    const response = await nativeFetch('/api/auth/telegram/start', { method: 'POST' });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (popup) popup.close();
      showLogin(result.error || 'Unable to start Telegram sign-in.');
      return;
    }
    const challenge = {
      challenge_id: result.challenge_id,
      verifier: result.verifier,
    };
    sessionStorage.setItem(challengeKey, JSON.stringify(challenge));
    setMessage(`Continue in @${result.bot_username}. This request expires in 5 minutes.`, 'success');
    if (popup) popup.location.replace(result.login_url);
    else window.location.href = result.login_url;
    pollChallenge(challenge);
  }

  function init() {
    elements().button?.addEventListener('click', startLogin);
    const challenge = JSON.parse(sessionStorage.getItem(challengeKey) || 'null');
    if (challenge) {
      showLogin('Complete the sign-in in Telegram.');
      pollChallenge(challenge);
    }
  }

  window.gtrsgAuth = {
    nativeFetch,
    init,
    showLogin,
    clearSession,
    hasSession: () => Boolean(session?.access_token),
  };
})();
