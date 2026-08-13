alter table public.weekly_poll_schedules
  add column if not exists testing_mode boolean not null default false,
  add column if not exists testing_status text not null default 'off',
  add column if not exists testing_batch_id uuid,
  add column if not exists testing_override jsonb,
  add column if not exists testing_started_at timestamptz;

alter table public.weekly_poll_schedules
  drop constraint if exists weekly_poll_schedules_testing_status_check;

alter table public.weekly_poll_schedules
  add constraint weekly_poll_schedules_testing_status_check
  check (testing_status in ('off', 'armed', 'running'));

alter table public.weekly_poll_schedules
  drop constraint if exists weekly_poll_schedules_testing_state_check;

alter table public.weekly_poll_schedules
  add constraint weekly_poll_schedules_testing_state_check
  check (
    (not testing_mode and testing_status = 'off' and testing_batch_id is null and testing_override is null)
    or
    (testing_mode and testing_status in ('armed', 'running') and testing_batch_id is not null and testing_override is not null)
  );

comment on column public.weekly_poll_schedules.testing_mode is
  'One-shot accelerated test override. Telegram content remains production-identical.';

comment on column public.weekly_poll_schedules.testing_override is
  'Temporary full weekly-template payload used only by the armed testing batch.';
