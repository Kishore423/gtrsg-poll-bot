// In-memory implementation of the data repository. Used by the test suite and
// for local development without a database. The Postgres implementation
// (postgres.js) mirrors these exact method signatures and shapes so the rest of
// the app is storage-agnostic.
//
// Canonical shapes:
//   slot  = { id, slot_date, time_start, time_end, slot_count, service, sent_at }
//   poll  = { id, slot_date, service, question, provider_poll_id, group_chat_id,
//             options: [name], capacities: { name: count }, confirmed_at }
//   vote  = { option_name, voter_id, display_name, voted_at_ms }
//   target= { service, chat_id, title, active }

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function createMemoryDb() {
  const slots = [];
  const polls = [];
  const votes = []; // { id, poll_id, option_name, voter_id, display_name, voted_at_ms }
  const settings = new Map();
  const targets = new Map(); // service -> { service, chat_id, title, active }
  const telegramGroups = [];
  const pollExclusions = [];
  const webhookEvents = new Map();
  // One Telegram bot per user. bot_name mirrors Telegram's own name (never an
  // independent app label) and the token is stored encrypted.
  const bots = [];
  const appUsers = [];
  const telegramLoginChallenges = new Map();
  let slotSeq = 0;
  let pollSeq = 0;
  let voteSeq = 0;
  let telegramGroupSeq = 0;
  let pollExclusionSeq = 0;
  let botSeq = 0;
  let appUserSeq = 0;

  return {
    async insertSlot({ slot_date, time_start, time_end, slot_count, service = 'WHCL' }) {
      const id = ++slotSeq;
      slots.push({ id, slot_date, time_start, time_end, slot_count, service, sent_at: null });
      return id;
    },

    async deleteSlot(id) {
      const i = slots.findIndex((s) => s.id === id);
      if (i !== -1) slots.splice(i, 1);
    },

    async listUpcomingSlots() {
      const today = todayIso();
      return slots
        .filter((s) => s.slot_date >= today)
        .sort((a, b) => a.slot_date.localeCompare(b.slot_date) || a.time_start.localeCompare(b.time_start))
        .map((s) => ({ ...s }));
    },

    async listUnsentSlots() {
      return slots
        .filter((s) => s.sent_at === null)
        .sort((a, b) => a.slot_date.localeCompare(b.slot_date) || a.time_start.localeCompare(b.time_start))
        .map((s) => ({ ...s }));
    },

    async markSlotsSent(ids) {
      const set = new Set(ids);
      const now = new Date().toISOString();
      for (const s of slots) if (set.has(s.id)) s.sent_at = now;
    },

    async insertPoll({ slot_date, service, question, provider_poll_id, group_chat_id, options, capacities }) {
      const id = ++pollSeq;
      polls.push({
        id,
        slot_date,
        service,
        question,
        provider_poll_id: String(provider_poll_id),
        group_chat_id: String(group_chat_id),
        options: [...options],
        capacities: { ...capacities },
        confirmed_at: null,
        created_at: new Date().toISOString(),
      });
      return id;
    },

    async getPollByProviderPollId(providerPollId) {
      const p = polls.find((x) => x.provider_poll_id === String(providerPollId));
      return p ? { ...p } : null;
    },

    async getPollById(id) {
      const p = polls.find((x) => x.id === id);
      return p ? { ...p } : null;
    },

    async listPolls() {
      return polls
        .slice()
        .sort((a, b) => b.slot_date.localeCompare(a.slot_date) || b.id - a.id)
        .map((p) => ({ ...p }));
    },

    async markPollConfirmed(id) {
      const p = polls.find((x) => x.id === id);
      if (p) p.confirmed_at = new Date().toISOString();
    },

    // Applies one voter's current selection. Existing rows are kept so the
    // voter's original arrival time survives later edits; deselected options are
    // removed. A re-selected option is treated as a fresh arrival.
    async upsertVoterVote(pollId, { voter_id, option_names, voted_at_ms = null, display_name = null }) {
      const selected = new Set(option_names);
      const existing = votes.filter((v) => v.poll_id === pollId && v.voter_id === String(voter_id));
      for (const v of existing) {
        if (!selected.has(v.option_name)) {
          votes.splice(votes.indexOf(v), 1);
        } else if (display_name) {
          v.display_name = display_name;
        }
      }
      const haveNames = new Set(existing.map((v) => v.option_name));
      for (const name of selected) {
        if (haveNames.has(name)) continue;
        votes.push({
          id: ++voteSeq,
          poll_id: pollId,
          option_name: name,
          voter_id: String(voter_id),
          display_name,
          voted_at_ms: voted_at_ms ?? Date.now(),
        });
      }
    },

    // Ordered by arrival (voted_at_ms, then insertion id) - what FCFS runs on.
    async getVotesForPoll(pollId) {
      return votes
        .filter((v) => v.poll_id === pollId)
        .sort((a, b) => (a.voted_at_ms - b.voted_at_ms) || (a.id - b.id))
        .map((v) => ({
          option_name: v.option_name,
          voter_id: v.voter_id,
          display_name: v.display_name,
          voted_at_ms: v.voted_at_ms,
        }));
    },

    async getSetting(key) {
      return settings.has(key) ? settings.get(key) : null;
    },

    async setSetting(key, value) {
      settings.set(key, String(value));
    },

    // The group each service's bot is in (auto-captured when the bot is added).
    async setTarget(service, { chat_id, title, active }) {
      targets.set(service, { service, chat_id: String(chat_id), title: title ?? null, active: !!active });
    },

    async getTarget(service) {
      const t = targets.get(service);
      return t && t.active ? { ...t } : null;
    },

    async listTargets() {
      return [...targets.values()].map((t) => ({ ...t }));
    },

    async listTelegramGroups({ botId = null } = {}) {
      // botId scopes the list to one user's bot; admins pass nothing to see all.
      return telegramGroups
        .filter((group) => group.enabled !== false)
        .filter((group) => !botId ||
          String(group.bot_ref || group.bot_id) === String(botId))
        .map((group) => ({ ...group, bot_id: group.bot_ref || group.bot_id }));
    },

    async assignTelegramGroupsToBot(oldBotId, botId) {
      const updated = [];
      for (const group of telegramGroups) {
        if (String(group.bot_id) !== String(oldBotId) || group.bot_ref) continue;
        group.bot_ref = String(botId);
        group.bot_id = String(botId);
        updated.push({ ...group, bot_id: group.bot_ref });
      }
      return updated;
    },

    // ---- Bots (one per user) -------------------------------------------------
    async createBot({ bot_name, telegram_username, telegram_bot_id, token_encrypted, webhook_secret }) {
      if (telegram_bot_id != null && bots.some((bot) =>
        String(bot.telegram_bot_id) === String(telegram_bot_id))) {
        const error = new Error('Telegram bot ID already exists');
        error.code = '23505';
        error.constraint = 'bots_telegram_bot_id_key';
        throw error;
      }
      const bot = {
        id: `bot-${++botSeq}`,
        bot_name,
        telegram_username: telegram_username ?? null,
        telegram_bot_id: telegram_bot_id ?? null,
        token_encrypted,
        webhook_secret,
        enabled: true,
        name_synced_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      };
      bots.push(bot);
      return bot.id;
    },

    async listBots() {
      return bots.map((bot) => ({ ...bot }));
    },

    async getBot(id) {
      const bot = bots.find((item) => item.id === String(id));
      return bot ? { ...bot } : null;
    },

    // Records the name Telegram confirmed; the app never invents a name.
    async setBotName(id, botName) {
      const bot = bots.find((item) => item.id === String(id));
      if (!bot) return null;
      bot.bot_name = botName;
      bot.name_synced_at = new Date().toISOString();
      return { ...bot };
    },

    async setBotTelegramIdentity(id, { bot_name, telegram_username, telegram_bot_id }) {
      const bot = bots.find((item) => item.id === String(id));
      if (!bot) return null;
      if (bot_name !== undefined) bot.bot_name = bot_name;
      if (telegram_username !== undefined) bot.telegram_username = telegram_username;
      if (telegram_bot_id !== undefined) bot.telegram_bot_id = telegram_bot_id;
      bot.name_synced_at = new Date().toISOString();
      return { ...bot };
    },

    async deleteBot(id) {
      const index = bots.findIndex((item) => item.id === String(id));
      if (index === -1) return null;
      return bots.splice(index, 1)[0];
    },

    // Re-enables an existing (previously disabled/orphaned) bot row and refreshes
    // its token/webhook secret so a freed Telegram bot can be reassigned without
    // creating a duplicate telegram_bot_id row.
    async reactivateBot(id, { token_encrypted, webhook_secret } = {}) {
      const bot = bots.find((item) => item.id === String(id));
      if (!bot) return null;
      if (token_encrypted !== undefined) bot.token_encrypted = token_encrypted;
      if (webhook_secret !== undefined) bot.webhook_secret = webhook_secret;
      bot.enabled = true;
      bot.name_synced_at = new Date().toISOString();
      return { ...bot };
    },

    // ---- App users (the Telegram allow-list) ---------------------------------
    async createAppUser({
      role = 'user',
      bot_id = null,
      telegram_user_id = null,
      telegram_username = null,
      telegram_display_name = null,
      profile_photo_data = null,
      deployment_sheets_enabled = false,
      login_bot_verified_at = null,
    }) {
      const user = {
        id: `app-user-${++appUserSeq}`,
        telegram_user_id: telegram_user_id ? String(telegram_user_id) : null,
        telegram_username,
        telegram_display_name,
        profile_photo_data,
        deployment_sheets_enabled: Boolean(deployment_sheets_enabled),
        login_bot_verified_at,
        role,
        bot_id: bot_id ? String(bot_id) : null,
        enabled: true,
        created_at: new Date().toISOString(),
      };
      appUsers.push(user);
      return user.id;
    },

    async listAppUsers() {
      return appUsers.map((user) => ({ ...user }));
    },

    async getAppUserByTelegramId(telegramUserId) {
      const user = appUsers.find(
        (item) => item.telegram_user_id === String(telegramUserId) && item.enabled);
      return user ? { ...user } : null;
    },

    async getAppUserByTelegramIdentifier(identifier) {
      const normalized = String(identifier).toLowerCase();
      const user = appUsers.find((item) => item.enabled && (
        item.telegram_user_id === String(identifier) ||
        String(item.telegram_username || '').toLowerCase() === normalized
      ));
      return user ? { ...user } : null;
    },

    async setAppUserTelegramIdentity(id, {
      telegram_user_id,
      telegram_username = null,
      telegram_display_name = null,
      login_bot_verified_at,
    }) {
      const user = appUsers.find((item) => item.id === String(id));
      if (!user) return null;
      user.telegram_user_id = telegram_user_id ? String(telegram_user_id) : null;
      user.telegram_username = telegram_username;
      user.telegram_display_name = telegram_display_name;
      if (login_bot_verified_at !== undefined) {
        user.login_bot_verified_at = login_bot_verified_at;
      }
      return { ...user };
    },

    async updateAppUser(id, {
      telegram_user_id,
      telegram_username,
      telegram_display_name,
      role,
      enabled,
    }) {
      const user = appUsers.find((item) => item.id === String(id));
      if (!user) return null;
      user.telegram_user_id = telegram_user_id ? String(telegram_user_id) : null;
      user.telegram_username = telegram_username;
      user.telegram_display_name = telegram_display_name;
      user.role = role;
      user.enabled = Boolean(enabled);
      return { ...user };
    },

    async setAppUserProfilePhoto(id, profilePhotoData) {
      const user = appUsers.find((item) => item.id === String(id));
      if (!user) return null;
      user.profile_photo_data = profilePhotoData;
      return { ...user };
    },

    async setAppUserDeploymentSheetsEnabled(id, enabled) {
      const user = appUsers.find((item) => item.id === String(id));
      if (!user) return null;
      user.deployment_sheets_enabled = Boolean(enabled);
      return { ...user };
    },

    async setAppUserRole(id, role) {
      const user = appUsers.find((item) => item.id === String(id));
      if (!user) return null;
      user.role = role;
      return { ...user };
    },

    async setAppUserBot(id, botId) {
      const user = appUsers.find((item) => item.id === String(id));
      if (!user) return null;
      user.bot_id = botId ? String(botId) : null;
      return { ...user };
    },

    async replaceAppUserBot(id, botId) {
      const user = appUsers.find((item) => item.id === String(id));
      if (!user) return null;
      const oldBotId = user.bot_id;
      user.bot_id = botId ? String(botId) : null;
      if (oldBotId && oldBotId !== user.bot_id) {
        const oldBot = bots.find((item) => item.id === oldBotId);
        if (oldBot) oldBot.enabled = false;
        telegramGroups.forEach((group) => {
          if (String(group.bot_ref || group.bot_id) === oldBotId) group.enabled = false;
        });
      }
      return { ...user, old_bot_id: oldBotId || null };
    },

    async setAppUserEnabled(id, enabled) {
      const user = appUsers.find((item) => item.id === String(id));
      if (!user) return null;
      user.enabled = Boolean(enabled);
      return { ...user };
    },

    async deleteAppUser(id) {
      const index = appUsers.findIndex((item) => item.id === String(id));
      if (index === -1) return null;
      return appUsers.splice(index, 1)[0];
    },

    async createTelegramLoginChallenge({
      id,
      verifier_hash,
      telegram_user_id = null,
      otp_hash,
      expires_at,
      created_at,
    }) {
      const challenge = {
        id,
        verifier_hash,
        telegram_user_id: telegram_user_id ? String(telegram_user_id) : null,
        otp_hash,
        expires_at,
        attempt_count: 0,
        sent_at: null,
        consumed_at: null,
        created_at: created_at || new Date().toISOString(),
      };
      telegramLoginChallenges.set(id, challenge);
      return { ...challenge };
    },

    async getTelegramLoginChallenge(id) {
      const challenge = telegramLoginChallenges.get(String(id));
      return challenge ? { ...challenge } : null;
    },

    async getLatestSentTelegramLoginChallenge(telegramUserId) {
      return [...telegramLoginChallenges.values()]
        .filter((item) =>
          item.telegram_user_id === String(telegramUserId) && item.sent_at)
        .sort((a, b) => new Date(b.sent_at) - new Date(a.sent_at))
        .map((item) => ({ ...item }))[0] || null;
    },

    async countSentTelegramLoginChallengesSince(telegramUserId, since) {
      const sinceMs = new Date(since).getTime();
      return [...telegramLoginChallenges.values()].filter((item) =>
        item.telegram_user_id === String(telegramUserId) &&
        item.sent_at &&
        new Date(item.sent_at).getTime() >= sinceMs
      ).length;
    },

    async markTelegramLoginChallengeSent(id, sentAt = new Date().toISOString()) {
      const challenge = telegramLoginChallenges.get(String(id));
      if (!challenge) return null;
      challenge.sent_at = sentAt;
      return { ...challenge };
    },

    async consumeTelegramLoginChallenge({
      id,
      verifier_hash,
      otp_hash,
      max_attempts,
      now,
    }) {
      const challenge = telegramLoginChallenges.get(String(id));
      if (!challenge ||
          !challenge.sent_at ||
          challenge.verifier_hash !== verifier_hash ||
          challenge.consumed_at ||
          challenge.attempt_count >= max_attempts ||
          new Date(challenge.expires_at).getTime() <= new Date(now).getTime()) return null;
      challenge.attempt_count += 1;
      const matched = challenge.otp_hash === otp_hash;
      if (matched) challenge.consumed_at = now;
      return { ...challenge, matched };
    },

    async listPollExclusions(telegramGroupId = null) {
      return pollExclusions
        .filter((item) => !telegramGroupId || item.telegram_group_id === String(telegramGroupId))
        .sort((a, b) => a.event_date.localeCompare(b.event_date))
        .map((item) => ({ ...item }));
    },

    async upsertPollExclusion({ telegram_group_id, event_date }) {
      const groupId = String(telegram_group_id);
      let item = pollExclusions.find((row) =>
        row.telegram_group_id === groupId && row.event_date === event_date);
      if (!item) {
        item = {
          id: `poll-exclusion-${++pollExclusionSeq}`,
          telegram_group_id: groupId,
          event_date,
          created_at: new Date().toISOString(),
        };
        pollExclusions.push(item);
      }
      return { ...item, removed_unsent_polls: 0, active_poll_status: null };
    },

    async deletePollExclusion(id) {
      const index = pollExclusions.findIndex((item) => item.id === id);
      if (index === -1) return null;
      return pollExclusions.splice(index, 1)[0];
    },

    async isPollDateExcluded(telegramGroupId, eventDate) {
      return pollExclusions.some((item) =>
        item.telegram_group_id === String(telegramGroupId) && item.event_date === eventDate);
    },

    async createTelegramGroup({ telegram_chat_id, group_name, service = null, bot_id = 'PRIMARY', bot_ref = null }) {
      const id = await this.upsertTelegramGroupFromWebhook({
        telegram_chat_id,
        group_name,
        service,
        bot_id,
        bot_ref,
      });
      return id;
    },

    async getTelegramGroup(id) {
      const group = telegramGroups.find((item) => item.id === String(id));
      return group ? { ...group, bot_id: group.bot_ref || group.bot_id } : null;
    },

    async upsertTelegramGroupFromWebhook({ telegram_chat_id, group_name, service, bot_id, bot_ref = null }) {
      const chatId = String(telegram_chat_id);
      const route = bot_ref || bot_id || service || 'PRIMARY';
      let group = telegramGroups.find((item) =>
        item.telegram_chat_id === chatId && String(item.bot_ref || item.bot_id) === String(route));
      if (!group) {
        group = {
          id: `managed-group-${++telegramGroupSeq}`,
          telegram_chat_id: chatId,
          group_name,
          service,
          bot_id: bot_id || route,
          bot_ref,
          enabled: true,
        };
        telegramGroups.push(group);
      } else {
        Object.assign(group, { group_name, service, bot_ref: bot_ref || group.bot_ref, enabled: true });
      }
      return group.id;
    },

    async setTelegramGroupEnabledByChatAndBot(telegramChatId, botId, enabled) {
      const group = telegramGroups.find((item) =>
        item.telegram_chat_id === String(telegramChatId) &&
        String(item.bot_ref || item.bot_id) === String(botId));
      if (!group) return false;
      group.enabled = Boolean(enabled);
      return true;
    },

    async beginWebhookEvent(updateId, botId, updateType) {
      const key = String(updateId);
      if (webhookEvents.has(key)) return false;
      webhookEvents.set(key, { updateId: key, botId, updateType, status: 'processing' });
      return true;
    },

    async finishWebhookEvent(updateId, status = 'processed', error = null) {
      const event = webhookEvents.get(String(updateId));
      if (event) Object.assign(event, { status, error });
    },
  };
}

module.exports = { createMemoryDb };
