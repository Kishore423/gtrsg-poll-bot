require('dotenv').config({ path: process.env.ENV_FILE || '.env' });

const { createSql } = require('../src/db/postgres');

const JOB_NAME = 'gtrsg-minute-scheduler';
const URL_SECRET_NAME = 'gtrsg_scheduler_url';
const AUTH_SECRET_NAME = 'gtrsg_cron_secret';

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function upsertVaultSecret(sql, name, value, description) {
  const [existing] = await sql`select id from vault.secrets where name=${name}`;
  if (existing) {
    await sql`select vault.update_secret(${existing.id}::uuid,${value},${name},${description},${null}::uuid)`;
    return existing.id;
  }
  const [created] = await sql`
    select vault.create_secret(${value},${name},${description},${null}::uuid) as id`;
  return created.id;
}

async function setupScheduler({
  connectionString = required('DATABASE_URL'),
  cronSecret = required('CRON_SECRET'),
  appUrl = String(process.env.APP_URL || 'https://gtrsg-poll-bot.vercel.app').replace(/\/$/, ''),
} = {}) {
  const sql = createSql(connectionString);
  try {
    await sql`create extension if not exists pg_cron`;
    await sql`create extension if not exists pg_net with schema extensions`;

    await upsertVaultSecret(sql, URL_SECRET_NAME, appUrl, 'Telegram Poll Manager production URL');
    await upsertVaultSecret(sql, AUTH_SECRET_NAME, cronSecret, 'Telegram Poll Manager cron bearer secret');

    const command = `
      select net.http_post(
        url := (select decrypted_secret from vault.decrypted_secrets where name = '${URL_SECRET_NAME}') || '/api/cron/scheduler',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = '${AUTH_SECRET_NAME}')
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 50000
      );`;
    const [job] = await sql`select cron.schedule(${JOB_NAME},'* * * * *',${command}) as job_id`;
    return { jobId: job.job_id, jobName: JOB_NAME, schedule: '* * * * *', appUrl };
  } finally {
    await sql.end();
  }
}

if (require.main === module) {
  setupScheduler()
    .then((result) => {
      process.stdout.write(
        `Supabase scheduler ready: ${result.jobName} (${result.schedule}) -> ${result.appUrl}\n`
      );
    })
    .catch((error) => {
      process.stderr.write(`Scheduler setup failed: ${error.message}\n`);
      process.exitCode = 1;
    });
}

module.exports = { setupScheduler, upsertVaultSecret };
