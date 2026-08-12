// polls.js — JavaScript for the Polls page (polls.html)
// Handles auth, polls table with date/type filters, action buttons.

'use strict';

/* ── Auth layer ─────────────────────────────────────────────────── */
const nativeFetch = window.gtrsgAuth.nativeFetch;
const authOverlay = document.getElementById('auth-overlay');

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
let currentUser = null;
let adminUsers = [];

function renderRoleNavigation(user) {
  document.querySelectorAll('[data-admin-nav]').forEach((element) => {
    element.hidden = user?.role !== 'admin';
  });
  window.refreshIcons?.();
}

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

function typePill(isCustom) {
  return isCustom
    ? '<span class="pill pill-custom">Custom</span>'
    : '<span class="pill pill-muted">Batch default</span>';
}

function pollTypeValue(poll) {
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

function sortPollsByDate(polls, direction = 'asc') {
  const dateDirection = direction === 'desc' ? -1 : 1;
  return [...polls].sort((a, b) => {
    const left = pollSortKey(a);
    const right = pollSortKey(b);
    for (let index = 0; index < left.length; index += 1) {
      const comparison = String(left[index]).localeCompare(String(right[index]));
      if (comparison !== 0) return index === 0 ? comparison * dateDirection : comparison;
    }
    return 0;
  });
}

/* ── Filter state ───────────────────────────────────────────────── */
const filterDateInput    = document.getElementById('filter-event-date');
const filterBotField     = document.getElementById('filter-bot-field');
const filterBotInput     = document.getElementById('filter-bot');
const filterGroupInput   = document.getElementById('filter-group');
const filterTypeInput    = document.getElementById('filter-type');
const filterDateOrderInput = document.getElementById('filter-date-order');
const clearFiltersBtn    = document.getElementById('clear-filters-btn');

function botFilterLabel(user) {
  const bot = user.bot || {};
  const botName = bot.bot_name || (bot.telegram_username ? `@${bot.telegram_username}` : 'Assigned bot');
  const botHandle = bot.telegram_username && botName !== `@${bot.telegram_username}`
    ? ` (@${bot.telegram_username})`
    : '';
  const userName = user.telegram_display_name || user.telegram_username || 'Unlabelled user';
  return `${botName}${botHandle} — ${userName}`;
}

function populateBotFilter() {
  if (!filterBotInput) return;
  const currentValue = filterBotInput.value;
  const assignedUsers = adminUsers
    .filter((user) => user.bot_id && user.bot?.id)
    .sort((a, b) => botFilterLabel(a).localeCompare(botFilterLabel(b)));
  filterBotInput.innerHTML = [
    '<option value="">All bots</option>',
    ...assignedUsers.map((user) =>
      `<option value="${escapeHtml(user.bot_id)}">${escapeHtml(botFilterLabel(user))}</option>`),
  ].join('\n');
  filterBotInput.value = assignedUsers.some((user) => String(user.bot_id) === currentValue)
    ? currentValue
    : '';
}

function groupFilterKey(group) {
  const chatId = String(group?.telegram_chat_id || '').trim();
  return chatId ? `chat:${chatId}` : `group:${String(group?.id || '')}`;
}

function uniqueGroupsByTelegramChat(groups) {
  const seen = new Set();
  return groups.filter((group) => {
    const key = groupFilterKey(group);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function populateGroupFilter() {
  if (!filterGroupInput) return;
  const currentVal = filterGroupInput.value;
  const botFilter = filterBotInput?.value || '';
  const availableGroups = botFilter
    ? managedGroups.filter((group) => String(group.bot_id) === botFilter)
    : managedGroups;
  const uniqueGroups = uniqueGroupsByTelegramChat(availableGroups);
  const optionsHtml = [
    '<option value="">All groups</option>',
    ...uniqueGroups.map((group) =>
      `<option value="${escapeHtml(groupFilterKey(group))}">${escapeHtml(group.group_name)}</option>`),
  ].join('\n');
  filterGroupInput.innerHTML = optionsHtml;
  filterGroupInput.value = uniqueGroups.some((group) => groupFilterKey(group) === currentVal)
    ? currentVal
    : '';
}

function applyFilters() {
  const dateFilter    = filterDateInput.value;
  const botFilter     = filterBotInput?.value || '';
  const groupFilter   = filterGroupInput.value;
  const typeFilter    = filterTypeInput.value;
  const dateOrder     = filterDateOrderInput.value;

  const filtered = scheduledPolls.filter((poll) => {
    const pollDate = String(poll.event_date).slice(0, 10);
    const pollGroup = groupFilter
      ? managedGroups.find((group) => String(group.id) === String(poll.telegram_group_id))
      : null;

    if (dateFilter    && pollDate               !== dateFilter)    return false;
    if (botFilter     && String(poll.bot_id)     !== botFilter)     return false;
    if (groupFilter   && groupFilterKey(pollGroup) !== groupFilter) return false;
    if (typeFilter    && pollTypeValue(poll)    !== typeFilter)    return false;
    return true;
  });
  visiblePolls = sortPollsByDate(filtered, dateOrder);
  renderPollsTable(visiblePolls);
}

filterDateInput.addEventListener('change', applyFilters);
filterBotInput?.addEventListener('change', () => {
  filterGroupInput.value = '';
  populateGroupFilter();
  applyFilters();
});
filterGroupInput.addEventListener('change', applyFilters);
filterTypeInput.addEventListener('change', applyFilters);
filterDateOrderInput.addEventListener('change', applyFilters);

clearFiltersBtn.addEventListener('click', () => {
  filterDateInput.value    = '';
  if (filterBotInput) filterBotInput.value = '';
  filterGroupInput.value   = '';
  filterTypeInput.value    = '';
  filterDateOrderInput.value = 'asc';
  populateGroupFilter();
  visiblePolls = sortPollsByDate(scheduledPolls, 'asc');
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
      isActive ? `<button type="button" data-id="${poll.id}" data-action="send-now" class="secondary btn-sm poll-action"><i data-lucide="send" aria-hidden="true"></i> Send now</button>` : '',
      poll.status === 'failed' ? `<button type="button" data-id="${poll.id}" data-action="retry" class="secondary btn-sm poll-action"><i data-lucide="rotate-ccw" aria-hidden="true"></i> Retry</button>` : '',
      isActive ? `<button type="button" data-id="${poll.id}" data-action="cancel" class="danger-link btn-sm poll-action"><i data-lucide="x-circle" aria-hidden="true"></i> Cancel</button>` : '',
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
        <td>${typePill(poll.is_custom)}</td>
        <td>
          <div class="poll-meta">Release ${formatLocalDateTime(poll.resolved_release_at)}</div>
          <div class="poll-meta">Cutoff ${formatLocalDateTime(poll.close_at)}</div>
        </td>
        <td class="col-actions">
          <div class="col-actions">
            ${actionBtns}
            <button type="button" data-id="${poll.id}" class="secondary btn-sm poll-details"><i data-lucide="panel-right-open" aria-hidden="true"></i> Details</button>
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
  scheduledPolls = sortPollsByDate(await response.json());
  applyFilters(); // re-render with current filter
}

document.getElementById('refresh-polls-btn').addEventListener('click', loadScheduledPolls);

/* ── Bootstrap ──────────────────────────────────────────────────── */
async function loadPollsPage() {
  if (currentUser?.role === 'admin') {
    const usersRes = await fetch('/api/admin/users', { cache: 'no-store' });
    if (usersRes.ok && usersRes.status !== 501) {
      adminUsers = await usersRes.json();
      populateBotFilter();
      filterBotField.hidden = false;
    }
  }
  const groupsRes = await fetch('/api/telegram-groups');
  if (groupsRes.ok && groupsRes.status !== 501) {
    managedGroups = await groupsRes.json();
    populateGroupFilter();
  }
  await loadScheduledPolls();
}

async function bootstrap() {
  window.gtrsgAuth.init();
  const config = await (await nativeFetch('/api/auth-config')).json();
  if (config.required && !window.gtrsgAuth.hasSession()) {
    window.gtrsgAuth.showLogin();
    return;
  }
  if (config.required) {
    const meResponse = await fetch('/api/me');
    if (!meResponse.ok) {
      window.gtrsgAuth.showLogin('Session expired. Sign in with Telegram again.');
      return;
    }
    currentUser = await meResponse.json();
    window.gtrsgAuth.renderUser(currentUser);
    renderRoleNavigation(currentUser);
  } else {
    currentUser = { role: 'admin' };
    renderRoleNavigation(currentUser);
  }
  await loadPollsPage();
}

bootstrap().catch((err) => setStatus(`Error: ${err.message}`, 'error'));
