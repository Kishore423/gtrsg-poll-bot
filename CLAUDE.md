# Gops poll project memory

Canonical shared memory for Claude Code and Codex. Codex uses `AGENTS.md` as its
adapter; keep both aligned when durable knowledge changes. **Two agents work on
this repo concurrently — update this file whenever architecture/behavior changes
so the other agent stays in sync.**

---

# ✅ COMPLETE (2026-07-24): Multi-tenant rework

**Approved plan:** `C:\Users\kirub\.claude\plans\authentication-using-each-sleepy-hollerith.md`
(historical design reference).

### Goal (one line)

At most one Telegram bot **per user**: admin can map a BotFather token to a
Telegram identity during provisioning or leave it blank and assign the bot later;
that user only sees the groups **their own bot** is in. Sign-in uses a short-lived
Telegram bot OTP and a signed application session; roles are **admin | user**.

### Confirmed decisions

- The immutable Telegram user ID is the identity and authorization key. A valid
  Telegram OTP grants nothing unless an enabled `app_users` row exists for that
  ID. Unknown identities receive a generic response but no OTP or session.
- Bot tokens: admin pastes BotFather token → **encrypted** in DB (never sent to browser).
- Admins see **all** groups/bots; an admin may have **no bot** (`bot_id` nullable).
- Bot name and handle are Telegram-owned and read-only in the website. The Admin
  roster refreshes assigned bots through `getMyName` and `getMe` using the
  explicit, non-cacheable `POST /api/admin/telegram-identities/refresh` action.
  Normal `GET /api/admin/users` roster loads use stored values. `bots.bot_name` and
  `bots.telegram_username` are caches only. Website rename APIs fail closed;
  admins make identity changes in Telegram/BotFather and then refresh.
- `app_users.telegram_username` is the person's login handle, while
  `bots.telegram_username` is the assigned bot handle. Repository and API
  results keep these fields separate so the bot handle never replaces the user
  handle in the Admin edit form.
- User handles are Telegram-owned and read-only after provisioning. Login_bot
  refreshes a bound user's handle by immutable Telegram ID on `/start`, OTP
  requests, and the explicit Admin refresh action. The Admin form may manage the person's
  display label, role, enabled state, and dedicated bot mapping, but cannot
  overwrite either the user handle or the bot identity. Telegram-provided handle
  casing is preserved; lookups and uniqueness remain case-insensitive.
- Pending users and admins are enrolled only when the handle from Login_bot's
  private `/start` update matches the handle entered by the admin. A mismatch
  leaves `telegram_user_id` unbound, sends generic correction guidance through
  Login_bot, and remains **Awaiting Login_bot handle verification** in Admin.
  A successful match binds the immutable ID and shows **Verified by Login_bot**.
- `app_users.login_bot_verified_at`, not `telegram_user_id`, is the authoritative
  Login_bot enrollment state. Legacy migration IDs were observed through polling
  bots and remain unverified. A matching private Login_bot `/start` sets the
  timestamp; OTP delivery, session issuance, and the Admin verified label all
  require it. The schema migration only backfills users with a previously
  successful Login_bot OTP delivery.
- Telegram can only refresh a private user's handle through Login_bot after that
  user has opened the bot. The Admin roster treats Telegram's `chat not found`
  response as an unavailable refresh, retains the cached handle, and prompts the
  user to press Start; genuine user or bot API failures remain errors.
- Admins may replace a user's assigned bot by entering a different BotFather
  token in Edit. Add user and Save changes automatically read the exact
  Telegram-owned bot name, handle, and immutable ID before assignment; there is
  no separate verification action. The new bot is validated and its webhook is
  registered with that same token before the single `app_users.bot_id` mapping
  changes. Failed webhook registration or user assignment rolls back the new
  webhook and database row so a retry is not blocked by a stale mapping. The
  previous bot and its managed groups are disabled, its webhook is removed, and
  historical records remain intact.
  A Telegram bot ID already registered in the application cannot be duplicated.
  Postgres enforces this invariant with the partial unique index
  `bots_telegram_bot_id_key`; the memory repository mirrors it for tests, and
  duplicate BotFather-token assignment returns HTTP 409.
