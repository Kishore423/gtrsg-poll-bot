# Codex adapter

> # ✅ MULTI-TENANT REWORK COMPLETE (2026-07-24)
>
> The per-user Telegram bot, RBAC, managed-group, and Telegram sign-in work has
> landed. Historical approved plan:
> `C:\Users\kirub\.claude\plans\authentication-using-each-sleepy-hollerith.md`
>
> **Current status:** Tasks 1-8 are done (`src/crypto.js`, `bots`/
> `app_users`, Telegram identity allow-list, tenant group scoping/RBAC, UUID bot
> webhook routing/token resolution, admin APIs/page, dashboard group-popup flow,
> migration script, and Telegram bot OTP login). Validate with `npm test` and
> `npm run check`.
>
> Task 4 added `src/tenancy.js` and scoped existing managed routes in
> `src/server.js`: managed groups, weekly schedules, skip dates, and scheduled
> poll list/create/details/actions/deletes. Non-admin users get only rows for
> their `app_users.bot_id`; direct access to another bot's group returns 404.
>
> Task 5 backend added dynamic Telegram token resolution, UUID bot webhooks
> (`/api/telegram/:botId`) with per-bot webhook secrets, `bot_ref` group capture,
> `getMyName`/`setMyName` client methods, DB bot identity sync, and DB-backed
> webhook registration. Legacy WHCL/PSA/PRIMARY routes remain during migration.
>
> Task 6 added `/admin` plus `/api/admin/*` for allow-list users and bot
> management. BotFather tokens are optional during user creation; an unassigned
> user remains valid and an admin can assign a token later from Edit. Tokens are
> encrypted with `BOT_TOKEN_ENC_KEY`. Bot names and handles are Telegram-owned,
> read-only website fields; loading or explicitly refreshing the Admin roster
> mirrors `getMyName`/`getMe`, and website rename APIs fail closed.
>
> Task 7 changed the main dashboard Managed groups section: groups are
> auto-detected when a user's bot is added to Telegram, the **Verify bot** button
> remains beside each group, and clicking a group opens a popup for **Weekly
> default template**, **Skip days**, or **Custom poll**. Those workflow cards
> have no manual group-delete control; a Telegram membership removal disables
> and hides that bot/group row automatically.
> bind to the clicked group without another Telegram-group dropdown. Test-poll
> actions remain inside the weekly template and one-off poll sections. All three
> workflows render as full-width command rows with Lucide icons, supporting
> text, and consistent depth states. Home, Polls, and Admin share
> `public/theme.css` / `public/theme.js`, including restrained perspective,
> layered shadows, inset controls, and reduced-motion fallbacks. Dynamic icon
> hydration targets only non-SVG `[data-lucide]` placeholders because generated
> Lucide SVGs retain that attribute and must not retrigger hydration.
> Viewport dialog backdrops are direct children of `body`, after `main`; placing
> them inside the animated `main` constrains fixed positioning to the content box.
> Admins first search the Admin roster by display name; selecting one user scopes
> group rows and managed schedules to that user's single `bot_id`. **Verify bot**
> reports success only after Telegram accepts a test message sent by that bot to
> the exact selected group. Bot removal membership updates disable the matching
> `(Telegram chat, bot)` row, so managed lists contain current memberships only;
> a later add or group message re-enables the same row. Admin user selection also
> refreshes that bot's saved memberships against Telegram to retire stale rows
> whose removal webhook predates this behavior.
>
> Task 8 added `npm run migrate:multi-tenant` /
> `scripts/migrate-to-multi-tenant.js` to create/reuse WHCL/PSA bot rows, assign
> legacy service groups to `bot_ref`, and upsert the seed `app_users` roster.
>
> ⚠️ Two things not to "tidy up":
> 1. `telegram_groups.bot_ref` (uuid) was added **alongside** the legacy `bot_id`
>    text column on purpose — expand/contract, so the live bots keep working. The
>    claim functions return `coalesce(g.bot_ref::text, g.bot_id)`. Don't drop
>    `bot_id` until `scripts/migrate-to-multi-tenant.js` has backfilled.
> 2. A valid Telegram OTP only proves control of that Telegram account. The
>    `app_users` allow-list is the authorization gate and must fail closed — never
>    let "Telegram verified ⇒ allowed" creep into any endpoint.

