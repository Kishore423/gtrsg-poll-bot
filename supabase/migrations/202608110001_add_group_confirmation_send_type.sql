alter table public.weekly_poll_schedules
  add column if not exists confirmation_send_type text not null default 'weekly_summary',
  add column if not exists confirmation_days_before_event smallint;

alter table public.confirmation_messages
  add column if not exists confirmation_send_type text not null default 'weekly_summary';

update public.weekly_poll_schedules w
set confirmation_send_type = case
    when coalesce(g.service, g.bot_id) = 'PSA' then 'weekly_summary'
    else 'per_event_day'
  end,
  confirmation_days_before_event = case
    when coalesce(g.service, g.bot_id) = 'PSA' then null
    else 1
  end
from public.telegram_groups g
where g.id = w.telegram_group_id
  and w.confirmation_send_type = 'weekly_summary'
  and w.confirmation_days_before_event is null;

update public.confirmation_messages cm
set confirmation_send_type = case
    when coalesce(g.service, g.bot_id) = 'PSA' then 'weekly_summary'
    else 'per_event_day'
  end
from public.telegram_groups g
where g.id = cm.telegram_group_id
  and cm.confirmation_send_type = 'weekly_summary';

alter table public.weekly_poll_schedules
  drop constraint if exists weekly_poll_schedules_confirmation_send_type_check;

alter table public.weekly_poll_schedules
  add constraint weekly_poll_schedules_confirmation_send_type_check
  check (confirmation_send_type in ('weekly_summary','per_event_day'));

alter table public.weekly_poll_schedules
  drop constraint if exists weekly_poll_schedules_confirmation_days_before_event_check;

alter table public.weekly_poll_schedules
  add constraint weekly_poll_schedules_confirmation_days_before_event_check
  check (
    (confirmation_send_type = 'weekly_summary' and confirmation_days_before_event is null)
    or
    (confirmation_send_type = 'per_event_day' and confirmation_days_before_event between 0 and 14)
  );

alter table public.confirmation_messages
  drop constraint if exists confirmation_messages_confirmation_send_type_check;

alter table public.confirmation_messages
  add constraint confirmation_messages_confirmation_send_type_check
  check (confirmation_send_type in ('weekly_summary','per_event_day'));

comment on column public.weekly_poll_schedules.confirmation_send_type is
  'weekly_summary sends one combined confirmation for the event week; per_event_day sends one confirmation per event date.';

comment on column public.weekly_poll_schedules.confirmation_days_before_event is
  'For per_event_day confirmations, number of local days before the event date when the confirmation is sent.';

comment on column public.confirmation_messages.confirmation_send_type is
  'Frozen confirmation delivery style copied from the weekly schedule or creation payload.';

create or replace function public.create_scheduled_event(
  p_payload jsonb, p_created_by uuid default null
) returns uuid language plpgsql security definer set search_path=public as $$
declare
  v_event_id uuid;
  v_poll_id uuid;
  v_shift jsonb;
  v_index integer := 0;
begin
  if jsonb_array_length(p_payload->'shifts') < 1 then raise exception 'at least one shift is required'; end if;
  insert into events(telegram_group_id,title,event_date,timezone,status,operational_tags,created_by)
  values ((p_payload->>'telegram_group_id')::uuid, p_payload->>'title',
    (p_payload->>'event_date')::date, coalesce(p_payload->>'timezone','Asia/Singapore'),
    'scheduled', coalesce(array(select jsonb_array_elements_text(p_payload->'operational_tags')), '{}'), p_created_by)
  returning id into v_event_id;

  for v_shift in select * from jsonb_array_elements(p_payload->'shifts') loop
    insert into event_shifts(event_id,label,start_time,end_time,capacity,display_order)
    values (v_event_id,v_shift->>'label',(v_shift->>'start_time')::time,
      (v_shift->>'end_time')::time,(v_shift->>'capacity')::integer,v_index);
    v_index := v_index + 1;
  end loop;

  insert into scheduled_polls(event_id,telegram_group_id,weekly_schedule_id,poll_title,
    poll_question,poll_options,specific_release_at,specific_release_day_of_week,
    specific_release_time,resolved_release_at,close_at,timezone,status,enabled,created_by,is_custom)
  values (v_event_id,(p_payload->>'telegram_group_id')::uuid,
    nullif(p_payload->>'weekly_schedule_id','')::uuid,p_payload->>'poll_title',p_payload->>'poll_question',
    (select case when count(*)=1 then jsonb_agg(s->>'label') || '["Not available"]'::jsonb
      else jsonb_agg(s->>'label') end from jsonb_array_elements(p_payload->'shifts') s),
    nullif(p_payload->>'specific_release_at','')::timestamptz,
    nullif(p_payload->>'specific_release_day_of_week','')::smallint,
    nullif(p_payload->>'specific_release_time','')::time,
    (p_payload->>'resolved_release_at')::timestamptz,(p_payload->>'close_at')::timestamptz,
    coalesce(p_payload->>'timezone','Asia/Singapore'),'scheduled',true,p_created_by,
    coalesce((p_payload->>'is_custom')::boolean,false))
  returning id into v_poll_id;

  insert into confirmation_messages(event_id,telegram_group_id,scheduled_poll_id,resolved_send_at,
    header_text,footer_text,show_waiting_list,show_empty_shifts,confirmation_send_type,status)
  values (v_event_id,(p_payload->>'telegram_group_id')::uuid,v_poll_id,
    (p_payload->>'resolved_confirmation_at')::timestamptz,p_payload->>'confirmation_header',
    p_payload->>'confirmation_footer',coalesce((p_payload->>'show_waiting_list')::boolean,false),
    coalesce((p_payload->>'show_empty_shifts')::boolean,true),
    coalesce(p_payload->>'confirmation_send_type','weekly_summary'),'scheduled');
  return v_poll_id;
end $$;

drop function if exists public.claim_due_confirmations(integer);

create function public.claim_due_confirmations(p_limit integer default 10)
returns table (
  id uuid, event_id uuid, scheduled_poll_id uuid, service text, telegram_chat_id bigint,
  telegram_message_id bigint, header_text text, footer_text text, resolved_send_at timestamptz,
  show_waiting_list boolean, show_empty_shifts boolean, confirmation_send_type text, claim_token uuid
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
    c.show_waiting_list, c.show_empty_shifts, c.confirmation_send_type, c.claim_token
  from claimed c join telegram_groups g on g.id=c.telegram_group_id and g.enabled;
end $$;

revoke all on function public.claim_due_confirmations(integer) from public, anon, authenticated;
