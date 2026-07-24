// polls.js — JavaScript for the Polls page (polls.html)
// Handles auth, polls table with date/type filters, action buttons.

'use strict';

/* ── Auth layer ─────────────────────────────────────────────────── */
const nativeFetch = window.fetch.bind(window);
let authSession = JSON.parse(sessionStorage.getItem('gtrsg-auth') || 'null');

window.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  const isManagementApi = url.startsWith('/api/') && !url.startsWith('/api/auth/');
  const headers = new Headers(init.headers || (typeof input === 'string' ? undefined : input.headers));
  if (isManagementApi && authSession?.access_token) headers.set('Authorization', `Bearer ${authSession.access_token}`);
  let response = await nativeFetch(input, { ...init, headers });
  if (isManagementApi && response.status === 401 && authSession?.refresh_token) {
    const refreshed = await nativeFetch('/api/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: authSession.refresh_token }),
    });
    if (refreshed.ok) {
      authSession = { ...authSession, ...await refreshed.json() };
      sessionStorage.setItem('gtrsg-auth', JSON.stringify(authSession));
      headers.set('Authorization', `Bearer ${authSession.access_token}`);
      response = await nativeFetch(input, { ...init, headers });
    }
  }
  if (isManagementApi && response.status === 401) showLogin();
  return response;
};

const authOverlay = document.getElementById('auth-overlay');
const authForm    = document.getElementById('auth-form');
const authError   = document.getElementById('auth-error');

function showLogin() {
  authSession = null;
  sessionStorage.removeItem('gtrsg-auth');
  authOverlay.hidden = false;
}

authForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  authError.textContent = '';
  const body = Object.fromEntries(new FormData(authForm).entries());
  const response = await nativeFetch('/api/auth/sign-in', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) { authError.textContent = result.error || 'Sign-in failed'; return; }
  authSession = result;
  sessionStorage.setItem('gtrsg-auth', JSON.stringify(result));
  authOverlay.hidden = true;
  await loadPollsPage();
});

/* ── Status bar ─────────────────────────────────────────────────── */
const navStatus = document.getElementById('nav-status');
function setStatus(message, kind) {
  navStatus.textContent = message;
  navStatus.className = message ? kind : '';
  if (message) {
    clearTimeout(navStatus._timer);
    if (kind === 'success') navStatus._timer = setTimeout(() => { navStatus.textContent = ''; navStatus.className = ''; }, 4000);
  }
}

/* ── Helpers ────────────────────────────────────────────────────── */
let managedGroups  = [];
let scheduledPolls = [];
let visiblePolls = [];

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function servicePill(service) {
  if (!service) return '<span class="pill pill-muted">General</span>';
  return service === 'PSA'
    ? '<span class="pill pill-psa">PSA</span>'
    : '<span class="pill pill-whcl">Wheelchair</span>';
}

function typePill(isCustom, isTest) {
  if (isTest) return '<span class="pill pill-test">Test</span>';
  return isCustom
    ? '<span class="pill pill-custom">Custom</span>'
    : '<span class="pill pill-muted">Batch default</span>';
}

function pollTypeValue(poll) {
  if (Array.isArray(poll.operational_tags) && poll.operational_tags.includes('test')) return 'test';
  if (poll.is_custom) return 'custom';
  return 'batch_default';
}

function statusPill(status) {
  return `<span class="pill status-pill-${status}">${escapeHtml(status)}</span>`;
}

