// Previews the web UI with no database and no real Telegram bots. Seeds a
// couple of slots + a poll with votes so the results/confirmation UI is visible.
//   node scripts/dev-ui-preview.js   (then open http://localhost:4322)
const { createServer } = require('../src/server');
const { createMemoryDb } = require('../src/db/memory');
const { sendDuePolls } = require('../src/scheduler');

async function main() {
  // Dates a couple of months out so the confirmation window isn't open yet.
  const db = createMemoryDb();
  await db.insertSlot({ slot_date: '2026-12-12', time_start: '0430', time_end: '0830', slot_count: 1, service: 'WHCL' });
  await db.insertSlot({ slot_date: '2026-12-12', time_start: '1700', time_end: '2200', slot_count: 2, service: 'WHCL' });
  await db.insertSlot({ slot_date: '2026-12-13', time_start: '2200', time_end: '0300', slot_count: 1, service: 'WHCL' });
  await db.insertSlot({ slot_date: '2026-12-12', time_start: '0800', time_end: '1300', slot_count: 1, service: 'PSA' });
  await db.insertSlot({ slot_date: '2026-12-13', time_start: '1400', time_end: '1900', slot_count: 2, service: 'PSA' });

  // Pretend both bots are already in their groups.
  await db.setTarget('WHCL', { chat_id: '-100111', title: 'GTRSG Wheelchair', active: true });
  await db.setTarget('PSA', { chat_id: '-100222', title: 'GTRSG PSA', active: true });

  const botId = await db.createBot({
    bot_name: 'Preview poll bot',
    telegram_username: 'preview_poll_bot',
    telegram_bot_id: '9000000001',
    token_encrypted: 'preview-only',
    webhook_secret: 'preview-only',
  });
  await db.createAppUser({
    telegram_username: 'preview_admin',
    telegram_display_name: 'Preview Admin',
    role: 'admin',
    bot_id: botId,
  });
  const managedGroupId = await db.upsertTelegramGroupFromWebhook({
    telegram_chat_id: '-100333',
    group_name: 'Preview operations group',
    service: 'PSA',
    bot_id: botId,
    bot_ref: botId,
  });
  const managedGroup = await db.getTelegramGroup(managedGroupId);
  const weeklySchedules = [{
    id: 'preview-weekly-schedule',
    telegram_group_id: managedGroup.id,
    event_category: null,
    poll_release_day_of_week: 3,
    poll_release_time: '17:00',
    confirmation_day_of_week: 5,
    confirmation_time: '12:00',
    gap_weeks: 1,
    timezone: 'Asia/Singapore',
    enabled: true,
    shifts: [{ label: '0800-1700', start_time: '08:00', end_time: '17:00', capacity: 2 }],
  }];
  db.listManagedWeeklySchedules = async () => weeklySchedules.map((schedule) => ({
    ...schedule,
    group_name: managedGroup.group_name,
    service: managedGroup.service,
    bot_id: botId,
  }));
  db.upsertManagedWeeklySchedule = async (value) => {
    const row = { ...weeklySchedules[0], ...value };
    weeklySchedules.splice(0, 1, row);
    return { ...row };
  };
  db.getWeeklySchedule = async (id) => {
    const row = weeklySchedules.find((schedule) => String(schedule.id) === String(id));
    return row ? { ...row } : null;
  };

  // Synthetic deployment data exercises the same download route as production.
  const previewDates = Array.from({ length: 7 }, (_, i) => `2026-09-${21 + i}`);
  db.listScheduledPolls = async () => previewDates.map((date, i) => ({
    id: `preview-deployment-${i}`, event_id: `preview-event-${i}`,
    event_date: date, telegram_group_id: managedGroup.id,
    group_name: '8B_KR_NX Flexi (sample)', bot_id: botId,
    confirmation_status: 'sent', status: 'closed',
  }));
  const sampleWorkingDays = [[1, 2, 3], [3, 4, 5], [0, 4], [0, 1, 3, 6]];
  db.getAllocation = async (eventId) => {
    const day = Number(String(eventId).replace('preview-event-', ''));
    return sampleWorkingDays.flatMap((days, i) => days.includes(day) ? [{
      telegram_user_id: `sample-${i}`, telegram_username: `sample_staff_${i + 1}`,
      display_name: `Sample staff ${i + 1}`, status: 'confirmed',
      display_order: 0, confirmed_position: i + 1,
      label: i === 3 && [1, 3].includes(day) ? '2000-0000'
        : i === 2 ? '0730-1230' : '0730-1230, 1230-1630',
    }] : []);
  };

  if (process.argv.includes('--actual-roster')) {
    const { loadPreviewRoster } = require('./preview-roster');
    const snapshot = await loadPreviewRoster();
    db.listScheduledPolls = async () => structuredClone(snapshot.polls);
    db.getAllocation = async (eventId) => structuredClone(snapshot.allocations[eventId] || []);
    const getPreviewGroup = db.getTelegramGroup.bind(db);
    db.getTelegramGroup = async (id) => structuredClone(snapshot.groups.find((g) => String(g.id) === String(id)))
      || getPreviewGroup(id);
    console.log(`Loaded actual roster snapshot: ${snapshot.polls.length} polls for 21–27 Sep 2026.`);
  }

  let pollSeq = 0;
  const telegram = {
    async sendPoll() { pollSeq += 1; return { poll_id: `PREVIEW-${pollSeq}`, message_id: pollSeq }; },
    async sendMessage(service, chatId, html) { console.log(`Preview confirmation -> ${chatId}:\n${html}`); },
    async getMe() { return { id: 9000000001, username: 'preview_poll_bot' }; },
    async call(service, method) {
      if (method === 'getChatMember') return { status: 'administrator', can_post_messages: true };
      throw new Error(`Preview Telegram method ${method} is not implemented`);
    },
  };

  // Send only the 12th so the 13th stays pending (shows per-day send rows).
  await sendDuePolls(db, telegram, { slotDate: '2026-12-12' });

  const [whclPoll] = (await db.listPolls()).filter((p) => p.service === 'WHCL');
  await db.upsertVoterVote(whclPoll.id, { voter_id: '1', option_names: ['1700-2200'], voted_at_ms: 1000, display_name: 'Alice' });
  await db.upsertVoterVote(whclPoll.id, { voter_id: '2', option_names: ['1700-2200'], voted_at_ms: 2000, display_name: 'Bob' });
  await db.upsertVoterVote(whclPoll.id, { voter_id: '3', option_names: ['1700-2200'], voted_at_ms: 3000, display_name: 'Carol' });

  const app = createServer(db, telegram, {
    enableLegacyWorkflow: process.env.ENABLE_LEGACY_WORKFLOW !== 'false',
  });
  const port = process.env.PORT || 4322;
  app.listen(port, '127.0.0.1', () => console.log(`UI preview running at http://localhost:${port}`));
}

main().catch((err) => {
  console.error('Failed to start UI preview:', err);
  process.exit(1);
});
