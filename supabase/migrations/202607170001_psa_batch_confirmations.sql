-- Return resolved_send_at with claimed confirmations so the app can group PSA
-- confirmations into one batch message while leaving WHCL as one message per poll.
drop function if exists public.claim_due_confirmations(integer);

create function public.claim_due_confirmations(p_limit integer default 10)
returns table (
  id uuid, event_id uuid, scheduled_poll_id uuid, service text, telegram_chat_id bigint,
  telegram_message_id bigint, header_text text, footer_text text, resolved_send_at timestamptz,
  show_waiting_list boolean, show_empty_shifts boolean, claim_token uuid
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
  select c.id, c.event_id, c.scheduled_poll_id, g.bot_id,
    g.telegram_chat_id, c.telegram_message_id, c.header_text, c.footer_text, c.resolved_send_at,
    c.show_waiting_list, c.show_empty_shifts, c.claim_token
  from claimed c join telegram_groups g on g.id=c.telegram_group_id and g.enabled;
end $$;
