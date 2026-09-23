// Verifies that the local production-data connection can read real data but
// that PostgreSQL has made the session read-only.
const postgres = require('postgres');

require('dotenv').config({ quiet: true });
require('dotenv').config({ path: '.env.readonly', override: true, quiet: true });

async function main() {
  if (process.env.LOCAL_READ_ONLY !== 'true' || !process.env.LOCAL_READONLY_DATABASE_URL) {
    throw new Error('Run "npm run setup:local-readonly" first.');
  }
  const sql = postgres(process.env.LOCAL_READONLY_DATABASE_URL, { ssl: 'require', max: 1 });
  try {
    await sql`set default_transaction_read_only = on`;
    const [row] = await sql`
      select current_setting('default_transaction_read_only') as transaction_read_only,
             (select count(*)::text from telegram_groups) as group_count,
             has_table_privilege(current_user, 'telegram_groups', 'INSERT') as has_insert_privilege`;
    if (row.transaction_read_only !== 'on') {
      throw new Error('PostgreSQL did not enable default_transaction_read_only.');
    }
    console.log(`Read-only connection verified: ${row.group_count} production groups visible; INSERT privilege: ${row.has_insert_privilege}.`);
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error('Local read-only verification failed:', error.message);
  process.exitCode = 1;
});
