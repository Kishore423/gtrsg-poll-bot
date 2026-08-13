const nativeFetch = window.gtrsgAuth.nativeFetch;
let legacyWorkflowEnabled = true;
const authOverlay = document.getElementById('auth-overlay');
let currentUser = null;

const form = document.getElementById('slot-form');
const slotsContainer = document.getElementById('slots-container');
const statusEl = document.getElementById('status');
const triggerBtn = document.getElementById('trigger-now');
const targetsListEl = document.getElementById('targets-list');
const managedGroupForm = document.getElementById('managed-group-form');
const managedScheduleForm = document.getElementById('managed-schedule-form');
const advancePollForm = document.getElementById('advance-poll-form');
const shiftEditor = document.getElementById('shift-editor');
const weeklyShiftEditor = document.getElementById('weekly-shift-editor');
const weeklyAddShiftBtn = document.getElementById('weekly-add-shift');
const managedGroupList = document.getElementById('managed-group-list');
const managedScheduleList = document.getElementById('managed-schedule-list');
const templateTimingPreview = document.getElementById('template-timing-preview');
const weeklyTemplatePollPreview = document.getElementById('weekly-template-poll-preview');
const oneOffTimingPreview = document.getElementById('one-off-timing-preview');
const templateSkipDateInput = document.getElementById('template-skip-date');
const templateAddSkipDateBtn = document.getElementById('template-add-skip-date');
const templateSkipDateList = document.getElementById('template-skip-date-list');
const groupActionDialog = document.getElementById('group-action-dialog');
const groupActionTitle = document.getElementById('group-action-title');
const groupActionSubtitle = document.getElementById('group-action-subtitle');
const groupActionClose = document.getElementById('group-action-close');
const actionFeedbackDialog = document.getElementById('action-feedback-dialog');
const actionFeedbackMessage = document.getElementById('action-feedback-message');
const actionFeedbackClose = document.getElementById('action-feedback-close');
const managedScheduleSection = document.getElementById('managed-schedule-section');
const skipDaysSection = document.getElementById('skip-days-section');
const advancePollSection = document.getElementById('advance-poll-section');
const batchReleaseDateInput = document.getElementById('batch-release-date');
const batchSummary = document.getElementById('batch-summary');
const batchList = document.getElementById('batch-list');
const batchScheduleBtn = document.getElementById('batch-schedule');
const adminManagedUserFilter = document.getElementById('admin-managed-user-filter');
const adminManagedUserSearch = document.getElementById('admin-managed-user-search');
const adminManagedUserOptions = document.getElementById('admin-managed-user-options');
const adminManagedUserSummary = document.getElementById('admin-managed-user-summary');

const SERVICE_ORDER = ['WHCL', 'PSA'];
const SERVICE_NAMES = { WHCL: 'Wheelchair', PSA: 'Passenger Service Associate' };
const DEFAULT_RELEASE_DAY = 3;
const DEFAULT_RELEASE_TIME = '17:00';
let managedGroups = [];
let allManagedGroups = [];
let managedSchedules = [];
let scheduledPolls = [];
let generatedBatchRows = [];
let pollExclusions = [];
let selectedManagedGroupId = '';
let adminManagedUsers = [];
let selectedAdminManagedUserId = '';
let adminManagedContextRefreshPromise = null;
let managedScheduleSavePending = false;

const managedWorkflowSections = [managedScheduleSection, skipDaysSection, advancePollSection].filter(Boolean);

function hideManagedWorkflowSections() {
  managedWorkflowSections.forEach((section) => {
    section.hidden = true;
  });
}

function setSelectedManagedGroup(telegramGroupId) {
  selectedManagedGroupId = telegramGroupId || '';
  managedScheduleForm.elements.telegram_group_id.value = selectedManagedGroupId;
  advancePollForm.elements.telegram_group_id.value = selectedManagedGroupId;
  const weeklyTestGroup = document.getElementById('weekly-send-group');
  if (weeklyTestGroup) weeklyTestGroup.value = selectedManagedGroupId;
  syncWeeklyTemplateFormFromSavedSchedule(selectedManagedGroupId);
  syncOneOffPollFormFromSavedSchedule(selectedManagedGroupId);
  refreshManagedPreviews();
}

async function selectManagedGroup(telegramGroupId) {
  setSelectedManagedGroup(telegramGroupId);
  await loadPollExclusions(telegramGroupId);
}

async function openGroupActionDialog(telegramGroupId) {
  const group = groupById(telegramGroupId);
  if (!group || !groupActionDialog) return;
  await selectManagedGroup(telegramGroupId);
  groupActionTitle.textContent = managedGroupOptionLabel(group);
  groupActionSubtitle.textContent = group.telegram_chat_id;
  groupActionDialog.hidden = false;
}

function closeGroupActionDialog() {
  if (groupActionDialog) groupActionDialog.hidden = true;
}

function showActionFeedback(message) {
  if (!actionFeedbackDialog || !actionFeedbackMessage) return;
  actionFeedbackMessage.textContent = message;
  actionFeedbackDialog.hidden = false;
  actionFeedbackClose?.focus();
}

function closeActionFeedback() {
  if (actionFeedbackDialog) actionFeedbackDialog.hidden = true;
}

