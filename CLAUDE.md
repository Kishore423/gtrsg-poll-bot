# Gops poll project memory

Canonical shared memory for Claude Code and Codex. Codex uses `AGENTS.md` as its
adapter; keep both aligned when durable knowledge changes. **Two agents work on
this repo concurrently — update this file whenever architecture/behavior changes
so the other agent stays in sync.**

---

# 🚧 IN PROGRESS (2026-07-24): Multi-tenant rework — Claude Code owns this

**Approved plan:** `C:\Users\kirub\.claude\plans\authentication-using-each-sleepy-hollerith.md`
(read it first — it has the full design, decisions and verification steps).

### ⛔ File ownership while this is in flight

**Codex: please do NOT edit these files** until this rework lands — Claude Code is
mid-change and concurrent edits will clobber each other:

- `src/server.js`, `public/app.js`, `public/index.html`
- `src/auth.js`, `src/telegram.js`, `src/processUpdate.js`
- `src/db/memory.js`, `src/db/postgres.js`

Everything else (schedulers, pollBuilder, confirmation, scheduleRules, tests for
those) is free. If you must touch an owned file, note it here first.

**Codex note (2026-07-24):** touched owned Task 5 files to add UUID bot webhook
routing and token resolution while preserving legacy WHCL/PSA routes. Updated
`src/server.js`, `src/telegram.js`, `src/processUpdate.js`, both DB adapters,
webhook scripts, and focused tests.

**Codex note (2026-07-24):** also completed Tasks 6-8 on owned files per user
request: admin APIs/page, dashboard managed-group popup workflow, and
`scripts/migrate-to-multi-tenant.js`.

### Goal (one line)

One Telegram bot **per user**: admin maps a BotFather token to a user's email; that
user only sees the groups **their own bot** is in. Sign-in uses **Supabase email
OTP** checked against the `app_users` allow-list; roles are **admin | user**.

### Confirmed decisions

- Supabase Auth proves the caller controls an email inbox. The `app_users` email
  allow-list is therefore the **only** authorisation boundary: it must **fail
  closed** (no row ⇒ 403 "not provisioned"). OTP emails are only sent after the
  requested email is found enabled in `app_users`.
- Bot tokens: admin pastes BotFather token → **encrypted** in DB (never sent to browser).
- Admins see **all** groups/bots; an admin may have **no bot** (`bot_id` nullable).
- Bot name is **bidirectional**: UI edit → `setMyName` (shows in BotFather);
  BotFather rename → pulled back via `getMyName`. `bots.bot_name` is only ever a
  **cache of Telegram's value**, never an independent label. `@username` is
  BotFather-only (no API).
- Seed roster: `Malla_Sonia@gtr.com.sg` (user, @Pax_services_bot),
  `Yidan_Wang@sats.com.sg` (user, @Flexi_wheelchair_bot),
  `Kirubakaran_Kishore@sats.com.sg` (**admin**, no bot).
- Telegram **privacy mode stays ON**. Group auto-detect relies on `my_chat_member`
  (fires on bot-add regardless of privacy); `/start@<bot>` is the fallback.

### Progress

| # | Task | Status |
| --- | --- | --- |
| 1 | `src/crypto.js` token encryption | ✅ **done** (7 tests green) |
| 2 | `bots` + `app_users` schema & repo methods | ✅ **done** |
| 3 | Email OTP + `app_users` allow-list | ✅ **done** (9 tests green) |
| 4 | RBAC + per-user tenancy scoping | ✅ **done** (92 tests green) |
| 5 | Per-bot Telegram routing + name sync | ✅ **done** (94 tests green before Task 6-8) |
| 6 | Admin page (`/admin`) + admin APIs | ✅ **done** |
| 7 | Main UI → group-popup flow | ✅ **done** |
| 8 | Migration script + docs | ✅ **done** |

**Done so far (already on disk, 81 tests green):**
- `src/crypto.js` — AES-256-GCM `encryptToken`/`decryptToken`/`maskToken`/
  `generateWebhookSecret`, keyed by new env `BOT_TOKEN_ENC_KEY` (base64, 32 bytes).
  Tests in `test/crypto.test.js`.
- `supabase/migrations/202607240001_multi_tenant.sql` — `bots` + `app_users` tables,
  `telegram_groups.bot_ref uuid` FK, RLS.
