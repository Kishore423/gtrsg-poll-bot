create table if not exists public.poll_release_exclusions (
  id uuid primary key default gen_random_uuid(),
  telegram_group_id uuid not null references public.telegram_groups(id) on delete cascade,
  event_date date not null,
  created_at timestamptz not null default now(),
  unique (telegram_group_id, event_date)
);

create index if not exists poll_release_exclusions_group_date_idx
  on public.poll_release_exclusions(telegram_group_id, event_date);

alter table public.poll_release_exclusions enable row level security;

drop policy if exists "enabled admins" on public.poll_release_exclusions;
create policy "enabled admins" on public.poll_release_exclusions
  for all to authenticated
  using (public.is_enabled_admin())
  with check (public.is_enabled_admin());
