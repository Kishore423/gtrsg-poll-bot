(function setupTelegramAuth() {
  const nativeFetch = window.fetch.bind(window);
  const sessionKey = 'gtrsg-auth';
  const challengeKey = 'gtrsg-telegram-otp';
  let session = JSON.parse(sessionStorage.getItem(sessionKey) || 'null');
  let challenge = JSON.parse(sessionStorage.getItem(challengeKey) || 'null');
  let requestInFlight = false;
  let renderedUser = null;

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
    navUser: document.getElementById('nav-user'),
    accountMenu: document.getElementById('nav-account-menu'),
    profilePhotoInput: document.getElementById('nav-profile-photo-input'),
    uploadPhoto: document.getElementById('nav-upload-photo'),
    signOut: document.getElementById('nav-sign-out'),
    accountStatus: document.getElementById('nav-account-status'),
    avatar: document.getElementById('nav-user-avatar'),
    profileViewer: document.getElementById('profile-viewer'),
    profileViewerImage: document.getElementById('profile-viewer-image'),
    closeProfileViewer: document.getElementById('close-profile-viewer'),
    deleteProfilePhoto: document.getElementById('delete-profile-photo'),
    profileViewerStatus: document.getElementById('profile-viewer-status'),
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

  function showPendingCodeStep(identifierValue) {
    const { identifier, codeStep, code, send, verify, change, setup } = elements();
    if (identifier) {
      identifier.value = identifierValue;
      identifier.disabled = true;
    }
    if (codeStep) codeStep.hidden = false;
    if (code) code.disabled = false;
    if (send) send.hidden = true;
    if (verify) {
      verify.hidden = false;
      verify.disabled = true;
      verify.textContent = 'Preparing verification...';
    }
    if (change) change.hidden = true;
    if (setup) setup.hidden = true;
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

  function renderUser(user) {
    const container = document.getElementById('nav-user');
    const name = document.getElementById('nav-user-name');
    const avatar = document.getElementById('nav-user-avatar');
    if (!container || !name || !user) return;
    renderedUser = { ...(renderedUser || {}), ...user };

    const displayName = renderedUser.telegram_display_name
      || (renderedUser.telegram_username ? `@${renderedUser.telegram_username}` : '')
      || 'Telegram user';
    name.textContent = displayName;
    name.title = displayName;
    if (avatar) {
      avatar.textContent = displayName.replace(/^@/, '').trim().charAt(0).toUpperCase() || 'T';
      if (avatar.style) {
        avatar.style.backgroundImage = renderedUser.profile_photo_data
          ? `url("${renderedUser.profile_photo_data}")`
          : '';
      }
      avatar.classList?.toggle('has-photo', Boolean(renderedUser.profile_photo_data));
      avatar.title = renderedUser.profile_photo_data ? 'View profile picture' : '';
    }
    container.hidden = false;
  }

  function setAccountStatus(message = '', kind = '') {
    const { accountStatus } = elements();
    if (!accountStatus) return;
    accountStatus.textContent = message;
    accountStatus.className = `nav-account-status ${kind}`.trim();
  }

  function closeAccountMenu() {
    const { navUser, accountMenu } = elements();
    if (accountMenu) accountMenu.hidden = true;
    navUser?.setAttribute('aria-expanded', 'false');
  }

  function createProfileViewer() {
    if (document.getElementById('profile-viewer')) return;
    const viewer = document.createElement('div');
    viewer.id = 'profile-viewer';
    viewer.className = 'profile-viewer';
    viewer.hidden = true;
    viewer.setAttribute('role', 'dialog');
    viewer.setAttribute('aria-modal', 'true');
    viewer.setAttribute('aria-label', 'Profile picture');
    viewer.innerHTML = `
      <div class="profile-viewer-panel">
        <button id="close-profile-viewer" class="profile-viewer-close" type="button" aria-label="Close profile picture">X</button>
        <img id="profile-viewer-image" class="profile-viewer-image" alt="Your profile picture" />
        <button id="delete-profile-photo" class="delete-profile-photo" type="button">Delete profile picture</button>
        <p id="profile-viewer-status" class="profile-viewer-status" aria-live="polite"></p>
      </div>`;
    document.body.appendChild(viewer);
  }

  function closeProfileViewer() {
    const { profileViewer, profileViewerImage } = elements();
    if (profileViewer) profileViewer.hidden = true;
    if (profileViewerImage) profileViewerImage.removeAttribute('src');
  }

  function openProfileViewer(event) {
    if (!renderedUser?.profile_photo_data) return false;
    event?.stopPropagation();
    closeAccountMenu();
    const { profileViewer, profileViewerImage, closeProfileViewer: closeButton, profileViewerStatus } = elements();
    if (!profileViewer || !profileViewerImage) return false;
    profileViewerImage.src = renderedUser.profile_photo_data;
    if (profileViewerStatus) profileViewerStatus.textContent = '';
    profileViewer.hidden = false;
    closeButton?.focus();
    return true;
  }

  async function deleteProfilePhoto() {
    const { deleteProfilePhoto: button, profileViewerStatus } = elements();
    if (button) button.disabled = true;
    if (profileViewerStatus) {
      profileViewerStatus.textContent = 'Deleting profile picture...';
      profileViewerStatus.className = 'profile-viewer-status';
    }
    try {
      const response = await window.fetch('/api/me/profile-photo', { method: 'DELETE' });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Unable to delete profile picture.');
      renderUser({ profile_photo_data: null });
      closeProfileViewer();
      setAccountStatus('Profile picture deleted.', 'success');
    } catch (error) {
      if (profileViewerStatus) {
        profileViewerStatus.textContent = error.message;
        profileViewerStatus.className = 'profile-viewer-status error';
      }
    } finally {
      if (button) button.disabled = false;
    }
  }

  function toggleAccountMenu() {
    const { navUser, accountMenu } = elements();
    if (!accountMenu) return;
    accountMenu.hidden = !accountMenu.hidden;
    navUser?.setAttribute('aria-expanded', String(!accountMenu.hidden));
    if (!accountMenu.hidden) setAccountStatus('');
  }

  function resizeProfilePhoto(file) {
    return new Promise((resolve, reject) => {
      if (!file?.type?.startsWith('image/')) {
        reject(new Error('Choose a JPEG, PNG, or WebP image.'));
        return;
      }
      if (file.size > 5 * 1024 * 1024) {
        reject(new Error('Choose an image smaller than 5 MB.'));
        return;
      }
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Unable to read that image.'));
      reader.onload = () => {
        const image = new Image();
        image.onerror = () => reject(new Error('Unable to open that image.'));
        image.onload = () => {
          const size = Math.min(256, image.naturalWidth, image.naturalHeight);
          const sourceX = Math.max(0, (image.naturalWidth - size) / 2);
          const sourceY = Math.max(0, (image.naturalHeight - size) / 2);
          const canvas = document.createElement('canvas');
          canvas.width = 256;
          canvas.height = 256;
          const context = canvas.getContext('2d');
          context.fillStyle = '#ffffff';
          context.fillRect(0, 0, 256, 256);
          context.drawImage(image, sourceX, sourceY, size, size, 0, 0, 256, 256);
          const dataUrl = canvas.toDataURL('image/webp', 0.84);
          if (dataUrl.length > 275000) {
            reject(new Error('The resized image is still too large. Choose a simpler image.'));
            return;
          }
          resolve(dataUrl);
        };
        image.src = String(reader.result);
      };
      reader.readAsDataURL(file);
    });
  }

  async function uploadProfilePhoto(event) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    setAccountStatus('Preparing picture...');
    try {
      const profilePhotoData = await resizeProfilePhoto(file);
      const response = await window.fetch('/api/me/profile-photo', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile_photo_data: profilePhotoData }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Unable to save profile picture.');
      renderUser({ profile_photo_data: result.profile_photo_data });
      setAccountStatus('Profile picture updated.', 'success');
    } catch (error) {
      setAccountStatus(error.message, 'error');
    } finally {
      input.value = '';
    }
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
      setMessage('Enter your Telegram handle.');
      identifier?.focus();
      return;
    }
    requestInFlight = true;
    showPendingCodeStep(value);
    setMessage('');
    let response;
    let result;
    try {
      response = await nativeFetch('/api/auth/telegram/otp/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: value }),
      });
      result = await response.json().catch(() => ({}));
    } catch {
      requestInFlight = false;
      showIdentifierStep();
      setMessage('Unable to reach the sign-in service. Please try again.');
      return;
    }
    requestInFlight = false;
    if (!response.ok) {
      showIdentifierStep();
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
    createProfileViewer();
    const {
      form, verify, change, code, navUser, accountMenu,
      profilePhotoInput, uploadPhoto, signOut, avatar, profileViewer,
      closeProfileViewer: closeViewer, deleteProfilePhoto: deletePhoto,
    } = elements();
    form?.addEventListener('submit', (event) => {
      event.preventDefault();
      if (requestInFlight) return;
      if (challenge) verifyOtp();
      else requestOtp();
    });
    verify?.addEventListener('click', verifyOtp);
    change?.addEventListener('click', changeAccount);
    code?.addEventListener('input', () => {
      code.value = code.value.replace(/\D/g, '').slice(0, 6);
    });
    navUser?.addEventListener('click', (event) => {
      if (event.target === avatar && openProfileViewer(event)) return;
      toggleAccountMenu();
    });
    uploadPhoto?.addEventListener('click', () => profilePhotoInput?.click());
    profilePhotoInput?.addEventListener('change', uploadProfilePhoto);
    signOut?.addEventListener('click', () => {
      clearSession();
      clearChallenge();
      window.location.reload();
    });
    closeViewer?.addEventListener('click', closeProfileViewer);
    deletePhoto?.addEventListener('click', deleteProfilePhoto);
    profileViewer?.addEventListener('click', (event) => {
      if (event.target === profileViewer) closeProfileViewer();
    });
    document.addEventListener('click', (event) => {
      if (!accountMenu?.hidden && !event.target.closest('.nav-account')) closeAccountMenu();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        closeAccountMenu();
        closeProfileViewer();
      }
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
    renderUser,
    hasSession: () => Boolean(session?.access_token),
  };
})();
