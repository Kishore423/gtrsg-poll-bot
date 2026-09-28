-- Keep new release batches moving even when older Telegram sends are retrying.
-- Also prevent a confirmation message for a poll that was never posted.

create or replace function public.claim_due_polls(p_limit integer default 10)
returns table (
  id uuid, event_id uuid, telegram_group_id uuid, service text, telegram_chat_id bigint,
  poll_question text, poll_options jsonb, claim_token uuid
) language plpgsql security definer set search_path=public as $$
begin
  return query
  with candidates as (
    select sp.id
    from scheduled_polls sp
    join events e on e.id=sp.event_id
    left join weekly_poll_schedules w on w.id=sp.weekly_schedule_id
    where sp.enabled and sp.status in ('scheduled','failed')
      and sp.resolved_release_at <= now()
      and (sp.claimed_at is null or sp.claimed_at < now() - interval '10 minutes')
      and (w.id is null or not w.testing_mode or
        ('template-testing:' || w.testing_batch_id::text)=any(e.operational_tags))
    order by case when sp.status = 'scheduled' then 0 else 1 end,
      sp.resolved_release_at, e.event_date, sp.id
    for update of sp skip locked limit greatest(1, least(p_limit, 50))
  ), claimed as (
    update scheduled_polls sp set status='sending', claim_token=gen_random_uuid(),
      claimed_at=now(), updated_at=now()
    from candidates c where sp.id=c.id
    returning sp.*
  )
  select c.id, c.event_id, c.telegram_group_id, coalesce(g.bot_ref::text, g.bot_id),
    g.telegram_chat_id, c.poll_question, c.poll_options, c.claim_token
  from claimed c
  join events e on e.id=c.event_id
  join telegram_groups g on g.id=c.telegram_group_id and g.enabled
  order by e.event_date, c.resolved_release_at, c.id;
end $$;

create or replace function public.claim_due_confirmations(p_limit integer default 10)
returns table (
  id uuid, event_id uuid, scheduled_poll_id uuid, service text, telegram_chat_id bigint,
  telegram_message_id bigint, header_text text, footer_text text, resolved_send_at timestamptz,
  show_waiting_list boolean, show_empty_shifts boolean, confirmation_send_type text, claim_token uuid
) language plpgsql security definer set search_path=public as $$
begin
  return query
  with candidates as (
    select cm.id from confirmation_messages cm
    join scheduled_polls sp on sp.id=cm.scheduled_poll_id
    join events e on e.id=sp.event_id
    left join weekly_poll_schedules w on w.id=sp.weekly_schedule_id
    where cm.status in ('scheduled','failed') and cm.resolved_send_at <= now()
      and sp.telegram_poll_id is not null
      and (cm.claimed_at is null or cm.claimed_at < now() - interval '10 minutes')
      and (w.id is null or not w.testing_mode or
        ('template-testing:' || w.testing_batch_id::text)=any(e.operational_tags))
    order by cm.resolved_send_at, cm.id
    for update of cm skip locked limit greatest(1, least(p_limit, 50))
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
