-- Multi-tenant rework: one Telegram bot per user, Microsoft SSO allow-list, RBAC.
--
-- Expand/contract migration: `telegram_groups.bot_ref` (uuid FK) is added alongside
-- the legacy `bot_id` text column rather than replacing it, because several SQL
-- functions (claim_due_polls, claim_due_confirmations, apply_scheduled_poll_response)
-- read `bot_id`. scripts/migrate-to-multi-tenant.js backfills bot_ref; the functions
-- below prefer bot_ref and fall back to bot_id so both work mid-migration.

create extension if not exists citext;

-- One bot per user. bot_name mirrors Telegram's own name (never an app-only label);
-- the token is AES-256-GCM encrypted by src/crypto.js and never leaves the server.
create table if not exists public.bots (
  id uuid primary key default gen_random_uuid(),
  bot_name text not null,
  telegram_username text,
  telegram_bot_id bigint,
  token_encrypted text not null,
  webhook_secret text not null,
  enabled boolean not null default true,
  name_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The SSO allow-list. Because the Entra app registration is multi-tenant, ANY
-- Microsoft work/school account can complete the login step -- membership of this
-- table is the only thing that grants access. Deny by default.
create table if not exists public.app_users (
  id uuid primary key default gen_random_uuid(),
  email citext not null unique,
  auth_user_id uuid unique references auth.users(id) on delete set null,
  role text not null default 'user' check (role in ('admin','user')),
  bot_id uuid unique references public.bots(id) on delete set null, -- 1 bot <-> 1 user
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Ownership link: which bot (and therefore which user) a group belongs to.
alter table public.telegram_groups
  add column if not exists bot_ref uuid references public.bots(id) on delete cascade;

create index if not exists telegram_groups_bot_ref_idx on public.telegram_groups(bot_ref);

-- The old uniqueness was (telegram_chat_id, bot_id); the same chat may legitimately
-- be managed by two different users' bots, so keep that shape on the new column.
create unique index if not exists telegram_groups_chat_bot_ref_key
  on public.telegram_groups(telegram_chat_id, bot_ref)
  where bot_ref is not null;

-- Legacy bot_id was constrained to the fixed service enum; per-user bots make that
-- obsolete. Drop the constraint/default so the column can hold a bot uuid as text
-- during transition.
alter table public.telegram_groups drop constraint if exists telegram_groups_bot_id_check;
alter table public.telegram_groups alter column bot_id drop default;

-- Re-declare the claim functions so the `service` column they return is the bot key
-- the app resolves a token with: the new bot uuid once backfilled, else the legacy
-- text. Bodies are otherwise unchanged from 202607160001 / 202607170001.

create or replace function public.claim_due_polls(p_limit integer default 10)
returns table (
  id uuid, event_id uuid, telegram_group_id uuid, service text, telegram_chat_id bigint,
  poll_question text, poll_options jsonb, claim_token uuid
) language plpgsql security definer set search_path=public as $$
begin
  return query
  with candidates as (
    select sp.id
    from scheduled_polls sp
    join events e on e.id=sp.event_id
    where sp.enabled and sp.status in ('scheduled','failed')
      and sp.resolved_release_at <= now()
      and (sp.claimed_at is null or sp.claimed_at < now() - interval '10 minutes')
    order by e.event_date, sp.resolved_release_at, sp.id
    for update skip locked limit greatest(1, least(p_limit, 50))
  ), claimed as (
    update scheduled_polls sp set status='sending', claim_token=gen_random_uuid(),
      claimed_at=now(), updated_at=now()
    from candidates c where sp.id=c.id returning sp.*
  )
  select c.id, c.event_id, c.telegram_group_id, coalesce(g.bot_ref::text, g.bot_id),
    g.telegram_chat_id, c.poll_question, c.poll_options, c.claim_token
  from claimed c
  join events e on e.id=c.event_id
  join telegram_groups g on g.id=c.telegram_group_id and g.enabled
  order by e.event_date, c.resolved_release_at, c.id;
end $$;

drop function if exists public.claim_due_confirmations(integer);
create function public.claim_due_confirmations(p_limit integer default 10)
returns table (
  id uuid, event_id uuid, scheduled_poll_id uuid, service text, telegram_chat_id bigint,
  telegram_message_id bigint, header_text text, footer_text text, resolved_send_at timestamptz,
  show_waiting_list boolean, show_empty_shifts boolean, claim_token uuid
) language plpgsql security definer set search_path=public as $$
begin
  return query
  with candidates as (
    select cm.id from confirmation_messages cm
    where cm.status in ('scheduled','failed') and cm.resolved_send_at <= now()
      and (cm.claimed_at is null or cm.claimed_at < now() - interval '10 minutes')
    order by cm.resolved_send_at, cm.id
    for update skip locked limit greatest(1, least(p_limit, 50))
  ), claimed as (
    update confirmation_messages cm set status='sending', claim_token=gen_random_uuid(),
      claimed_at=now(), updated_at=now()
    from candidates c where cm.id=c.id returning cm.*
  )
  select c.id, c.event_id, c.scheduled_poll_id, coalesce(g.bot_ref::text, g.bot_id),
    g.telegram_chat_id, c.telegram_message_id, c.header_text, c.footer_text, c.resolved_send_at,
    c.show_waiting_list, c.show_empty_shifts, c.claim_token
  from claimed c join telegram_groups g on g.id=c.telegram_group_id and g.enabled;
end $$;

alter table public.bots enable row level security;
alter table public.app_users enable row level security;

-- Service-role (the API) bypasses RLS; these policies only expose a user's own row.
drop policy if exists "user can read own app_user row" on public.app_users;
create policy "user can read own app_user row" on public.app_users
  for select to authenticated using (auth_user_id = auth.uid());