- Seed roster: `@sonia_mala` (user, @Pax_services_bot),
  `@Y6yyyyyyyyyyuu` (user, no bot), `@ht1193` / Howell
  (user, @Flexi_wheelchair_bot), and `@kishorek888` (**admin**, no bot).
- Telegram **privacy mode stays ON**. Group auto-detect relies on `my_chat_member`
  (fires on bot-add regardless of privacy); `/start@<bot>` is the fallback.

### Progress

| # | Task | Status |
| --- | --- | --- |
| 1 | `src/crypto.js` token encryption | ✅ **done** (7 tests green) |
| 2 | `bots` + `app_users` schema & repo methods | ✅ **done** |
| 3 | Telegram sign-in + `app_users` allow-list | ✅ **done** |
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
  `listAppUsers`, `getAppUserByTelegramId`, `setAppUserTelegramIdentity`,
  `setAppUserRole`, `deleteAppUser`). `listTelegramGroups({ botId })` now takes
  an optional scope.
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
  Admins can create allow-list users with or without a bot, paste a BotFather
  token during creation or later from Edit, enable/disable or delete users, and
  refresh read-only bot names/handles from Telegram. `/api/admin/*` is protected
  by `requireAdmin` when auth is on.
- Task 7 dashboard flow: managed groups are auto-detected by webhook updates and
  rendered as clickable rows. Each row keeps **Verify bot** but has no manual
  delete action; Telegram membership removal disables and hides the row
  automatically. Clicking the row opens a popup with **Weekly default template**,
  **Skip days**, and **Custom poll** actions. The template, skip-days, and
  one-off poll cards stay hidden until a group workflow is chosen. Those workflow
  cards bind to the clicked group without showing another Telegram-group
  dropdown. Test-poll actions remain inside the weekly template and one-off poll
  sections. The group popup presents all three workflows as full-width command
  rows with Lucide icons, concise supporting text, and consistent depth states.
  Home, Polls, and Admin share `public/theme.css` / `public/theme.js`: the visual
  system uses restrained perspective, layered shadows, inset controls, elevated
  navigation, and reduced-motion fallbacks without changing application behavior.
  Dynamic icon hydration must target only non-SVG `[data-lucide]` placeholders;
  generated Lucide SVGs retain that attribute and must not retrigger hydration.
  Viewport dialog backdrops are direct children of `body`, after `main`; nesting
  them inside the animated `main` constrains fixed positioning to the content box.
  Admins first search the Admin roster by display name; selecting one user scopes
  group rows and managed schedules to that user's single `bot_id`. Home reloads
  that non-cached roster on bootstrap, browser restore, and window focus so bot
  assignments changed in Admin propagate to an already-open Home page. The
  selected-user summary and empty state name the assigned bot and handle. Verification
  succeeds only after Telegram accepts a test message sent by that bot to the
  exact selected group. Bot removal membership updates disable the matching
  `(Telegram chat, bot)` row, so managed lists contain current memberships only;
  a later add or group message re-enables the same row. Admin user selection also
  refreshes that bot's saved memberships against Telegram to retire stale rows
  whose removal webhook predates this behavior.
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
- `src/telegramAuth.js` accepts an approved Telegram handle, then sends a
  six-digit OTP to the immutable `telegram_user_id` through the dedicated
  `LOGIN` bot configured by `TELEGRAM_LOGIN_BOT_TOKEN`. Polling-bot assignments
  are never used for authentication delivery.
- OTP challenges expire after five minutes, are bound to the requesting browser,
  allow five attempts, are consumed atomically, and produce a 12-hour HMAC-signed
  session. Successful sends have a one-minute cooldown and a five-per-hour cap.
- Unknown or not-yet-bound Telegram identities receive the same generic browser
  response but no database challenge, OTP, or session. Admins provision the
  approved handle without entering a numeric Telegram ID.
- A private `/start` message to the dedicated login bot binds an unbound approved
  handle to the immutable ID supplied by Telegram. The handle must match exactly,
  and an already-bound row is never reassigned. This opens the conversation for
  future OTP delivery but does not authenticate the browser. The `LOGIN` webhook
  ignores group and poll activity.