- `bots`/`app_users` methods in **both** `src/db/memory.js` and `src/db/postgres.js`
  (`createBot`, `listBots`, `getBot`, `setBotName`, `deleteBot`, `createAppUser`,
  `listAppUsers`, `getAppUserByEmail`, `setAppUserAuthId`, `setAppUserRole`,
  `deleteAppUser`). `listTelegramGroups({ botId })` now takes an optional scope.
- `src/tenancy.js` — Task 4 tenant helpers: `scopeGroups(user)` and
  `assertGroupAccess(db, user, groupId)`, returning 404 for groups outside a
  non-admin user's bot. `src/server.js` applies this to managed groups, weekly
  schedules, skip dates, scheduled poll creation/list/details/actions/deletes.
- Task 5 backend routing: `src/telegram.js` can resolve bot tokens dynamically
  with `resolveToken(botId)` and exposes `getMyName` / `setMyName`; `src/app.js`
  decrypts DB-stored bot tokens for UUID bot keys. `src/server.js` accepts both
  legacy `/api/telegram/whcl|psa|primary` routes and new `/api/telegram/:botId`
  routes, validating UUID routes against `bots.webhook_secret`. Webhook group
  detection writes `telegram_groups.bot_ref` for UUID bots while keeping legacy
  `bot_id` fallback. `scripts/set-webhook.js` reads enabled DB bots, registers
  `/api/telegram/<bot id>`, and syncs `getMe()` / `getMyName()` into the bot
  cache.
- Task 6 admin UI/API: `/admin` serves `public/admin.html` / `public/admin.js`.
  Admins can create allow-list users, paste a BotFather token for user bots,
  enable/disable or delete users, list bots, and rename bots through Telegram
  `setMyName`. `/api/admin/*` is protected by `requireAdmin` when auth is on.
- Task 7 dashboard flow: managed groups are auto-detected by webhook updates and
  rendered as clickable rows. Each row still has **Verify bot** and delete
  actions; clicking the row opens a popup with **Weekly default template**,
  **Skip days**, **Custom poll**, and **Send test poll** actions. The template,
  skip-days, and one-off poll cards stay hidden until a group workflow is chosen.
- Task 8 migration: `npm run migrate:multi-tenant` creates/reuses WHCL and PSA
  bot records from `TELEGRAM_TOKEN_WHCL` / `TELEGRAM_TOKEN_PSA`, assigns legacy
  `telegram_groups.bot_id` service rows to `bot_ref`, and upserts the seed
  `app_users` roster. It requires `DATABASE_URL` and stable `BOT_TOKEN_ENC_KEY`.

**⚠️ Key migration decision — expand/contract, no flag day.** `bot_id` is read inside
`claim_due_polls`, `claim_due_confirmations` and `apply_scheduled_poll_response`, so
its type was **not** changed in place. Instead `telegram_groups.bot_ref` (uuid FK) was
added alongside the legacy text `bot_id`, and the claim functions now return
`coalesce(g.bot_ref::text, g.bot_id)`. **Both models work simultaneously** — the live
WHCL/PSA bots keep running until `scripts/migrate-to-multi-tenant.js` backfills
`bot_ref`. Do not "tidy" this by dropping `bot_id` before that backfill runs.

**Task 3 (done) — what changed, so nothing gets "fixed" back:**
- `src/auth.js` rewritten: `verifyAdmin` → **`verifyUser`** (looks up `app_users` by
  email from the Supabase JWT, backfills `auth_user_id`, returns
  `{id,email,role,bot_id}`); `adminAuth` → **`requireUser`** / **`requireAdmin`**.
  Password `signIn` **removed** — SSO only. Tests: `test/auth.test.js`.
- Denial codes are deliberate: **403 "not provisioned"** (valid Supabase login, not on
  the allow-list) vs **401** (no/invalid token). The UI must not bounce a 403 back to
  the login button — that would loop forever; it shows "ask an admin" instead.
- `src/server.js`: `/api/auth/sign-in` removed, **`/api/auth/send-otp`** and
  **`/api/auth/verify-otp`** added for email OTP login, **`GET /api/me`** added (returns
  email/role/bot_id), and the global gate now routes `/api/admin/*` through
  `requireAdmin` and everything else through `requireUser`.