Codex-facing adapter. `CLAUDE.md` is the canonical source of project knowledge —
read it for the full architecture. **Two agents (Claude Code + Codex) work on
this repo concurrently; update both `CLAUDE.md` and `AGENTS.md` on every durable
change so neither drifts.**

## Project summary

Node.js (CommonJS, Node 24.x) service running GTRSG wheelchair (`WHCL`) / PSA
(`PSA`) shift-slot **Telegram** polls. Express UI/API, **Supabase** for Postgres
(`DATABASE_URL` via the `postgres` lib), Telegram bot OTP auth, **Vercel serverless +
Vercel Cron** for hosting/scheduling.

> Migrated off WhatsApp/Baileys entirely. Also past Vercel-Postgres/Neon and HTTP
> Basic Auth — now Supabase for DB and Telegram for auth. Disregard those obsolete references.

## Two workflows

- **Managed (production)**: dashboard-scheduled polls with precise timezone
  release/close/confirmation times, cron-driven sending with claim-token
  concurrency, edit-in-place confirmations, waiting lists, poll closures.
  `src/productionScheduler.js` (including `generateScheduledPollsFromTemplates`),
  `src/scheduleResolver.js`,
  `buildManagedConfirmationMessage`, repo `claim*/complete*/fail*/getAllocation`.
- **Legacy (original slot UI)**: gated by `enableLegacyWorkflow` (on for
  `DB_DRIVER=memory`, `ENABLE_LEGACY_WORKFLOW=true`, or unconfigured Vercel
  preview). Its `/api/slots|polls|...` return 410 when disabled.

## Working agreements

- Never commit `.env`/`.env.local`, bot tokens, `DATABASE_URL`, or Supabase keys.
- Keep `WHCL`/`PSA` routing separate (separate tokens + targets).
- **Supervisor scheduling requirements implemented (2026-07-13):** default poll
  release is Wednesday 17:00 SGT. Legacy weekly sending releases WHCL slots for
  the following Monday-Sunday week and PSA slots for the following two
  Monday-Sunday weeks. Managed poll creation uses service-specific timing from
  `src/scheduleRules.js`: PSA cuts off Friday 08:00 SGT and WHCL cuts off 1 day
  before the event date at 08:00 SGT. Weekly templates persist an independently
  configurable confirmation weekday/time; when absent, legacy defaults remain
  PSA Friday 12:00 and WHCL at its day-before 08:00 cutoff. One-off polls persist
  an explicit confirmation date/time. Every confirmation must resolve strictly
  after its poll release. Vercel Hobby only allows daily cron, so `vercel.json` currently runs
  `/api/cron/scheduler` once daily; exact Wednesday 17:00 / Friday 12:00 delivery
  needs either Vercel Pro hourly cron, an external scheduler, or manual trigger.
  The managed scheduler auto-generates missing default polls from each saved group
  template only on its configured local release weekday after the release time;
  it does not backfill a missed/deleted batch on later days. It skips dates that
  already have active polls; admins should not manually create release batches. Each
  Telegram group has persistent event-date exclusions in
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
  Managed confirmation messages include a service title (`Wheelchair` or `PSA`)
  and event date in the header, and only confirmed participants; waiting-list and
  unfilled slot rows are intentionally omitted.
- The data layer is a repository with two implementations sharing one async
  interface (`src/db/memory.js`, `src/db/postgres.js`); keep them in lockstep —
  the memory one is what the tests run against.
