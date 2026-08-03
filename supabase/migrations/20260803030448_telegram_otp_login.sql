-- Replace the Telegram deep-link approval challenge with a browser-bound,
-- single-use OTP sent to an already approved immutable Telegram user ID.
delete from public.telegram_login_challenges;

alter table public.telegram_login_challenges
  drop column if exists telegram_username,
  drop column if exists telegram_display_name,
  drop column if exists verified_at,
  add column if not exists otp_hash text,
  add column if not exists attempt_count integer not null default 0,
  add column if not exists sent_at timestamptz,
  add column if not exists consumed_at timestamptz;

alter table public.telegram_login_challenges
  alter column otp_hash set not null;

alter table public.telegram_login_challenges
  add constraint telegram_login_challenges_attempt_count_check
  check (attempt_count between 0 and 5);

create index if not exists telegram_login_challenges_user_sent_idx
  on public.telegram_login_challenges (telegram_user_id, sent_at desc)
  where sent_at is not null;

create unique index if not exists app_users_telegram_username_key
  on public.app_users (lower(telegram_username))
  where telegram_username is not null;

drop table if exists public.telegram_access_requests;

alter table public.telegram_login_challenges enable row level security;
revoke all on public.telegram_login_challenges from anon, authenticated;