- `src/app.js`: passes `db` into `createSupabaseAuth` (the allow-list lookup needs it)
  and `verifyUser` into server options.
- `public/`: password/Microsoft sign-in forms replaced by an email OTP flow.
  The session returned by `/api/auth/verify-otp` is stored in session storage.
  Elements marked
  `data-admin-only` are unhidden only when `/api/me` says `role === 'admin'`.
  Supabase sends a numeric code only when the **Magic Link / OTP** email template
  contains `{{ .Token }}`; a template with only `{{ .ConfirmationURL }}` sends a
  link instead. Repeat send requests can hit Supabase's built-in email rate limit
  (default 60 seconds).

### If picking this up cold, do task 6 next

Task 5 backend plumbing is done. Next: admin page (`/admin`) and admin APIs for
creating app users/bots, validating pasted BotFather tokens, registering the
new bot webhook, and exposing explicit bot rename through `setMyName`.

---

## Purpose

Node.js (CommonJS) service that runs GTRSG wheelchair (`WHCL`) and passenger
service associate (`PSA`) shift-slot **Telegram** polls: schedules/sends polls,
records votes via webhook, and posts first-come-first-served confirmations.
Deployed on **Vercel** (serverless) with **Supabase** for Postgres + admin auth.

> History: WhatsApp/Baileys (removed) → Telegram on Vercel with Vercel-Postgres
> (Claude) → **Supabase DB + Supabase Auth + a managed production workflow**
> (Codex, current). Ignore obsolete WhatsApp/Baileys/Vercel-Postgres/Neon/
> Basic-Auth references anywhere in history.

## Two workflows (important)

The app currently ships BOTH, selected at runtime:

- **Managed workflow = production** (Codex). Admin dashboard (Supabase Auth) to
  schedule polls with precise timezone release/close/confirmation times, sent by
  cron with claim-token concurrency safety, edit-in-place confirmations, waiting
  lists, and poll closures. Modules: `src/productionScheduler.js` (including
  `generateScheduledPollsFromTemplates` and `sendScheduledPollImmediately`),
  `src/scheduleResolver.js`,
  `buildManagedConfirmationMessage`, and the
  `claim*/complete*/fail*` + `getAllocation` repo methods.
- **Legacy workflow = the original slot UI** (Claude). Add-slot / send-poll /
  results / confirm endpoints. Gated by `enableLegacyWorkflow`: ON only for
  `DB_DRIVER=memory`, `ENABLE_LEGACY_WORKFLOW=true`, or unconfigured Vercel
  preview. When OFF its `/api/slots|polls|...` endpoints return HTTP 410.

## Architecture

- **Bots**: a `PRIMARY` bot (`TELEGRAM_BOT_TOKEN`) plus optional per-service
  `TELEGRAM_TOKEN_WHCL` / `TELEGRAM_TOKEN_PSA` (fall back to PRIMARY). The two
  service bots are live: WHCL = @Flexi_wheelchair_bot (id 8632673727),
  PSA = @Pax_services_bot (id 8764384354). Tokens live only in `.env` /
  Vercel env — never commit them.
- **Webhook, not polling**: Telegram → `POST /api/telegram/:service`
  (`src/server.js` → `src/processUpdate.js`). Authenticated by the
  `X-Telegram-Bot-Api-Secret-Token` header (`TELEGRAM_WEBHOOK_SECRET`).
  Updates are de-duplicated (`beginWebhookEvent`/`finishWebhookEvent`). Any
  configured webhook bot route (`PRIMARY`, `WHCL`, `PSA`) auto-captures a
  managed Telegram group from bot membership updates or received group
  messages/commands, upserting the row by `(telegram_chat_id, bot_id)`. WHCL/PSA
  also update the legacy target table; PRIMARY is stored as a general managed
  group (`service=null`, `bot_id='PRIMARY'`). One bot can be mapped to multiple
  managed groups because each distinct `(telegram_chat_id, bot_id)` gets its own
  row and templates/polls are scoped by `telegram_group_id`. `src/telegramUpdates.js`
  parses updates; `src/telegram.js` is the Bot API client (sendPoll,
  sendMessage, editMessage, stopPoll, setWebhook).
  Dashboard group labels show service routes as `PSA bot`, `Wheelchair bot`, or
  `General bot`; if the Telegram group title already contains `(PSA)` or
  `(wheelchair)`, the UI rewrites that suffix to include `bot` instead of
  appending a duplicate service label.
