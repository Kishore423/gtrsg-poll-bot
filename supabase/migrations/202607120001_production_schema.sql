begin;

create extension if not exists pgcrypto;

-- Compatibility tables preserve the current slot dashboard while new work is
-- created through the normalized event/scheduled-poll model below.
create table if not exists public.slots (
  id bigserial primary key, slot_date date not null, time_start text not null,
  time_end text not null, slot_count integer not null check (slot_count > 0),
  service text not null default 'WHCL' check (service in ('WHCL','PSA')),
  sent_at timestamptz
);
create table if not exists public.polls (
  id bigserial primary key, slot_date date not null,
  service text not null default 'WHCL' check (service in ('WHCL','PSA')),
  question text not null, provider_poll_id text not null unique,
  group_chat_id bigint not null, options jsonb not null, capacities jsonb not null,
  telegram_message_id bigint, confirmed_at timestamptz, created_at timestamptz not null default now()
);
create table if not exists public.votes (
  id bigserial primary key, poll_id bigint not null references public.polls(id) on delete cascade,
  option_name text not null, voter_id bigint not null, display_name text,
  voted_at_ms bigint not null, unique(poll_id, option_name, voter_id)
);
create table if not exists public.settings (key text primary key, value text not null);
create table if not exists public.targets (
  service text primary key check (service in ('WHCL','PSA')),
  chat_id bigint not null, title text, active boolean not null default true
);

