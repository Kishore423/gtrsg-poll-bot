alter table public.app_users
  add column if not exists deployment_sheets_enabled boolean not null default false;