function showManagedWorkflow(workflow) {
  if (!selectedManagedGroupId) return;
  hideManagedWorkflowSections();
  const section = workflow === 'skip'
    ? skipDaysSection
    : workflow === 'custom'
      ? advancePollSection
      : managedScheduleSection;
  if (section) {
    section.hidden = false;
    if (workflow === 'template') {
      syncWeeklyTemplateFormFromSavedSchedule(selectedManagedGroupId);
    } else if (workflow === 'custom') {
      syncOneOffPollFormFromSavedSchedule(selectedManagedGroupId);
    }
    section.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  closeGroupActionDialog();
}

function formatTime(hhmm) {
  return `${hhmm.slice(0, 2)}:${hhmm.slice(2, 4)}`;
}

function servicePill(service) {
  // Only WHCL/PSA are real service routes. Per-user (UUID) bot ids and any other
  // value are neutral — never fall through to a "Wheelchair" label, which
  // mislabels e.g. a PSA-bot group as green Wheelchair.
  if (service === 'PSA') return '<span class="pill pill-psa">PSA</span>';
  if (service === 'WHCL') return '<span class="pill pill-whcl">Wheelchair</span>';
  return '<span class="pill" style="background: #f4f6f8; color: #5b6472; border: 1px solid var(--border);">General</span>';
}

function managedGroupOptionLabel(group) {
  return group.group_name || '';
}

function setStatus(message, kind) {
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.className = message ? `visible ${kind}` : '';
}

function addLocalDays(dateText, days) {
  const [year, month, day] = dateText.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function weekday(dateText) {
  return new Date(`${dateText}T00:00:00Z`).getUTCDay();
}

function releaseDateForEvent(eventDate, releaseDay, gapWeeks = 0) {
  const eventMonday = mondayOfWeek(eventDate);
  const releaseWeekMonday = addLocalDays(eventMonday, -(Number(gapWeeks || 0) + 1) * 7);
  return addLocalDays(releaseWeekMonday, (Number(releaseDay) + 6) % 7);
}

function mondayOfWeek(dateText) {
  return addLocalDays(dateText, -((weekday(dateText) + 6) % 7));
}

function eventWeekDateTime(eventDate, targetDay, targetTime) {
  const eventMonday = mondayOfWeek(eventDate);
  const priorWeekMonday = addLocalDays(eventMonday, -7);
  const date = addLocalDays(priorWeekMonday, (Number(targetDay) + 6) % 7);
  return `${date}T${String(targetTime).slice(0, 5)}`;
}

function serviceForGroup(telegramGroupId) {
  const group = managedGroups.find((g) => g.id === telegramGroupId);
  return group?.service || group?.bot_id || 'WHCL';
}

function managedTimingForEvent({ telegramGroupId, eventDateVal, schedule }) {
  const service = serviceForGroup(telegramGroupId);
  const releaseDay = schedule?.poll_release_day_of_week ?? DEFAULT_RELEASE_DAY;
  const releaseTime = (schedule?.poll_release_time || DEFAULT_RELEASE_TIME).slice(0, 5);
  const releaseDate = releaseDateForEvent(eventDateVal, releaseDay, schedule?.gap_weeks);
  const releaseAt = `${releaseDate}T${releaseTime}`;
  const hasConfiguredConfirmation = schedule?.confirmation_day_of_week !== undefined &&
    Boolean(schedule?.confirmation_time);
  const configuredConfirmationAt = hasConfiguredConfirmation
    ? eventWeekDateTime(
      eventDateVal,
      Number(schedule.confirmation_day_of_week),
      String(schedule.confirmation_time),
    )
    : null;

  if (service === 'PSA') {
    const cutoffAt = eventWeekDateTime(
      eventDateVal,
      5,
      '08:00',
    );
    const timing = {
      service,
      releaseAt,
      closeAt: cutoffAt,
      confirmationAt: configuredConfirmationAt || `${cutoffAt.slice(0, 10)}T12:00`,
    };
    if (timing.closeAt <= releaseAt) {
      throw new RangeError('PSA release must be before Friday 08:00 in the week before the event week');
    }
    if (timing.confirmationAt <= releaseAt) {
      throw new RangeError('Confirmation date and time must be after release date and time');
    }
    return timing;
  }

  const cutoffDate = addLocalDays(eventDateVal, -1);
  const timing = {
    service,
    releaseAt,
    closeAt: `${cutoffDate}T08:00`,
    confirmationAt: configuredConfirmationAt || `${cutoffDate}T08:00`,
  };
  if (timing.closeAt <= releaseAt) {
    throw new RangeError('Release date and time must be before the event cutoff');
  }
  if (timing.confirmationAt <= releaseAt) {
    throw new RangeError('Confirmation date and time must be after release date and time');
  }
  return timing;
}

function formatLocalDateTime(value) {
  if (!value) return 'Not set';
  return new Date(value).toLocaleString('en-SG', {
    hour12: false, year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function formatLocalDate(dateText) {
  return new Date(`${dateText}T00:00:00`).toLocaleDateString('en-SG', {
    weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
  });
}

function groupById(telegramGroupId) {
  return managedGroups.find((group) => group.id === telegramGroupId);
}

function adminUserSearchLabel(user) {
  const displayName = user.telegram_display_name || user.telegram_username || `Telegram ${user.telegram_user_id}`;
  return user.telegram_username ? `${displayName} - @${user.telegram_username}` : displayName;
}

function adminManagedUserBotLabel(user) {
  const bot = user?.bot;
  if (!bot?.id) return 'no assigned bot';
  const name = bot.bot_name || 'Telegram bot';
  return bot.telegram_username ? `${name} (@${bot.telegram_username})` : name;
}

function selectedAdminManagedUser() {
  return adminManagedUsers.find((user) => String(user.id) === selectedAdminManagedUserId) || null;
}

async function loadAdminManagedUsers() {
  if (currentUser?.role !== 'admin') return;
  const response = await fetch('/api/admin/users', { cache: 'no-store' });
  const result = await response.json().catch(() => []);
  if (!response.ok) throw new Error(result.error || 'Unable to load users for managed groups');
  adminManagedUsers = result;
  adminManagedUserOptions.innerHTML = adminManagedUsers.map((user) =>
    `<option value="${escapeHtml(adminUserSearchLabel(user))}"></option>`).join('');
  if (!selectedAdminManagedUserId && adminManagedUserSearch?.value.trim()) {
    const restoredLabel = adminManagedUserSearch.value.trim().toLowerCase();
    const restoredUser = adminManagedUsers.find((user) =>
      adminUserSearchLabel(user).toLowerCase() === restoredLabel);
    if (restoredUser) selectedAdminManagedUserId = String(restoredUser.id);
  }
  const selectedUser = selectedAdminManagedUser();
  if (selectedUser && adminManagedUserSearch) {
    adminManagedUserSearch.value = adminUserSearchLabel(selectedUser);
  }
  adminManagedUserFilter.hidden = false;
}

async function refreshAdminManagedContext() {
  if (currentUser?.role !== 'admin') return;
  if (adminManagedContextRefreshPromise) return adminManagedContextRefreshPromise;
  adminManagedContextRefreshPromise = (async () => {
    await loadAdminManagedUsers();
    if (selectedAdminManagedUserId) {
      await loadManagedGroups();
      await loadManagedSchedules();
    }
  })();
  try {
    await adminManagedContextRefreshPromise;
  } finally {
    adminManagedContextRefreshPromise = null;
  }
}

adminManagedUserSearch?.addEventListener('input', async () => {
  const query = adminManagedUserSearch.value.trim().toLowerCase();
  const selected = adminManagedUsers.find((user) =>
    adminUserSearchLabel(user).toLowerCase() === query);
  if (!selected && query) return;
  const nextUserId = selected ? String(selected.id) : '';
  if (nextUserId === selectedAdminManagedUserId) return;
  selectedAdminManagedUserId = nextUserId;
  selectedManagedGroupId = '';
  hideManagedWorkflowSections();
  try {
    await loadManagedGroups();
    await loadManagedSchedules();
  } catch (error) {
    setStatus(`Error: ${error.message}`, 'error');
  }
});

function scheduleForGroup(telegramGroupId) {
  return managedSchedules.find((s) => s.telegram_group_id === telegramGroupId && s.enabled);
}

function replaceManagedSchedule(schedule) {
  const index = managedSchedules.findIndex((item) =>
    item.id === schedule.id ||
    (item.telegram_group_id === schedule.telegram_group_id && (item.event_category || '') === (schedule.event_category || ''))
  );
  if (index === -1) managedSchedules.push(schedule);
  else managedSchedules[index] = schedule;
}

function scheduleFromSaveResult(result, body) {
  return {
    ...result,
    telegram_group_id: body.telegram_group_id,
    poll_release_day_of_week: body.poll_release_day_of_week,
    poll_release_time: body.poll_release_time,
    confirmation_day_of_week: body.confirmation_day_of_week,
    confirmation_time: body.confirmation_time,
    gap_weeks: body.gap_weeks,
    timezone: body.timezone,
    enabled: body.enabled !== false,
    shifts: body.shifts,
  };
}

function defaultScheduleForGroup(telegramGroupId) {
  return {
    telegram_group_id: telegramGroupId,
    poll_release_day_of_week: DEFAULT_RELEASE_DAY,
    poll_release_time: DEFAULT_RELEASE_TIME,
    confirmation_day_of_week: 5,
    confirmation_time: '12:00',
    gap_weeks: 0,
    timezone: 'Asia/Singapore',
    enabled: true,
  };
}

function addDays(dateText, days) {
  return addLocalDays(dateText, days);
}

function nextReleaseDateForSchedule(schedule, from = new Date()) {
  const day = Number(schedule?.poll_release_day_of_week ?? DEFAULT_RELEASE_DAY);
  const releaseTime = String(schedule?.poll_release_time || DEFAULT_RELEASE_TIME).slice(0, 5);
  const today = new Date(from);
  today.setHours(0, 0, 0, 0);
  const todayText = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const delta = (day - weekday(todayText) + 7) % 7;
  let releaseDate = addDays(todayText, delta);
  if (new Date(`${releaseDate}T${releaseTime}:00+08:00`) <= from) {
    releaseDate = addDays(releaseDate, 7);
  }
  return releaseDate;
}

function batchRangeForReleaseDate(releaseDate, gapWeeks = 0) {
  const daysUntilMonday = ((1 - weekday(releaseDate) + 7) % 7) || 7;
  const start = addDays(releaseDate, daysUntilMonday + Number(gapWeeks || 0) * 7);
  return Array.from({ length: 7 }, (_, index) => addDays(start, index));
}

function generatedShiftLabel(start, end) {
  return `${start.replace(':', '')}-${end.replace(':', '')}`;
}

function isGeneratedShiftLabel(label) {
  return /^\d{4}-\d{4}$/.test(label);
}

function syncGeneratedShiftLabel(row) {
  const start = row.querySelector('[name="shift_start"]')?.value || '';
  const end = row.querySelector('[name="shift_end"]')?.value || '';
  const labelInput = row.querySelector('[name="shift_label"]');
  if (!start || !end || !labelInput) return;
  const current = labelInput.value.trim();
  const next = generatedShiftLabel(start, end);
  labelInput.placeholder = next;
  if (!current || isGeneratedShiftLabel(current)) {
    labelInput.value = next;
  }
}

function shiftRowsFromContainer(container) {
  return [...container.querySelectorAll('.shift-row')].map((row) => {
    const start = row.querySelector('[name="shift_start"]').value;
    const end = row.querySelector('[name="shift_end"]').value;
    const labelInput = row.querySelector('[name="shift_label"]');
    const customLabel = labelInput.value.trim();
    const capacity = row.querySelector('[name="shift_capacity"]').value;
    const fallbackLabel = generatedShiftLabel(start, end);
    if (!customLabel || isGeneratedShiftLabel(customLabel)) {
      labelInput.placeholder = fallbackLabel;
      labelInput.value = fallbackLabel;
    }
    return {
      label: customLabel && !isGeneratedShiftLabel(customLabel) ? customLabel : fallbackLabel,
      start_time: start,
      end_time: end,
      capacity: Number(capacity),
      complete: Boolean(start && end && capacity),
    };
  });
}

function normalizeShifts(shifts) {
  return shifts.map((shift) => ({
    label: shift.label,
    start_time: shift.start_time,
    end_time: shift.end_time,
    capacity: Number(shift.capacity),
  }));
}

function pollTextForEvent({ group, eventDateVal, shifts }) {
  const eventDate = new Date(eventDateVal + 'T00:00:00');
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const datePrefix = `${days[eventDate.getDay()]}, ${eventDate.getDate()}${months[eventDate.getMonth()]}${String(eventDate.getFullYear()).slice(-2)}`;
  const title = `${group.group_name} - ${datePrefix} Slots`;
  const shiftSummaries = shifts.map((shift) => {
    const unit = shift.capacity === 1 ? 'slot' : 'slots';
    return `${shift.capacity} ${unit} for ${shift.label}`;
  });
  return { title, pollQuestion: `${datePrefix} - ${shiftSummaries.join(', ')}` };
}

function pollOptionLabelsForShifts(shifts) {
  const labels = shifts.map((shift) => shift.label);
  if (labels.length === 1) labels.push('Not available');
  return labels;
}

function buildScheduledPollPayload({
  telegramGroupId,
  eventDateVal,
  schedule,
  shifts,
  isCustom,
  sendImmediately = false,
  isTest = false,
  confirmationAt = null,
}) {
  const group = groupById(telegramGroupId);
  const timing = managedTimingForEvent({ telegramGroupId, eventDateVal, schedule });
  let { title, pollQuestion } = pollTextForEvent({ group, eventDateVal, shifts });
  if (isTest) {
    title = `[TEST] ${title}`;
    pollQuestion = `[TEST] ${pollQuestion}`;
  }
  const isPastRelease = new Date(timing.releaseAt) <= new Date();
  const immediate = sendImmediately || isPastRelease || isTest;
  return {
    telegram_group_id: telegramGroupId,
    event_date: eventDateVal,
    title,
    poll_question: pollQuestion,
    release_mode: immediate ? 'weekly' : 'datetime',
    specific_release_at: immediate ? undefined : timing.releaseAt,
    send_immediately: immediate,
    close_at: timing.closeAt,
    confirmation_at: confirmationAt || timing.confirmationAt,
    weekly_schedule_id: schedule.id,
    timezone: 'Asia/Singapore',
    confirmation_header: isTest ? 'Confirmed slots (TEST)' : 'Confirmed slots',
    confirmation_footer: isTest ? 'take note pls (TEST)' : 'take note pls',
    show_waiting_list: false,
    show_empty_shifts: false,
    is_custom: Boolean(isCustom),
    is_test: Boolean(isTest),
    shifts,
  };
}

function activePollForDate(telegramGroupId, eventDateVal) {
  return scheduledPolls.find((poll) =>
    poll.telegram_group_id === telegramGroupId &&
    String(poll.event_date).slice(0, 10) === eventDateVal &&
    poll.status !== 'cancelled'
  );
}

function timingSummaryHtml({ telegramGroupId, eventDateVal, schedule, confirmationAt = null }) {
  const group = groupById(telegramGroupId);
  if (!group) return 'Select a group.';
  const effectiveSchedule = schedule || defaultScheduleForGroup(telegramGroupId);
  const service = serviceForGroup(telegramGroupId);
  const timing = eventDateVal ? managedTimingForEvent({ telegramGroupId, eventDateVal, schedule: effectiveSchedule }) : null;
  if (timing && confirmationAt) timing.confirmationAt = confirmationAt;
  const gapWeeks = Number(effectiveSchedule.gap_weeks || 0);
  const gapRule = gapWeeks === 0
    ? 'next Monday-Sunday event week'
    : `${gapWeeks} full gap ${gapWeeks === 1 ? 'week' : 'weeks'} before the Monday-Sunday event week`;
  const confirmationRule = `Confirmation ${DAY_NAMES[effectiveSchedule.confirmation_day_of_week]} ${String(effectiveSchedule.confirmation_time).slice(0, 5)} in the week before the event week.`;
  const rule = service === 'PSA'
    ? `Cutoff Friday before the event week at 08:00. ${confirmationRule}`
    : `Cutoff 1 day before each event at 08:00. ${confirmationRule}`;
  const source = schedule ? '' : 'Default timing: ';
  return timing
    ? `${servicePill(service)} <strong>${escapeHtml(group.group_name)}</strong><br>Release ${formatLocalDateTime(timing.releaseAt)} · Cutoff ${formatLocalDateTime(timing.closeAt)} · Confirmation ${formatLocalDateTime(timing.confirmationAt)}`
    : `${servicePill(service)} <strong>${escapeHtml(group.group_name)}</strong><br>Release ${DAY_NAMES[effectiveSchedule.poll_release_day_of_week]} ${String(effectiveSchedule.poll_release_time).slice(0, 5)}; ${gapRule}. ${rule}`;
}

function sendPollNow() { /* moved to polls.js */ }

function createTimeWheelPicker(container, initialValue = '08:00') {
  let [initH, initM] = initialValue.split(':');
  initH = initH || '08';
  initM = initM || '00';

  const name = container.dataset.name;
  container.innerHTML = `
    <input type="hidden" name="${name}" value="${initH}:${initM}" />
    <div class="wheel wheel-hour">
      <div class="wheel-pad"></div>
      ${Array.from({ length: 24 }, (_, i) => {
        const val = String(i).padStart(2, '0');
        return `<div class="wheel-item" data-val="${val}">${val}</div>`;
      }).join('')}
      <div class="wheel-pad"></div>
    </div>
    <span class="wheel-separator">:</span>
    <div class="wheel wheel-minute">
      <div class="wheel-pad"></div>
      ${Array.from({ length: 60 }, (_, i) => {
        const val = String(i).padStart(2, '0');
        return `<div class="wheel-item" data-val="${val}">${val}</div>`;
      }).join('')}
      <div class="wheel-pad"></div>
    </div>
  `;

  const input = container.querySelector('input[type="hidden"]');
  const hourWheel = container.querySelector('.wheel-hour');
  const minuteWheel = container.querySelector('.wheel-minute');

  function setPickerValue(hour, minute) {
    input.value = `${hour}:${minute}`;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function initWheel(wheel, initialVal, type, onSelect) {
    const items = [...wheel.querySelectorAll('.wheel-item')];
    const itemHeight = () => items[0].offsetHeight || 25.6;
    
    const initIdx = items.findIndex(item => item.dataset.val === initialVal);
    if (initIdx !== -1) {
      wheel.scrollTop = initIdx * itemHeight();
    }

    let scrollTimeout;
    function updateActive() {
      const idx = Math.round(wheel.scrollTop / itemHeight());
      items.forEach((item, i) => {
        if (i === idx) {
          item.classList.add('active');
        } else {
          item.classList.remove('active');
        }
      });
      if (items[idx]) {
        onSelect(items[idx].dataset.val);
      }
    }

    wheel.addEventListener('scroll', () => {
      updateActive();
      clearTimeout(scrollTimeout);
      scrollTimeout = setTimeout(() => {
        const height = itemHeight();
        const idx = Math.round(wheel.scrollTop / height);
        wheel.scrollTo({ top: idx * height, behavior: 'smooth' });
      }, 150);
    });

    wheel.addEventListener('click', (e) => {
      const item = e.target.closest('.wheel-item');
      if (!item || !item.classList.contains('active')) return;
      if (item.querySelector('input')) return; // already editing

      const originalVal = item.dataset.val;
      const inlineInput = document.createElement('input');
      inlineInput.type = 'text';
      inlineInput.value = originalVal;
      inlineInput.maxLength = 2;

      item.innerHTML = '';
      item.appendChild(inlineInput);
      inlineInput.focus();
      inlineInput.select();

      let finished = false;
      function finishEdit() {
        if (finished) return;
        finished = true;
        
        let typedVal = inlineInput.value.trim();
        if (/^\d$/.test(typedVal)) {
          typedVal = typedVal.padStart(2, '0');
        }
        
        const maxVal = type === 'hour' ? 23 : 59;
        const isValid = /^\d{2}$/.test(typedVal) && Number(typedVal) <= maxVal;

        if (isValid) {
          item.innerHTML = typedVal;
          item.dataset.val = typedVal;
          onSelect(typedVal);
          scrollToVal(wheel, typedVal);
        } else {
          item.innerHTML = originalVal;
        }
      }

      inlineInput.addEventListener('input', () => {
        let typedVal = inlineInput.value.trim();
        if (/^\d$/.test(typedVal)) typedVal = typedVal.padStart(2, '0');
        const maxVal = type === 'hour' ? 23 : 59;
        if (/^\d{2}$/.test(typedVal) && Number(typedVal) <= maxVal) {
          onSelect(typedVal);
        }
      });

      inlineInput.addEventListener('blur', finishEdit);
      inlineInput.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          finishEdit();
        } else if (ev.key === 'Escape') {
          ev.preventDefault();
          inlineInput.value = originalVal;
          finishEdit();
        }
      });
    });

    setTimeout(updateActive, 50);
  }

  function scrollToVal(wheel, val) {
    const items = [...wheel.querySelectorAll('.wheel-item')];
    const itemHeight = items[0].offsetHeight || 25.6;
    const idx = items.findIndex(item => item.dataset.val === val);
    if (idx !== -1) {
      wheel.scrollTo({ top: idx * itemHeight, behavior: 'smooth' });
    }
  }

  let selectedHour = initH;
  let selectedMinute = initM;

  initWheel(hourWheel, initH, 'hour', (val) => {
    selectedHour = val;
    setPickerValue(selectedHour, selectedMinute);
  });

  initWheel(minuteWheel, initM, 'minute', (val) => {
    selectedMinute = val;
    setPickerValue(selectedHour, selectedMinute);
  });
}

function addShiftRowToContainer(container, value = {}) {
  const row = document.createElement('div');
  row.className = 'schedule-row shift-row';

  let startTime = value.start_time || '08:00';
  if (startTime.includes(':') && startTime.split(':').length > 2) {
    startTime = startTime.slice(0, 5);
  }
  let endTime = value.end_time || '17:00';
  if (endTime.includes(':') && endTime.split(':').length > 2) {
    endTime = endTime.slice(0, 5);
  }

  row.innerHTML = `
    <label class="shift-label-field">Shift label (optional)<input name="shift_label" value="${escapeHtml(value.label || '')}" placeholder="Auto-generated" /></label>
    <label class="shift-time-field">Starts<div class="time-wheel-picker" data-name="shift_start"></div></label>
    <label class="shift-time-field">Ends<div class="time-wheel-picker" data-name="shift_end"></div></label>
    <label class="shift-slots-field">Slots<input type="number" name="shift_capacity" min="0" value="${value.capacity ?? 1}" required /></label>
    <span class="shift-actions">
      <button type="button" class="danger-link remove-shift">Remove</button>
    </span>`;

  row.querySelector('.remove-shift').addEventListener('click', () => {
    row.remove();
    if (container === weeklyShiftEditor) updateTemplatePollPreview();
  });
  container.appendChild(row);

  createTimeWheelPicker(row.querySelector('[data-name="shift_start"]'), startTime);
  createTimeWheelPicker(row.querySelector('[data-name="shift_end"]'), endTime);
  ['input', 'change'].forEach((eventName) => {
    row.querySelector('[name="shift_start"]').addEventListener(eventName, () => syncGeneratedShiftLabel(row));
    row.querySelector('[name="shift_end"]').addEventListener(eventName, () => syncGeneratedShiftLabel(row));
  });
  row.querySelector('[name="shift_label"]').addEventListener('input', () => {
    const labelInput = row.querySelector('[name="shift_label"]');
    if (!labelInput.value.trim()) syncGeneratedShiftLabel(row);
  });
  syncGeneratedShiftLabel(row);
}

function addShiftRow(value = {}) {
  addShiftRowToContainer(shiftEditor, value);
}

function addWeeklyShiftRow(value = {}) {
  addShiftRowToContainer(weeklyShiftEditor, value);
}

function syncOneOffPollFormFromSavedSchedule(telegramGroupId = advancePollForm.elements.telegram_group_id.value) {
  const schedule = scheduleForGroup(telegramGroupId);
  shiftEditor.innerHTML = '';
  if (schedule && Array.isArray(schedule.shifts) && schedule.shifts.length) {
    schedule.shifts.forEach((shift) => addShiftRow(shift));
  } else {
    addShiftRow();
  }
  syncOneOffConfirmationFromTiming();
  updateOneOffTimingPreview();
}

function setTimeWheelPickerValue(container, value) {
  if (!container) return;
  const normalized = String(value || DEFAULT_RELEASE_TIME).slice(0, 5);
  const [hour, minute] = normalized.split(':');
  const input = container.querySelector('input[type="hidden"]');
  if (input) input.value = `${hour}:${minute}`;

  [
    ['.wheel-hour', hour],
    ['.wheel-minute', minute],
  ].forEach(([selector, val]) => {
    const wheel = container.querySelector(selector);
    if (!wheel) return;
    const items = [...wheel.querySelectorAll('.wheel-item')];
    const index = items.findIndex((item) => item.dataset.val === val);
    if (index === -1) return;
    const itemHeight = items[0]?.offsetHeight || 25.6;
    wheel.scrollTop = index * itemHeight;
    items.forEach((item, itemIndex) => item.classList.toggle('active', itemIndex === index));
  });
}

function syncWeeklyTemplateFormFromSavedSchedule(telegramGroupId) {
  const schedule = scheduleForGroup(telegramGroupId) || defaultScheduleForGroup(telegramGroupId);
  managedScheduleForm.elements.telegram_group_id.value = telegramGroupId || '';
  managedScheduleForm.elements.poll_release_day_of_week.value = String(schedule.poll_release_day_of_week ?? DEFAULT_RELEASE_DAY);
  managedScheduleForm.elements.poll_release_time.value = String(schedule.poll_release_time || DEFAULT_RELEASE_TIME).slice(0, 5);
  managedScheduleForm.elements.confirmation_day_of_week.value = String(schedule.confirmation_day_of_week ?? 5);
  managedScheduleForm.elements.confirmation_time.value = String(schedule.confirmation_time || '12:00').slice(0, 5);
  managedScheduleForm.elements.gap_weeks.value = String(schedule.gap_weeks ?? 0);
  setTimeWheelPickerValue(document.querySelector('[data-name="poll_release_time"]'), managedScheduleForm.elements.poll_release_time.value);
  setTimeWheelPickerValue(document.querySelector('[data-name="confirmation_time"]'), managedScheduleForm.elements.confirmation_time.value);

  weeklyShiftEditor.innerHTML = '';
  const shifts = Array.isArray(schedule.shifts) ? schedule.shifts : [];
  if (shifts.length) shifts.forEach((shift) => addWeeklyShiftRow(shift));
  else addWeeklyShiftRow();
}

function renderPollExclusions() {
  if (!templateSkipDateList) return;
  if (!pollExclusions.length) {
    templateSkipDateList.innerHTML = '<p class="hint" style="margin: 0;">No event dates are currently skipped for this group.</p>';
    return;
  }
  templateSkipDateList.innerHTML = pollExclusions.map((item) => `
    <div class="schedule-row">
      <span><strong>${escapeHtml(formatLocalDate(String(item.event_date).slice(0, 10)))}</strong></span>
      <button type="button" class="danger-link remove-skip-date" data-id="${escapeHtml(item.id)}">Allow poll</button>
    </div>`).join('');
  templateSkipDateList.querySelectorAll('.remove-skip-date').forEach((button) => {
    button.addEventListener('click', async () => {
      if (!window.confirm('Allow the automatic scheduler to create this event date again?')) return;
      const response = await fetch(`/api/poll-exclusions/${button.dataset.id}`, { method: 'DELETE' });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) return setStatus(`Error: ${result.error}`, 'error');
      await loadPollExclusions(managedScheduleForm.elements.telegram_group_id.value);
      setStatus('Event date is allowed again.', 'success');
    });
  });
}

async function loadPollExclusions(telegramGroupId) {
  if (!telegramGroupId) {
    pollExclusions = [];
    renderPollExclusions();
    return;
  }
  const response = await fetch(`/api/poll-exclusions?telegram_group_id=${encodeURIComponent(telegramGroupId)}`);
  if (response.status === 501) return;
  const result = await response.json();
  if (!response.ok) return setStatus(`Error: ${result.error}`, 'error');
  pollExclusions = result;
  renderPollExclusions();
}

async function addPollExclusion() {
  const telegramGroupId = managedScheduleForm.elements.telegram_group_id.value;
  const eventDate = templateSkipDateInput.value;
  if (!telegramGroupId || !eventDate) {
    setStatus('Select a Telegram group and event date to skip.', 'error');
    return;
  }
  const response = await fetch('/api/poll-exclusions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ telegram_group_id: telegramGroupId, event_date: eventDate }),
  });
  const result = await response.json();
  if (!response.ok) return setStatus(`Error: ${result.error}`, 'error');
  templateSkipDateInput.value = '';
  await loadPollExclusions(telegramGroupId);
  if (result.active_poll_status) {
    setStatus(`Date skipped for future generation, but its existing ${result.active_poll_status} poll was already sent and remains active.`, 'error');
  } else if (result.removed_unsent_polls) {
    setStatus('Event date skipped and its unsent default poll was removed.', 'success');
  } else {
    setStatus('Event date will be skipped in automatic release batches.', 'success');
  }
}

weeklyAddShiftBtn.addEventListener('click', () => {
  addWeeklyShiftRow();
  updateTemplatePollPreview();
});
document.getElementById('add-shift').addEventListener('click', () => addShiftRow());
addWeeklyShiftRow();
addShiftRow();



function updateTemplateTimingPreview() {
  const telegramGroupId = managedScheduleForm.elements.telegram_group_id.value;
  const schedule = {
    poll_release_day_of_week: Number(managedScheduleForm.elements.poll_release_day_of_week.value),
    poll_release_time: managedScheduleForm.elements.poll_release_time.value,
    confirmation_day_of_week: Number(managedScheduleForm.elements.confirmation_day_of_week.value),
    confirmation_time: managedScheduleForm.elements.confirmation_time.value,
    gap_weeks: Number(managedScheduleForm.elements.gap_weeks.value),
  };
  templateTimingPreview.innerHTML = timingSummaryHtml({ telegramGroupId, schedule });
}

function updateTemplatePollPreview() {
  if (!weeklyTemplatePollPreview) return;
  const telegramGroupId = managedScheduleForm.elements.telegram_group_id.value;
  const group = groupById(telegramGroupId);
  if (!group) {
    weeklyTemplatePollPreview.innerHTML = 'Select a group to preview the Telegram poll options.';
    return;
  }

  const savedSchedule = scheduleForGroup(telegramGroupId);
  const formSchedule = {
    poll_release_day_of_week: Number(managedScheduleForm.elements.poll_release_day_of_week.value || DEFAULT_RELEASE_DAY),
    poll_release_time: managedScheduleForm.elements.poll_release_time.value || DEFAULT_RELEASE_TIME,
    confirmation_day_of_week: Number(managedScheduleForm.elements.confirmation_day_of_week.value ?? 5),
    confirmation_time: managedScheduleForm.elements.confirmation_time.value || '12:00',
    gap_weeks: Number(managedScheduleForm.elements.gap_weeks.value || 0),
  };
  const schedule = formSchedule;
  const editorShifts = normalizeShifts(shiftRowsFromContainer(weeklyShiftEditor)
    .filter((shift) => shift.complete && Number.isFinite(shift.capacity)));
  const savedShifts = Array.isArray(savedSchedule?.shifts) ? normalizeShifts(savedSchedule.shifts) : [];
  const shifts = editorShifts.length ? editorShifts : savedShifts;

  if (!shifts.length) {
    weeklyTemplatePollPreview.innerHTML = 'Save template shifts to preview the Telegram poll options.';
    return;
  }

  const releaseDate = nextReleaseDateForSchedule(schedule);
  const eventDateVal = batchRangeForReleaseDate(releaseDate, schedule.gap_weeks)[0];
  const { pollQuestion } = pollTextForEvent({ group, eventDateVal, shifts });
  const options = pollOptionLabelsForShifts(shifts);
  weeklyTemplatePollPreview.innerHTML = `
    <h5>Telegram poll preview</h5>
    <div class="template-poll-question">${escapeHtml(pollQuestion)}</div>
    <ul class="template-poll-options">
      ${options.map((option) => `<li>${escapeHtml(option)}</li>`).join('')}
    </ul>
    <p class="template-poll-meta">Preview event date: ${formatLocalDate(eventDateVal)}</p>`;
}

function updateOneOffTimingPreview() {
  const telegramGroupId = advancePollForm.elements.telegram_group_id.value;
  const eventDateVal = advancePollForm.elements.event_date.value;
  const schedule = scheduleForGroup(telegramGroupId);
  const confirmationDate = advancePollForm.elements.confirmation_date.value;
  const confirmationTime = advancePollForm.elements.one_off_confirmation_time.value;
  const confirmationAt = confirmationDate && confirmationTime
    ? `${confirmationDate}T${confirmationTime}`
    : null;
  oneOffTimingPreview.innerHTML = eventDateVal
    ? timingSummaryHtml({ telegramGroupId, eventDateVal, schedule, confirmationAt })
    : timingSummaryHtml({ telegramGroupId, schedule });
}

function syncOneOffConfirmationFromTiming() {
  const telegramGroupId = advancePollForm.elements.telegram_group_id.value;
  const eventDateVal = advancePollForm.elements.event_date.value;
  if (!telegramGroupId || !eventDateVal) {
    advancePollForm.elements.confirmation_date.value = '';
    return;
  }
  const schedule = scheduleForGroup(telegramGroupId) || defaultScheduleForGroup(telegramGroupId);
  const timing = managedTimingForEvent({ telegramGroupId, eventDateVal, schedule });
  advancePollForm.elements.confirmation_date.value = timing.confirmationAt.slice(0, 10);
  setTimeWheelPickerValue(
    document.querySelector('[data-name="one_off_confirmation_time"]'),
    timing.confirmationAt.slice(11, 16),
  );
}

function updateBatchSummary() {
  const telegramGroupId = selectedManagedGroupId;
  const releaseDate = batchReleaseDateInput.value;
  const schedule = scheduleForGroup(telegramGroupId);
  const group = groupById(telegramGroupId);
  if (!group || !schedule) {
    batchSummary.innerHTML = 'Select a group with a saved release template.';
    return;
  }
  const service = serviceForGroup(telegramGroupId);
  const dates = releaseDate ? batchRangeForReleaseDate(releaseDate, schedule.gap_weeks) : [];
  const rangeText = dates.length ? `${formatLocalDate(dates[0])} to ${formatLocalDate(dates[dates.length - 1])}` : 'Use Next release or choose a release date.';
  batchSummary.innerHTML = `${servicePill(service)} <strong>${escapeHtml(group.group_name)}</strong><br>Release date: ${releaseDate || 'Not selected'} · Event range: ${rangeText}`;
}

function refreshManagedPreviews() {
  updateTemplateTimingPreview();
  updateTemplatePollPreview();
  updateOneOffTimingPreview();
}

function renderBatchRows() {
  if (!generatedBatchRows.length) { batchList.innerHTML = ''; return; }
  batchList.innerHTML = `
    <table class="batch-table">
      <thead><tr><th></th><th>Event date</th><th>Release</th><th>Cutoff</th><th>Confirmation</th><th>Status</th></tr></thead>
      <tbody>${generatedBatchRows.map((row, index) => `
        <tr class="${row.disabled ? 'batch-row-disabled' : ''}">
          <td><input type="checkbox" data-index="${index}" ${row.enabled ? 'checked' : ''} ${row.disabled ? 'disabled' : ''} /></td>
          <td><strong>${formatLocalDate(row.eventDate)}</strong><br><span class="no-votes">${escapeHtml(row.shiftSummary)}</span></td>
          <td>${formatLocalDateTime(row.timing.releaseAt)}</td>
          <td>${formatLocalDateTime(row.timing.closeAt)}</td>
          <td>${formatLocalDateTime(row.timing.confirmationAt)}</td>
          <td>${row.statusHtml}</td>
        </tr>`).join('')}
      </tbody>
    </table>`;
  batchList.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener('change', () => { generatedBatchRows[Number(cb.dataset.index)].enabled = cb.checked; });
  });
}

