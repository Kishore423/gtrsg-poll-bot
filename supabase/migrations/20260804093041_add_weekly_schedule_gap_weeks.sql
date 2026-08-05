alter table public.weekly_poll_schedules
  add column if not exists gap_weeks smallint not null default 0;

alter table public.weekly_poll_schedules
  drop constraint if exists weekly_poll_schedules_gap_weeks_check;

alter table public.weekly_poll_schedules
  add constraint weekly_poll_schedules_gap_weeks_check
  check (gap_weeks between 0 and 12);

comment on column public.weekly_poll_schedules.gap_weeks is
  'Number of full Monday-Sunday weeks between the release week and the single event week.';
