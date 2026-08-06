'use strict';

const nativeFetch = window.gtrsgAuth.nativeFetch;
const list = document.getElementById('deployment-list');
const status = document.getElementById('deployment-status');
const refreshButton = document.getElementById('refresh-deployments');

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatDate(isoDate) {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  return new Intl.DateTimeFormat('en-SG', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

function setStatus(message = '', kind = '') {
  status.textContent = message;
  status.className = `page-status ${kind}`.trim();
}

function renderSheets(sheets) {
  if (!sheets.length) {
    list.innerHTML = `
      <div class="empty-state">
        <i data-lucide="file-clock" aria-hidden="true"></i>
        <p>No confirmed deployment sheets are available in the latest four weeks.</p>
      </div>`;
    window.refreshIcons?.();
    return;
  }

  const weeks = new Map();
  for (const sheet of sheets) {
    if (!weeks.has(sheet.start_date)) weeks.set(sheet.start_date, []);
    weeks.get(sheet.start_date).push(sheet);
  }
  list.innerHTML = [...weeks.entries()].map(([startDate, weekSheets]) => `
    <section class="deployment-week">
      <div class="deployment-week-header">
        <h2>${escapeHtml(formatDate(startDate))} to ${escapeHtml(formatDate(weekSheets[0].end_date))}</h2>
        <span>${weekSheets.length} ${weekSheets.length === 1 ? 'group' : 'groups'}</span>
      </div>
      ${weekSheets.map((sheet) => `
        <div class="deployment-row">
          <div>
            <h3>${escapeHtml(sheet.group_name)}</h3>
            <p>Confirmed deployment sheet</p>
          </div>
          <button type="button" class="primary download-sheet"
            data-group-id="${escapeHtml(sheet.telegram_group_id)}"
            data-group-name="${escapeHtml(sheet.group_name)}"
            data-start-date="${escapeHtml(sheet.start_date)}"
            data-end-date="${escapeHtml(sheet.end_date)}">
            <i data-lucide="download" aria-hidden="true"></i> Download Excel
          </button>
        </div>`).join('')}
    </section>`).join('');
  window.refreshIcons?.();
}

async function loadDeploymentSheets() {
  refreshButton.disabled = true;
  setStatus('Loading confirmed deployment sheets...');
  try {
    const response = await fetch('/api/deployment-sheets');
    const result = await response.json().catch(() => []);
    if (!response.ok) throw new Error(result.error || 'Unable to load deployment sheets');
    renderSheets(result);
    setStatus('');
  } catch (error) {
    setStatus(error.message, 'error');
  } finally {
    refreshButton.disabled = false;
  }
}

async function downloadSheet(button) {
  button.disabled = true;
  const params = new URLSearchParams({
    telegram_group_id: button.dataset.groupId,
    start_date: button.dataset.startDate,
    end_date: button.dataset.endDate,
  });
  setStatus(`Building ${button.dataset.groupName} deployment sheet...`);
  try {
    const response = await fetch(`/api/confirmed-slots.xlsx?${params}`);
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(result.error || 'Unable to download deployment sheet');
    }
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const groupSlug = button.dataset.groupName.toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'telegram-group';
    link.href = objectUrl;
    link.download = `deployment-sheet-${groupSlug}-${button.dataset.startDate}-to-${button.dataset.endDate}.xlsx`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(objectUrl);
    setStatus(`Deployment sheet downloaded for ${button.dataset.groupName}.`);
  } catch (error) {
    setStatus(error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

list.addEventListener('click', (event) => {
  const button = event.target.closest('.download-sheet');
  if (button) void downloadSheet(button);
});
refreshButton.addEventListener('click', loadDeploymentSheets);

async function bootstrap() {
  window.gtrsgAuth.init();
  const config = await (await nativeFetch('/api/auth-config')).json();
  if (config.required && !window.gtrsgAuth.hasSession()) {
    window.gtrsgAuth.showLogin();
    return;
  }
  if (!config.required) {
    document.querySelectorAll('[data-deployment-nav], [data-admin-nav]').forEach((item) => {
      item.hidden = false;
    });
    await loadDeploymentSheets();
    return;
  }
  const meResponse = await fetch('/api/me');
  if (!meResponse.ok) {
    window.gtrsgAuth.showLogin('Session expired. Sign in with Telegram again.');
    return;
  }
  const user = await meResponse.json();
  window.gtrsgAuth.renderUser(user);
  document.querySelectorAll('[data-admin-nav]').forEach((item) => {
    item.hidden = user.role !== 'admin';
  });
  if (!user.deployment_sheets_enabled) {
    window.location.replace('/');
    return;
  }
  await loadDeploymentSheets();
}

bootstrap().catch((error) => setStatus(error.message, 'error'));
