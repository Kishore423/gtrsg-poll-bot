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
    where sp.enabled and sp.status in ('scheduled','failed')
      and sp.resolved_release_at <= now()
      and (sp.claimed_at is null or sp.claimed_at < now() - interval '10 minutes')
    order by e.event_date, sp.resolved_release_at, sp.id
    for update skip locked limit greatest(1, least(p_limit, 50))
  ), claimed as (
    update scheduled_polls sp set status='sending', claim_token=gen_random_uuid(),
      claimed_at=now(), updated_at=now()
    from candidates c where sp.id=c.id returning sp.*
  )
  select c.id, c.event_id, c.telegram_group_id, g.bot_id,
    g.telegram_chat_id, c.poll_question, c.poll_options, c.claim_token
  from claimed c
  join events e on e.id=c.event_id
  join telegram_groups g on g.id=c.telegram_group_id and g.enabled
  order by e.event_date, c.resolved_release_at, c.id;
end $$;
