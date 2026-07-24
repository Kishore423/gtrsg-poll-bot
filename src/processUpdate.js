const { parseUpdate } = require('./telegramUpdates');
const { NOT_AVAILABLE_OPTION } = require('./pollBuilder');

function managedGroupRoute(service) {
  return {
    service: ['WHCL', 'PSA'].includes(service) ? service : null,
    bot_id: service || 'PRIMARY',
  };
}

// Applies one Telegram update to the data store. Shared by the production
// webhook route (server.js) and the local long-polling dev harness
// (scripts/dev-telegram.js) so both behave identically.
async function processTelegramUpdate(db, service, update) {
  const event = parseUpdate(update);
  if (event.type === 'poll_vote' && db.getScheduledPollByTelegramId &&
      await db.getScheduledPollByTelegramId(event.pollId)) {
    const accepted = await db.applyScheduledPollResponse({
      updateId: update.update_id,
      pollId: event.pollId,
      userId: event.user.id,
      username: event.user.username,
      firstName: event.user.firstName,
      lastName: event.user.lastName,
      displayName: event.user.name,
      optionIds: event.optionIds,
      rawPayload: update,
      botId: service,
    });
    return { handled: accepted ? 'poll_vote' : 'duplicate' };
  }
  if (update.update_id !== undefined && db.beginWebhookEvent) {
    const accepted = await db.beginWebhookEvent(update.update_id, service, event.type);
    if (!accepted) return { handled: 'duplicate' };
  }

  try {

  if (event.type === 'group_membership') {
    if (service !== 'PRIMARY') {
      await db.setTarget(service, { chat_id: event.chatId, title: event.title, active: event.active });
    }
    if (event.active && db.upsertTelegramGroupFromWebhook) {
      const route = managedGroupRoute(service);
      await db.upsertTelegramGroupFromWebhook({
        telegram_chat_id: event.chatId,
        group_name: event.title || `${service} group`,
        service: route.service,
        bot_id: route.bot_id,
      });
    }
    const result = {
      handled: 'group_membership',
      summary: `${service} bot ${event.active ? 'linked to' : 'removed from'} group ${event.title || event.chatId}`,
    };
    if (update.update_id !== undefined && db.finishWebhookEvent) {
      await db.finishWebhookEvent(update.update_id, 'processed');
    }
    return result;
  }

  if (event.type === 'group_seen') {
    if (service !== 'PRIMARY') {
      await db.setTarget(service, { chat_id: event.chatId, title: event.title, active: true });
    }
    if (db.upsertTelegramGroupFromWebhook) {
      const route = managedGroupRoute(service);
      await db.upsertTelegramGroupFromWebhook({
        telegram_chat_id: event.chatId,
        group_name: event.title || `${service} group`,
        service: route.service,
        bot_id: route.bot_id,
      });
    }
    const result = {
      handled: 'group_seen',
      summary: `${service} bot saw group ${event.title || event.chatId}`,
    };
    if (update.update_id !== undefined && db.finishWebhookEvent) {
      await db.finishWebhookEvent(update.update_id, 'processed');
    }
    return result;
  }

  if (event.type === 'poll_vote') {
    const poll = await db.getPollByProviderPollId(event.pollId);
    if (!poll) return { handled: 'ignore' };
    const optionNames = event.optionIds
      .map((i) => poll.options[i])
      .filter((name) => name && name !== NOT_AVAILABLE_OPTION);
    await db.upsertVoterVote(poll.id, {
      voter_id: event.user.id,
      option_names: optionNames,
      voted_at_ms: Date.now(),
      display_name: event.user.name,
    });
    const result = {
      handled: 'poll_vote',
      summary: `Vote: poll ${poll.id} ${event.user.name} -> ${optionNames.join(', ') || '(none)'}`,
    };
    if (update.update_id !== undefined && db.finishWebhookEvent) {
      await db.finishWebhookEvent(update.update_id, 'processed');
    }
    return result;
  }

  if (update.update_id !== undefined && db.finishWebhookEvent) {
    await db.finishWebhookEvent(update.update_id, 'ignored');
  }
  return { handled: 'ignore' };
  } catch (error) {
    if (update.update_id !== undefined && db.finishWebhookEvent) {
      await db.finishWebhookEvent(update.update_id, 'failed', error.message);
    }
    throw error;
  }
}

module.exports = { processTelegramUpdate };
