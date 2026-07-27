-- Telegram identity fully replaces email identity for application users.
alter table public.app_users drop column if exists email;
