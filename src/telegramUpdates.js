// Pure parsing of Telegram webhook updates into the two events we care about:
//   - group_membership: the bot was added to / removed from a group, so we can
//     auto-capture (or clear) that service's target chat id.
//   - group_seen: the bot received a group message, so we can capture the chat id.
//   - poll_vote: someone voted (or retracted) on a poll, for FCFS allocation.
// Anything else -> { type: 'ignore' }.

const IN_GROUP_STATUSES = new Set(['member', 'administrator', 'creator']);

function displayName(user) {
  if (!user) return null;
  const full = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  if (full) return full;
  if (user.username) return `@${user.username}`;
  return String(user.id);
}

function parseUpdate(update) {
  if (!update || typeof update !== 'object') return { type: 'ignore' };

  // Bot's own membership changed (added to or removed from a chat).
  if (update.my_chat_member) {
    const { chat, new_chat_member: member } = update.my_chat_member;
    if (chat && (chat.type === 'group' || chat.type === 'supergroup')) {
      return {
        type: 'group_membership',
        chatId: String(chat.id),
        title: chat.title || null,
        active: IN_GROUP_STATUSES.has(member?.status),
      };
    }
    return { type: 'ignore' };
  }

  if (update.message?.chat && ['group', 'supergroup'].includes(update.message.chat.type)) {
    return {
      type: 'group_seen',
      chatId: String(update.message.chat.id),
      title: update.message.chat.title || null,
    };
  }

  // A vote (non-anonymous poll => user is present). Empty option_ids = retraction.
  if (update.poll_answer) {
    const answer = update.poll_answer;
    return {
      type: 'poll_vote',
      pollId: String(answer.poll_id),
      user: {
        id: String(answer.user?.id),
        name: displayName(answer.user),
        username: answer.user?.username || null,
        firstName: answer.user?.first_name || null,
        lastName: answer.user?.last_name || null,
      },
      optionIds: Array.isArray(answer.option_ids) ? answer.option_ids : [],
    };
  }

  return { type: 'ignore' };
}

module.exports = { parseUpdate, displayName };