function generateBatchRows() {
  const telegramGroupId = selectedManagedGroupId;
  const schedule = scheduleForGroup(telegramGroupId);
  const group = groupById(telegramGroupId);
  if (!telegramGroupId || !group || !schedule) { setStatus('Error: Select a group with a saved release template first.', 'error'); return; }
  if (!Array.isArray(schedule.shifts) || !schedule.shifts.length) { setStatus('Error: Add template shifts before generating a release batch.', 'error'); return; }
  const releaseDate = batchReleaseDateInput.value || nextReleaseDateForSchedule(schedule);
  batchReleaseDateInput.value = releaseDate;
  const shifts = normalizeShifts(schedule.shifts);
  const shiftSummary = shifts.map((s) => `${s.label} (${s.capacity})`).join(', ');
  generatedBatchRows = batchRangeForReleaseDate(releaseDate, schedule.gap_weeks).map((eventDate) => {
    const timing = managedTimingForEvent({ telegramGroupId, eventDateVal: eventDate, schedule });
    const existing = activePollForDate(telegramGroupId, eventDate);
    return { eventDate, timing, shifts, shiftSummary, enabled: !existing, disabled: Boolean(existing),
      statusHtml: existing ? '<span class="pill pill-muted">Already scheduled</span>' : '<span class="pill pill-pending">Ready</span>' };
  });
  updateBatchSummary();
  renderBatchRows();
}

