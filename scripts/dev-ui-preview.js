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

  let pollSeq = 0;
  const telegram = {
    async sendPoll() { pollSeq += 1; return { poll_id: `PREVIEW-${pollSeq}`, message_id: pollSeq }; },
    async sendMessage(service, chatId, html) { console.log(`Preview confirmation -> ${chatId}:\n${html}`); },
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
  app.listen(port, () => console.log(`UI preview running at http://localhost:${port}`));
}

main().catch((err) => {
  console.error('Failed to start UI preview:', err);
  process.exit(1);
});
