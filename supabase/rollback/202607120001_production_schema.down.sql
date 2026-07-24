begin;
drop function if exists public.fail_confirmation_send(uuid,uuid,text);
drop function if exists public.complete_confirmation_send(uuid,uuid,bigint,text,boolean);
drop function if exists public.claim_due_confirmations(integer);
drop function if exists public.fail_poll_send(uuid,uuid,text);
drop function if exists public.complete_poll_close(uuid,uuid,text);
drop function if exists public.claim_due_poll_closures(integer);
drop function if exists public.complete_poll_send(uuid,uuid,text,bigint);
drop function if exists public.claim_due_polls(integer);
drop function if exists public.create_scheduled_event(jsonb,uuid);
drop function if exists public.apply_poll_response(bigint,text,bigint,text,text,text,text,integer[],jsonb,text);
drop function if exists public.recalculate_shift_allocation(uuid,text);
drop function if exists public.is_enabled_admin();
drop table if exists public.allocation_audit_log;
drop table if exists public.confirmation_messages;
drop table if exists public.webhook_events;
drop table if exists public.poll_participants;
drop table if exists public.poll_response_events;
drop table if exists public.scheduled_polls;
drop table if exists public.recurrence_series;
drop table if exists public.event_shifts;
drop table if exists public.events;
drop table if exists public.weekly_poll_schedules;
drop table if exists public.telegram_users;
drop table if exists public.telegram_groups;
drop table if exists public.admin_users;
commit;


