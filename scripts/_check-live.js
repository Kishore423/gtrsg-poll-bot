// TEMP read-only check. Delete after use.
require('dotenv').config();
const postgres = require('postgres');
const sql = postgres(process.env.DATABASE_URL, { ssl: 'require', max: 2, idle_timeout: 5 });

(async () => {
  try {
    const tables = await sql`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_name in ('app_users','bots','admin_users','telegram_groups')
      order by table_name`;
    console.log('relevant tables present:', tables.map((t) => t.table_name).join(', ') || '(none)');

    const cols = await sql`
      select column_name from information_schema.columns
      where table_schema='public' and table_name='telegram_groups' and column_name in ('bot_id','bot_ref')`;
    console.log('telegram_groups columns:', cols.map((c) => c.column_name).join(', ') || '(none)');

    const admins = await sql`select count(*)::int as n from admin_users`;
    console.log('admin_users rows:', admins[0].n);
  } catch (e) {
    console.error('ERROR:', e.message);
  } finally {
    await sql.end();
  }
})();