- `app_users.telegram_user_id` is unique and is the authorization join key.
  The email column was removed on 2026-07-24; handles and display names are
  refreshable metadata only.
- `public/telegram-auth.js` is the shared login client for Home, Polls, and Admin.
  The active UI, API, repository, and `app_users` schema are Telegram-only. The
  six-digit field becomes editable immediately after **Send code** while the
  server prepares the browser-bound challenge; verification enables when that
  response arrives. The code step also has a **Resend code** button
  (`#telegram-resend-code`) that re-requests an OTP for the same handle without
  leaving the code step (server cooldown/`retry_after` surfaces inline), and the
  **Open @<login bot>** link (`#telegram-bot-link`) no longer navigates — clicking
  it toggles a QR code (`#telegram-bot-qr`) of the bot's `t.me` setup URL so users
  can scan it with a phone camera to open/Start the bot; the panel also offers an
  "Open on this device" fallback link. QR rendering uses the vendored, offline
  `public/vendor/qrcode.js` (qrcode-generator UMD, exposes `window.qrcode`), added
  to Home/Polls/Admin before `telegram-auth.js`.
- `GET /api/me` returns Telegram identity, role, and `bot_id`. `/api/admin/*`
  remains admin-only and all other management APIs remain tenant-scoped.

## Purpose

Node.js (CommonJS) service that runs GTRSG wheelchair (`WHCL`) and passenger
service associate (`PSA`) shift-slot **Telegram** polls: schedules/sends polls,
records votes via webhook, and posts first-come-first-served confirmations.
Deployed on **Vercel** (serverless) with **Supabase** for Postgres and Telegram
bot OTP sign-in.

> History: WhatsApp/Baileys (removed) → Telegram on Vercel with Vercel-Postgres
> (Claude) → **Supabase Postgres + Telegram Auth + a managed production workflow**
> (Codex, current). Ignore obsolete WhatsApp/Baileys/Vercel-Postgres/Neon/
> Basic-Auth references anywhere in history.

## Two workflows (important)

The app currently ships BOTH, selected at runtime:

- **Managed workflow = production** (Codex). Authenticated admin dashboard to
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
- **Login bot**: `LOGIN` is the dedicated @user_login_otp_bot configured by
  `TELEGRAM_LOGIN_BOT_TOKEN`. It sends authentication OTPs only and never
  captures groups or handles poll updates.
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
  Managed-group rows display exactly the stored Telegram group name and chat ID;
  they do not show bot/service pills or append bot/service text.
- **Data layer**: repository with two implementations sharing one async
  interface — `src/db/postgres.js` (Supabase Postgres via the `postgres` lib,
  `DATABASE_URL`) and `src/db/memory.js` (tests + local). `scripts/migrate.js`
  creates the schema; `scripts/verify-migration.js` checks it. `pollBuilder.js`
  and `confirmation.js` are pure.