- **Data layer**: repository with two implementations sharing one async
  interface — `src/db/postgres.js` (Supabase Postgres via the `postgres` lib,
  `DATABASE_URL`) and `src/db/memory.js` (tests + local). `scripts/migrate.js`
  creates the schema; `scripts/verify-migration.js` checks it. `pollBuilder.js`
  and `confirmation.js` are pure.
- **Auth**: `src/auth.js` (Supabase). Users sign in with email OTP via Supabase
  Auth, then `verifyUser` looks up the normalized email in `app_users`.
  `requireAdmin` gates `/api/admin/*`; `requireUser` gates the rest of `/api/*`
  except `/api/auth/*`, `/api/telegram/*`, `/api/cron/*`. The `app_users`
  allow-list must fail closed.
- **Vercel**: `vercel.json` uses explicit `builds` (not zero-config rewrites) to avoid Vercel
  auto-discovering `src/server.js` as a function. Only `api/index.js` is the serverless entry;
  `public/**` is served as static. Routes: `/api/*` → function, static assets → `public/`, all
  else → function (Express catches and serves via the root handler). `src/localServer.js` is
  local `npm start` only. Cron hits `/api/cron/*` (Bearer `CRON_SECRET`). Unconfigured Vercel
  (no creds) boots a memory-DB demo preview with the legacy workflow enabled.
 
## Critical constraints

- Never commit `.env`/`.env.local`, bot tokens, `DATABASE_URL`, or Supabase keys.
- Keep `WHCL`/`PSA` routing separate end to end.
- **Supervisor scheduling requirements implemented (2026-07-13):** default poll
  release is Wednesday 17:00 SGT. Legacy weekly sending releases WHCL slots for
  the following Monday-Sunday week and PSA slots for the following two
  Monday-Sunday weeks. Managed poll creation uses service-specific timing from
  `src/scheduleRules.js`: PSA cuts off Friday 08:00 SGT and confirms Friday
  12:00 SGT; WHCL cuts off 1 day before the event date at 08:00 SGT and, because
  no separate WHCL confirmation time was specified, confirms at the same 08:00
  cutoff. Vercel Hobby only allows daily cron, so `vercel.json` currently runs
  `/api/cron/scheduler` once daily; exact Wednesday 17:00 / Friday 12:00 delivery
  needs either Vercel Pro hourly cron, an external scheduler, or manual trigger.
  The managed scheduler now auto-generates missing default polls from each saved
  group template only on its configured local release weekday after the release
  time; it does not backfill a missed/deleted batch on later days. It skips dates
  that already have active polls; admins should not manually create release batches.
  Each Telegram group has persistent event-date exclusions in
  `poll_release_exclusions`. The template UI's **Skip event dates** control adds
  these before release, and the generator never creates polls for excluded dates.
  Adding an exclusion also removes an existing unsent default poll for that date;
  already-open polls remain because an exclusion cannot retract a sent Telegram
  poll. Removing an exclusion allows generation again while that batch is current.
  Generated default polls preserve the batch release date for every event date in
  the batch, so WHCL day-before cutoffs cannot fall before the release time.
  Due default polls are claimed and sent by event date first, then release time,
  so a same-release batch is delivered earliest-date to latest-date. The
  Postgres repository waits for startup SQL patches before claim operations, and
  `runScheduledPolls` also sorts claimed rows in application code before sending
  so production send order does not depend only on the database function return
  order.
- Allocation is capacity-bound, strictly first-come-first-served by vote arrival
  (`voted_at_ms`); a voter's original arrival survives edits; a retraction (empty
  `option_ids`) removes them.
- Confirmations auto-send 08:00 SGT the day before the slot/event date
  (`CONFIRMATION_HOUR`, default 8). Managed confirmations include a service title
  (`Wheelchair` or `PSA`) and event date in the header, and only confirmed
  participants; waiting-list and unfilled slot rows are intentionally omitted.
  Managed confirmations are set to 1 day before the event date at 8:00 AM SGT,
  and weekly schedules store a template of
  event shifts that are automatically pre-populated on the poll editor card. Start and end
  time inputs use compact custom 24-hour scroll-wheel pickers (drum selectors)
  in separate responsive grid fields for space efficiency and consistent
  formatting across all client browsers and operating systems.