- Auth: Telegram bot OTP sessions (`src/telegramAuth.js`). `REQUIRE_ADMIN_AUTH`
  (default true in prod)
  protects `/api/*` except `/api/auth/*`, `/api/telegram/*`, `/api/cron/*`
  (those use the webhook secret / cron bearer instead).
  Admins provision an approved Telegram handle without entering a numeric ID.
  A private `/start` to the login bot binds an unbound approved handle to the
  immutable ID supplied by Telegram; the handle must match exactly and an
  already-bound row is never reassigned. `/api/auth/telegram/otp/request` accepts
  the approved handle and sends a six-digit code to `app_users.telegram_user_id`
  through
  the dedicated `LOGIN` bot configured by `TELEGRAM_LOGIN_BOT_TOKEN`. Polling-bot
  assignments are never used for authentication delivery.
  `/api/auth/telegram/otp/verify` consumes the five-minute browser-bound challenge
  and issues a signed 12-hour session. Codes allow five attempts and successful
  sends have a one-minute cooldown plus a five-per-hour cap. Unknown or
  not-yet-bound identities get a generic response but no OTP/session. The login
  bot webhook ignores group/poll activity. `app_users` stores no email; Telegram ID is the
  authorization key, while handle and display name are metadata. Home, Polls,
  and Admin show the admin-managed `telegram_display_name` in the navbar after
  authentication, falling back to the Telegram handle when needed. Clicking the
  identity opens a shared account menu with profile-picture upload and Sign out.
  Uploads are resized to 256x256 WebP client-side, capped at 200 KB server-side,
  and saved to the caller's own `app_users.profile_photo_data`. Admin user rows
  have an Edit dialog with a read-only Telegram handle plus editable display
  name, role, enabled status, and dedicated bot assignment. The assigned bot's
  Telegram display name and handle are also read-only and derived from its
  encrypted BotFather token. `app_users.telegram_username` is the person's
  login handle and `bots.telegram_username` is the assigned bot handle;
  repository and API results keep them separate. Login_bot refreshes a bound
  user's handle by immutable Telegram ID on `/start`, OTP requests, and Admin
  roster refreshes. Clicking an existing
  avatar opens a full-screen viewer over a translucent black backdrop with an X
  close control and a self-only delete action. The shared
  login UI exposes an editable six-digit field immediately after **Send code**
  and enables verification when the challenge response arrives.
- Webhook updates are de-duplicated (`beginWebhookEvent`/`finishWebhookEvent`);
  preserve that. Any configured webhook bot route (`PRIMARY`, `WHCL`, `PSA`)
  auto-captures a managed Telegram group from bot membership updates or received
  group messages/commands, upserting the row by `(telegram_chat_id, bot_id)`.
  WHCL/PSA also update the legacy target table; PRIMARY is stored as a general
  managed group (`service=null`, `bot_id='PRIMARY'`). One bot can be mapped to
  multiple managed groups because each distinct `(telegram_chat_id, bot_id)` gets
  its own row and templates/polls are scoped by `telegram_group_id`.
  Managed-group names are displayed exactly as stored by Telegram; the UI does
  not append bot/service text such as `(PSA bot)` to the group name.
- Use CommonJS + the Node built-in test runner. Run `npm test` and
  `npm run check` after behavior changes.
- After every code change, review both `CLAUDE.md` and `AGENTS.md` and keep them
  aligned. No artificial changelog entries.

## Bots (live)

- `PRIMARY` = `TELEGRAM_BOT_TOKEN`; per-service `TELEGRAM_TOKEN_WHCL` /
  `TELEGRAM_TOKEN_PSA` fall back to PRIMARY.
- WHCL bot: @Flexi_wheelchair_bot (id 8632673727).
- PSA bot: @Pax_services_bot (id 8764384354).
- Login bot: @user_login_otp_bot (`LOGIN`; authentication only).

## Deployment (Vercel + Supabase)

UAT: `https://gtrsg-poll-bhqx4qvy5-kishores-projects-ecc05d96.vercel.app`
Prod: `https://gtrsg-poll-bot.vercel.app`
Supabase ref `flbcgncbwoavqtrlpnfq`. No secrets in this file (Vercel env + local `.env`).

- **Two-bot config (decided)**: set `TELEGRAM_TOKEN_WHCL` + `TELEGRAM_TOKEN_PSA`, and
  **omit `TELEGRAM_BOT_TOKEN`**. `set-webhook.js` registers every explicitly
  configured bot and rejects duplicate token values so one bot cannot get multiple
  webhook URLs. `TELEGRAM_BOT_USERNAME` is unused in code (omit).
- Prod-required env (app.js throws): `APP_SESSION_SECRET` (32+ characters),
  `TELEGRAM_WEBHOOK_SECRET`, `CRON_SECRET`, `DATABASE_URL`, `BOT_TOKEN_ENC_KEY`,
  and `TELEGRAM_LOGIN_BOT_TOKEN`.
- **DATABASE_URL = Supabase SESSION pooler (5432).** `postgres.js` uses prepared
  statements (no `prepare:false`); do NOT switch to the transaction pooler (6543)
  without adding `prepare:false`.
- **Schema**: `npm run migrate` is disabled; use `npx supabase db push`
  (`supabase/migrations/202607120001_production_schema.sql`).