function formatLocalDateTime(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('en-SG', {
    hour12: false, year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function formatLocalDate(dateText) {
  return new Date(`${dateText}T00:00:00`).toLocaleDateString('en-SG', {
    weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
  });
}

function pollSortKey(poll) {
  return [
    String(poll.event_date || '').slice(0, 10),
    poll.group_name || '',
    poll.resolved_release_at || '',
    poll.created_at || '',
    poll.id || '',
  ];
}

function sortPollsEarliestFirst(polls) {
  return [...polls].sort((a, b) => {
    const left = pollSortKey(a);
    const right = pollSortKey(b);
    for (let index = 0; index < left.length; index += 1) {
      const comparison = String(left[index]).localeCompare(String(right[index]));
      if (comparison !== 0) return comparison;
    }
    return 0;
  });
}

/* ── Filter state ───────────────────────────────────────────────── */
const filterDateInput    = document.getElementById('filter-event-date');
const filterGroupInput   = document.getElementById('filter-group');
const filterTypeInput    = document.getElementById('filter-type');
const clearFiltersBtn    = document.getElementById('clear-filters-btn');

function populateGroupFilter() {
  if (!filterGroupInput) return;
  const currentVal = filterGroupInput.value;
  const optionsHtml = ['<option value="">All groups</option>', ...managedGroups.map(g => `<option value="${g.id}">${escapeHtml(g.group_name)}</option>`)].join('\n');
  filterGroupInput.innerHTML = optionsHtml;
  filterGroupInput.value = currentVal;
}

function applyFilters() {
  const dateFilter    = filterDateInput.value;
  const groupFilter   = filterGroupInput.value;
  const typeFilter    = filterTypeInput.value;

  const filtered = scheduledPolls.filter((poll) => {
    const pollDate = String(poll.event_date).slice(0, 10);

    if (dateFilter    && pollDate               !== dateFilter)    return false;
    if (groupFilter   && poll.telegram_group_id !== groupFilter)   return false;
    if (typeFilter    && pollTypeValue(poll)    !== typeFilter)    return false;
    return true;
  });
  visiblePolls = sortPollsEarliestFirst(filtered);
  renderPollsTable(visiblePolls);
}

filterDateInput.addEventListener('change', applyFilters);
filterGroupInput.addEventListener('change', applyFilters);
filterTypeInput.addEventListener('change', applyFilters);

clearFiltersBtn.addEventListener('click', () => {
  filterDateInput.value    = '';
  filterGroupInput.value   = '';
  filterTypeInput.value    = '';
  visiblePolls = sortPollsEarliestFirst(scheduledPolls);
  renderPollsTable(visiblePolls);
});

/* ── Polls table ────────────────────────────────────────────────── */
const pollsTableContainer = document.getElementById('polls-table-container');
const detailsModal = document.getElementById('details-modal');
const detailsModalBody = document.getElementById('details-modal-body');
const detailsCloseBtn = document.getElementById('details-close-btn');

function closeDetailsModal() {
  detailsModal.hidden = true;
  detailsModalBody.innerHTML = '';
}

function openDetailsModal(details) {
  const participants = Array.isArray(details.participants) ? details.participants : [];
  detailsModalBody.innerHTML = participants.length
    ? `<ul class="details-list">${participants.map((item) => `
        <li>
          <strong>${escapeHtml(item.label)}</strong>
          <span>${escapeHtml(item.display_name || 'Unknown participant')}</span>
          <span class="details-muted">${escapeHtml(item.status || 'unknown')}${item.qualifying_since ? ` · ${escapeHtml(formatLocalDateTime(item.qualifying_since))}` : ''}</span>
        </li>`).join('')}</ul>`
    : '<p class="empty-state">No responses yet.</p>';
  detailsModal.hidden = false;
}

detailsCloseBtn.addEventListener('click', closeDetailsModal);
detailsModal.addEventListener('click', (event) => {
  if (event.target === detailsModal) closeDetailsModal();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !detailsModal.hidden) closeDetailsModal();
});

function renderPollsTable(polls) {
  if (!polls.length) {
    pollsTableContainer.innerHTML = '<p class="empty-state">No polls match the current filter. Go to <a href="/">Home</a> to create one.</p>';
    return;
  }

  const rows = polls.map((poll) => {
    const service = poll.service ||
      managedGroups.find((g) => g.id === poll.telegram_group_id)?.service ||
      managedGroups.find((g) => g.id === poll.telegram_group_id)?.bot_id;

    const isActive   = ['draft', 'scheduled', 'failed'].includes(poll.status);

    const actionBtns = [
      isActive ? `<button type="button" data-id="${poll.id}" data-action="send-now" class="secondary btn-sm poll-action">Send now</button>` : '',
      poll.status === 'failed' ? `<button type="button" data-id="${poll.id}" data-action="retry" class="secondary btn-sm poll-action">Retry</button>` : '',
      isActive ? `<button type="button" data-id="${poll.id}" data-action="cancel" class="danger-link btn-sm poll-action">Cancel</button>` : '',
    ].filter(Boolean).join('');

    return `
      <tr>
        <td>
          <div class="poll-title">${escapeHtml(poll.title)}</div>
          <div class="poll-meta">${escapeHtml(poll.group_name)}</div>
        </td>
        <td>${servicePill(service)}</td>
        <td>${formatLocalDate(String(poll.event_date).slice(0, 10))}</td>
        <td>${statusPill(poll.status)}</td>
        <td>${typePill(poll.is_custom, Array.isArray(poll.operational_tags) && poll.operational_tags.includes('test'))}</td>
        <td>
          <div class="poll-meta">Release ${formatLocalDateTime(poll.resolved_release_at)}</div>
          <div class="poll-meta">Cutoff ${formatLocalDateTime(poll.close_at)}</div>
        </td>
        <td class="col-actions">
          <div class="col-actions">
            ${actionBtns}
            <button type="button" data-id="${poll.id}" class="secondary btn-sm poll-details">Details</button>
          </div>
        </td>
      </tr>`;
  }).join('');

  pollsTableContainer.innerHTML = `
    <table class="polls-table">
      <thead>
        <tr>
          <th>Title / Group</th>
          <th>Service</th>
          <th>Event date</th>
          <th>Status</th>
          <th>Type</th>
          <th>Timing</th>
          <th></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;

  pollsTableContainer.querySelectorAll('.poll-action').forEach((btn) => btn.addEventListener('click', async (event) => {
    event.preventDefault();
    setStatus('Processing…', 'pending');
    const response = await fetch(`/api/scheduled-polls/${btn.dataset.id}/${btn.dataset.action}`, { method: 'POST' });
    const result = await response.json();
    setStatus(response.ok ? 'Done.' : `Error: ${result.error}`, response.ok ? 'success' : 'error');
    if (response.ok) loadScheduledPolls();
  }));

  pollsTableContainer.querySelectorAll('.poll-details').forEach((btn) => btn.addEventListener('click', async (event) => {
    event.preventDefault();
    setStatus('Loading details...', 'pending');
    const response = await fetch(`/api/scheduled-polls/${btn.dataset.id}/details`);
    const details = await response.json();
    if (!response.ok) {
      setStatus(`Error: ${details.error}`, 'error');
      return;
    }
    openDetailsModal(details);
    setStatus('', '');
  }));
}

async function loadScheduledPolls() {
  const response = await fetch('/api/scheduled-polls');
  if (response.status === 501) return;
  scheduledPolls = sortPollsEarliestFirst(await response.json());
  applyFilters(); // re-render with current filter
}

document.getElementById('refresh-polls-btn').addEventListener('click', loadScheduledPolls);

/* ── Bootstrap ──────────────────────────────────────────────────── */
async function loadPollsPage() {
  const groupsRes = await fetch('/api/telegram-groups');
  if (groupsRes.ok && groupsRes.status !== 501) {
    managedGroups = await groupsRes.json();
    populateGroupFilter();
  }
  await loadScheduledPolls();
}

async function bootstrap() {
  const config = await (await nativeFetch('/api/auth-config')).json();
  if (config.required && !authSession?.access_token) { showLogin(); return; }
  await loadPollsPage();
}

bootstrap().catch((err) => setStatus(`Error: ${err.message}`, 'error'));