- Telegram needs ≥2 poll options; single-option days get a `Not available`
  filler (ignored in results/votes). Confirmation messages are Telegram HTML with
  `tg://user?id=…` mentions; escape all user-supplied names.
- Poll sending is idempotent (legacy `sent_at`; managed claim tokens).
- Isolated Testing card: allows sending test polls immediately. These are tagged with
  `operational_tags = ['test']` (Test mode), which bypasses duplicate check blocks,
  avoids deleting or overwriting default weekly schedules, does not delete existing
  scheduled/custom polls for the same group/date, and does not block scheduled sends
  or automatic default-poll generation for that date.
  The Home page template test-poll control sends the entire current release batch
  for the selected group's saved template (WHCL 7 polls, PSA 14 polls), not a
  single event-date poll. Its optional release date field overrides the batch
  release date; when blank it uses the latest configured release day/time that has
  already happened in Asia/Singapore. Test-batch sends are sorted earliest event
  date to latest event date and paced with a short delay between Telegram sends;
  partial failures are reported per event date. It also has a test-only
  confirmation delay input; it overrides `confirmation_at` to `now + N minutes`
  for every test poll in the batch so confirmation text can be smoke-tested
  shortly after release.
  This before-close confirmation override is allowed only when `is_test=true`;
  normal polls still confirm after the configured close/cutoff timing. The
  dashboard triggers only those test polls' confirmations after the delay while
  the page remains open, so old due confirmations are not flushed by a smoke
  test; otherwise delivery still depends on the configured cron/external
  scheduler. Successful test-poll sends show a browser alert: "poll sent, please
  check telegram".
- Confirmation delivery is service-specific: PSA due confirmations are grouped
  into one Telegram message per group/resolved confirmation time, with each event
  date and its confirmed timeslots listed in date order. Wheelchair confirmations
  intentionally remain one Telegram confirmation message per poll/event date.
- Production requires `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
  `SUPABASE_SERVICE_ROLE_KEY`, `TELEGRAM_WEBHOOK_SECRET`, `CRON_SECRET`
  (`src/app.js` throws otherwise).
- Manual human steps: create the BotFather bots (done — tokens provided),
  provision Supabase, set env vars, deploy on Vercel, add each bot to its group.
- After every code change, review `CLAUDE.md` and `AGENTS.md` and update both.
 
## Deployment (Vercel + Supabase) — current runbook

UAT target: `https://gtrsg-poll-bhqx4qvy5-kishores-projects-ecc05d96.vercel.app`
Prod target: `https://gtrsg-poll-bot.vercel.app`
Supabase project ref `flbcgncbwoavqtrlpnfq`. **No secrets in this file** — tokens/keys
live only in Vercel env + the local (gitignored) `.env`.

- **Two-bot env config (decided)**: set `TELEGRAM_TOKEN_WHCL` and `TELEGRAM_TOKEN_PSA`;
  **omit `TELEGRAM_BOT_TOKEN`**. `set-webhook.js` registers every explicitly
  configured bot and rejects duplicate token values so one bot cannot be assigned
  multiple webhook URLs.
