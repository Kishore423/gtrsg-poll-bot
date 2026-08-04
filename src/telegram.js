// Thin Telegram Bot API client. One bot token per service (WHCL, PSA) so each
// service posts to its own group. Uses the global fetch in Node 20+.
//
// No polling loop and no persistent socket: updates arrive via webhook (see
// server.js /api/telegram/:service), which is what makes this deployable on
// Vercel's serverless functions.

const API_BASE = 'https://api.telegram.org';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createTelegramClient({ tokens = {}, resolveToken = null, fetchImpl = fetch } = {}) {
  const tokenCache = new Map();

  async function tokenFor(botKey) {
    if (tokens[botKey]) return tokens[botKey];
    if (tokenCache.has(botKey)) return tokenCache.get(botKey);
    if (resolveToken) {
      const token = await resolveToken(botKey);
      if (token) {
        tokenCache.set(botKey, token);
        return token;
      }
    }
    throw new Error(`No Telegram bot token configured for bot ${botKey}`);
  }

  async function call(botKey, method, params, { maxAttempts = 3 } = {}) {
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const token = await tokenFor(botKey);
        const res = await fetchImpl(`${API_BASE}/bot${token}/${method}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(params || {}),
        });
        const body = await res.json();
        if (body.ok) return body.result;
        const error = new Error(`Telegram ${method} failed: ${body.error_code} ${body.description}`);
        error.telegramCode = body.error_code;
        error.retryAfter = body.parameters?.retry_after;
        if (body.error_code < 500 && body.error_code !== 429) throw error;
        lastError = error;
      } catch (error) {
        lastError = error;
        if (error.telegramCode && error.telegramCode < 500 && error.telegramCode !== 429) throw error;
      }
      if (attempt < maxAttempts) {
        const delay = lastError.retryAfter ? lastError.retryAfter * 1000 : 250 * (2 ** (attempt - 1));
        await sleep(Math.min(delay, 5000));
      }
    }
    throw lastError;
  }

  // Sends a native poll. is_anonymous:false is REQUIRED - it's the only way
  // Telegram includes the voter's identity in poll_answer updates, which
  // first-come-first-served allocation depends on. allows_multiple_answers lets
  // a person bid on several timeslots, matching the old "select one or more".
  // Returns { poll_id, message_id } - poll_id links later votes back to us.
  async function sendPoll(botKey, chatId, question, options) {
    const message = await call(botKey, 'sendPoll', {
      chat_id: chatId,
      question,
      options,
      is_anonymous: false,
      allows_multiple_answers: true,
    });
    return { poll_id: message.poll.id, message_id: message.message_id };
  }

  // text is HTML (parse_mode HTML). Mentions are <a href="tg://user?id=..">,
  // which tag a user by id even when they have no @username.
  async function sendMessage(botKey, chatId, html) {
    return call(botKey, 'sendMessage', {
      chat_id: chatId,
      text: html,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
  }

  async function editMessage(botKey, chatId, messageId, html) {
    return call(botKey, 'editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: html,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
  }

  async function stopPoll(botKey, chatId, messageId) {
    return call(botKey, 'stopPoll', { chat_id: chatId, message_id: messageId });
  }

  async function setWebhook(botKey, url, secretToken) {
    return call(botKey, 'setWebhook', {
      url,
      secret_token: secretToken,
      allowed_updates: ['poll_answer', 'my_chat_member', 'message'],
    });
  }

  async function getMe(botKey) {
    return call(botKey, 'getMe');
  }

  async function getChat(botKey, chatId) {
    return call(botKey, 'getChat', { chat_id: chatId });
  }

  async function getMyName(botKey) {
    return call(botKey, 'getMyName');
  }

  async function setMyName(botKey, name) {
    return call(botKey, 'setMyName', { name });
  }

  return {
    sendPoll,
    sendMessage,
    editMessage,
    stopPoll,
    setWebhook,
    getMe,
    getChat,
    getMyName,
    setMyName,
    call,
  };
}

module.exports = { createTelegramClient };