- **Admin bootstrap** (else locked out): `REQUIRE_ADMIN_AUTH=true` + an enabled
  admin row in `app_users` with `telegram_user_id`. The production migration maps
  the existing Kishore admin row to the Telegram identity already observed by
  the poll bot.
- `telegram_groups.bot_id` defaults to `service || 'PRIMARY'`. The table unique constraint
  is on `(telegram_chat_id, bot_id)`, allowing a single group chat ID to be added multiple
  times for different bots.
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
- **Order**: db push → create admin user + row → Vercel redeploy → verify login →
  `set-webhook` (only after redeploy is live) → assign bot_ids → add bots to groups.
- **Live-DB findings (2026-07-12)**: "Gtr poll" (`-1004496348175`) registered twice
  (bot_id WHCL + PSA, both enabled) — routing correct. **"Send immediately" bug root
  cause**: `sendPollNow` (public/app.js) requires the selected group to have an
  enabled `weekly_poll_schedules` row and errors before POSTing; only the PSA group had
  one, so `events`/`scheduled_polls` were empty (no `last_error`). **Fixed at the
  time:** WHCL was given the same Friday 17:00 default as PSA; this predates the
  2026-07-13 supervisor requirement and should be changed in production data to
  Wednesday 17:00 if the row still exists. Current code derives WHCL cutoff as
  day-before 8:00 AM and PSA cutoff as Friday 8:00 AM; confirmation weekday/time
  comes from each saved template. The weekly schedule
  defaults also act as templates for shifts, storing them in a `shifts` JSONB column and auto-populating
  them on the dashboard's "Create a poll" card. `webhook_events` had traffic, so both
  bots' webhooks are live. Production auth is enabled with
  `REQUIRE_ADMIN_AUTH=true`; management APIs require a valid Telegram session.
- The poll editor has one form-level **Send immediately** action beside **Review and
  schedule**; it sends every shift row currently in the form.
- The 2026-08-03 production release at `https://gtrsg-poll-bot.vercel.app`
  includes admin user-scoped managed groups and current Telegram membership
  refresh.
- The managed dashboard includes a Release rules summary, a unified **Group template &
  automatic releases** section (template settings and template test polls), and a
  **Create one-off poll** section with inline timing preview and integrated test button.
  Default release batches are generated by the backend scheduler from saved
  templates, not manually from the UI.
  The Home page status area lives outside the legacy workflow so Verify bot and
  test poll actions show visible feedback in production.
  The Polls page **Details** action uses an in-page modal instead of a browser alert,
  and generated poll action buttons are explicit `type="button"` to prevent accidental reloads.
  The Polls page table is intentionally ordered by event date ascending
  (earliest first, latest last), both from `listScheduledPolls()` and in the
  frontend before rendering/filtering.
  Home and Polls both keep a role-gated **Admin** navbar item: `/api/me` reveals
  it for admins on every page load, while normal users never see it. Normal-user
  managed groups, weekly templates, and custom replacement polls remain scoped
  server-side to the bot assigned to that user.
  Successful **Save default** and **Review and schedule** actions show an in-page
  completion dialog naming the selected Telegram group; API failures remain in
  the shared status area and must not open the success dialog.
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
  The weekly template form uses a dedicated vertical layout for release controls,
  shift rows, and Add/Save actions; do not put those controls back into the global
  `form` grid because it causes overlap with the custom time wheel pickers. A
  Telegram poll preview sits below the horizontal divider and above the
  **Test template poll** heading/input controls at the bottom of section 1;
  `ensureTemplatePreviewPlacement()` also enforces that DOM order at runtime. It shows the generated
  question and option labels from current shift edits, or from the saved weekly
  default after **Save default**. The save
  handler intentionally keeps the edited release controls and shift rows visible
  after a successful save; do not reset the form back to a blank template row.
  The template timing description is driven by the currently selected release
  day/time controls, even when a saved schedule already exists for the group.
  After weekly schedules load or save, the weekly shift editor, release day, and
  release time are rebuilt from the selected Telegram group's saved template so
  each bot/group can keep different default slots and release timing. The Telegram
  poll preview reflects the latest persisted defaults. The save flow patches the
  local schedule cache from the PUT response plus the exact submitted release
  timing and shift rows before refreshing the schedule list, so the preview must
  not snap back to an older GET result after saving. Generated shift labels in the preview/save
  path are recomputed from the live start/end time controls (`HHMM-HHMM`) and
  written back into the label input on picker input/change events; only
  non-time-range label text is treated as a true custom label.
  One-off/custom poll creation, including **Send test poll**, falls back to the
  default Wednesday 17:00 release timing when a group has no saved weekly template.
  The one-off editor starts from the selected group's saved default template
  shifts and refreshes after template saves, group changes, and one-off form
  resets so admins only edit exceptions. The `send-now` action returns
  success directly after `sendScheduledPollImmediately`; do not run a second
  scheduled-state transition after the poll is already open. Backend immediate
  sends also synthesize `specific_release_at=now` when no weekly/specific release
  schedule is present.
  Test polls do not override or delete default weekly schedules, nor do they delete
  existing scheduled/custom polls or block actual scheduled polls or automatic
  default-poll generation for that day.
  They are tagged with an operational tag (`test`) and rendered
  with a distinct red "Test" type pill in the polls table. The Home page template
  test-poll control sends the entire current release batch for the selected
  group's saved template (WHCL 7 polls, PSA 14 polls), not a single event-date
  poll. Its optional release date field overrides the batch release date; when
  blank it uses the latest configured release day/time that has already happened
  in Asia/Singapore. Test-batch sends are sorted earliest event date to latest
  event date and paced with a short delay between Telegram sends; partial
  failures are reported per event date. It also has a test-only confirmation
  delay input; it overrides `confirmation_at` to `now + N minutes` for every test
  poll in the batch so confirmation text can be smoke-tested shortly after
  release. This before-close confirmation override is allowed only when
  `is_test=true`; normal polls still confirm after the configured close/cutoff
  timing. The dashboard triggers only those test polls' confirmations after the
  delay while the page remains open, so old due confirmations are not flushed by
  a smoke test; otherwise delivery still depends on the configured cron/external
  scheduler.
  Successful test-poll sends show a browser alert: "poll sent, please check
  telegram". Confirmation delivery is service-specific: PSA due confirmations are
  grouped into one Telegram message per group/resolved confirmation time, with
  each event date and its confirmed timeslots listed in date order. Wheelchair
  confirmations intentionally remain one Telegram confirmation message per
  poll/event date. Start and end time inputs
  use compact custom 24-hour scroll-wheel pickers (drum selectors) in separate
  responsive grid fields for space efficiency and consistent formatting across
  all client browsers and operating systems.