- `TELEGRAM_BOT_USERNAME` is unused and omitted from configuration.
- Prod-required env (`src/app.js` throws otherwise): `SUPABASE_URL`,
  `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `TELEGRAM_WEBHOOK_SECRET`,
  `CRON_SECRET`, `DATABASE_URL`, and stable `BOT_TOKEN_ENC_KEY`.
  `NEXT_PUBLIC_SUPABASE_*` optional (falls back to `SUPABASE_*`). Legacy
  WHCL/PSA routes share `TELEGRAM_WEBHOOK_SECRET`; UUID bot routes use each
  bot row's `webhook_secret`.
- **DATABASE_URL uses the Supabase SESSION pooler (port 5432).** `src/db/postgres.js`
  relies on prepared statements (`postgres(url,{ssl:'require',max:5,idle_timeout:20})`,
  no `prepare:false`), which require session mode. Do NOT switch to the transaction
  pooler (port 6543) unless `prepare:false` is added first — it would throw
  prepared-statement errors.
- **Schema**: `npm run migrate` is intentionally disabled (errors, telling you to use
  the CLI). Apply with `npx supabase db push`; migration is
  `supabase/migrations/202607120001_production_schema.sql`.
- **Admin bootstrap (or the dashboard is locked out)**: `REQUIRE_ADMIN_AUTH=true`
  and an enabled admin row in `app_users`. `npm run migrate:multi-tenant`
  upserts `Kirubakaran_Kishore@sats.com.sg` as `role='admin'`; otherwise insert
  an enabled `app_users` admin row manually before turning auth on.
- `telegram_groups.bot_id` defaults to `'PRIMARY'`; in the dashboard assign each group
  `WHCL`/`PSA` so it uses the right bot token.
  Deleting a Telegram group from the app reassigns that group's managed weekly
  template plus related events, scheduled polls, and confirmations to the newest
  enabled replacement group on the same service route before deleting the old row.
  If there is no replacement, deletion returns a 409 because poll data must be
  moved rather than removed.
- The dashboard **Verify bot** endpoint resolves a group as `service` first when
  it is `WHCL`/`PSA`, then `bot_id`, then `PRIMARY`, so older rows with
  `service='WHCL'` and stale `bot_id='PRIMARY'` still verify with the wheelchair
  token. Actual scheduled sends still use `telegram_groups.bot_id` in the DB
  claim functions, so production rows should still have the correct `bot_id`.
- **Deploy order**: (1) `npx supabase db push`; (2) set Vercel env including
  `BOT_TOKEN_ENC_KEY`; (3) Vercel redeploy (env vars apply only to new
  deployments); (4) run `npm run migrate:multi-tenant`; (5) verify email OTP
  login loads the dashboard/admin page; (6) run `npm run set-webhook` locally
  ONLY after the redeploy is live (Telegram must hit a deployment that has the
  secret + DB); (7) add each user's bot to its group as admin.
- **Footgun**: never run `npm run dev-telegram` after webhooks are live — it calls
  `deleteWebhook` and long-polls, wiping the production webhooks. Re-run `set-webhook`
  to restore.

### Live-DB findings (2026-07-12, verified by querying the session pooler)

- `telegram_groups`: one physical group "Gtr poll" (`-1004496348175`) registered twice —
  `bot_id=WHCL` and `bot_id=PSA`, both enabled. Correct config; routing was NOT the bug.
- **"Send immediately" root cause**: the dashboard's immediate-send path
  (`sendPollNow` in `public/app.js`) REQUIRES the selected group to have an
  enabled `weekly_poll_schedules` row (it derives confirmation/close times from it) and
  returns an error before POSTing otherwise. Only the PSA group had a schedule; the
  WHCL group had none → zero rows in `events`/`scheduled_polls` (nothing in
  `last_error`). **Fixed at the time:** WHCL was given the same enabled Friday
  17:00 release / Saturday 12:00 confirmation schedule as PSA. This live default
  predates the 2026-07-13 supervisor requirement and should be changed in
  production data to Wednesday 17:00 if the row still exists.
- The poll editor has one form-level **Send immediately** action beside **Review and
  schedule**. It sends all shift rows currently in the form; shift rows only have a
  Remove action.
- Production deploy `dpl_CE7ZSmWgmjg3BhwPQKQgKTmM3NDk` was promoted on
  2026-07-14 and aliased to `https://gtrsg-poll-bot.vercel.app`.
- The managed dashboard now includes a Release rules summary, a renamed **Group
  release template** section with service-specific timing previews, and a **Create
  one-off poll** section with inline timing preview. Default release batches are
  generated by the backend scheduler from saved templates, not manually from the UI.
  The Home page has a managed status area outside the legacy workflow so
  Verify bot and test poll actions show visible feedback in production.
- The Polls page **Details** action renders an in-page modal instead of a browser
  alert, and all generated poll action buttons are explicit `type="button"` to
  avoid accidental form submission/reload behavior. The Polls page table is
  intentionally ordered by event date ascending (earliest first, latest last),
  both from `listScheduledPolls()` and in the frontend before rendering/filtering.
  The filter bar filters by event date, Telegram group, and poll type (`test`,
  `custom`, `batch_default`); it intentionally does not include status or bot
  type filters because the Telegram group selection already identifies the group
  context.
  The Polls page is a monitoring surface and intentionally exposes no bulk
  **Clear all polls** or individual **Remove** controls. Default polls are
  omitted through the template's persistent **Skip event dates** mechanism,
  rather than deleted and recreated by the scheduler. Protected backend deletion
  endpoints remain available for maintenance and accept `CLEAR_POLLS_PASSWORD`
  only; `CRON_SECRET` must not be accepted as a fallback.