- **Auth**: `src/telegramAuth.js` creates verifier-bound Telegram login challenges
  and signed application sessions. `verifyUser` resolves the immutable Telegram
  user ID in `app_users`.
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
  release is Wednesday 17:00 SGT. Every legacy or managed release batch is
  limited to one Monday-Sunday event week (at most 7 polls). Managed weekly
  templates persist `gap_weeks` per Telegram group: 0 targets the next event
  week, 1 leaves one full week between the release and event weeks, and so on.
  This lead-time setting is not service-hardcoded. Managed poll creation uses
  service-specific timing from `src/scheduleRules.js`: PSA cuts off Friday 08:00
  SGT in the week immediately before the event week and WHCL cuts off 1 day
  before each event at 08:00 SGT. Weekly confirmation weekday/time also always
  resolves inside the week immediately before the event week and must remain
  strictly after release. When absent, legacy defaults remain PSA Friday 12:00
  and WHCL at its day-before 08:00 cutoff. One-off polls persist
  an explicit confirmation date/time. Every confirmation must resolve strictly
  after its poll release. Vercel Hobby only allows daily cron, so `vercel.json` currently runs
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
  (`CONFIRMATION_HOUR`, default 8). Managed confirmations include a known service
  title (`Wheelchair`, `PSA`, or `General`) and event date in the header.
  Dedicated bot UUID routes omit the service-title line so internal identifiers
  never appear in Telegram. Only confirmed participants are included;
  waiting-list and unfilled slot rows are intentionally omitted.
  Managed confirmations are set to 1 day before the event date at 8:00 AM SGT,
  and weekly schedules store a template of
  event shifts that are automatically pre-populated on the poll editor card. Start and end
  time inputs use compact custom 24-hour scroll-wheel pickers (drum selectors)
  in separate responsive grid fields for space efficiency and consistent
  formatting across all client browsers and operating systems. Wheel selection
  measures row height when each scroll event occurs; do not cache dimensions
  while a managed section is hidden, because reopening it can otherwise change
  persisted times.
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
  for the selected group's saved template (7 polls for either service), not a
  single event-date poll. It uses that group's saved gap-week rule. Its optional
  release date field overrides the batch
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
  `runScheduledConfirmations` sorts non-PSA (Wheelchair) single confirmations by
  event date (via `getEventDate`) before sending, and orders PSA batches by their
  earliest event date, so per-date messages are never jumbled — most visible when
  several test dates confirm at once.

### 2026-08-05 fixes (multi-tenant bugs + deployment sheet)

- **Per-user polls now show (tenancy fix).** `scheduled_polls` has no `bot_id`
  column, so `postgres.listScheduledPolls()` now selects
  `coalesce(g.bot_ref::text, g.bot_id) as bot_id`; without it `filterRowsByUserBot`
  compared against `undefined` and hid every poll from non-admin users. The
  managed scheduling methods live only in `postgres.js` (memory.js has none), so
  this has no memory mirror; managed tests use inline fake DBs.
- **Bot reassignment (orphan reuse + Remove bot).** Replacing a user's bot only
  disables the old bot row, leaving an orphan that still holds the unique
  `telegram_bot_id`, which blocked reassigning that token elsewhere (409).
  `createBotFromToken` now 409s only when another user still **owns** the matching
  bot; an unowned/orphan row is reused via the new `db.reactivateBot(id, {token_encrypted, webhook_secret})`
  (memory + postgres), which re-enables the row, refreshes token/secret, and
  re-registers the webhook. `PATCH /api/admin/users/:id` accepts `remove_bot:true`
  to unassign + disable a bot (kept, not hard-deleted, to preserve poll history
  and avoid the `telegram_groups.bot_ref ON DELETE CASCADE`) and remove its
  webhook, freeing the bot for reassignment. Admin Edit dialog has a **Remove bot**
  button (`#remove-user-bot`, shown only when the user has a bot). `inspect-token`
  reports `already_assigned` from actual ownership, not mere row existence.
- **Service pill no longer mislabels (fix).** `public/app.js` `servicePill()` now
  returns the neutral **General** pill for anything other than `WHCL`/`PSA`
  (including per-user UUID bot ids); it previously defaulted every non-`PSA` value
  to green **Wheelchair**, so a PSA-bot group showed "Wheelchair".
