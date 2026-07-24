-- Telegram is the application identity provider. Email remains optional legacy
-- metadata while the immutable Telegram user ID becomes the authorization key.
alter table public.app_users alter column email drop not null;
alter table public.app_users
  add column if not exists telegram_user_id bigint,
  add column if not exists telegram_username text,
  add column if not exists telegram_display_name text;

create unique index if not exists app_users_telegram_user_id_key
  on public.app_users (telegram_user_id)
  where telegram_user_id is not null;

create table if not exists public.telegram_login_challenges (
  id text primary key,
  verifier_hash text not null,
  telegram_user_id bigint,
  telegram_username text,
  telegram_display_name text,
  expires_at timestamptz not null,
  verified_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists telegram_login_challenges_expires_idx
  on public.telegram_login_challenges (expires_at);

create table if not exists public.telegram_access_requests (
  telegram_user_id bigint primary key,
  telegram_username text,
  telegram_display_name text,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected')),
  requested_at timestamptz not null default now(),
  reviewed_at timestamptz
);

alter table public.telegram_login_challenges enable row level security;
alter table public.telegram_access_requests enable row level security;
revoke all on public.telegram_login_challenges from anon, authenticated;
revoke all on public.telegram_access_requests from anon, authenticated;