async function scheduleGeneratedBatch() {
  const telegramGroupId = selectedManagedGroupId;
  const schedule = scheduleForGroup(telegramGroupId);
  const rows = generatedBatchRows.filter((row) => row.enabled && !row.disabled);
  if (!rows.length) { setStatus('Error: Select at least one ready event date.', 'error'); return; }
  setStatus(`Scheduling ${rows.length} poll${rows.length === 1 ? '' : 's'}...`, 'pending');
  for (const row of rows) {
    try {
      const payload = buildScheduledPollPayload({ telegramGroupId, eventDateVal: row.eventDate, schedule, shifts: row.shifts, isCustom: false });
      const response = await fetch('/api/scheduled-polls', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Scheduling failed');
      row.enabled = false; row.disabled = true;
      row.statusHtml = '<span class="pill pill-sent">Scheduled</span>';
    } catch (err) {
      row.statusHtml = `<span class="pill pill-pending">Failed</span><br><span class="no-votes">${escapeHtml(err.message)}</span>`;
    }
    renderBatchRows();
  }
  setStatus('Batch scheduling finished.', 'success');
}

groupActionClose?.addEventListener('click', closeGroupActionDialog);
groupActionDialog?.addEventListener('click', (event) => {
  if (event.target === groupActionDialog) closeGroupActionDialog();
});
actionFeedbackClose?.addEventListener('click', closeActionFeedback);
actionFeedbackDialog?.addEventListener('click', (event) => {
  if (event.target === actionFeedbackDialog) closeActionFeedback();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && actionFeedbackDialog && !actionFeedbackDialog.hidden) {
    closeActionFeedback();
  }
});
groupActionDialog?.querySelectorAll('[data-group-workflow]').forEach((button) => {
  button.addEventListener('click', () => showManagedWorkflow(button.dataset.groupWorkflow));
});
templateAddSkipDateBtn?.addEventListener('click', addPollExclusion);
managedScheduleForm.elements.poll_release_day_of_week.addEventListener('change', () => {
  updateTemplateTimingPreview();
  updateTemplatePollPreview();
});
managedScheduleForm.elements.confirmation_day_of_week.addEventListener('change', () => {
  updateTemplateTimingPreview();
  updateTemplatePollPreview();
});
managedScheduleForm.elements.gap_weeks.addEventListener('input', () => {
  updateTemplateTimingPreview();
  updateTemplatePollPreview();
});
weeklyShiftEditor.addEventListener('input', updateTemplatePollPreview);
weeklyShiftEditor.addEventListener('change', updateTemplatePollPreview);