- **Deployment sheet (who is deployed where).** The Polls page downloads
  `GET /api/confirmed-slots.xlsx` (tenant-scoped; admins may pass `?bot_id=`) as
  a formatted Excel roster with `Telegram handle`, `Name`, then chronological
  event-date columns formatted `3-Aug`. Confirmed shifts are stacked as
  `Shift: <label>` lines in bordered, wrapped cells; the header is frozen and
  print-ready in landscape. `GET /api/confirmed-slots.csv` remains for
  integrations. Confirmed only; waiting-list excluded. People are keyed by
  immutable Telegram id (fallback handle/name). OFF/RD and staff-number fields
  are not in the current data model. The button uses auth-wrapped `fetch` and
  downloads `deployment-sheet-<date>.xlsx`.
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
- Prod-required env (`src/app.js` throws when auth is enabled):
  `APP_SESSION_SECRET`, `TELEGRAM_WEBHOOK_SECRET`, and `CRON_SECRET`.
  Postgres and encrypted per-user bots additionally require `DATABASE_URL` and
  a stable `BOT_TOKEN_ENC_KEY`. Legacy
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
  and an enabled admin row in `app_users` with `telegram_user_id`. The production
  migration maps the existing Kishore admin row to the Telegram identity already
  observed by the poll bot.
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
  `BOT_TOKEN_ENC_KEY` and `APP_SESSION_SECRET`; (3) Vercel redeploy (env vars apply only to new
  deployments); (4) run `npm run migrate:multi-tenant`; (5) verify Telegram
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
- The 2026-08-03 production release at `https://gtrsg-poll-bot.vercel.app`
  includes admin user-scoped managed groups and current Telegram membership
  refresh.
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
  Home and Polls both keep a role-gated **Admin** navbar item: `/api/me` reveals
  it for admins on every page load, while normal users never see it. Normal-user
  managed groups, weekly templates, and custom replacement polls remain scoped
  server-side to the bot assigned to that user.
  Successful **Save default** and **Review and schedule** actions show an in-page
  completion dialog naming the selected Telegram group; API failures remain in
  the shared status area and must not open the success dialog.
  Home, Polls, and Admin retain their existing layouts while sharing a restrained
  Telegram scheduling illustration in the page header plus dimensional surfaces,
  table states, modal blur, and reduced-motion-aware transitions from
  `public/theme.css`. The header artwork lives at
  `public/assets/poll-operations-header.png`.
  The filter bar filters by event date, Telegram group, and poll type (`test`,
  `custom`, `batch_default`). Admins additionally get a bot filter populated
  from the Admin roster; selecting a bot narrows both poll rows and the Telegram
  group choices. Normal users do not see that control and remain scoped
  server-side to their assigned bot.
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
- **Production auth is enabled**: Vercel sets `REQUIRE_ADMIN_AUTH=true`, so
  management APIs require a valid Telegram session. Existing enabled users are
  mapped by immutable Telegram ID and the Kishore account has the admin role.
  Home, Polls, and Admin show the user's admin-managed
  `telegram_display_name` in the navbar after authentication, with the Telegram
  handle as a fallback when no display name is set. Clicking that identity opens
  the shared account menu for profile-picture upload and Sign out. Profile
  pictures are resized to 256x256 WebP in the browser, capped at 200 KB by the
  API, and stored in `app_users.profile_photo_data`; users can update only their
  own picture. Admin user rows expose an Edit dialog with a read-only Telegram
  handle plus editable display name, role, enabled status, and dedicated bot
  assignment. The assigned bot's Telegram display name and handle are also
  read-only. Clicking an existing avatar opens a full-screen profile viewer with a
  translucent black backdrop, an X close control, and a self-only delete action.
  Bot tokens and immutable bot handles are intentionally never displayed.
- `webhook_events` had traffic (20 rows) → both bots' production webhooks are
  registered and delivering.
- PSA group's observed weekly schedule at the time: release Fri 17:00,
  confirmation Sat 12:00, Asia/Singapore. This is historical state and should be
  changed in production data to Wednesday 17:00; the application now derives PSA
  cutoff/confirmation as Friday 08:00/12:00 when creating managed polls.
- **Telegram auth configuration:** the identity migration is applied and
  existing users are mapped by immutable Telegram ID. Vercel Production requires
  `APP_SESSION_SECRET`, `TELEGRAM_LOGIN_BOT_TOKEN`, and
  `REQUIRE_ADMIN_AUTH=true`. `scripts/set-webhook.js` always registers the
  dedicated login bot at `/api/telegram/login`, even when polling bots come from
  the database. OTP requests also idempotently ensure that webhook from inside
  the Vercel runtime, so login-bot registration self-heals after deployments.

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

## Movement Roster UI

Home, Polls, and Admin use the **Movement Roster** design system documented in
`DESIGN.md`: deep-ink navigation, technical airport line-art, compact squared
controls, ruled docket bands, and restrained structural depth. Home prioritizes
release rules and managed groups before legacy tools. Skip days are specific
calendar dates, and each Telegram group opens an editable weekly default template
with its own timing and shifts. Preserve server-enforced tenant scoping and show
cross-user controls only to admins.
