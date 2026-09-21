// Read a bounded production snapshot without running repository startup migrations.
const postgres = require('postgres');

async function loadPreviewRoster() {
  require('dotenv').config({ quiet: true });
  if (!process.env.DATABASE_URL) {
    throw new Error('Actual-roster preview requires DATABASE_URL in your local .env file.');
  }
  const sql = postgres(process.env.DATABASE_URL, {
    ssl: 'require', max: 1, connect_timeout: 10,
  });
  try {
    return await sql.begin('read only', async (tx) => {
      const groups = await tx`select id,group_name,telegram_chat_id::text,service,
        coalesce(bot_ref::text,bot_id) as bot_id from telegram_groups
        where lower(group_name)=lower(${process.env.PREVIEW_GROUP_NAME || '8B_KR_NX Flexi'})`;
      if (!groups.length) throw new Error('Preview group not found. Set PREVIEW_GROUP_NAME to its exact Telegram group name.');
      const polls = await tx`select sp.id,sp.event_id,sp.telegram_group_id,sp.status,
        e.event_date::text,g.group_name,coalesce(g.bot_ref::text,g.bot_id) as bot_id,
        cm.status as confirmation_status
        from scheduled_polls sp join events e on e.id=sp.event_id
        join telegram_groups g on g.id=sp.telegram_group_id
        left join confirmation_messages cm on cm.scheduled_poll_id=sp.id
        left join weekly_poll_schedules w on w.id=sp.weekly_schedule_id
        where sp.telegram_group_id in ${tx(groups.map((g) => g.id))}
          and e.event_date between '2026-09-21'::date and '2026-09-27'::date
          and not ('reset-for-production'=any(e.operational_tags) and
            sp.telegram_poll_id is null and sp.status='scheduled')
          and (w.id is null or not w.testing_mode or
            ('template-testing:' || w.testing_batch_id::text)=any(e.operational_tags))
        order by e.event_date,sp.resolved_release_at,sp.created_at`;
      if (!polls.length) throw new Error('No actual polls found for 21–27 September 2026.');
      const allocations = {};
      for (const eventId of new Set(polls.map((p) => p.event_id))) {
        allocations[eventId] = await tx`select s.label,s.display_order,p.status,p.confirmed_position,
          u.telegram_user_id::text,u.telegram_username,u.display_name
          from event_shifts s join poll_participants p on p.shift_id=s.id and p.current_response
          join telegram_users u on u.telegram_user_id=p.telegram_user_id
          where s.event_id=${eventId}::uuid and p.status='confirmed'
          order by s.display_order,p.confirmed_position`;
      }
      return { groups, polls, allocations };
    });
  } finally {
    await sql.end();
  }
}

module.exports = { loadPreviewRoster };