advancePollForm.elements.event_date.addEventListener('change', () => {
  syncOneOffConfirmationFromTiming();
  updateOneOffTimingPreview();
});

advancePollForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  await submitOneOffPoll(false);
});
document.getElementById('send-test-poll').addEventListener('click', () => submitOneOffPoll(true));
document.getElementById('weekly-start-rehearsal').addEventListener('click', submitWeeklyTemplateRehearsal);

async function submitOneOffPoll(isTest = false) {
  const telegramGroupId = advancePollForm.elements.telegram_group_id.value;
  const eventDateVal    = advancePollForm.elements.event_date.value;
  const confirmationDate = advancePollForm.elements.confirmation_date.value;
  const confirmationTime = advancePollForm.elements.one_off_confirmation_time.value;
  if (!telegramGroupId || !eventDateVal || !confirmationDate || !confirmationTime) {
    return setStatus('Error: Event and confirmation date/time are required.', 'error');
  }
  const schedule = scheduleForGroup(telegramGroupId) || defaultScheduleForGroup(telegramGroupId);
  const group = managedGroups.find((g) => g.id === telegramGroupId);
  if (!group) return setStatus('Error: Group not found.', 'error');
  const shifts = [...shiftEditor.querySelectorAll('.shift-row')].map((row) => {
    const start = row.querySelector('[name="shift_start"]').value;
    const end   = row.querySelector('[name="shift_end"]').value;
    const label = row.querySelector('[name="shift_label"]').value.trim();
    const cap   = row.querySelector('[name="shift_capacity"]').value;
    return { label: label || (start.replace(':', '') + '-' + end.replace(':', '')), start_time: start, end_time: end, capacity: Number(cap), _ok: Boolean(start && end && cap) };
  });
  if (!shifts.length)          return setStatus('Error: Add at least one shift.', 'error');
  if (shifts.some((s) => !s._ok)) return setStatus('Error: Fill start, end and slots for every shift.', 'error');
  shifts.forEach((s) => delete s._ok);
  const confirmationAt = `${confirmationDate}T${confirmationTime}`;
  const payload = buildScheduledPollPayload({
    telegramGroupId,
    eventDateVal,
    schedule,
    shifts,
    isCustom: true,
    sendImmediately: isTest,
    isTest,
    confirmationAt,
  });
  const releaseAt = payload.send_immediately
    ? new Date()
    : new Date(`${payload.specific_release_at}:00+08:00`);
  const confirmationInstant = new Date(`${confirmationAt}:00+08:00`);
  if (Number.isNaN(confirmationInstant.getTime()) || confirmationInstant <= releaseAt) {
    return setStatus('Error: Confirmation date and time must be after release date and time.', 'error');
  }
  const preview = `${payload.title}\n${payload.poll_question}\n${shifts.map((s) => `${s.label}: ${s.capacity}`).join('\n')}\n${isTest ? 'Type: TEST POLL (Immediate)' : `Release: ${payload.specific_release_at}\nCloses: ${payload.close_at}`}`;
  if (!window.confirm(`${isTest ? 'Send this test poll immediately?' : 'Schedule this poll?'}\n\n${preview}`)) return;
  setStatus(isTest ? 'Sending test poll…' : 'Creating poll…', 'pending');
  const response = await fetch('/api/scheduled-polls', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const result   = await response.json();
  if (!response.ok) return setStatus(`Error: ${result.error}`, 'error');
  if (isTest) {
    const triggerRes = await fetch(`/api/scheduled-polls/${result.id}/send-now`, { method: 'POST' });
    setStatus(triggerRes.ok ? 'Test poll sent to Telegram.' : 'Test poll created but send failed.', triggerRes.ok ? 'success' : 'error');
    if (triggerRes.ok) window.alert('poll sent, please check telegram');
  } else {
    setStatus(`Scheduled for ${formatLocalDateTime(result.resolved_release_at)}.`, 'success');
    showActionFeedback(`One-off poll scheduled for ${group.group_name}.`);
  }
  const selectedGroupId = telegramGroupId;
  advancePollForm.reset();
  advancePollForm.elements.telegram_group_id.value = selectedGroupId;
  syncOneOffPollFormFromSavedSchedule(selectedGroupId);
}

async function submitWeeklyTemplateRehearsal() {
  const telegramGroupId = document.getElementById('weekly-send-group').value;
  const delayInput = document.getElementById('weekly-rehearsal-clear-delay');
  const submitButton = document.getElementById('weekly-start-rehearsal');
  const clearAfterMinutes = Number(delayInput?.value || 5);

  if (!telegramGroupId) return setStatus('Error: Please select a Telegram group first.', 'error');
  if (!Number.isInteger(clearAfterMinutes) || clearAfterMinutes < 1 || clearAfterMinutes > 60) {
    return setStatus('Error: Rehearsal clear time must be between 1 and 60 minutes.', 'error');
  }
  const schedule = managedSchedules.find((s) => s.telegram_group_id === telegramGroupId && s.enabled);
  if (!schedule) {
    return setStatus('Error: This group has no weekly default schedule. Save one first above.', 'error');
  }

  const group = managedGroups.find((g) => g.id === telegramGroupId);
  if (!group) return setStatus('Error: Group not found.', 'error');

  const shifts = schedule.shifts;
  if (!shifts || !shifts.length) {
    return setStatus('Error: The template for this group has no shifts saved.', 'error');
  }

  const releaseDate = nextReleaseDateForSchedule(schedule);
  const eventDates = batchRangeForReleaseDate(releaseDate, schedule.gap_weeks).sort();
  const preview = [
    `${managedGroupOptionLabel(group)}`,
    `Next production release: ${formatLocalDate(releaseDate)}`,
    `Batch polls scheduled for rehearsal: ${eventDates.length}`,
    `Event range: ${formatLocalDate(eventDates[0])} to ${formatLocalDate(eventDates[eventDates.length - 1])}`,
    `Rehearsal release time: ${String(schedule.poll_release_time || '17:00').slice(0, 5)}`,
    `Clear rehearsal after: ${clearAfterMinutes} minute${clearAfterMinutes === 1 ? '' : 's'}`,
    'Production release, cutoff, and confirmation timestamps will not change.',
    '',
    eventDates.map((dateText) => `- ${formatLocalDate(dateText)}`).join('\n'),
  ].join('\n');
  if (!window.confirm(`Schedule the actual weekly batch rehearsal?\n\n${preview}`)) return;

  submitButton.disabled = true;
  setStatus(`Scheduling rehearsal for ${eventDates.length} actual batch poll${eventDates.length === 1 ? '' : 's'}...`, 'pending');
  try {
    const response = await fetch('/api/template-rehearsals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        telegram_group_id: telegramGroupId,
        weekly_schedule_id: schedule.id,
        clear_after_minutes: clearAfterMinutes,
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Rehearsal could not be started');
    setStatus(`${result.poll_count} actual batch poll${result.poll_count === 1 ? '' : 's'} scheduled for rehearsal at ${formatLocalDateTime(result.start_at)}. The scheduler will clear them at ${formatLocalDateTime(result.clear_at)}. Production timing remains ${formatLocalDateTime(result.actual_release_at)}.`, 'success');
    window.alert(`Actual batch rehearsal scheduled for ${formatLocalDateTime(result.start_at)}.`);
  } catch (error) {
    setStatus(`Template rehearsal failed: ${error.message}`, 'error');
  } finally {
    submitButton.disabled = false;
  }
}

async function loadManagedGroups() {
  const selectedUser = selectedAdminManagedUser();
  const groupUrl = currentUser?.role === 'admin' && selectedUser?.bot_id
    ? `/api/telegram-groups?bot_id=${encodeURIComponent(selectedUser.bot_id)}&refresh=1`
    : '/api/telegram-groups';
  const response = await fetch(groupUrl);
  if (response.status === 501) return;
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(result.error || 'Unable to refresh managed groups');
  }
  allManagedGroups = await response.json();
  managedGroups = currentUser?.role === 'admin'
    ? (selectedUser?.bot_id
      ? allManagedGroups.filter((group) => String(group.bot_id) === String(selectedUser.bot_id))
      : [])
    : allManagedGroups;
  if (currentUser?.role === 'admin' && adminManagedUserSummary) {
    if (!selectedUser) {
      adminManagedUserSummary.textContent = 'Select a user to view the groups detected for their assigned bot.';
    } else if (!selectedUser.bot_id) {
      adminManagedUserSummary.textContent = `${selectedUser.telegram_display_name || selectedUser.telegram_username} does not have a bot assigned.`;
    } else {
      adminManagedUserSummary.textContent = `${managedGroups.length} group${managedGroups.length === 1 ? '' : 's'} detected for ${selectedUser.telegram_display_name || selectedUser.telegram_username} using ${adminManagedUserBotLabel(selectedUser)}.`;
    }
  }
  if (!managedGroups.some((group) => group.id === selectedManagedGroupId)) {
    selectedManagedGroupId = '';
    hideManagedWorkflowSections();
  }
  if (selectedManagedGroupId) await selectManagedGroup(selectedManagedGroupId);
  else refreshManagedPreviews();
  managedGroupList.innerHTML = managedGroups.length ? managedGroups.map((group) => `
      <div class="schedule-row managed-group-row" data-id="${escapeHtml(group.id)}" tabindex="0" role="button" aria-label="Manage ${escapeHtml(managedGroupOptionLabel(group))}">
        <span><strong>${escapeHtml(managedGroupOptionLabel(group))}</strong> (${escapeHtml(group.telegram_chat_id)})</span>
        <span>
          <button type="button" class="secondary verify-group" data-id="${group.id}"><i data-lucide="badge-check" aria-hidden="true"></i> Verify bot</button>
      </span>
    </div>`).join('') : `<p class="hint">${currentUser?.role === 'admin' && !selectedUser
      ? 'Search and select a user above.'
      : currentUser?.role === 'admin' && !selectedUser?.bot_id
        ? `${escapeHtml(selectedUser.telegram_display_name || selectedUser.telegram_username)} does not have a bot assigned. Assign one in Admin.`
        : currentUser?.role === 'admin'
        ? `No groups have been detected for ${escapeHtml(adminManagedUserBotLabel(selectedUser))}. Add this bot to a Telegram group, then send a message in that group.`
        : 'No groups have been detected for your assigned bot. Add the bot to a Telegram group, then send a message in that group.'}</p>`;
  managedGroupList.querySelectorAll('.managed-group-row').forEach((row) => {
    const open = () => openGroupActionDialog(row.dataset.id);
    row.addEventListener('click', open);
    row.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      open();
    });
  });
  managedGroupList.querySelectorAll('.verify-group').forEach((button) => button.addEventListener('click', async (event) => {
    event.stopPropagation();
    const response = await fetch(`/api/telegram-groups/${button.dataset.id}/verify`, { method: 'POST' });
    const result = await response.json();
    setStatus(response.ok
      ? `Verification message sent to ${result.group_name}.`
      : `Error: ${result.error}`, response.ok && result.message_sent ? 'success' : 'error');
  }));
}

managedGroupForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const body = Object.fromEntries(new FormData(managedGroupForm).entries());
  const response = await fetch('/api/telegram-groups', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) return setStatus(`Error: ${result.error}`, 'error');
  managedGroupForm.reset();
  await loadManagedGroups();
  setStatus('Telegram group added.', 'success');
});

async function loadManagedSchedules({ syncEditor = true } = {}) {
  const response = await fetch('/api/weekly-schedules');
  if (response.status === 501) return;
  const rows = await response.json();
  const visibleGroupIds = new Set(managedGroups.map((group) => String(group.id)));
  managedSchedules = currentUser?.role === 'admin'
    ? rows.filter((schedule) => visibleGroupIds.has(String(schedule.telegram_group_id)))
    : rows;
  if (managedScheduleList) {
      managedScheduleList.innerHTML = managedSchedules.map((s) => {
        const releaseDay = DAY_NAMES[s.poll_release_day_of_week];
        const group = managedGroups.find((item) => item.id === s.telegram_group_id);
        const service = group?.service || group?.bot_id || 'WHCL';
        const groupLabel = group ? managedGroupOptionLabel(group) : s.group_name;
        const confirmationDay = DAY_NAMES[s.confirmation_day_of_week];
        const serviceRule = service === 'PSA'
          ? 'PSA cutoff Fri before event week at 08:00'
          : 'Wheelchair cutoff day-before 08:00';
        const gapWeeks = Number(s.gap_weeks || 0);
        const gapDescription = gapWeeks === 0
          ? 'Next event week'
          : `${gapWeeks} full gap ${gapWeeks === 1 ? 'week' : 'weeks'}`;
      const shiftsDesc = Array.isArray(s.shifts) && s.shifts.length 
        ? s.shifts.map((sh) => `${sh.label} (${sh.capacity} slots)`).join(', ')
        : 'No template shifts';
      return `
          <div class="schedule-row">
            <span>
              ${servicePill(service)} <strong>${escapeHtml(groupLabel)}</strong>: 
              Release: ${releaseDay} at ${String(s.poll_release_time).slice(0, 5)}<br>
            <small style="color: var(--ink-soft);">${escapeHtml(gapDescription)}. Confirmation: ${confirmationDay} at ${String(s.confirmation_time).slice(0, 5)} in the week before events. ${escapeHtml(serviceRule)}.</small><br>
            <small style="color: var(--ink-soft);">${escapeHtml(shiftsDesc)}</small>
          </span>
          <button type="button" class="danger-link delete-schedule" data-id="${s.id}">Delete</button>
        </div>`;
    }).join('');
  }
  if (syncEditor) syncWeeklyTemplateFormFromSavedSchedule(managedScheduleForm.elements.telegram_group_id.value);
  syncOneOffPollFormFromSavedSchedule(advancePollForm.elements.telegram_group_id.value);
  refreshManagedPreviews();
  if (managedScheduleList) {
    managedScheduleList.querySelectorAll('.delete-schedule').forEach((button) => button.addEventListener('click', async () => {
      if (!window.confirm('Delete this weekly default schedule?')) return;
      const response = await fetch(`/api/weekly-schedules/${button.dataset.id}`, { method: 'DELETE' });
      if (response.ok) {
        await loadManagedSchedules();
        setStatus('Weekly default deleted.', 'success');
      } else {
        const result = await response.json();
        setStatus(`Error: ${result.error}`, 'error');
      }
    }));
  }
}

managedScheduleForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (managedScheduleSavePending) return;

  const submitButton = event.submitter || managedScheduleForm.querySelector('[type="submit"]');
  managedScheduleSavePending = true;
  managedScheduleForm.setAttribute('aria-busy', 'true');
  if (submitButton) submitButton.disabled = true;

  try {
    const body = Object.fromEntries(new FormData(managedScheduleForm).entries());
    body.timezone = 'Asia/Singapore';

    const shifts = shiftRowsFromContainer(weeklyShiftEditor).map(({ complete, ...shift }) => shift);
    body.shifts = shifts;
    body.poll_release_day_of_week = Number(body.poll_release_day_of_week);
    body.confirmation_day_of_week = Number(body.confirmation_day_of_week);
    body.gap_weeks = Number(body.gap_weeks);

    setStatus('Saving weekly default...', 'pending');
    const response = await fetch('/api/weekly-schedules', { method: 'PUT',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) {
      setStatus(`Error: ${result.error}`, 'error');
      return;
    }
    const savedSchedule = scheduleFromSaveResult(result, body);
    replaceManagedSchedule(savedSchedule);
    syncWeeklyTemplateFormFromSavedSchedule(body.telegram_group_id);
    if (advancePollForm.elements.telegram_group_id.value === body.telegram_group_id) {
      syncOneOffPollFormFromSavedSchedule(body.telegram_group_id);
    }
    await loadManagedSchedules({ syncEditor: false });
    replaceManagedSchedule(savedSchedule);
    syncWeeklyTemplateFormFromSavedSchedule(body.telegram_group_id);
    if (advancePollForm.elements.telegram_group_id.value === body.telegram_group_id) {
      syncOneOffPollFormFromSavedSchedule(body.telegram_group_id);
    }
    updateTemplatePollPreview();
    setStatus('Weekly default saved.', 'success');
    const group = groupById(body.telegram_group_id);
    showActionFeedback(`Default template saved for ${group?.group_name || 'the selected Telegram group'}.`);
  } finally {
    managedScheduleSavePending = false;
    managedScheduleForm.removeAttribute('aria-busy');
    if (submitButton) submitButton.disabled = false;
  }
});

// renderScheduledPolls and loadScheduledPolls moved to polls.js

// loadScheduledPolls moved to polls.js

// advancePollForm submit moved to polls.js

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

