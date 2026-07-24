const { NOT_AVAILABLE_OPTION } = require('./pollBuilder');

// Confirmations auto-send at 08:00 Singapore time on the day BEFORE the slot
// date, whether or not every slot is filled. Assignments are always the first
// `capacity` voters per option (first-come-first-served).
const DEFAULT_CONFIRMATION_HOUR = 8;
const DEFAULT_TIMEZONE_OFFSET = '+08:00';

function shiftStartForOption(slotDate, optionName, timezoneOffset = DEFAULT_TIMEZONE_OFFSET) {
  const match = /^(\d{2})(\d{2})-/.exec(optionName);
  if (!match) return null;
  return new Date(`${slotDate}T${match[1]}:${match[2]}:00${timezoneOffset}`);
}

// 08:00 (local offset) on the day before slotDate. Fixed-offset arithmetic is
// safe here because Singapore has no daylight saving.
function confirmationDueAt(
  slotDate,
  { confirmationHour = DEFAULT_CONFIRMATION_HOUR, timezoneOffset = DEFAULT_TIMEZONE_OFFSET } = {}
) {
  const hour = String(confirmationHour).padStart(2, '0');
  const sameDay = new Date(`${slotDate}T${hour}:00:00${timezoneOffset}`);
  return new Date(sameDay.getTime() - 24 * 60 * 60 * 1000);
}

// poll.capacities is an object { optionName: count }.
// votes are [{ option_name, voter_id, display_name, voted_at_ms }] in FCFS order.
// Produces assignments [{ option_name, capacity, voters: [{ id, name }] }].
function buildConfirmationState(
  poll,
  votes,
  {
    now = new Date(),
    confirmationHour = DEFAULT_CONFIRMATION_HOUR,
    timezoneOffset = DEFAULT_TIMEZONE_OFFSET,
  } = {}
) {
  const capacities = poll.capacities || {};
  const votesByOption = new Map();
  for (const vote of votes) {
    if (!votesByOption.has(vote.option_name)) votesByOption.set(vote.option_name, []);
    votesByOption.get(vote.option_name).push({ id: vote.voter_id, name: vote.display_name || vote.voter_id });
  }

  const assignments = [];
  const starts = [];
  let totalSlots = 0;
  let filledSlots = 0;

  for (const [optionName, capacity] of Object.entries(capacities)) {
    if (optionName === NOT_AVAILABLE_OPTION || capacity === 0) continue;
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error(`Invalid slot capacity for ${optionName}`);
    }
    const voters = (votesByOption.get(optionName) || []).slice(0, capacity);
    const start = shiftStartForOption(poll.slot_date, optionName, timezoneOffset);
    if (start) starts.push(start);
    totalSlots += capacity;
    filledSlots += voters.length;
    assignments.push({ option_name: optionName, capacity, voters });
  }

  const shiftStart = starts.length
    ? new Date(Math.min(...starts.map((date) => date.getTime())))
    : null;
  const deadlineAt = confirmationDueAt(poll.slot_date, { confirmationHour, timezoneOffset });
  const allFilled = totalSlots > 0 && filledSlots >= totalSlots;
  const windowOpen = now >= deadlineAt;
  const shiftStarted = Boolean(shiftStart && now >= shiftStart);

  return {
    assignments,
    totalSlots,
    filledSlots,
    allFilled,
    shiftStart,
    deadlineAt,
    windowOpen,
    shiftStarted,
    // Managers may send (or resend) the current first-come list at any time
    // before the earliest shift starts - fill status is informational only.
    canConfirm: totalSlots > 0 && !shiftStarted,
  };
}

module.exports = {
  buildConfirmationState,
  confirmationDueAt,
  shiftStartForOption,
  DEFAULT_CONFIRMATION_HOUR,
  DEFAULT_TIMEZONE_OFFSET,
};
