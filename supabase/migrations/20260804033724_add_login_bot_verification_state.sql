alter table public.app_users
  add column if not exists login_bot_verified_at timestamptz;

-- A successfully delivered OTP proves that the dedicated login bot already had
-- access to the user's private chat. Legacy IDs without this evidence remain
-- unverified until their next private /start update.
update public.app_users as app_user
set login_bot_verified_at = evidence.verified_at
from (
  select telegram_user_id, max(sent_at) as verified_at
  from public.telegram_login_challenges
  where sent_at is not null
  group by telegram_user_id
) as evidence
where app_user.telegram_user_id = evidence.telegram_user_id
  and app_user.login_bot_verified_at is null;