// Renders one service section: a heading plus a Date/Time/#Slots/Status table,
// with a per-day "Send poll for <date>" row under each day that has pending slots.
function renderServiceSection(service, slots) {
  const byDate = new Map();
  for (const slot of slots) {
    if (!byDate.has(slot.slot_date)) byDate.set(slot.slot_date, []);
    byDate.get(slot.slot_date).push(slot);
  }

  let rows = '';
  for (const [date, dateSlots] of byDate) {
    for (const slot of dateSlots) {
      const statusPill = slot.sent_at
        ? '<span class="pill pill-sent">Sent</span>'
        : '<span class="pill pill-pending">Pending</span>';
      rows += `
        <tr>
          <td>${slot.slot_date}</td>
          <td>${formatTime(slot.time_start)}–${formatTime(slot.time_end)}</td>
          <td>${slot.slot_count}</td>
          <td>${statusPill}</td>
          <td class="col-actions">${slot.sent_at ? '' : `<button data-id="${slot.id}" class="danger-link delete-btn">Delete</button>`}</td>
        </tr>`;
    }
    const pendingCount = dateSlots.filter((s) => !s.sent_at).length;
    if (pendingCount > 0) {
      rows += `
        <tr class="day-send-row">
          <td colspan="5" class="col-actions">
            <button class="secondary send-day-btn" data-date="${date}" data-service="${service}">
              Send poll for ${date} (${pendingCount} pending slot${pendingCount === 1 ? '' : 's'})
            </button>
          </td>
        </tr>`;
    }
  }

  return `
    <div class="service-section">
      <h3 class="service-heading service-heading-${service.toLowerCase()}">${escapeHtml(SERVICE_NAMES[service] || service)}</h3>
      <table>
        <thead>
          <tr><th>Date</th><th>Time</th><th># slots</th><th>Status</th><th class="col-actions"></th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

async function loadSlots() {
  const res = await fetch('/api/slots');
  const slots = await res.json();

  if (slots.length === 0) {
    slotsContainer.innerHTML =
      '<p class="empty-state">No slots added yet — use the form above to add this week\'s slots.</p>';
    return;
  }

  const byService = new Map();
  for (const slot of slots) {
    const service = slot.service || 'WHCL';
    if (!byService.has(service)) byService.set(service, []);
    byService.get(service).push(slot);
  }

  const services = [...byService.keys()].sort(
    (a, b) => SERVICE_ORDER.indexOf(a) - SERVICE_ORDER.indexOf(b)
  );
  slotsContainer.innerHTML = services
    .map((service) => renderServiceSection(service, byService.get(service)))
    .join('');

  slotsContainer.querySelectorAll('.delete-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await fetch(`/api/slots/${btn.dataset.id}`, { method: 'DELETE' });
      loadSlots();
    });
  });

  slotsContainer.querySelectorAll('.send-day-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      setStatus(`Sending poll for ${btn.dataset.date}…`, 'pending');
      const res = await fetch('/api/trigger-now', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slot_date: btn.dataset.date, service: btn.dataset.service }),
      });
      const body = await res.json();
      if (res.ok) {
        setStatus(`Sent ${body.sent} poll(s) for ${btn.dataset.date}.`, 'success');
        loadSlots();
        loadPolls();
      } else {
        setStatus(`Error: ${body.error}`, 'error');
      }
    });
  });
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(form).entries());
  data.time_start = data.time_start.replace(':', '');
  data.time_end = data.time_end.replace(':', '');

  const res = await fetch('/api/slots', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });

  if (res.ok) {
    form.reset();
    setStatus('', '');
    loadSlots();
  } else {
    const body = await res.json();
    setStatus(`Error: ${body.error}`, 'error');
  }
});

const pollListEl = document.getElementById('poll-list');

function voterLabel(voter) {
  return voter.name || voter.display_name || voter.id || 'Unknown user';
}

function ordinal(n) {
  const suffix = { 1: 'st', 2: 'nd', 3: 'rd' }[n % 100 > 10 && n % 100 < 14 ? 0 : n % 10] || 'th';
  return `${n}${suffix}`;
}

async function loadPolls() {
  const res = await fetch('/api/polls');
  const polls = await res.json();
  pollListEl.innerHTML = '';

  if (polls.length === 0) {
    pollListEl.innerHTML = '<p class="no-votes">No polls sent yet.</p>';
    return;
  }

  for (const poll of polls) {
    const div = document.createElement('div');
    div.className = 'poll';

    const requiredSlots = poll.total_slots ?? poll.options.reduce(
      (total, option) => total + (Number.isInteger(option.capacity) ? option.capacity : 0),
      0
    );
    const filledSlots = poll.filled_slots ?? poll.options.reduce(
      (total, option) => total + Math.min(option.voters.length, option.capacity || 0),
      0
    );
    const isFilled = requiredSlots > 0 && filledSlots >= requiredSlots;
    const statusPill = poll.shift_started
      ? '<span class="pill pill-pending">Shift started</span>'
      : poll.confirmed_at && poll.confirmation_window_open
        ? '<span class="pill pill-sent">Confirmed — updates allowed</span>'
        : poll.confirmed_at
          ? '<span class="pill pill-sent">Confirmed</span>'
      : isFilled
        ? '<span class="pill pill-sent">Completed — ready to confirm</span>'
        : poll.confirmation_window_open
          ? `<span class="pill pill-pending">48-hour window — ready (${filledSlots}/${requiredSlots})</span>`
          : `<span class="pill pill-pending">Awaiting votes (${filledSlots}/${requiredSlots})</span>`;
    const optionsHtml = poll.options.length === 0
      ? '<p class="no-votes">No options recorded for this poll.</p>'
      : poll.options.map((option) => {
          const capText = option.capacity === null
            ? ''
            : ` — ${option.capacity} ${option.capacity === 1 ? 'slot' : 'slots'}`;
          const votersHtml = option.voters.length === 0
            ? '<span class="no-votes">No votes yet.</span>'
            : option.voters.map((voter, i) => {
                // First-come-first-served: the first `capacity` voters win by
                // default; later ones are waitlist. Supervisor can override.
                const wins = option.capacity === null || i < option.capacity;
                return `
                  <label class="voter ${wins ? '' : 'waitlist'}" title="Voted ${ordinal(i + 1)}">
                    <input type="checkbox" value="${voter.jid}" ${wins ? 'checked' : ''} disabled />
                    ${i + 1}. ${voterLabel(voter)}${wins ? '' : ' (waitlist)'}
                  </label>`;
              }).join('');
          return `
            <div class="poll-option" data-option="${option.name}">
              <div class="poll-option-name">${option.name}${capText}</div>
              ${votersHtml}
            </div>`;
        }).join('');

    div.innerHTML = `
      <div class="poll-question">
        <span>${servicePill(poll.service)} ${poll.question}</span>
        ${statusPill}
      </div>
      ${optionsHtml}
      ${poll.can_confirm
        ? `<button class="primary confirm-btn" data-id="${poll.id}">${poll.confirmed_at ? 'Send updated confirmation' : 'Submit confirmation to group'}</button>`
        : ''}
    `;
    pollListEl.appendChild(div);
  }

  pollListEl.querySelectorAll('.confirm-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      setStatus('Sending confirmation…', 'pending');
      const res = await fetch(`/api/polls/${btn.dataset.id}/confirm`, {
        method: 'POST',
      });
      const body = await res.json();
      if (res.ok) {
        setStatus('Confirmation sent to the group.', 'success');
        loadPolls();
      } else {
        setStatus(`Error: ${body.error}`, 'error');
      }
    });
  });
}

triggerBtn.addEventListener('click', async () => {
  setStatus('Sending…', 'pending');
  const res = await fetch('/api/trigger-now', { method: 'POST' });
  const body = await res.json();
  if (res.ok) {
    setStatus(`Sent ${body.sent} poll(s).`, 'success');
    loadSlots();
  } else {
    setStatus(`Error: ${body.error}`, 'error');
  }
});

const scheduleForm = document.getElementById('schedule-form');
const scheduleListEl = document.getElementById('schedule-list');
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
let schedules = [];

function renderTargets(targets) {
  targetsListEl.innerHTML = SERVICE_ORDER.map((service) => {
    const target = targets.find((item) => item.service === service && item.active);
    const targetText = target
      ? `<strong>${escapeHtml(target.title || target.chat_id)}</strong>`
      : '<span class="no-votes">Not linked - add this service bot to its Telegram group</span>';
    return `
      <div class="schedule-row">
        ${servicePill(service)}
        <span>${targetText}</span>
      </div>`;
  }).join('');
}

async function loadTargets() {
  renderTargets(await (await fetch('/api/targets')).json());
}

// Populate the form fields with the currently-saved values for one service, so
// switching the Service dropdown shows that service's existing schedule.
function fillScheduleForm(service) {
  const match = schedules.find((s) => s.service === service);
  if (!match) return;
  scheduleForm.elements.day.value = String(match.day);
  scheduleForm.elements.time.value = match.time;
}

function renderScheduleList() {
  if (schedules.length === 0) {
    scheduleListEl.innerHTML = '<p class="no-votes">No schedules configured.</p>';
    return;
  }
  scheduleListEl.innerHTML = schedules.map((s) => `
    <div class="schedule-row">
      ${servicePill(s.service)}
      <span>Every <strong>${DAY_NAMES[s.day]}</strong> at <strong>${s.time}</strong> (Singapore time)</span>
    </div>
  `).join('');
}

async function loadSchedule() {
  schedules = await (await fetch('/api/schedule')).json();
  renderScheduleList();
  fillScheduleForm(scheduleForm.elements.service.value);
}

scheduleForm.elements.service.addEventListener('change', () => {
  fillScheduleForm(scheduleForm.elements.service.value);
});

scheduleForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const service = scheduleForm.elements.service.value;
  const day = Number(scheduleForm.elements.day.value);
  const time = scheduleForm.elements.time.value;
  const res = await fetch('/api/schedule', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ service, day, time }),
  });
  const body = await res.json();
  if (res.ok) {
    const label = service === 'PSA' ? 'PSA' : 'Wheelchair';
    setStatus(`${label} weekly send scheduled: every ${DAY_NAMES[body.day]} at ${body.time}.`, 'success');
    loadSchedule();
  } else {
    setStatus(`Error: ${body.error}`, 'error');
  }
});

async function loadDashboard(includeLegacy = legacyWorkflowEnabled) {
  await loadManagedGroups();
  const managed = [loadManagedSchedules()];
  const legacy = includeLegacy ? [loadSchedule(), loadTargets(), loadSlots(), loadPolls()] : [];
  await Promise.all([...managed, ...legacy]);
}

async function bootstrap() {
  hideManagedWorkflowSections();
  window.gtrsgAuth.init();
  const config = await (await nativeFetch('/api/auth-config')).json();
  legacyWorkflowEnabled = config.legacyEnabled;
  if (config.demoPreview) {
    setStatus('Preview mode: data resets automatically and Telegram sending is disabled.', 'pending');
  }
  if (!config.legacyEnabled) document.querySelectorAll('.legacy-workflow').forEach((element) => element.remove());

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
    document.querySelectorAll('[data-admin-only]').forEach((element) => {
      element.hidden = currentUser.role !== 'admin';
    });
    if (currentUser.role === 'admin') await loadAdminManagedUsers();
  } else {
    currentUser = { role: 'admin' };
    document.querySelectorAll('[data-admin-nav]').forEach((element) => {
      element.hidden = false;
    });
    window.refreshIcons?.();
    await loadAdminManagedUsers();
  }
  const releaseTimePicker = document.querySelector('[data-name="poll_release_time"]');
  if (releaseTimePicker) {
    createTimeWheelPicker(releaseTimePicker, '17:00');
    managedScheduleForm.elements.poll_release_time.addEventListener('change', () => {
      updateTemplateTimingPreview();
      updateTemplatePollPreview();
    });
  }
  const confirmationTimePicker = document.querySelector('[data-name="confirmation_time"]');
  if (confirmationTimePicker) {
    createTimeWheelPicker(confirmationTimePicker, '12:00');
    managedScheduleForm.elements.confirmation_time.addEventListener('change', () => {
      updateTemplateTimingPreview();
      updateTemplatePollPreview();
    });
  }
  const oneOffConfirmationTimePicker = document.querySelector('[data-name="one_off_confirmation_time"]');
  if (oneOffConfirmationTimePicker) {
    createTimeWheelPicker(oneOffConfirmationTimePicker, '12:00');
    advancePollForm.elements.one_off_confirmation_time.addEventListener('change', updateOneOffTimingPreview);
  }

  if (config.legacyEnabled) {
    const timeStartPicker = document.querySelector('[data-name="time_start"]');
    const timeEndPicker = document.querySelector('[data-name="time_end"]');
    if (timeStartPicker) createTimeWheelPicker(timeStartPicker, '08:00');
    if (timeEndPicker) createTimeWheelPicker(timeEndPicker, '17:00');
  }
  await loadDashboard(config.legacyEnabled);
}

bootstrap().catch((error) => setStatus(`Error: ${error.message}`, 'error'));
window.addEventListener('pageshow', (event) => {
  if (!event.persisted) return;
  refreshAdminManagedContext().catch((error) => setStatus(`Error: ${error.message}`, 'error'));
});
window.addEventListener('focus', () => {
  if (!authOverlay.hidden) return;
  refreshAdminManagedContext().catch((error) => setStatus(`Error: ${error.message}`, 'error'));
});
// Telegram votes arrive by webhook in the background; refresh results periodically.
setInterval(() => {
  if (authOverlay.hidden && legacyWorkflowEnabled) loadPolls();
}, 10000);