create table if not exists public.admin_users (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null unique references auth.users(id) on delete cascade,
  role text not null default 'admin' check (role in ('admin', 'operator', 'viewer')),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.telegram_groups (
  id uuid primary key default gen_random_uuid(),
  telegram_chat_id bigint not null,
  group_name text not null,
  service text check (service in ('WHCL', 'PSA')),
  bot_id text not null default 'PRIMARY' check (bot_id in ('PRIMARY','WHCL','PSA')),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (telegram_chat_id, bot_id)
);

create table if not exists public.telegram_users (
  id uuid primary key default gen_random_uuid(),
  telegram_user_id bigint not null unique,
  telegram_username text,
  first_name text,
  last_name text,
  display_name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.weekly_poll_schedules (
  id uuid primary key default gen_random_uuid(),
  telegram_group_id uuid not null references public.telegram_groups(id) on delete cascade,
  event_category text,
  poll_release_day_of_week smallint not null check (poll_release_day_of_week between 0 and 6),
  poll_release_time time not null,
  confirmation_day_of_week smallint not null check (confirmation_day_of_week between 0 and 6),
  confirmation_time time not null,
  timezone text not null default 'Asia/Singapore',
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique nulls not distinct (telegram_group_id, event_category)
);

create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  telegram_group_id uuid not null references public.telegram_groups(id) on delete restrict,
  title text not null check (length(trim(title)) > 0),
  event_date date not null,
  timezone text not null default 'Asia/Singapore',
  status text not null default 'draft' check (status in ('draft', 'scheduled', 'open', 'closed', 'cancelled')),
  operational_tags text[] not null default '{}',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.event_shifts (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  label text not null check (length(trim(label)) > 0),
  start_time time not null,
  end_time time not null,
  capacity integer not null check (capacity >= 0),
  display_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (event_id, label),
  unique (event_id, display_order)
);

create table if not exists public.recurrence_series (
  id uuid primary key default gen_random_uuid(),
  recurrence_type text not null check (recurrence_type in ('weekly')),
  recurrence_rule jsonb not null default '{}',
  enabled boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.scheduled_polls (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  telegram_group_id uuid not null references public.telegram_groups(id) on delete restrict,
  weekly_schedule_id uuid references public.weekly_poll_schedules(id) on delete set null,
  poll_title text not null,
  poll_question text not null check (length(trim(poll_question)) between 1 and 300),
  poll_options jsonb not null check (jsonb_typeof(poll_options) = 'array' and jsonb_array_length(poll_options) between 2 and 10),
  specific_release_at timestamptz,
  specific_release_day_of_week smallint check (specific_release_day_of_week between 0 and 6),
  specific_release_time time,
  resolved_release_at timestamptz,
  close_at timestamptz,
  timezone text not null default 'Asia/Singapore',
  recurrence_series_id uuid references public.recurrence_series(id) on delete set null,
  recurrence_type text check (recurrence_type is null or recurrence_type in ('weekly')),
  recurrence_rule jsonb,
  status text not null default 'draft' check (status in ('draft','scheduled','queued','sending','sent','open','closed','cancelled','failed')),
  enabled boolean not null default true,
  telegram_poll_id text unique,
  telegram_message_id bigint,
  sent_at timestamptz,
  retry_count integer not null default 0 check (retry_count >= 0),
  last_error text,
  claim_token uuid,
  claimed_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (close_at is null or resolved_release_at is null or close_at > resolved_release_at),
  check (sent_at is null or telegram_poll_id is not null)
);

create table if not exists public.poll_response_events (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  scheduled_poll_id uuid not null references public.scheduled_polls(id) on delete cascade,
  telegram_poll_id text not null,
  telegram_user_id bigint not null,
  selected_option_ids integer[] not null default '{}',
  selected_shift_ids uuid[] not null default '{}',
  qualifying_response boolean not null,
  received_at timestamptz not null default clock_timestamp(),
  telegram_update_id bigint not null unique,
  raw_payload jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists public.poll_participants (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  shift_id uuid not null references public.event_shifts(id) on delete cascade,
  telegram_user_id bigint not null,
  current_response boolean not null default false,
  qualifying_since timestamptz,
  status text not null check (status in ('not_qualified','confirmed','waiting_list','withdrawn')),
  confirmed_position integer check (confirmed_position is null or confirmed_position > 0),
  waiting_list_position integer check (waiting_list_position is null or waiting_list_position > 0),
  updated_at timestamptz not null default now(),
  unique (event_id, shift_id, telegram_user_id),
  unique (event_id, shift_id, confirmed_position),
  unique (event_id, shift_id, waiting_list_position),
  check ((status = 'confirmed') = (confirmed_position is not null)),
  check ((status = 'waiting_list') = (waiting_list_position is not null))
);

create table if not exists public.webhook_events (
  id uuid primary key default gen_random_uuid(),
  telegram_update_id bigint not null unique,
  bot_id text not null default 'PRIMARY',
  update_type text not null,
  processing_status text not null default 'processing' check (processing_status in ('processing','processed','ignored','failed')),
  received_at timestamptz not null default clock_timestamp(),
  processed_at timestamptz,
  error text,
  created_at timestamptz not null default now()
);

create table if not exists public.confirmation_messages (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  telegram_group_id uuid not null references public.telegram_groups(id) on delete restrict,
  scheduled_poll_id uuid not null references public.scheduled_polls(id) on delete cascade,
  resolved_send_at timestamptz not null,
  confirmation_type text not null default 'final',
  header_text text,
  footer_text text,
  message_text text,
  telegram_message_id bigint,
  status text not null default 'scheduled' check (status in ('draft','scheduled','sending','sent','updated','failed','cancelled')),
  show_waiting_list boolean not null default false,
  show_empty_shifts boolean not null default true,
  sent_at timestamptz,
  updated_at timestamptz not null default now(),
  retry_count integer not null default 0 check (retry_count >= 0),
  last_error text,
  claim_token uuid,
  claimed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (event_id, confirmation_type)
);

create table if not exists public.allocation_audit_log (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  shift_id uuid not null references public.event_shifts(id) on delete cascade,
  telegram_user_id bigint not null,
  previous_status text,
  new_status text not null,
  previous_position integer,
  new_position integer,
  qualifying_timestamp timestamptz,
  reason text not null,
  changed_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists participants_qualifying_idx on public.poll_participants(event_id, shift_id, qualifying_since, telegram_user_id);
create index if not exists participants_status_idx on public.poll_participants(event_id, shift_id, status, qualifying_since, telegram_user_id);
create index if not exists response_poll_user_idx on public.poll_response_events(telegram_poll_id, telegram_user_id);
create index if not exists response_scheduled_user_idx on public.poll_response_events(scheduled_poll_id, telegram_user_id);
create index if not exists response_update_idx on public.poll_response_events(telegram_update_id);
create index if not exists scheduled_release_idx on public.scheduled_polls(resolved_release_at) where status in ('scheduled','failed');
create index if not exists scheduled_status_idx on public.scheduled_polls(status);
create index if not exists confirmation_send_idx on public.confirmation_messages(resolved_send_at) where status in ('scheduled','failed');
create index if not exists confirmation_status_idx on public.confirmation_messages(status);

create or replace function public.recalculate_shift_allocation(p_shift_id uuid, p_reason text default 'response')
returns void language plpgsql security definer set search_path = public as $$
declare
  v_event_id uuid;
  v_capacity integer;
  v_row record;
  v_confirmed integer := 0;
  v_waiting integer := 0;
  v_new_status text;
  v_new_position integer;
begin
  select event_id, capacity into v_event_id, v_capacity
  from event_shifts where id = p_shift_id for update;
  if not found then raise exception 'shift not found'; end if;

  for v_row in
    select * from poll_participants
    where event_id = v_event_id and shift_id = p_shift_id
    order by current_response desc, qualifying_since asc nulls last, telegram_user_id asc
    for update
  loop
    if not v_row.current_response then
      v_new_status := 'withdrawn'; v_new_position := null;
    elsif v_confirmed < v_capacity then
      v_confirmed := v_confirmed + 1; v_new_status := 'confirmed'; v_new_position := v_confirmed;
    else
      v_waiting := v_waiting + 1; v_new_status := 'waiting_list'; v_new_position := v_waiting;
    end if;

    if v_row.status is distinct from v_new_status
       or coalesce(v_row.confirmed_position, v_row.waiting_list_position) is distinct from v_new_position then
      insert into allocation_audit_log(event_id, shift_id, telegram_user_id, previous_status,
        new_status, previous_position, new_position, qualifying_timestamp, reason)
      values (v_event_id, p_shift_id, v_row.telegram_user_id, v_row.status, v_new_status,
        coalesce(v_row.confirmed_position, v_row.waiting_list_position), v_new_position,
        v_row.qualifying_since, p_reason);
    end if;

    update poll_participants set status = v_new_status,
      confirmed_position = case when v_new_status = 'confirmed' then v_new_position end,
      waiting_list_position = case when v_new_status = 'waiting_list' then v_new_position end,
      updated_at = now()
    where id = v_row.id;
  end loop;
end $$;

create or replace function public.apply_poll_response(
  p_update_id bigint, p_poll_id text, p_user_id bigint, p_username text,
  p_first_name text, p_last_name text, p_display_name text,
  p_option_ids integer[], p_raw_payload jsonb, p_bot_id text default 'PRIMARY'
) returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_poll scheduled_polls%rowtype;
  v_group_bot text;
  v_shift event_shifts%rowtype;
  v_selected boolean;
  v_now timestamptz := clock_timestamp();
begin
  insert into webhook_events(telegram_update_id, bot_id, update_type)
  values (p_update_id, p_bot_id, 'poll_answer')
  on conflict (telegram_update_id) do nothing;
  if not found then return false; end if;

  select * into v_poll from scheduled_polls where telegram_poll_id = p_poll_id for update;
  if not found then
    update webhook_events set processing_status='ignored', processed_at=clock_timestamp()
    where telegram_update_id=p_update_id;
    return true;
  end if;
  select bot_id into v_group_bot from telegram_groups where id=v_poll.telegram_group_id;
  if p_bot_id is distinct from v_group_bot then
    update webhook_events set processing_status='ignored', processed_at=clock_timestamp(),
      error='poll belongs to a different bot' where telegram_update_id=p_update_id;
    return true;
  end if;

  insert into telegram_users(telegram_user_id, telegram_username, first_name, last_name, display_name)
  values (p_user_id, p_username, p_first_name, p_last_name, p_display_name)
  on conflict (telegram_user_id) do update set telegram_username=excluded.telegram_username,
    first_name=excluded.first_name, last_name=excluded.last_name,
    display_name=excluded.display_name, updated_at=now();

  insert into poll_response_events(event_id, scheduled_poll_id, telegram_poll_id,
    telegram_user_id, selected_option_ids, selected_shift_ids, qualifying_response,
    received_at, telegram_update_id, raw_payload)
  select v_poll.event_id, v_poll.id, p_poll_id, p_user_id, p_option_ids,
    coalesce(array_agg(s.id order by s.display_order) filter (where s.id is not null), '{}'),
    cardinality(p_option_ids) > 0, v_now, p_update_id, p_raw_payload
  from event_shifts s where s.event_id=v_poll.event_id
    and s.display_order = any(p_option_ids);

  for v_shift in select * from event_shifts where event_id=v_poll.event_id for update loop
    v_selected := v_shift.display_order = any(p_option_ids);
    insert into poll_participants(event_id, shift_id, telegram_user_id, current_response,
      qualifying_since, status)
    values (v_poll.event_id, v_shift.id, p_user_id, v_selected,
      case when v_selected then v_now end, case when v_selected then 'not_qualified' else 'withdrawn' end)
    on conflict (event_id, shift_id, telegram_user_id) do update set
      current_response=excluded.current_response,
      qualifying_since=case
        when excluded.current_response and not poll_participants.current_response then excluded.qualifying_since
        when excluded.current_response then poll_participants.qualifying_since
        else null end,
      status=case when excluded.current_response then poll_participants.status else 'withdrawn' end,
      confirmed_position=case when excluded.current_response then poll_participants.confirmed_position end,
      waiting_list_position=case when excluded.current_response then poll_participants.waiting_list_position end,
      updated_at=now();
    perform recalculate_shift_allocation(v_shift.id, 'telegram_response');
  end loop;

  update webhook_events set processing_status='processed', processed_at=clock_timestamp()
  where telegram_update_id=p_update_id;
  update confirmation_messages set status='scheduled', resolved_send_at=clock_timestamp(), updated_at=now()
  where scheduled_poll_id=v_poll.id and status in ('sent','updated');
  return true;
exception when others then
  update webhook_events set processing_status='failed', processed_at=clock_timestamp(), error=sqlerrm
  where telegram_update_id=p_update_id;
  return false;
end $$;

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
    from candidates c where sp.id=c.id
    returning sp.*
  )
  select c.id, c.event_id, c.telegram_group_id, g.bot_id,
    g.telegram_chat_id, c.poll_question, c.poll_options, c.claim_token
  from claimed c
  join events e on e.id=c.event_id
  join telegram_groups g on g.id=c.telegram_group_id and g.enabled
  order by e.event_date, c.resolved_release_at, c.id;
end $$;

create or replace function public.create_scheduled_event(p_payload jsonb, p_created_by uuid)
returns uuid language plpgsql security definer set search_path=public as $$
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
    specific_release_time,resolved_release_at,close_at,timezone,status,enabled,created_by)
  values (v_event_id,(p_payload->>'telegram_group_id')::uuid,
    nullif(p_payload->>'weekly_schedule_id','')::uuid,p_payload->>'poll_title',p_payload->>'poll_question',
    (select case when count(*)=1 then jsonb_agg(s->>'label') || '["Not available"]'::jsonb
      else jsonb_agg(s->>'label') end from jsonb_array_elements(p_payload->'shifts') s),
    nullif(p_payload->>'specific_release_at','')::timestamptz,
    nullif(p_payload->>'specific_release_day_of_week','')::smallint,
    nullif(p_payload->>'specific_release_time','')::time,
    (p_payload->>'resolved_release_at')::timestamptz,(p_payload->>'close_at')::timestamptz,
    coalesce(p_payload->>'timezone','Asia/Singapore'),'scheduled',true,p_created_by)
  returning id into v_poll_id;

  insert into confirmation_messages(event_id,telegram_group_id,scheduled_poll_id,resolved_send_at,
    header_text,footer_text,show_waiting_list,show_empty_shifts,status)
  values (v_event_id,(p_payload->>'telegram_group_id')::uuid,v_poll_id,
    (p_payload->>'resolved_confirmation_at')::timestamptz,p_payload->>'confirmation_header',
    p_payload->>'confirmation_footer',coalesce((p_payload->>'show_waiting_list')::boolean,false),
    coalesce((p_payload->>'show_empty_shifts')::boolean,true),'scheduled');
  return v_poll_id;
end $$;

create or replace function public.complete_poll_send(
  p_id uuid, p_claim_token uuid, p_telegram_poll_id text, p_message_id bigint
) returns boolean language plpgsql security definer set search_path=public as $$
begin
  update scheduled_polls set telegram_poll_id=p_telegram_poll_id,
    telegram_message_id=p_message_id, sent_at=clock_timestamp(), status='open',
    claim_token=null, claimed_at=null, last_error=null, updated_at=now()
  where id=p_id and claim_token=p_claim_token and status='sending' and sent_at is null;
  return found;
end $$;

create or replace function public.fail_poll_send(p_id uuid, p_claim_token uuid, p_error text)
returns void language sql security definer set search_path=public as $$
  update scheduled_polls set status='failed', retry_count=retry_count+1,
    last_error=left(p_error, 1000), claim_token=null, claimed_at=null, updated_at=now()
  where id=p_id and claim_token=p_claim_token and status='sending' and sent_at is null
$$;

create or replace function public.claim_due_poll_closures(p_limit integer default 10)
returns table(id uuid,service text,telegram_chat_id bigint,telegram_message_id bigint,claim_token uuid)
language plpgsql security definer set search_path=public as $$
begin
  return query with candidates as (
    select sp.id from scheduled_polls sp where sp.status='open' and sp.close_at <= now()
    order by sp.close_at for update skip locked limit greatest(1,least(p_limit,50))
  ), claimed as (
    update scheduled_polls sp set status='queued',claim_token=gen_random_uuid(),claimed_at=now(),updated_at=now()
    from candidates c where sp.id=c.id returning sp.*
  ) select c.id,g.bot_id,g.telegram_chat_id,c.telegram_message_id,c.claim_token
    from claimed c join telegram_groups g on g.id=c.telegram_group_id;
end $$;

create or replace function public.complete_poll_close(p_id uuid,p_claim_token uuid,p_error text default null)
returns boolean language plpgsql security definer set search_path=public as $$
begin
  update scheduled_polls set status=case when p_error is null then 'closed' else 'failed' end,
    last_error=left(p_error,1000),retry_count=retry_count+case when p_error is null then 0 else 1 end,
    claim_token=null,claimed_at=null,updated_at=now()
  where id=p_id and claim_token=p_claim_token and status='queued';
  return found;
end $$;

create or replace function public.claim_due_confirmations(p_limit integer default 10)
returns table (
  id uuid, event_id uuid, scheduled_poll_id uuid, service text, telegram_chat_id bigint,
  telegram_message_id bigint, header_text text, footer_text text,
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
    g.telegram_chat_id, c.telegram_message_id, c.header_text, c.footer_text,
    c.show_waiting_list, c.show_empty_shifts, c.claim_token
  from claimed c join telegram_groups g on g.id=c.telegram_group_id and g.enabled;
end $$;

create or replace function public.complete_confirmation_send(
  p_id uuid, p_claim_token uuid, p_message_id bigint, p_message_text text, p_was_edit boolean
) returns boolean language plpgsql security definer set search_path=public as $$
begin
  update confirmation_messages set telegram_message_id=p_message_id,
    message_text=p_message_text, sent_at=coalesce(sent_at, clock_timestamp()),
    status=case when p_was_edit then 'updated' else 'sent' end,
    claim_token=null, claimed_at=null, last_error=null, updated_at=now()
  where id=p_id and claim_token=p_claim_token and status='sending';
  return found;
end $$;

create or replace function public.fail_confirmation_send(p_id uuid, p_claim_token uuid, p_error text)
returns void language sql security definer set search_path=public as $$
  update confirmation_messages set status='failed', retry_count=retry_count+1,
    last_error=left(p_error, 1000), claim_token=null, claimed_at=null, updated_at=now()
  where id=p_id and claim_token=p_claim_token and status='sending'
$$;

alter table public.admin_users enable row level security;
alter table public.telegram_groups enable row level security;
alter table public.telegram_users enable row level security;
alter table public.weekly_poll_schedules enable row level security;
alter table public.events enable row level security;
alter table public.event_shifts enable row level security;
alter table public.recurrence_series enable row level security;
alter table public.scheduled_polls enable row level security;
alter table public.poll_response_events enable row level security;
alter table public.poll_participants enable row level security;
alter table public.webhook_events enable row level security;
alter table public.confirmation_messages enable row level security;
alter table public.allocation_audit_log enable row level security;
alter table public.slots enable row level security;
alter table public.polls enable row level security;
alter table public.votes enable row level security;
alter table public.settings enable row level security;
alter table public.targets enable row level security;

create or replace function public.is_enabled_admin() returns boolean
language sql stable security definer set search_path=public as $$
  select exists(select 1 from admin_users where auth_user_id=auth.uid() and enabled)
$$;

do $$ declare t text; begin
  foreach t in array array['slots','polls','votes','settings','targets',
    'telegram_groups','telegram_users','weekly_poll_schedules','events',
    'event_shifts','recurrence_series','scheduled_polls','poll_response_events','poll_participants',
    'webhook_events','confirmation_messages','allocation_audit_log']
  loop
    execute format('create policy "enabled admins" on public.%I for all to authenticated using (public.is_enabled_admin()) with check (public.is_enabled_admin())', t);
  end loop;
end $$;

create policy "admin can read own record" on public.admin_users for select to authenticated
using (auth_user_id=auth.uid());

revoke all on function public.apply_poll_response(bigint,text,bigint,text,text,text,text,integer[],jsonb,text) from public, anon, authenticated;
revoke all on function public.recalculate_shift_allocation(uuid,text) from public, anon, authenticated;
revoke all on function public.claim_due_polls(integer) from public, anon, authenticated;
revoke all on function public.create_scheduled_event(jsonb,uuid) from public, anon, authenticated;
revoke all on function public.complete_poll_send(uuid,uuid,text,bigint) from public, anon, authenticated;
revoke all on function public.fail_poll_send(uuid,uuid,text) from public, anon, authenticated;
revoke all on function public.claim_due_poll_closures(integer) from public, anon, authenticated;
revoke all on function public.complete_poll_close(uuid,uuid,text) from public, anon, authenticated;
revoke all on function public.claim_due_confirmations(integer) from public, anon, authenticated;
revoke all on function public.complete_confirmation_send(uuid,uuid,bigint,text,boolean) from public, anon, authenticated;
revoke all on function public.fail_confirmation_send(uuid,uuid,text) from public, anon, authenticated;

commit;
