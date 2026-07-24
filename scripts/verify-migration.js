const assert = require('node:assert/strict');
const postgres = require('postgres');

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
const sql = postgres(url, { ssl: url.includes('127.0.0.1') ? false : 'require' });
const rollback = new Error('ROLLBACK_VERIFICATION');

async function verify() {
  try {
    await sql.begin(async (tx) => {
      const [group] = await tx`insert into telegram_groups(telegram_chat_id,group_name,service)
        values (-100999999,'Migration verification','WHCL') returning id`;
      const payload = {
        telegram_group_id: group.id,
        title: 'Verification event', event_date: '2099-01-02', timezone: 'Asia/Singapore',
        poll_title: 'Verification', poll_question: 'Choose a shift',
        shifts: [{ label: 'AM', start_time: '08:00', end_time: '12:00', capacity: 1 }],
        resolved_release_at: '2020-01-01T00:00:00Z', close_at: '2099-01-01T00:00:00Z',
        resolved_confirmation_at: '2020-01-01T00:00:00Z', show_waiting_list: true,
      };
      const [created] = await tx`select create_scheduled_event(${tx.json(payload)},null) as id`;
      const [claim] = await tx`select * from claim_due_polls(1)`;
      assert.equal(claim.id, created.id);
      const [complete] = await tx`select complete_poll_send(${claim.id},${claim.claim_token},'VERIFY-POLL',99) as ok`;
      assert.equal(complete.ok, true);

      const response = (updateId, userId, options) => tx`select apply_poll_response(
        ${updateId},'VERIFY-POLL',${userId},null,'User',null,${`User ${userId}`},${options},
        ${tx.json({ update_id: updateId })},'PRIMARY') as accepted`;
      assert.equal((await response(900001, 101, [0]))[0].accepted, true);
      assert.equal((await response(900002, 102, [0]))[0].accepted, true);
      assert.equal((await response(900002, 102, [0]))[0].accepted, false);

      let participants = await tx`select telegram_user_id,status,confirmed_position,waiting_list_position
        from poll_participants order by telegram_user_id`;
      assert.deepEqual(participants.map((row) => [String(row.telegram_user_id), row.status]),
        [['101', 'confirmed'], ['102', 'waiting_list']]);

      assert.equal((await response(900003, 101, []))[0].accepted, true);
      participants = await tx`select telegram_user_id,status,confirmed_position,waiting_list_position
        from poll_participants order by telegram_user_id`;
      assert.equal(participants[1].status, 'confirmed');
      assert.equal(participants[1].confirmed_position, 1);
      const [privilege] = await tx`select has_table_privilege('anon','public.telegram_groups','select') as allowed`;
      assert.equal(privilege.allowed, false);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  } finally {
    await sql.end();
  }
  console.log('Supabase migration integration verification passed.');
}

verify().catch((error) => { console.error(error); process.exit(1); });
