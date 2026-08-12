# Production deployment

## Architecture

```mermaid
flowchart LR
  A[Admin browser] -->|Supabase access token| V[Vercel Express API]
  T[Telegram Bot API] -->|secret-token webhook| V
  C[Vercel Cron every 5 minutes] -->|CRON_SECRET| V
  V -->|SQL and transactional functions| S[Supabase PostgreSQL]
  V -->|sendPoll stopPoll editMessageText| T
  S --> R[Response history and allocation audit]
```

The static dashboard and Express API deploy as one Vercel project. Supabase
provides PostgreSQL and Auth. Production Telegram updates use one official bot
webhook at `/api/telegram/primary`. Optional WHCL/PSA bot tokens are supported
only when separate bot identities and permissions are an operational requirement.

## Prerequisites

- Node.js 24
- Supabase CLI and a Supabase project
- Vercel CLI/account and a plan that supports five-minute cron execution
- One BotFather bot added as an administrator in every managed Telegram group

The bot needs permission to send messages, send polls, edit its messages, and
manage its polls. Disable BotFather privacy mode so non-anonymous poll answers
are delivered. The bot token never belongs in browser configuration.

## Supabase

1. Link and back up production before migration:

   ```bash
   npx supabase login
   npx supabase link --project-ref <project-ref>
   npx supabase db dump --linked -f backup-before-202607120001.sql
   npx supabase db push --dry-run
   npx supabase db push
   ```

2. Create an Auth user in Supabase, then authorize it once in SQL Editor:

   ```sql
   insert into public.admin_users (auth_user_id, role)
   values ('<auth.users id>', 'admin');
   ```

3. Set Supabase Auth Site URL to the production Vercel URL and disable public
   signup. Preview and production should use separate Supabase projects.

The migration is [202607120001_production_schema.sql](supabase/migrations/202607120001_production_schema.sql).
It is additive and does not drop compatibility tables. It stores timestamps as
UTC `timestamptz`, enables RLS, and installs transactional allocation/claim RPCs.

### Rollback

Stop the Vercel cron and remove the webhook before rollback. Restore the backup
for the safest full rollback. The object-only rollback script is
`supabase/rollback/202607120001_production_schema.down.sql`; review it before
running because it deletes all data in the new production tables:

```bash
npm run delete-webhook
psql "$DATABASE_URL" -f supabase/rollback/202607120001_production_schema.down.sql
psql "$DATABASE_URL" -f backup-before-202607120001.sql
```

## Vercel

- Framework preset: Other
- Root directory: repository root
- Install command: `npm ci`
- Build command: `npm run build`
- Output directory: leave empty
- Runtime: Node.js 24.x
- Serverless entry: `api/index.js`
- Cron: `GET /api/cron/scheduler` daily at 00:00 UTC on Vercel Hobby. Configure
  an authenticated external five-minute scheduler or upgrade to Vercel Pro for
  timely release, close, and confirmation execution.

Set these for Production (and separate values for Preview):

| Variable | Required | Scope |
| --- | --- | --- |
| `TELEGRAM_TOKEN_WHCL` | yes (two-bot setup) | server only |
| `TELEGRAM_TOKEN_PSA` | yes (two-bot setup) | server only |
| `TELEGRAM_BOT_TOKEN` | **omit** in the two-bot setup (single-bot fallback only; if set, `set-webhook.js` registers only the PRIMARY webhook) | server only |
| `TELEGRAM_WEBHOOK_SECRET` | yes | server only |
| `SUPABASE_URL` | yes | server only |
| `SUPABASE_ANON_KEY` | yes | server only |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | server only |
| `DATABASE_URL` | yes | server only; Supabase pooler URL |
| `APP_URL` | yes | server/scripts |
| `CRON_SECRET` | yes | server only |
| `REQUIRE_ADMIN_AUTH` | yes, `true` | server only |
| `ENABLE_LEGACY_WORKFLOW` | yes, `false` | server only |

Do not expose the bot token, webhook secret, service-role key, database URL, or
cron secret. Deploy with `vercel --prod` after environment variables are set.

## Telegram webhook

Register after production deployment:

```bash
APP_URL=https://<project>.vercel.app \
TELEGRAM_TOKEN_WHCL=<wheelchair-token> \
TELEGRAM_TOKEN_PSA=<psa-token> \
TELEGRAM_WEBHOOK_SECRET=<secret> \
npm run set-webhook
```

Verify with Bot API `getWebhookInfo`. Remove without discarding pending updates:

```bash
TELEGRAM_TOKEN_WHCL=<wheelchair-token> TELEGRAM_TOKEN_PSA=<psa-token> npm run delete-webhook
```

## Verification

```bash
npm ci
npm run lint
npm test
npm run build
npx supabase start
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npm run verify:migration
```

After deploy, sign in, create the managed Telegram group using its numeric chat
ID, create a weekly default, rehearse its actual upcoming batch, and verify webhook delivery,
poll closure, allocation, confirmation send, withdrawal promotion, and message
editing in a non-production Telegram group before enabling operational use.

## Recovery notes

Claimed rows intentionally remain `sending` if a function crashes after Telegram
accepts a message but before the database records its ID. This prevents an
automatic duplicate. Reconcile the Telegram group and database manually before
resetting such a row to `failed`. The checked-in Hobby cron is once daily; use a
suitable Vercel plan or an authenticated external scheduler for timely jobs.