- The Home page weekly template form uses a dedicated vertical layout for release
  controls, shift rows, and Add/Save actions. Do not rely on the global `form`
  grid for this section; it causes the time wheel pickers and action buttons to
  overlap at production widths. A Telegram poll preview sits below the horizontal
  divider and above the **Test template poll** heading/input controls at the
  bottom of section 1; `ensureTemplatePreviewPlacement()` also enforces that DOM
  order at runtime. The preview shows the generated question and option labels from current shift
  edits, or from the saved weekly default after **Save default**. The save handler intentionally keeps the edited release
  controls and shift rows visible after a successful save; do not reset the form
  back to a blank template row. The template timing description is driven by the
  currently selected release day/time controls, even when a saved schedule already
  exists for the group. After weekly schedules load or save, the weekly shift
  editor, release day, and release time are rebuilt from the selected Telegram
  group's saved template so each bot/group can keep different default slots and
  release timing. The Telegram poll preview reflects the latest persisted defaults. The save flow patches the
  local schedule cache from the PUT response plus the exact submitted release
  timing and shift rows before refreshing the schedule list, so the preview must
  not snap back to an older GET result after saving. Generated
  shift labels in the preview/save path are recomputed from the live start/end
  time controls (`HHMM-HHMM`) and written back into the label input on picker
  input/change events; only non-time-range label text is treated as a true custom
  label.
- One-off/custom poll creation, including **Send test poll**, can use default
  Wednesday 17:00 release timing when a group has no saved weekly template. The
  one-off editor starts from the selected group's saved default template shifts
  and refreshes after template saves, group changes, and one-off form resets so
  admins only edit exceptions. The `send-now` action returns
  success directly after `sendScheduledPollImmediately`; do not run a second
  scheduled-state transition after the poll is already open. Backend immediate
  sends also synthesize `specific_release_at=now` when no weekly/specific release
  schedule is present.
- **Auth is intentionally OFF on the live deployment**: production Vercel sets
  `REQUIRE_ADMIN_AUTH=false`, so `/api/auth-config` returns `required:false` and
  management APIs are publicly accessible. This was explicitly requested on 2026-07-13.
  The earlier deployment also answered 200 unauthenticated (it predated
  the `REQUIRE_ADMIN_AUTH=true` env var). `admin_users` had 0 rows — seed an admin
  BEFORE redeploying or the dashboard locks out.
- `webhook_events` had traffic (20 rows) → both bots' production webhooks are
  registered and delivering.
- PSA group's observed weekly schedule at the time: release Fri 17:00,
  confirmation Sat 12:00, Asia/Singapore. This is historical state and should be
  changed in production data to Wednesday 17:00; the application now derives PSA
  cutoff/confirmation as Friday 08:00/12:00 when creating managed polls.
- **Current deployment handoff:** all required Production variables are now set in
  Vercel. Do not redeploy until a Supabase Auth user exists and its enabled
  `admin_users` row is seeded; `auth.users` was still empty at the last check.

## Commands

- `npm install` — install deps (Node 24.x).
- `npm test` — Node test suite (47 tests; no DB/bots needed).
- `DB_DRIVER=memory npm start` — local server, memory DB, legacy workflow on.
- `npm run dev-telegram` — local long-polling harness to test the real WHCL/PSA
  bots end to end (memory DB; deletes webhooks; resets on restart).
- `node scripts/dev-ui-preview.js` — seeded UI preview on port 4322.
- `npm run check` (= build/lint), `npm run migrate`, `npm run verify:migration`,
  `npm run set-webhook`, `npm run delete-webhook`.

## Map

`src/`: telegram, telegramUpdates, processUpdate, db/{memory,postgres}, auth,
pollBuilder, confirmation, scheduler (legacy), scheduleResolver +
productionScheduler (managed), server, app, localServer. `public/` UI,
`api/index.js` Vercel entry, `vercel.json`, `scripts/`, `test/` (7 suites).
