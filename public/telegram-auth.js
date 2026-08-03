(function setupTelegramAuth() {
  const nativeFetch = window.fetch.bind(window);
  const sessionKey = 'gtrsg-auth';
  const challengeKey = 'gtrsg-telegram-otp';
  let session = JSON.parse(sessionStorage.getItem(sessionKey) || 'null');
  let challenge = JSON.parse(sessionStorage.getItem(challengeKey) || 'null');

  const elements = () => ({
    overlay: document.getElementById('auth-overlay'),
    form: document.getElementById('telegram-otp-form'),
    identifier: document.getElementById('telegram-identifier'),
    codeStep: document.getElementById('telegram-code-step'),
    code: document.getElementById('telegram-code'),
    send: document.getElementById('telegram-send-code'),
    verify: document.getElementById('telegram-verify-code'),
    change: document.getElementById('telegram-change-account'),
    setup: document.getElementById('telegram-setup'),
    botLink: document.getElementById('telegram-bot-link'),
    message: document.getElementById('auth-error'),
  });

  function setMessage(message = '', kind = '') {
    const { message: element } = elements();
    if (!element) return;
    element.textContent = message;
    element.className = `auth-error ${kind}`.trim();
  }

  function showIdentifierStep() {
    const { identifier, codeStep, code, send, verify, change, setup } = elements();
    if (identifier) identifier.disabled = false;
    if (codeStep) codeStep.hidden = true;
    if (code) code.value = '';
    if (send) {
      send.hidden = false;
      send.disabled = false;
      send.textContent = 'Send code';
    }
    if (verify) {
      verify.hidden = true;
      verify.disabled = false;
      verify.textContent = 'Verify code';
    }
    if (change) change.hidden = true;
    if (setup) setup.hidden = true;
  }

  function showCodeStep(activeChallenge = challenge) {
    const { identifier, codeStep, code, send, verify, change, setup, botLink } = elements();
    if (identifier) {
      identifier.value = activeChallenge.identifier || identifier.value;
      identifier.disabled = true;
    }
    if (codeStep) codeStep.hidden = false;
    if (send) send.hidden = true;
    if (verify) {
      verify.hidden = false;
      verify.disabled = false;
      verify.textContent = 'Verify code';
    }
    if (change) change.hidden = false;
    if (setup) setup.hidden = false;
    if (botLink) {
      botLink.href = activeChallenge.setup_url;
      botLink.textContent = `Open @${activeChallenge.bot_username}`;
    }
    window.setTimeout(() => code?.focus(), 0);
  }

  function showLogin(message = '') {
    const { overlay } = elements();
    if (overlay) overlay.hidden = false;
    if (challenge) showCodeStep(challenge);
    else showIdentifierStep();
    setMessage(message);
  }

  function clearSession() {
    session = null;
    sessionStorage.removeItem(sessionKey);
  }

  function clearChallenge() {
    challenge = null;
    sessionStorage.removeItem(challengeKey);
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
      showLogin('Your session expired. Sign in again.');
    }
    return response;
  };

  async function requestOtp() {
    const { identifier, send } = elements();
    const value = identifier?.value.trim();
    if (!value) {
      setMessage('Enter your Telegram ID or handle.');
      identifier?.focus();
      return;
    }
    if (send) {
      send.disabled = true;
      send.textContent = 'Sending code...';
    }
    setMessage('');
    const response = await nativeFetch('/api/auth/telegram/otp/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: value }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (send) {
        send.disabled = false;
        send.textContent = 'Send code';
      }
      setMessage(result.error || 'Unable to send a Telegram code.');
      return;
    }
    challenge = {
      challenge_id: result.challenge_id,
      verifier: result.verifier,
      expires_at: result.expires_at,
      bot_username: result.bot_username,
      setup_url: result.setup_url,
      identifier: value,
    };
    sessionStorage.setItem(challengeKey, JSON.stringify(challenge));
    showCodeStep(challenge);
    setMessage(`Check Telegram for a code from @${result.bot_username}.`, 'success');
  }

  async function verifyOtp() {
    const { code, verify } = elements();
    const value = String(code?.value || '').replace(/\D/g, '');
    if (value.length !== 6) {
      setMessage('Enter the six-digit code sent to Telegram.');
      code?.focus();
      return;
    }
    if (verify) {
      verify.disabled = true;
      verify.textContent = 'Verifying...';
    }
    setMessage('');
    const response = await nativeFetch('/api/auth/telegram/otp/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        challenge_id: challenge?.challenge_id,
        verifier: challenge?.verifier,
        code: value,
      }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (verify) {
        verify.disabled = false;
        verify.textContent = 'Verify code';
      }
      if (code) code.value = '';
      setMessage(result.error || 'Unable to verify the Telegram code.');
      code?.focus();
      return;
    }
    session = result;
    sessionStorage.setItem(sessionKey, JSON.stringify(result));
    clearChallenge();
    const { overlay } = elements();
    if (overlay) overlay.hidden = true;
    window.location.reload();
  }

  function changeAccount() {
    clearChallenge();
    showIdentifierStep();
    setMessage('');
    elements().identifier?.focus();
  }

  function init() {
    const { form, verify, change, code } = elements();
    form?.addEventListener('submit', (event) => {
      event.preventDefault();
      if (challenge) verifyOtp();
      else requestOtp();
    });
    verify?.addEventListener('click', verifyOtp);
    change?.addEventListener('click', changeAccount);
    code?.addEventListener('input', () => {
      code.value = code.value.replace(/\D/g, '').slice(0, 6);
    });
    if (challenge) {
      showCodeStep(challenge);
      setMessage(`Enter the code sent by @${challenge.bot_username}.`, 'success');
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