- Manual release-batch creation is not part of the primary UI; automatic template
  generation skips active existing polls by default.
- **Footgun**: don't run `npm run dev-telegram` after webhooks are live — it deletes
  the production webhooks (long-polls). Re-run `set-webhook` to restore.
- **Telegram auth configuration:** the identity migration is applied and
  existing users are mapped by immutable Telegram ID. Vercel Production requires
  `APP_SESSION_SECRET`, `TELEGRAM_LOGIN_BOT_TOKEN`, and
  `REQUIRE_ADMIN_AUTH=true`. `scripts/set-webhook.js` always registers the
  dedicated login bot at `/api/telegram/login`, even when polling bots come from
  the database. OTP requests also idempotently ensure that webhook from inside
  the Vercel runtime, so login-bot registration self-heals after deployments.

## Commands

- Install: `npm install`  ·  Tests: `npm test`  ·  Lint/build: `npm run check`
- Local (memory DB, legacy on): `DB_DRIVER=memory npm start`
- Real-bot local test: `npm run dev-telegram` (long-polling; resets on restart)
- Schema: `npm run migrate` / `npm run verify:migration`
- Webhooks: `npm run set-webhook` / `npm run delete-webhook`
- Seeded UI preview: `node scripts/dev-ui-preview.js`

## Project map

`src/`: `telegram.js`, `telegramUpdates.js`, `processUpdate.js`,
`db/{memory,postgres}.js`, `auth.js`, `pollBuilder.js`, `confirmation.js`,
`scheduler.js` (legacy), `scheduleResolver.js` + `productionScheduler.js`
(managed), `server.js`, `app.js`, `localServer.js`. `public/` UI,
`api/index.js` Vercel entry, `vercel.json` (uses explicit `builds` config —
do NOT switch back to zero-config rewrites; Vercel auto-discovers `src/server.js`
as a function otherwise, causing 500s on `/`), `scripts/`, `test/` (7 suites).

## Configuration boundaries

Secrets and deployment values live in ignored `.env` / Vercel env vars. Shared
Codex defaults belong in `.codex/config.toml`; developer-specific overrides stay
untracked.
