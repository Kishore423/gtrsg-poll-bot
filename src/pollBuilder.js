const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Telegram requires polls to have at least 2 options, so single-slot days
// get this filler option appended. Votes for it are ignored downstream.
const NOT_AVAILABLE_OPTION = 'Not available';
const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

function formatDateHeader(isoDate) {
  const d = new Date(`${isoDate}T00:00:00`);
  const day = DAY_NAMES[d.getDay()];
  const date = String(d.getDate()).padStart(2, '0');
  const month = MONTH_NAMES[d.getMonth()];
  const year = String(d.getFullYear()).slice(-2);
  return `${day}, ${date}${month}${year}`;
}

function formatTimeRange(timeStart, timeEnd) {
  return `${timeStart}-${timeEnd}`;
}

// Wheelchair and PSA polls go to different group chats, so a date with slots
// for both services produces two separate polls.
function groupByDateAndService(rows) {
  const groups = new Map();
  for (const row of rows) {
    const service = row.service || 'WHCL';
    const key = `${row.slot_date}|${service}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
}

const SERVICE_LABELS = { WHCL: 'Wheelchair', PSA: 'PSA' };

// rows: [{ id, slot_date, time_start, time_end, slot_count, service }]
// returns: [{ slot_date, service, question, options, rowIds }] sorted by date
// labelService prefixes the question with the service name - useful while both
// services share one group chat (testing); off once each has its own group.
function buildPollsFromSlots(rows, { labelService = false } = {}) {
  const groups = groupByDateAndService(rows);
  const polls = [];

  for (const [key, dateRows] of groups) {
    const [slot_date, service] = key.split('|');
    const summaryParts = dateRows.map((r) => {
      const unit = r.slot_count === 1 ? 'slot' : 'slots';
      return `${r.slot_count} ${unit} for ${formatTimeRange(r.time_start, r.time_end)}`;
    });
    const prefix = labelService ? `[${SERVICE_LABELS[service] || service}] ` : '';
    const question = `${prefix}${formatDateHeader(slot_date)} - ${summaryParts.join(', ')}`;

    const options = [];
    const capacities = {};
    for (const r of dateRows) {
      const range = formatTimeRange(r.time_start, r.time_end);
      if (!(range in capacities)) {
        options.push(range);
        capacities[range] = 0;
      }
      capacities[range] += r.slot_count;
    }

    if (options.length === 1) {
      options.push(NOT_AVAILABLE_OPTION);
      capacities[NOT_AVAILABLE_OPTION] = 0;
    }

    polls.push({
      slot_date,
      service,
      question,
      options,
      capacities,
      rowIds: dateRows.map((r) => r.id),
    });
  }

  polls.sort(
    (a, b) => a.slot_date.localeCompare(b.slot_date) || a.service.localeCompare(b.service)
  );
  return polls;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])
  );
}

// Telegram HTML mention that tags a user by id even without a @username.
function mention(voter) {
  const name = voter.name || 'Unknown user';
  const nameWithAt = name.startsWith('@') ? name : '@' + name;
  return `<a href="tg://user?id=${escapeHtml(voter.id)}">${escapeHtml(nameWithAt)}</a>`;
}

function managedMention(voter) {
  const name = voter.display_name || 'Unknown user';
  if (voter.telegram_user_id) {
    return `<a href="tg://user?id=${escapeHtml(voter.telegram_user_id)}">${escapeHtml(name)}</a>`;
  }
  return escapeHtml(name);
}

function buildManagedConfirmationMessage(rows, {
  header = 'Confirmed slots', footer = 'Please take note.',
  showWaitingList = false, showEmptyShifts = true,
  eventDate, serviceLabel,
} = {}) {
  const shifts = new Map();
  for (const row of rows) {
    if (!shifts.has(row.shift_id)) {
      shifts.set(row.shift_id, {
        label: row.label,
        capacity: row.capacity,
        confirmed: [],
        waiting: []
      });
    }
    if (row.status === 'confirmed') shifts.get(row.shift_id).confirmed.push(row);
    if (row.status === 'waiting_list') shifts.get(row.shift_id).waiting.push(row);
  }

  let formattedHeader = header || 'Confirmed slots';
  if (eventDate) {
    const d = new Date(`${eventDate}T00:00:00`);
    const day = DAY_NAMES[d.getDay()];
    const date = d.getDate();
    const month = MONTH_NAMES[d.getMonth()];
    const dateHeader = `${day} ${date} ${month}`;

    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const isTomorrow =
      d.getFullYear() === tomorrow.getFullYear() &&
      d.getMonth() === tomorrow.getMonth() &&
      d.getDate() === tomorrow.getDate();

    formattedHeader = `${formattedHeader} for ${isTomorrow ? 'tomor, ' : ''}${dateHeader}`;
  }

  const lines = [];
  if (serviceLabel) lines.push(`<b>${escapeHtml(serviceLabel)}</b>`);
  lines.push(`<b>${escapeHtml(formattedHeader)}</b>`, '');

  for (const shift of shifts.values()) {
    if (shift.confirmed.length === 0) {
      if (showEmptyShifts && shift.capacity > 0) {
        lines.push(`${escapeHtml(shift.label)}hrs — Unfilled (0/${shift.capacity})`);
      }
      continue;
    }
    const tags = shift.confirmed.map(managedMention).join(' ');
    lines.push(`${escapeHtml(shift.label)}hrs ${tags}`);
    
    if (showWaitingList && shift.waiting.length) {
      const waitTags = shift.waiting.map(managedMention).join(' ');
      lines.push(`Waiting list for ${escapeHtml(shift.label)}: ${waitTags}`);
    }
  }

  if (footer) {
    lines.push('', escapeHtml(footer));
  }
  return lines.join('\n');
}

// Builds the confirmation message as Telegram HTML, e.g.
//   Confirmed slots for tomor, Sun 5 Jul
//
//   0430-0830hrs <a href="tg://user?id=1">Alice</a>
//   1700-2200hrs <a ...>Bob</a> <a ...>Carol</a>
//   2200-0300hrs — Unfilled (0/1)
//   take note pls
// assignments: [{ option_name, capacity, voters: [{ id, name }] }]
// Returns { html }.
function buildConfirmationMessage(slotDate, assignments, footer = 'take note pls') {
  const d = new Date(`${slotDate}T00:00:00`);
  const header = `${DAY_NAMES[d.getDay()]} ${d.getDate()} ${MONTH_NAMES[d.getMonth()]}`;

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const isTomorrow =
    d.getFullYear() === tomorrow.getFullYear() &&
    d.getMonth() === tomorrow.getMonth() &&
    d.getDate() === tomorrow.getDate();

  const lines = [];
  for (const a of assignments) {
    if (a.voters.length === 0) {
      if (Number.isInteger(a.capacity) && a.capacity > 0) {
        lines.push(`${escapeHtml(a.option_name)}hrs — Unfilled (0/${a.capacity})`);
      }
      continue;
    }
    const tags = a.voters.map(mention).join(' ');
    lines.push(`${escapeHtml(a.option_name)}hrs ${tags}`);
  }

  const html = [
    `Confirmed slots for ${isTomorrow ? 'tomor, ' : ''}${escapeHtml(header)}`,
    '',
    ...lines,
    escapeHtml(footer),
  ].join('\n');

  return { html };
}

module.exports = {
  formatDateHeader,
  formatTimeRange,
  buildPollsFromSlots,
  buildConfirmationMessage,
  buildManagedConfirmationMessage,
  managedMention,
  escapeHtml,
  NOT_AVAILABLE_OPTION,
};
