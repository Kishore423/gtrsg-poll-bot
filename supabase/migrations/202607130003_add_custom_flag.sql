-- Add is_custom flag to scheduled_polls so manually-created custom polls
-- can be distinguished from weekly-default sends.
alter table public.scheduled_polls
  add column if not exists is_custom boolean not null default false;

comment on column public.scheduled_polls.is_custom is
  'True when the poll was manually created via Create a Poll with custom shifts, false for standard weekly-default sends.';

-- Update create_scheduled_event to persist the is_custom flag from the payload.
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
    header_text,footer_text,show_waiting_list,show_empty_shifts,status)
  values (v_event_id,(p_payload->>'telegram_group_id')::uuid,v_poll_id,
    (p_payload->>'resolved_confirmation_at')::timestamptz,p_payload->>'confirmation_header',
    p_payload->>'confirmation_footer',coalesce((p_payload->>'show_waiting_list')::boolean,false),
    coalesce((p_payload->>'show_empty_shifts')::boolean,true),'scheduled');
  return v_poll_id;
end $$;
