const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createMemoryDb } = require('../src/db/memory');
const { createServer } = require('../src/server');

function makeTelegram() {
  const polls = [];
  const messages = [];
  let seq = 0;
  return {
    polls,
    messages,
    async sendPoll(service, chatId, question, options) {
      seq += 1;
      polls.push({ service, chatId, question, options });
      return { poll_id: `TG-${seq}`, message_id: seq };
    },
    async sendMessage(service, chatId, html) {
      messages.push({ service, chatId, html });
    },
  };
}

async function withServer(run, serverOptions = {}) {
  const db = createMemoryDb();
  const telegram = makeTelegram();
  const server = createServer(db, telegram, serverOptions).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await run({ db, telegram, baseUrl });
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

const json = (method, body, headers) => ({
  method,
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

test('management APIs are open locally and require a provisioned user in production', async () => {
  await withServer(async ({ baseUrl }) => {
    assert.equal((await fetch(`${baseUrl}/api/slots`)).status, 200);
  });
  await withServer(async ({ baseUrl }) => {
    // Unprovisioned (or absent) identity is refused -- the allow-list, not the
    // Supabase token, is what grants access.
    assert.equal((await fetch(`${baseUrl}/api/slots`)).status, 401);
    const ok = await fetch(`${baseUrl}/api/slots`, { headers: { Authorization: 'Bearer valid' } });
    assert.equal(ok.status, 200);
  }, { requireAdminAuth: true, verifyUser: async (req) =>
    req.headers.authorization === 'Bearer valid'
      ? { id: 'user-1', telegram_user_id: '1001', role: 'user', bot_id: null }
      : null });
});

test('admin-only routes reject a provisioned non-admin', async () => {
  await withServer(async ({ baseUrl }) => {
    const asUser = await fetch(`${baseUrl}/api/admin/users`, {
      headers: { Authorization: 'Bearer user' },
    });
    assert.equal(asUser.status, 403);
  }, { requireAdminAuth: true, verifyUser: async (req) =>
    req.headers.authorization === 'Bearer user'
      ? { id: 'user-1', telegram_user_id: '1001', role: 'user', bot_id: null }
      : null });
});

test('admin roster refreshes a bound user handle from Telegram', async () => {
  await withServer(async ({ db, baseUrl }) => {
    await db.createAppUser({
      telegram_user_id: '1001',
      telegram_username: 'old_handle',
      telegram_display_name: 'Operations User',
      login_bot_verified_at: new Date().toISOString(),
    });
    const cachedResponse = await fetch(`${baseUrl}/api/admin/users`, {
      headers: { Authorization: 'Bearer admin' },
    });
    assert.equal(cachedResponse.headers.get('cache-control'), 'no-store');
    assert.equal((await cachedResponse.json())[0].telegram_username, 'old_handle');

    const response = await fetch(`${baseUrl}/api/admin/telegram-identities/refresh`, {
      method: 'POST',
      headers: { Authorization: 'Bearer admin' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const [user] = await response.json();
    assert.equal(user.telegram_username, 'current_handle');
    assert.equal(user.telegram_display_name, 'Operations User');
  }, {
    requireAdminAuth: true,
    verifyUser: async (req) =>
      req.headers.authorization === 'Bearer admin'
        ? { id: 'admin-1', telegram_user_id: '1002', role: 'admin', bot_id: null }
        : null,
    syncTelegramUserIdentity: async (user) => ({
      ...user,
      telegram_username: 'current_handle',
    }),
  });
});

test('admin roster treats a private Login_bot chat that has not started as unavailable', async () => {
  await withServer(async ({ db, baseUrl }) => {
    await db.createAppUser({
      telegram_user_id: '1001',
      telegram_username: 'cached_handle',
      telegram_display_name: 'Pending Login Bot User',
      login_bot_verified_at: new Date().toISOString(),
    });
    const response = await fetch(`${baseUrl}/api/admin/telegram-identities/refresh`, {
      method: 'POST',
      headers: { Authorization: 'Bearer admin' },
    });
    assert.equal(response.status, 200);
    const [user] = await response.json();
    assert.equal(user.telegram_username, 'cached_handle');
    assert.equal(user.sync_unavailable, true);
    assert.equal(Object.hasOwn(user, 'sync_error'), false);
  }, {
    requireAdminAuth: true,
    verifyUser: async (req) =>
      req.headers.authorization === 'Bearer admin'
        ? { id: 'admin-1', telegram_user_id: '1002', role: 'admin', bot_id: null }
        : null,
    syncTelegramUserIdentity: async () => {
      const error = new Error('Telegram getChat failed: 400 Bad Request: chat not found');
      error.telegramCode = 400;
      throw error;
    },
  });
});

test('Telegram OTP endpoints request a code and verify a login session', async () => {
  await withServer(async ({ baseUrl }) => {
    const started = await fetch(`${baseUrl}/api/auth/telegram/otp/request`, json('POST', {
      identifier: '@approved_user',
    }));
    assert.equal(started.status, 202);
    assert.equal((await started.json()).bot_username, 'login_bot');

    const finished = await fetch(`${baseUrl}/api/auth/telegram/otp/verify`, json('POST', {
      challenge_id: 'challenge',
      verifier: 'verifier',
      code: '123456',
    }));
    assert.equal(finished.status, 200);
    const session = await finished.json();
    assert.equal(session.status, 'authenticated');
    assert.equal(session.access_token, 'telegram-session');
  }, {
    requireAdminAuth: true,
    requestTelegramOtp: async (identifier) => {
      assert.equal(identifier, '@approved_user');
      return {
      challenge_id: 'challenge',
      verifier: 'verifier',
      bot_username: 'login_bot',
      setup_url: 'https://t.me/login_bot?start=login_setup',
      };
    },
    verifyTelegramOtp: async (challengeId, verifier, code) => {
      assert.equal(challengeId, 'challenge');
      assert.equal(verifier, 'verifier');
      assert.equal(code, '123456');
      return { status: 'authenticated', access_token: 'telegram-session', expires_at: 123 };
    },
  });
});

test('admin APIs mirror Telegram bot identity and keep it read-only', async () => {
  const previousKey = process.env.BOT_TOKEN_ENC_KEY;
  process.env.BOT_TOKEN_ENC_KEY = crypto.randomBytes(32).toString('base64');
  const db = createMemoryDb();
  const webhooks = [];
  const remoteNames = new Map();
  const remoteHandles = new Map();
  const setNameCalls = [];
  const deletedWebhooks = [];
  const telegram = {
    async setWebhook(botId, url, secret) {
      webhooks.push({ botId, url, secret });
      return true;
    },
    async getMe(botId) {
      return {
        id: 9001,
        username: remoteHandles.get(botId) || `${botId}_username`,
        first_name: 'Tenant Bot',
      };
    },
    async getMyName(botId) {
      return { name: remoteNames.get(botId) || `${botId} display` };
    },
    async setMyName(botId, name) {
      setNameCalls.push({ botId, name });
      return true;
    },
  };
  const server = createServer(db, telegram, {
    requireAdminAuth: true,
    appUrl: 'https://example.test',
    verifyUser: async (req) =>
      req.headers.authorization === 'Bearer admin'
        ? { id: 'admin-1', telegram_user_id: '1002', role: 'admin', bot_id: null }
        : null,
    createTelegramClientForToken: (token) => ({
      async getMe() {
        if (token === 'replacement-token') {
          return { id: 456, username: 'replacement_bot', first_name: 'Replacement Bot' };
        }
        if (token === 'assigned-later-token') {
          return { id: 234, username: 'assigned_later_bot', first_name: 'Assigned Later Bot' };
        }
        return { id: 123, username: 'new_user_bot', first_name: 'New User Bot' };
      },
      async getMyName() {
        if (token === 'replacement-token') return { name: 'Replacement Bot' };
        if (token === 'assigned-later-token') return { name: 'Assigned Later Bot' };
        return { name: 'New User Bot' };
      },
      async deleteWebhook() {
        deletedWebhooks.push(token);
        return true;
      },
    }),
  }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const headers = { Authorization: 'Bearer admin' };
    const created = await fetch(`${baseUrl}/api/admin/users`, json('POST', {
      telegram_username: 'new_user',
      telegram_display_name: 'New User',
      email: 'ignored@example.com',
      role: 'user',
      bot_token: 'fake-token',
    }, headers));
    assert.equal(created.status, 201);
    const body = await created.json();
    assert.equal(body.telegram_user_id, null);
    assert.equal(body.telegram_username, 'new_user');
    assert.equal(body.role, 'user');
    assert.equal(Object.hasOwn(body, 'email'), false);
    assert.ok(body.bot_id);
    assert.equal(webhooks.length, 1);
    assert.equal(webhooks[0].botId, body.bot_id);
    assert.match(webhooks[0].url, new RegExp(`/api/telegram/${body.bot_id}$`));

    remoteNames.set(body.bot_id, 'Telegram Managed Name');
    remoteHandles.set(body.bot_id, 'telegram_managed_bot');
    const listed = await fetch(`${baseUrl}/api/admin/telegram-identities/refresh`, {
      method: 'POST',
      headers,
    });
    assert.equal(listed.status, 200);
    const users = await listed.json();
    assert.equal(users[0].telegram_username, 'new_user');
    assert.equal(users[0].bot.bot_name, 'Telegram Managed Name');
    assert.equal(users[0].bot.telegram_username, 'telegram_managed_bot');
    assert.equal(Object.hasOwn(users[0], 'email'), false);
    assert.equal(Object.hasOwn(users[0], 'profile_photo_data'), false);

    const editedRes = await fetch(`${baseUrl}/api/admin/users/${body.id}`, json('PATCH', {
      telegram_display_name: 'Edited User',
      role: 'admin',
      enabled: false,
    }, headers));
    assert.equal(editedRes.status, 200);
    const edited = await editedRes.json();
    assert.equal(edited.telegram_user_id, null);
    assert.equal(edited.telegram_username, 'new_user');
    assert.equal(edited.telegram_display_name, 'Edited User');
    assert.equal(edited.role, 'admin');
    assert.equal(edited.enabled, false);
    assert.equal(edited.bot.bot_name, 'Telegram Managed Name');

    const userHandleRes = await fetch(`${baseUrl}/api/admin/users/${body.id}`, json('PATCH', {
      telegram_username: 'edited_user',
    }, headers));
    assert.equal(userHandleRes.status, 400);

    const userRenameRes = await fetch(`${baseUrl}/api/admin/users/${body.id}`, json('PATCH', {
      bot_name: 'Website Rename',
    }, headers));
    assert.equal(userRenameRes.status, 400);

    const botRenameRes = await fetch(`${baseUrl}/api/admin/bots/${body.bot_id}`, json('PATCH', {
      bot_name: 'Website Rename',
    }, headers));
    assert.equal(botRenameRes.status, 405);
    assert.deepEqual(setNameCalls, []);

    remoteNames.set(body.bot_id, 'Changed In Telegram');
    remoteHandles.set(body.bot_id, 'changed_in_telegram');
    const refreshed = await fetch(`${baseUrl}/api/admin/telegram-identities/refresh`, {
      method: 'POST',
      headers,
    });
    const refreshedUsers = await refreshed.json();
    assert.equal(refreshedUsers[0].telegram_username, 'new_user');
    assert.equal(refreshedUsers[0].bot.bot_name, 'Changed In Telegram');
    assert.equal(refreshedUsers[0].bot.telegram_username, 'changed_in_telegram');

    const unassignedRes = await fetch(`${baseUrl}/api/admin/users`, json('POST', {
      telegram_username: 'unassigned_user',
      telegram_display_name: 'Unassigned User',
      role: 'user',
    }, headers));
    assert.equal(unassignedRes.status, 201);
    const unassigned = await unassignedRes.json();
    assert.equal(unassigned.bot_id, null);
    assert.equal(webhooks.length, 1);

    const assignedRes = await fetch(`${baseUrl}/api/admin/users/${unassigned.id}`, json('PATCH', {
      bot_token: 'assigned-later-token',
    }, headers));
    assert.equal(assignedRes.status, 200);
    const assigned = await assignedRes.json();
    assert.ok(assigned.bot_id);
    assert.equal(assigned.bot.telegram_username, 'assigned_later_bot');
    assert.equal(webhooks.length, 2);
    assert.equal(webhooks.at(-1).botId, assigned.bot_id);

    const previousBotId = assigned.bot_id;
    const previousGroupId = await db.createTelegramGroup({
      telegram_chat_id: '-100999',
      group_name: 'Previous Bot Group',
      bot_id: previousBotId,
      bot_ref: previousBotId,
    });
    const replacedRes = await fetch(`${baseUrl}/api/admin/users/${unassigned.id}`, json('PATCH', {
      bot_token: 'replacement-token',
    }, headers));
    assert.equal(replacedRes.status, 200);
    const replaced = await replacedRes.json();
    assert.notEqual(replaced.bot_id, previousBotId);
    assert.equal(replaced.bot.telegram_username, 'replacement_bot');
    assert.equal((await db.getBot(previousBotId)).enabled, false);
    assert.equal((await db.getTelegramGroup(previousGroupId)).enabled, false);
    assert.deepEqual(deletedWebhooks, ['assigned-later-token']);
    assert.equal(webhooks.length, 3);

    const duplicateRes = await fetch(`${baseUrl}/api/admin/users/${unassigned.id}`, json('PATCH', {
      bot_token: 'replacement-token',
    }, headers));
    assert.equal(duplicateRes.status, 409);
    assert.match((await duplicateRes.json()).error, /already assigned in the application/);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    if (previousKey === undefined) delete process.env.BOT_TOKEN_ENC_KEY;
    else process.env.BOT_TOKEN_ENC_KEY = previousKey;
  }
});

test('memory repository rejects duplicate immutable Telegram bot IDs', async () => {
  const db = createMemoryDb();
  await db.createBot({
    bot_name: 'First mapping',
    telegram_bot_id: '9001',
    token_encrypted: 'first',
    webhook_secret: 'first-secret',
  });
  await assert.rejects(
    () => db.createBot({
      bot_name: 'Duplicate mapping',
      telegram_bot_id: '9001',
      token_encrypted: 'second',
      webhook_secret: 'second-secret',
    }),
    (error) =>
      error.code === '23505' && error.constraint === 'bots_telegram_bot_id_key'
  );
});

test('a signed-in user can upload only a bounded profile picture to their own account', async () => {
  await withServer(async ({ db, baseUrl }) => {
    const userId = await db.createAppUser({
      telegram_user_id: '1001',
      telegram_username: 'profile_user',
      telegram_display_name: 'Profile User',
    });
    assert.equal(userId, 'app-user-1');
    const headers = { Authorization: 'Bearer user' };
    const profilePhotoData = `data:image/png;base64,${Buffer.from('small profile image').toString('base64')}`;
    const uploaded = await fetch(`${baseUrl}/api/me/profile-photo`, json('PATCH', {
      profile_photo_data: profilePhotoData,
    }, headers));
    assert.equal(uploaded.status, 200);
    assert.equal((await uploaded.json()).profile_photo_data, profilePhotoData);
    assert.equal((await db.getAppUserByTelegramId('1001')).profile_photo_data, profilePhotoData);

    const deleted = await fetch(`${baseUrl}/api/me/profile-photo`, {
      method: 'DELETE',
      headers,
    });
    assert.equal(deleted.status, 200);
    assert.deepEqual(await deleted.json(), { deleted: true });
    assert.equal((await db.getAppUserByTelegramId('1001')).profile_photo_data, null);

    const invalid = await fetch(`${baseUrl}/api/me/profile-photo`, json('PATCH', {
      profile_photo_data: 'data:text/html;base64,PGgxPk5vPC9oMT4=',
    }, headers));
    assert.equal(invalid.status, 400);
  }, {
    requireAdminAuth: true,
    verifyUser: async (req) => req.headers.authorization === 'Bearer user'
      ? { id: 'app-user-1', telegram_user_id: '1001', role: 'user', bot_id: null }
      : null,
  });
});

test('tenant scoping limits managed groups to the caller bot', async () => {
  await withServer(async ({ db, baseUrl }) => {
    const groupA = await db.upsertTelegramGroupFromWebhook({
      telegram_chat_id: -1001,
      group_name: 'User A group',
      service: 'PSA',
      bot_id: 'bot-a',
    });
    const groupB = await db.upsertTelegramGroupFromWebhook({
      telegram_chat_id: -1002,
      group_name: 'User B group',
      service: 'WHCL',
      bot_id: 'bot-b',
    });

    const asUser = { Authorization: 'Bearer user-a' };
    const listed = await fetch(`${baseUrl}/api/telegram-groups`, { headers: asUser });
    assert.equal(listed.status, 200);
    assert.deepEqual((await listed.json()).map((group) => group.id), [groupA]);

    const attemptedOverride = await fetch(
      `${baseUrl}/api/telegram-groups?bot_id=bot-b&refresh=1`,
      { headers: asUser },
    );
    assert.equal(attemptedOverride.status, 200);
    assert.deepEqual((await attemptedOverride.json()).map((group) => group.id), [groupA]);

    const hiddenVerify = await fetch(`${baseUrl}/api/telegram-groups/${groupB}/verify`, {
      method: 'POST',
      headers: asUser,
    });
    assert.equal(hiddenVerify.status, 404);

    const hiddenSkipDate = await fetch(`${baseUrl}/api/poll-exclusions`, json('POST', {
      telegram_group_id: groupB,
      event_date: '2026-07-29',
    }, asUser));
    assert.equal(hiddenSkipDate.status, 404);

    const ownSkipDate = await fetch(`${baseUrl}/api/poll-exclusions`, json('POST', {
      telegram_group_id: groupA,
      event_date: '2026-07-29',
    }, asUser));
    assert.equal(ownSkipDate.status, 201);
  }, { requireAdminAuth: true, verifyUser: async (req) =>
    req.headers.authorization === 'Bearer user-a'
      ? { id: 'user-a', telegram_user_id: '1003', role: 'user', bot_id: 'bot-a' }
      : null });
});

test('tenant scoping permits own templates and custom replacements but blocks other bots', async () => {
  const groupA = {
    id: '11111111-1111-4111-8111-111111111111',
    telegram_chat_id: '-1001',
    group_name: 'User A group',
    service: 'WHCL',
    bot_id: 'bot-a',
  };
  const groupB = {
    id: '22222222-2222-4222-8222-222222222222',
    telegram_chat_id: '-1002',
    group_name: 'User B group',
    service: 'WHCL',
    bot_id: 'bot-b',
  };
  const schedules = new Map();
  const deletedPolls = [];
  const createdPolls = [];
  const db = {
    async getTelegramGroup(id) {
      return [groupA, groupB].find((group) => group.id === id) || null;
    },
    async upsertManagedWeeklySchedule(body) {
      const schedule = { id: `${body.telegram_group_id}-schedule`, bot_id: 'bot-a', ...body };
      schedules.set(schedule.id, schedule);
      return schedule;
    },
    async getWeeklySchedule(id) {
      return schedules.get(id) || null;
    },
    async getActivePollForDate(groupId) {
      return groupId === groupA.id
        ? { id: 'default-poll-a', status: 'scheduled', is_custom: false }
        : null;
    },
    async deleteScheduledPoll(id) {
      deletedPolls.push(id);
    },
    async createScheduledEvent(payload) {
      createdPolls.push(payload);
      return 'custom-poll-a';
    },
  };
  const server = createServer(db, makeTelegram(), {
    requireAdminAuth: true,
    verifyUser: async (req) => req.headers.authorization === 'Bearer user-a'
      ? { id: 'user-a', telegram_user_id: '1003', role: 'user', bot_id: 'bot-a' }
      : null,
  }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: 'Bearer user-a' };
  const template = {
    poll_release_day_of_week: 3,
    poll_release_time: '17:00',
    confirmation_day_of_week: 5,
    confirmation_time: '12:00',
    shifts: [{ label: '0800-1700', start_time: '08:00', end_time: '17:00', capacity: 1 }],
  };
  try {
    const ownTemplate = await fetch(`${baseUrl}/api/weekly-schedules`, json('PUT', {
      ...template,
      telegram_group_id: groupA.id,
    }, headers));
    assert.equal(ownTemplate.status, 200);
    const scheduleA = await ownTemplate.json();

    const foreignTemplate = await fetch(`${baseUrl}/api/weekly-schedules`, json('PUT', {
      ...template,
      telegram_group_id: groupB.id,
    }, headers));
    assert.equal(foreignTemplate.status, 404);

    const customPayload = {
      telegram_group_id: groupA.id,
      weekly_schedule_id: scheduleA.id,
      event_date: '2099-01-05',
      poll_question: 'Custom wheelchair poll',
      confirmation_at: '2099-01-01T12:00',
      is_custom: true,
      shifts: template.shifts,
    };
    const ownCustom = await fetch(`${baseUrl}/api/scheduled-polls`, json('POST', customPayload, headers));
    assert.equal(ownCustom.status, 201);
    assert.deepEqual(deletedPolls, ['default-poll-a']);
    assert.equal(createdPolls[0].telegram_group_id, groupA.id);
    assert.equal(createdPolls[0].is_custom, true);

    const foreignSchedule = { ...template, id: 'foreign-schedule', telegram_group_id: groupB.id, bot_id: 'bot-b' };
    schedules.set(foreignSchedule.id, foreignSchedule);
    const foreignCustom = await fetch(`${baseUrl}/api/scheduled-polls`, json('POST', {
      ...customPayload,
      telegram_group_id: groupB.id,
      weekly_schedule_id: foreignSchedule.id,
    }, headers));
    assert.equal(foreignCustom.status, 404);
    assert.equal(createdPolls.length, 1);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test('admins are not filtered by bot tenancy', async () => {
  await withServer(async ({ db, baseUrl }) => {
    await db.upsertTelegramGroupFromWebhook({
      telegram_chat_id: -1001,
      group_name: 'User A group',
      service: 'PSA',
      bot_id: 'bot-a',
    });
    await db.upsertTelegramGroupFromWebhook({
      telegram_chat_id: -1002,
      group_name: 'User B group',
      service: 'WHCL',
      bot_id: 'bot-b',
    });

    const listed = await fetch(`${baseUrl}/api/telegram-groups`, {
      headers: { Authorization: 'Bearer admin' },
    });
    assert.equal(listed.status, 200);
    assert.deepEqual((await listed.json()).map((group) => group.group_name).sort(), [
      'User A group',
      'User B group',
    ]);
  }, { requireAdminAuth: true, verifyUser: async (req) =>
    req.headers.authorization === 'Bearer admin'
      ? { id: 'admin-1', telegram_user_id: '1002', role: 'admin', bot_id: null }
      : null });
});

test('admin group refresh scopes to one bot and disables stale memberships', async () => {
  const db = createMemoryDb();
  await db.upsertTelegramGroupFromWebhook({
    telegram_chat_id: -1001,
    group_name: 'Current group',
    service: null,
    bot_id: 'bot-a',
  });
  await db.upsertTelegramGroupFromWebhook({
    telegram_chat_id: -1002,
    group_name: 'Former group',
    service: null,
    bot_id: 'bot-a',
  });
  await db.upsertTelegramGroupFromWebhook({
    telegram_chat_id: -1003,
    group_name: 'Different user group',
    service: null,
    bot_id: 'bot-b',
  });
  const checkedChats = [];
  const telegram = {
    async getMe(botId) {
      assert.equal(botId, 'bot-a');
      return { id: 7001 };
    },
    async call(botId, method, params) {
      assert.equal(botId, 'bot-a');
      assert.equal(method, 'getChatMember');
      assert.equal(params.user_id, 7001);
      checkedChats.push(String(params.chat_id));
      return { status: String(params.chat_id) === '-1002' ? 'left' : 'administrator' };
    },
  };
  const server = createServer(db, telegram, {
    requireAdminAuth: true,
    verifyUser: async (req) => req.headers.authorization === 'Bearer admin'
      ? { id: 'admin-1', telegram_user_id: '1002', role: 'admin', bot_id: null }
      : null,
  }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${baseUrl}/api/telegram-groups?bot_id=bot-a&refresh=1`, {
      headers: { Authorization: 'Bearer admin' },
    });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).map((group) => group.group_name), ['Current group']);
    assert.deepEqual(checkedChats.sort(), ['-1001', '-1002']);
    assert.deepEqual(
      (await db.listTelegramGroups({ botId: 'bot-a' })).map((group) => group.group_name),
      ['Current group'],
    );
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test('webhook: bot added to a group captures that service target', async () => {
  await withServer(async ({ db, baseUrl }) => {
    const res = await fetch(`${baseUrl}/api/telegram/whcl`, json('POST', {
      update_id: 1,
      my_chat_member: {
        chat: { id: -100123, type: 'supergroup', title: 'GTRSG Wheelchair' },
        new_chat_member: { status: 'member' },
      },
    }));
    assert.equal(res.status, 200);
    const target = await db.getTarget('WHCL');
    assert.equal(target.chat_id, '-100123');
    assert.equal(target.title, 'GTRSG Wheelchair');
    const groups = await db.listTelegramGroups();
    assert.equal(groups.length, 1);
    assert.equal(groups[0].telegram_chat_id, '-100123');
    assert.equal(groups[0].group_name, 'GTRSG Wheelchair');
    assert.equal(groups[0].service, 'WHCL');
    assert.equal(groups[0].bot_id, 'WHCL');
  });
});

test('webhook: bot removed from a group hides that managed group', async () => {
  await withServer(async ({ db, baseUrl }) => {
    const added = await fetch(`${baseUrl}/api/telegram/whcl`, json('POST', {
      update_id: 11,
      my_chat_member: {
        chat: { id: -100123, type: 'supergroup', title: 'Former Wheelchair Group' },
        new_chat_member: { status: 'administrator' },
      },
    }));
    assert.equal(added.status, 200);
    assert.equal((await db.listTelegramGroups()).length, 1);

    const removed = await fetch(`${baseUrl}/api/telegram/whcl`, json('POST', {
      update_id: 12,
      my_chat_member: {
        chat: { id: -100123, type: 'supergroup', title: 'Former Wheelchair Group' },
        new_chat_member: { status: 'left' },
      },
    }));
    assert.equal(removed.status, 200);
    assert.equal(await db.getTarget('WHCL'), null);
    assert.deepEqual(await db.listTelegramGroups(), []);
  });
});

test('webhook: service bot group message captures managed group', async () => {
  await withServer(async ({ db, baseUrl }) => {
    const res = await fetch(`${baseUrl}/api/telegram/psa`, json('POST', {
      update_id: 2,
      message: {
        message_id: 1,
        chat: { id: -100456, type: 'supergroup', title: 'New PSA Group' },
        text: '/start@Pax_services_bot',
      },
    }));
    assert.equal(res.status, 200);
    const target = await db.getTarget('PSA');
    assert.equal(target.chat_id, '-100456');
    assert.equal(target.title, 'New PSA Group');
    const groups = await db.listTelegramGroups();
    assert.equal(groups.length, 1);
    assert.equal(groups[0].telegram_chat_id, '-100456');
    assert.equal(groups[0].group_name, 'New PSA Group');
    assert.equal(groups[0].service, 'PSA');
    assert.equal(groups[0].bot_id, 'PSA');
  });
});

test('webhook: one service bot can capture multiple managed groups', async () => {
  await withServer(async ({ db, baseUrl }) => {
    for (const [updateId, chatId, title] of [
      [3, -100456, 'PSA Group A'],
      [4, -100789, 'PSA Group B'],
    ]) {
      const res = await fetch(`${baseUrl}/api/telegram/psa`, json('POST', {
        update_id: updateId,
        message: {
          message_id: 1,
          chat: { id: chatId, type: 'supergroup', title },
          text: 'plain text',
        },
      }));
      assert.equal(res.status, 200);
    }
    const groups = await db.listTelegramGroups();
    assert.equal(groups.length, 2);
    assert.deepEqual(groups.map((group) => group.telegram_chat_id).sort(), ['-100456', '-100789']);
    assert.deepEqual([...new Set(groups.map((group) => group.bot_id))], ['PSA']);
    assert.deepEqual([...new Set(groups.map((group) => group.service))], ['PSA']);
  });
});

test('webhook: primary bot group message captures general managed group', async () => {
  await withServer(async ({ db, baseUrl }) => {
    const res = await fetch(`${baseUrl}/api/telegram/primary`, json('POST', {
      update_id: 3,
      message: {
        message_id: 1,
        chat: { id: -100789, type: 'supergroup', title: 'General Group' },
        text: '/start',
      },
    }));
    assert.equal(res.status, 200);
    const groups = await db.listTelegramGroups();
    assert.equal(groups.length, 1);
    assert.equal(groups[0].telegram_chat_id, '-100789');
    assert.equal(groups[0].group_name, 'General Group');
    assert.equal(groups[0].service, null);
    assert.equal(groups[0].bot_id, 'PRIMARY');
  });
});

test('webhook: dedicated login bot never captures Telegram groups', async () => {
  await withServer(async ({ db, baseUrl }) => {
    const res = await fetch(`${baseUrl}/api/telegram/login`, json('POST', {
      update_id: 5,
      message: {
        message_id: 1,
        chat: { id: -100890, type: 'supergroup', title: 'Must stay unmanaged' },
        text: '/start',
      },
    }));
    assert.equal(res.status, 200);
    assert.deepEqual(await db.listTelegramGroups(), []);
  });
});

test('full flow: link group, send poll, vote, results ranked, confirm', async () => {
  await withServer(async ({ db, telegram, baseUrl }) => {
    // 1. Link the WHCL bot's group.
    await fetch(`${baseUrl}/api/telegram/whcl`, json('POST', {
      update_id: 10,
      my_chat_member: { chat: { id: -100999, type: 'group', title: 'G' }, new_chat_member: { status: 'administrator' } },
    }));

    // 2. Admin adds slots (2-slot option) and sends the poll.
    await fetch(`${baseUrl}/api/slots`, json('POST', { slot_date: '2026-08-25', time_start: '17:00', time_end: '22:00', slot_count: 2, service: 'WHCL' }));
    const trig = await fetch(`${baseUrl}/api/trigger-now`, json('POST', { service: 'WHCL' }));
    assert.equal((await trig.json()).sent, 1);
    assert.equal(telegram.polls[0].chatId, '-100999');
    const providerPollId = 'TG-1';

    // 3. Three people vote for 1700-2200 (capacity 2) -> 3rd is waitlisted.
    for (const [index, [id, name]] of [['1', 'Alice'], ['2', 'Bob'], ['3', 'Carol']].entries()) {
      await fetch(`${baseUrl}/api/telegram/whcl`, json('POST', {
        update_id: 11 + index,
        poll_answer: { poll_id: providerPollId, user: { id: Number(id), first_name: name }, option_ids: [0] },
      }));
    }

    // 4. Results show all three in arrival order.
    const polls = await (await fetch(`${baseUrl}/api/polls`)).json();
    const opt = polls[0].options.find((o) => o.name === '1700-2200');
    assert.deepEqual(opt.voters.map((v) => v.name), ['Alice', 'Bob', 'Carol']);
    assert.equal(opt.capacity, 2);
    assert.equal(polls[0].filled_slots, 2);

    // 5. Confirm -> message tags only the first two (FCFS).
    const conf = await fetch(`${baseUrl}/api/polls/${polls[0].id}/confirm`, json('POST', {}));
    assert.equal(conf.status, 200);
    assert.equal(telegram.messages.length, 1);
    const html = telegram.messages[0].html;
    assert.match(html, /Alice/);
    assert.match(html, /Bob/);
    assert.doesNotMatch(html, /Carol/);
  });
});

test('webhook: a retracted vote is removed from results', async () => {
  await withServer(async ({ baseUrl }) => {
    await fetch(`${baseUrl}/api/telegram/whcl`, json('POST', {
      update_id: 20,
      my_chat_member: { chat: { id: -1, type: 'group', title: 'G' }, new_chat_member: { status: 'member' } },
    }));
    await fetch(`${baseUrl}/api/slots`, json('POST', { slot_date: '2026-07-19', time_start: '17:00', time_end: '22:00', slot_count: 1, service: 'WHCL' }));
    await fetch(`${baseUrl}/api/trigger-now`, json('POST', { service: 'WHCL' }));

    await fetch(`${baseUrl}/api/telegram/whcl`, json('POST', {
      update_id: 21,
      poll_answer: { poll_id: 'TG-1', user: { id: 7, first_name: 'Dan' }, option_ids: [0] },
    }));
    let polls = await (await fetch(`${baseUrl}/api/polls`)).json();
    assert.equal(polls[0].options.find((o) => o.name === '1700-2200').voters.length, 1);

    // Empty option_ids = retraction.
    await fetch(`${baseUrl}/api/telegram/whcl`, json('POST', {
      update_id: 22,
      poll_answer: { poll_id: 'TG-1', user: { id: 7, first_name: 'Dan' }, option_ids: [] },
    }));
    polls = await (await fetch(`${baseUrl}/api/polls`)).json();
    assert.equal(polls[0].options.find((o) => o.name === '1700-2200').voters.length, 0);
  });
});

test('webhook rejects a wrong secret token when configured', async () => {
  await withServer(async ({ baseUrl }) => {
    const bad = await fetch(`${baseUrl}/api/telegram/whcl`, json('POST', { update_id: 30, my_chat_member: {} }, { 'X-Telegram-Bot-Api-Secret-Token': 'wrong' }));
    assert.equal(bad.status, 401);
    const good = await fetch(`${baseUrl}/api/telegram/whcl`, json('POST', {
      update_id: 31,
      my_chat_member: { chat: { id: -5, type: 'group', title: 'G' }, new_chat_member: { status: 'member' } },
    }, { 'X-Telegram-Bot-Api-Secret-Token': 'sec' }));
    assert.equal(good.status, 200);
  }, { telegramWebhookSecret: 'sec' });
});

test('webhook: per-user bot route validates its own secret and captures the group for that bot', async () => {
  await withServer(async ({ db, baseUrl }) => {
    const botId = await db.createBot({
      bot_name: 'User bot',
      telegram_username: 'user_test_bot',
      telegram_bot_id: 12345,
      token_encrypted: 'encrypted',
      webhook_secret: 'bot-secret',
    });

    const wrong = await fetch(`${baseUrl}/api/telegram/${botId}`, json('POST', {
      update_id: 32,
      my_chat_member: {
        chat: { id: -100321, type: 'supergroup', title: 'Tenant Group' },
        new_chat_member: { status: 'member' },
      },
    }, { 'X-Telegram-Bot-Api-Secret-Token': 'wrong' }));
    assert.equal(wrong.status, 401);

    const good = await fetch(`${baseUrl}/api/telegram/${botId}`, json('POST', {
      update_id: 33,
      my_chat_member: {
        chat: { id: -100321, type: 'supergroup', title: 'Tenant Group' },
        new_chat_member: { status: 'member' },
      },
    }, { 'X-Telegram-Bot-Api-Secret-Token': 'bot-secret' }));
    assert.equal(good.status, 200);

    const groups = await db.listTelegramGroups({ botId });
    assert.equal(groups.length, 1);
    assert.equal(groups[0].telegram_chat_id, '-100321');
    assert.equal(groups[0].group_name, 'Tenant Group');
    assert.equal(groups[0].bot_id, botId);
    assert.equal(groups[0].bot_ref, botId);
    assert.equal(groups[0].service, null);
  });
});

test('verify group prefers WHCL service over stale PRIMARY bot_id', async () => {
  let verifiedService = null;
  let verificationDelivery = null;
  const db = {
    async getTelegramGroup() {
      return {
        id: 'group-1',
        telegram_chat_id: '-100123',
        group_name: 'Wheelchair group',
        service: 'WHCL',
        bot_id: 'PRIMARY',
        enabled: true,
      };
    },
  };
  const telegram = {
    async getMe(service) {
      verifiedService = service;
      return { id: 99 };
    },
    async call(service, method, params) {
      assert.equal(service, 'WHCL');
      assert.equal(method, 'getChatMember');
      assert.deepEqual(params, { chat_id: '-100123', user_id: 99 });
      return { status: 'administrator', can_post_messages: true };
    },
    async sendMessage(service, chatId, html) {
      assert.equal(service, 'WHCL');
      verificationDelivery = { chatId, html };
      return { message_id: 51 };
    },
  };
  const server = createServer(db, telegram, { enableLegacyWorkflow: false }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${baseUrl}/api/telegram-groups/group-1/verify`, { method: 'POST' });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.present, true);
    assert.equal(body.can_post_messages, true);
    assert.equal(body.message_sent, true);
    assert.equal(body.message_id, 51);
    assert.equal(body.group_name, 'Wheelchair group');
    assert.equal(verifiedService, 'WHCL');
    assert.equal(verificationDelivery.chatId, '-100123');
    assert.match(verificationDelivery.html, /Wheelchair group/);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test('scheduled polls can be cleared in bulk', async () => {
  let cleared = false;
  let filteredIds = null;
  const id1 = '11111111-1111-4111-8111-111111111111';
  const id2 = '22222222-2222-4222-8222-222222222222';
  const db = {
    async deleteAllScheduledPolls() {
      cleared = true;
      return [{ id: id1 }, { id: id2 }];
    },
    async deleteScheduledPollsByIds(ids) {
      filteredIds = ids;
      return ids.map((id) => ({ id }));
    },
  };
  const server = createServer(db, makeTelegram(), { enableLegacyWorkflow: false }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${baseUrl}/api/scheduled-polls`, { method: 'DELETE' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { deleted: 2, ids: [id1, id2] });
    assert.equal(cleared, true);

    const filtered = await fetch(`${baseUrl}/api/scheduled-polls`, json('DELETE', { ids: [id2] }));
    assert.equal(filtered.status, 200);
    assert.deepEqual(await filtered.json(), { deleted: 1, ids: [id2] });
    assert.deepEqual(filteredIds, [id2]);

    const invalid = await fetch(`${baseUrl}/api/scheduled-polls`, json('DELETE', { ids: ['not-a-uuid'] }));
    assert.equal(invalid.status, 400);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test('scheduled poll bulk clear requires the configured clear password', async () => {
  let deleted = false;
  const id = '11111111-1111-4111-8111-111111111111';
  const db = {
    async deleteAllScheduledPolls() {
      deleted = true;
      return [{ id }];
    },
  };
  const server = createServer(db, makeTelegram(), {
    enableLegacyWorkflow: false,
    clearPollsPassword: 'secret-pass',
  }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const denied = await fetch(`${baseUrl}/api/scheduled-polls`, json('DELETE', { clear_password: 'wrong' }));
    assert.equal(denied.status, 403);
    assert.equal(deleted, false);

    const allowed = await fetch(`${baseUrl}/api/scheduled-polls`, json('DELETE', { clear_password: 'secret-pass' }));
    assert.equal(allowed.status, 200);
    assert.deepEqual(await allowed.json(), { deleted: 1, ids: [id] });
    assert.equal(deleted, true);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test('tenant scoping blocks non-admin scheduled poll bulk deletion outside their bot', async () => {
  const idA = '11111111-1111-4111-8111-111111111111';
  const idB = '22222222-2222-4222-8222-222222222222';
  let deleted = false;
  const db = {
    async deleteAllScheduledPolls() {
      deleted = true;
      return [];
    },
    async deleteScheduledPollsByIds() {
      deleted = true;
      return [];
    },
    async getScheduledPollDetails(id) {
      return {
        poll: {
          id,
          telegram_group_id: id === idA ? 'group-a' : 'group-b',
        },
      };
    },
    async getTelegramGroup(id) {
      if (id === 'group-a') return { id, bot_id: 'bot-a' };
      if (id === 'group-b') return { id, bot_id: 'bot-b' };
      return null;
    },
  };
  const server = createServer(db, makeTelegram(), {
    enableLegacyWorkflow: false,
    requireAdminAuth: true,
    verifyUser: async (req) =>
      req.headers.authorization === 'Bearer user-a'
        ? { id: 'user-a', telegram_user_id: '1003', role: 'user', bot_id: 'bot-a' }
        : null,
  }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const headers = { Authorization: 'Bearer user-a' };
    const clearAll = await fetch(`${baseUrl}/api/scheduled-polls`, {
      method: 'DELETE',
      headers,
    });
    assert.equal(clearAll.status, 403);

    const outside = await fetch(`${baseUrl}/api/scheduled-polls`, json('DELETE', { ids: [idB] }, headers));
    assert.equal(outside.status, 404);

    const own = await fetch(`${baseUrl}/api/scheduled-polls`, json('DELETE', { ids: [idA] }, headers));
    assert.equal(own.status, 200);
    assert.equal(deleted, true);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test('poll release exclusions can be added, listed, and removed', async () => {
  const exclusions = [];
  const db = {
    async getTelegramGroup(id) {
      return id === 'group-1' ? { id } : null;
    },
    async listPollExclusions(groupId) {
      return exclusions.filter((item) => !groupId || item.telegram_group_id === groupId);
    },
    async upsertPollExclusion(value) {
      const row = { id: 'exclusion-1', ...value, removed_unsent_polls: 1, active_poll_status: null };
      exclusions.push(row);
      return row;
    },
    async deletePollExclusion(id) {
      const index = exclusions.findIndex((item) => item.id === id);
      return index === -1 ? null : exclusions.splice(index, 1)[0];
    },
  };
  const server = createServer(db, makeTelegram(), { enableLegacyWorkflow: false }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const invalid = await fetch(`${baseUrl}/api/poll-exclusions`, json('POST', {
      telegram_group_id: 'group-1', event_date: '2026-02-30',
    }));
    assert.equal(invalid.status, 400);

    const created = await fetch(`${baseUrl}/api/poll-exclusions`, json('POST', {
      telegram_group_id: 'group-1', event_date: '2026-07-29',
    }));
    assert.equal(created.status, 201);
    assert.equal((await created.json()).removed_unsent_polls, 1);

    const listed = await fetch(`${baseUrl}/api/poll-exclusions?telegram_group_id=group-1`);
    assert.equal(listed.status, 200);
    assert.equal((await listed.json())[0].event_date, '2026-07-29');

    const removed = await fetch(`${baseUrl}/api/poll-exclusions/exclusion-1`, { method: 'DELETE' });
    assert.equal(removed.status, 200);
    assert.deepEqual(await removed.json(), { deleted: 'exclusion-1' });
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test('single scheduled poll removal requires the configured clear password', async () => {
  let deleted = false;
  const db = {
    async deleteScheduledPoll(id) {
      deleted = true;
      return { id };
    },
  };
  const server = createServer(db, makeTelegram(), {
    enableLegacyWorkflow: false,
    clearPollsPassword: 'secret-pass',
  }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const denied = await fetch(`${baseUrl}/api/scheduled-polls/poll-1`, json('DELETE', {
      clear_password: 'wrong',
    }));
    assert.equal(denied.status, 403);
    assert.equal(deleted, false);

    const allowed = await fetch(`${baseUrl}/api/scheduled-polls/poll-1`, json('DELETE', {
      clear_password: 'secret-pass',
    }));
    assert.equal(allowed.status, 200);
    assert.deepEqual(await allowed.json(), { deleted: 'poll-1' });
    assert.equal(deleted, true);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test('telegram group delete reports replacement requirement without deleting dependent polls', async () => {
  const db = {
    async deleteTelegramGroup() {
      const error = new Error('Add another enabled group for this service before deleting this group, so existing polls can be moved instead of removed.');
      error.statusCode = 409;
      throw error;
    },
  };
  const server = createServer(db, makeTelegram(), { enableLegacyWorkflow: false }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${baseUrl}/api/telegram-groups/group-1`, { method: 'DELETE' });
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /moved instead of removed/);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test('test poll creation does not delete an existing scheduled or custom poll for the same date', async () => {
  let deleted = false;
  let createdPayload = null;
  const db = {
    async getActivePollForDate() {
      return {
        id: 'existing-poll',
        status: 'scheduled',
        is_custom: true,
      };
    },
    async deleteScheduledPoll() {
      deleted = true;
    },
    async createScheduledEvent(payload) {
      createdPayload = payload;
      return 'test-poll-id';
    },
  };
  const server = createServer(db, makeTelegram(), { enableLegacyWorkflow: false }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${baseUrl}/api/scheduled-polls`, json('POST', {
      telegram_group_id: '11111111-1111-4111-8111-111111111111',
      event_date: '2026-07-20',
      poll_question: '[TEST] Mon, 20Jul26 - 1 slot for 0800-1700',
      send_immediately: true,
      is_test: true,
      is_custom: false,
      shifts: [{ label: '0800-1700', start_time: '08:00', end_time: '17:00', capacity: 1 }],
    }));
    assert.equal(response.status, 201);
    assert.equal(deleted, false);
    assert.deepEqual(createdPayload.operational_tags, ['test']);
    assert.equal(createdPayload.is_custom, false);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test('WHCL template test poll preserves short confirmation delay for near dates', async () => {
  let createdPayload = null;
  const groupId = '11111111-1111-4111-8111-111111111111';
  const scheduleId = '22222222-2222-4222-8222-222222222222';
  const todayInSingapore = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Singapore',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const requestedConfirmation = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const db = {
    async getWeeklySchedule() {
      return {
        id: scheduleId,
        telegram_group_id: groupId,
        enabled: true,
        poll_release_day_of_week: 3,
        poll_release_time: '17:00',
        confirmation_day_of_week: 3,
        confirmation_time: '17:00',
        timezone: 'Asia/Singapore',
      };
    },
    async getTelegramGroup() {
      return {
        id: groupId,
        telegram_chat_id: '-1001',
        group_name: 'Wheelchair',
        service: 'WHCL',
        bot_id: 'WHCL',
        enabled: true,
      };
    },
    async createScheduledEvent(payload) {
      createdPayload = payload;
      return 'test-poll-id';
    },
  };
  const server = createServer(db, makeTelegram(), { enableLegacyWorkflow: false }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${baseUrl}/api/scheduled-polls`, json('POST', {
      telegram_group_id: groupId,
      weekly_schedule_id: scheduleId,
      event_date: todayInSingapore,
      poll_question: '[TEST] Wheelchair test',
      send_immediately: true,
      confirmation_at: requestedConfirmation,
      is_test: true,
      shifts: [{ label: '0800-1700', start_time: '08:00', end_time: '17:00', capacity: 1 }],
    }));
    assert.equal(response.status, 201);
    assert.equal(createdPayload.resolved_confirmation_at, requestedConfirmation);
    assert.deepEqual(createdPayload.operational_tags, ['test']);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test('one-off poll preserves custom confirmation and rejects confirmation at release', async () => {
  let createdPayload = null;
  const groupId = '11111111-1111-4111-8111-111111111111';
  const scheduleId = '22222222-2222-4222-8222-222222222222';
  const db = {
    async getWeeklySchedule() {
      return {
        id: scheduleId,
        telegram_group_id: groupId,
        enabled: true,
        poll_release_day_of_week: 3,
        poll_release_time: '17:00',
        confirmation_day_of_week: 5,
        confirmation_time: '12:00',
        timezone: 'Asia/Singapore',
      };
    },
    async getTelegramGroup() {
      return {
        id: groupId,
        telegram_chat_id: '-1001',
        group_name: 'Wheelchair',
        service: 'WHCL',
        bot_id: 'WHCL',
        enabled: true,
      };
    },
    async getActivePollForDate() {
      return null;
    },
    async createScheduledEvent(payload) {
      createdPayload = payload;
      return 'custom-poll-id';
    },
  };
  const server = createServer(db, makeTelegram(), { enableLegacyWorkflow: false }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const payload = {
    telegram_group_id: groupId,
    weekly_schedule_id: scheduleId,
    event_date: '2099-01-05',
    poll_question: 'Mon, 5Jan99 - 1 slot for 0800-1700',
    confirmation_at: '2099-01-01T12:00',
    is_custom: true,
    shifts: [{ label: '0800-1700', start_time: '08:00', end_time: '17:00', capacity: 1 }],
  };
  try {
    const response = await fetch(`${baseUrl}/api/scheduled-polls`, json('POST', payload));
    assert.equal(response.status, 201);
    assert.equal(createdPayload.resolved_release_at, '2098-12-31T09:00:00.000Z');
    assert.equal(createdPayload.resolved_confirmation_at, '2099-01-01T04:00:00.000Z');

    const invalid = await fetch(`${baseUrl}/api/scheduled-polls`, json('POST', {
      ...payload,
      confirmation_at: '2098-12-31T17:00',
    }));
    assert.equal(invalid.status, 400);
    assert.match((await invalid.json()).error, /Confirmation time must be after release time/);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test('duplicate webhook update is processed exactly once', async () => {
  await withServer(async ({ db, baseUrl }) => {
    const body = { update_id: 40, my_chat_member: {
      chat: { id: -40, type: 'group', title: 'First' }, new_chat_member: { status: 'member' },
    } };
    assert.equal((await fetch(`${baseUrl}/api/telegram/whcl`, json('POST', body))).status, 200);
    body.my_chat_member.chat.title = 'Duplicate';
    assert.equal((await fetch(`${baseUrl}/api/telegram/whcl`, json('POST', body))).status, 200);
    assert.equal((await db.getTarget('WHCL')).title, 'First');
  });
});

test('malformed webhook update is rejected', async () => {
  await withServer(async ({ baseUrl }) => {
    assert.equal((await fetch(`${baseUrl}/api/telegram/whcl`, json('POST', { poll_answer: {} }))).status, 400);
  });
});

test('schedule endpoint stores per-service day/time', async () => {
  await withServer(async ({ baseUrl }) => {
    assert.deepEqual(await (await fetch(`${baseUrl}/api/schedule`)).json(), [
      { service: 'WHCL', day: 3, time: '17:00' },
      { service: 'PSA', day: 3, time: '17:00' },
    ]);
    const put = await fetch(`${baseUrl}/api/schedule`, json('PUT', { service: 'PSA', day: 3, time: '09:30' }));
    assert.deepEqual(await put.json(), { service: 'PSA', day: 3, time: '09:30' });
    assert.deepEqual(await (await fetch(`${baseUrl}/api/schedule`)).json(), [
      { service: 'WHCL', day: 3, time: '17:00' },
      { service: 'PSA', day: 3, time: '09:30' },
    ]);
    assert.equal((await fetch(`${baseUrl}/api/schedule`, json('PUT', { service: 'X', day: 3, time: '09:30' }))).status, 400);
  });
});

test('cron endpoint is guarded by the bearer secret', async () => {
  await withServer(async ({ baseUrl }) => {
    assert.equal((await fetch(`${baseUrl}/api/cron/confirmations`)).status, 401);
    const ok = await fetch(`${baseUrl}/api/cron/confirmations`, { headers: { Authorization: 'Bearer topsecret' } });
    assert.equal(ok.status, 200);
  }, { cronSecret: 'topsecret' });
});
