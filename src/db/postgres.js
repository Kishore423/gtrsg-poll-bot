const postgres = require('postgres');

function createSql(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) throw new Error('DATABASE_URL is required for Supabase PostgreSQL.');
  return postgres(connectionString, { ssl: 'require', max: 2, idle_timeout: 20 });
}

function createPostgresDb(sql = createSql()) {
  // Alter unique constraint on telegram_groups to allow duplicate chat_ids with different bot_ids
  const initPromise = (async () => {
    await sql`ALTER TABLE telegram_groups DROP CONSTRAINT IF EXISTS telegram_groups_telegram_chat_id_key`;
    await sql`ALTER TABLE telegram_groups DROP CONSTRAINT IF EXISTS telegram_groups_telegram_chat_id_unique`;
    await sql`ALTER TABLE telegram_groups ADD CONSTRAINT telegram_groups_chat_id_bot_id_key UNIQUE (telegram_chat_id, bot_id)`;
    await sql`
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
    `;
    await sql`
      create or replace function public.claim_due_confirmations(p_limit integer default 10)
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
    `;
  })().catch(err => {
    if (!err.message.includes('already exists')) {
      console.error('Migration error altering telegram_groups constraint:', err.message);
    }
  });

  return {
    async insertSlot({ slot_date, time_start, time_end, slot_count, service = 'WHCL' }) {
      const [row] = await sql`insert into slots (slot_date,time_start,time_end,slot_count,service)
        values (${slot_date},${time_start},${time_end},${slot_count},${service}) returning id`;
      return Number(row.id);
    },
    async deleteSlot(id) { await sql`delete from slots where id=${id}`; },
    async listUpcomingSlots() {
      return sql`select id,slot_date::text,time_start,time_end,slot_count,service,sent_at
        from slots where slot_date >= (now() at time zone 'Asia/Singapore')::date
        order by slot_date,time_start`;
    },
    async listUnsentSlots() {
      return sql`select id,slot_date::text,time_start,time_end,slot_count,service,sent_at
        from slots where sent_at is null order by slot_date,time_start`;
    },
    async markSlotsSent(ids) {
      if (ids.length) await sql`update slots set sent_at=now() where id in ${sql(ids)}`;
    },
    async insertPoll({ slot_date, service, question, provider_poll_id, group_chat_id,
      options, capacities, telegram_message_id = null }) {
      const [row] = await sql`insert into polls
        (slot_date,service,question,provider_poll_id,group_chat_id,options,capacities,telegram_message_id)
        values (${slot_date},${service},${question},${String(provider_poll_id)},${String(group_chat_id)},
          ${sql.json(options)},${sql.json(capacities)},${telegram_message_id}) returning id`;
      return Number(row.id);
    },
    async getPollByProviderPollId(id) {
      const [row] = await sql`select *,slot_date::text from polls where provider_poll_id=${String(id)}`;
      return row || null;
    },
    async getPollById(id) {
      const [row] = await sql`select *,slot_date::text from polls where id=${id}`;
      return row || null;
    },
    async listPolls() { return sql`select *,slot_date::text from polls order by slot_date desc,id desc`; },
    async markPollConfirmed(id, messageId = null) {
      await sql`update polls set confirmed_at=now(),telegram_message_id=coalesce(${messageId},telegram_message_id) where id=${id}`;
    },
    async upsertVoterVote(pollId, { voter_id, option_names, voted_at_ms = Date.now(), display_name }) {
      await sql.begin(async (tx) => {
        const vid = String(voter_id);
        await tx`select id from polls where id=${pollId} for update`;
        if (option_names.length) {
          await tx`delete from votes where poll_id=${pollId} and voter_id=${vid}
            and option_name not in ${tx(option_names)}`;
        } else await tx`delete from votes where poll_id=${pollId} and voter_id=${vid}`;
        for (const name of option_names) {
          await tx`insert into votes (poll_id,option_name,voter_id,display_name,voted_at_ms)
            values (${pollId},${name},${vid},${display_name},${voted_at_ms})
            on conflict (poll_id,option_name,voter_id) do update set display_name=excluded.display_name`;
        }
      });
    },
    async getVotesForPoll(pollId) {
      return sql`select option_name,voter_id::text,display_name,voted_at_ms
        from votes where poll_id=${pollId} order by voted_at_ms,voter_id`;
    },
    async getSetting(key) { const [r] = await sql`select value from settings where key=${key}`; return r?.value ?? null; },
    async setSetting(key, value) {
      await sql`insert into settings (key,value) values (${key},${String(value)})
        on conflict (key) do update set value=excluded.value`;
    },
    async setTarget(service, { chat_id, title, active }) {
      await sql`insert into targets (service,chat_id,title,active)
        values (${service},${String(chat_id)},${title ?? null},${!!active})
        on conflict (service) do update set chat_id=excluded.chat_id,title=excluded.title,active=excluded.active`;
    },
    async getTarget(service) { const [r] = await sql`select * from targets where service=${service} and active`; return r || null; },
    async listTargets() { return sql`select service,chat_id::text,title,active from targets order by service`; },
    async beginWebhookEvent(updateId, botId, updateType) {
      const rows = await sql`insert into webhook_events (telegram_update_id,bot_id,update_type)
        values (${updateId},${botId},${updateType}) on conflict (telegram_update_id) do nothing returning id`;
      return rows.length === 1;
    },
    async finishWebhookEvent(updateId, status = 'processed', error = null) {
      await sql`update webhook_events set processing_status=${status},processed_at=clock_timestamp(),error=${error}
        where telegram_update_id=${updateId}`;
    },
    async createScheduledEvent(payload, createdBy) {
      const [row] = await sql`select create_scheduled_event(${sql.json(payload)},${createdBy}::uuid) as id`;
      return row.id;
    },
    async listScheduledPolls() {
      return sql`select sp.*,e.title,e.event_date,e.operational_tags,g.group_name,g.telegram_chat_id,
        cm.status as confirmation_status,cm.resolved_send_at
        from scheduled_polls sp join events e on e.id=sp.event_id
        join telegram_groups g on g.id=sp.telegram_group_id
        left join confirmation_messages cm on cm.scheduled_poll_id=sp.id
        order by e.event_date asc, g.group_name asc, sp.resolved_release_at asc, sp.created_at asc`;
    },
    // botId scopes the list to one user's bot; admins pass nothing to see all.
    async listTelegramGroups({ botId = null } = {}) {
      if (botId) {
        return sql`select id,telegram_chat_id::text,group_name,service,bot_id,enabled
          from telegram_groups where bot_id = ${botId} order by group_name`;
      }
      return sql`select id,telegram_chat_id::text,group_name,service,bot_id,enabled
        from telegram_groups order by group_name`;
    },

    // ---- Bots (one per user) -------------------------------------------------
    async createBot({ bot_name, telegram_username, telegram_bot_id, token_encrypted, webhook_secret }) {
      const [row] = await sql`
        insert into bots (bot_name, telegram_username, telegram_bot_id, token_encrypted, webhook_secret)
        values (${bot_name}, ${telegram_username ?? null}, ${telegram_bot_id ?? null},
                ${token_encrypted}, ${webhook_secret})
        returning id`;
      return row.id;
    },

    async listBots() {
      return sql`select id, bot_name, telegram_username, telegram_bot_id, enabled,
        name_synced_at, created_at from bots order by bot_name`;
    },

    async getBot(id) {
      const [row] = await sql`select * from bots where id = ${id}`;
      return row || null;
    },

    // Records the name Telegram confirmed; the app never invents a name.
    async setBotName(id, botName) {
      const [row] = await sql`
        update bots set bot_name = ${botName}, name_synced_at = now(), updated_at = now()
        where id = ${id} returning id, bot_name, telegram_username, name_synced_at`;
      return row || null;
    },

    async deleteBot(id) {
      const [row] = await sql`delete from bots where id = ${id} returning id`;
      return row || null;
    },

    // ---- App users (the SSO allow-list) --------------------------------------
    async createAppUser({ email, role = 'user', bot_id = null }) {
      const [row] = await sql`
        insert into app_users (email, role, bot_id)
        values (${String(email).toLowerCase()}, ${role}, ${bot_id})
        returning id`;
      return row.id;
    },

    async listAppUsers() {
      return sql`
        select u.id, u.email, u.role, u.enabled, u.bot_id, u.auth_user_id, u.created_at,
               b.bot_name, b.telegram_username, b.name_synced_at
        from app_users u left join bots b on b.id = u.bot_id
        order by u.role desc, u.email`;
    },

    // Email is the join key between the Microsoft identity and the allow-list.
    async getAppUserByEmail(email) {
      const [row] = await sql`
        select id, email, role, enabled, bot_id, auth_user_id
        from app_users where email = ${String(email).toLowerCase()} and enabled`;
      return row || null;
    },

    async setAppUserAuthId(id, authUserId) {
      const [row] = await sql`
        update app_users set auth_user_id = ${authUserId}, updated_at = now()
        where id = ${id} returning id`;
      return row || null;
    },

    async setAppUserRole(id, role) {
      const [row] = await sql`
        update app_users set role = ${role}, updated_at = now()
        where id = ${id} returning id, email, role`;
      return row || null;
    },

    async deleteAppUser(id) {
      const [row] = await sql`delete from app_users where id = ${id} returning id, bot_id`;
      return row || null;
    },
    async createTelegramGroup({ telegram_chat_id, group_name, service = null, bot_id = 'PRIMARY' }) {
      const [row] = await sql`insert into telegram_groups(telegram_chat_id,group_name,service,bot_id)
        values (${telegram_chat_id},${group_name},${service},${bot_id}) returning id`;
      return row.id;
    },
    async upsertTelegramGroupFromWebhook({ telegram_chat_id, group_name, service, bot_id }) {
      const [row] = await sql`
        insert into telegram_groups(telegram_chat_id,group_name,service,bot_id,enabled)
        values (${telegram_chat_id},${group_name},${service},${bot_id},true)
        on conflict (telegram_chat_id,bot_id) do update set
          group_name=excluded.group_name,
          service=excluded.service,
          enabled=true,
          updated_at=now()
        returning id`;
      return row.id;
    },
    async getTelegramGroup(id) {
      const [row] = await sql`select id,telegram_chat_id::text,group_name,service,bot_id,enabled
        from telegram_groups where id=${id}::uuid`;
      return row || null;
    },
    async deleteTelegramGroup(id) {
      await sql.begin(async (tx) => {
        const [oldGroup] = await tx`
          select id, coalesce(service, bot_id, 'PRIMARY') as route
          from telegram_groups
          where id=${id}::uuid
          for update`;
        if (!oldGroup) return;

        const [replacement] = await tx`
          select id
          from telegram_groups
          where id<>${id}::uuid
            and enabled
            and coalesce(service, bot_id, 'PRIMARY')=${oldGroup.route}
          order by created_at desc, id desc
          limit 1`;

        if (replacement) {
          await tx`
            insert into poll_release_exclusions(telegram_group_id,event_date)
            select ${replacement.id},event_date
            from poll_release_exclusions
            where telegram_group_id=${id}::uuid
            on conflict (telegram_group_id,event_date) do nothing`;
          await tx`delete from poll_release_exclusions where telegram_group_id=${id}::uuid`;
          await tx`update weekly_poll_schedules set telegram_group_id=${replacement.id}, updated_at=now()
            where telegram_group_id=${id}::uuid`;
          await tx`update events set telegram_group_id=${replacement.id}, updated_at=now()
            where telegram_group_id=${id}::uuid`;
          await tx`update scheduled_polls set telegram_group_id=${replacement.id}, updated_at=now()
            where telegram_group_id=${id}::uuid`;
          await tx`update confirmation_messages set telegram_group_id=${replacement.id}, updated_at=now()
            where telegram_group_id=${id}::uuid`;
        } else {
          const [refs] = await tx`
            select
              (select count(*) from weekly_poll_schedules where telegram_group_id=${id}::uuid) +
              (select count(*) from events where telegram_group_id=${id}::uuid) +
              (select count(*) from scheduled_polls where telegram_group_id=${id}::uuid) +
              (select count(*) from confirmation_messages where telegram_group_id=${id}::uuid) as count`;
          if (Number(refs.count) > 0) {
            const error = new Error('Add another enabled group for this service before deleting this group, so existing polls can be moved instead of removed.');
            error.statusCode = 409;
            throw error;
          }
        }

        await tx`delete from telegram_groups where id=${id}::uuid`;
      });
    },
    async listManagedWeeklySchedules() {
      return sql`select w.*,g.group_name,g.service,g.bot_id from weekly_poll_schedules w
        join telegram_groups g on g.id=w.telegram_group_id order by g.group_name,w.event_category nulls first`;
    },
    async upsertManagedWeeklySchedule(value) {
      const [row] = await sql`insert into weekly_poll_schedules
        (telegram_group_id,event_category,poll_release_day_of_week,poll_release_time,
          confirmation_day_of_week,confirmation_time,timezone,enabled,shifts)
        values (${value.telegram_group_id}::uuid,${value.event_category || null},
          ${value.poll_release_day_of_week},${value.poll_release_time},
          ${value.confirmation_day_of_week},${value.confirmation_time},${value.timezone},${value.enabled},
          ${sql.json(value.shifts || [])})
        on conflict (telegram_group_id,event_category) do update set
          poll_release_day_of_week=excluded.poll_release_day_of_week,
          poll_release_time=excluded.poll_release_time,
          confirmation_day_of_week=excluded.confirmation_day_of_week,
          confirmation_time=excluded.confirmation_time,timezone=excluded.timezone,
          enabled=excluded.enabled,shifts=excluded.shifts,updated_at=now() returning *`;
      return row;
    },
    async deleteManagedWeeklySchedule(id) {
      await sql`delete from weekly_poll_schedules where id=${id}::uuid`;
    },
    async listPollExclusions(telegramGroupId = null) {
      return telegramGroupId
        ? sql`select id,telegram_group_id,event_date::text,created_at
            from poll_release_exclusions
            where telegram_group_id=${telegramGroupId}::uuid
            order by event_date,id`
        : sql`select id,telegram_group_id,event_date::text,created_at
            from poll_release_exclusions order by event_date,id`;
    },
    async upsertPollExclusion({ telegram_group_id, event_date }) {
      return sql.begin(async (tx) => {
        const [row] = await tx`
          insert into poll_release_exclusions(telegram_group_id,event_date)
          values (${telegram_group_id}::uuid,${event_date}::date)
          on conflict (telegram_group_id,event_date) do update set event_date=excluded.event_date
          returning id,telegram_group_id,event_date::text,created_at`;
        const removed = await tx`
          delete from scheduled_polls sp
          using events e
          where sp.event_id=e.id
            and sp.telegram_group_id=${telegram_group_id}::uuid
            and e.event_date=${event_date}::date
            and not sp.is_custom
            and not ('test'=any(e.operational_tags))
            and sp.status in ('draft','scheduled','failed')
          returning sp.id`;
        const [active] = await tx`
          select sp.status
          from scheduled_polls sp join events e on e.id=sp.event_id
          where sp.telegram_group_id=${telegram_group_id}::uuid
            and e.event_date=${event_date}::date
            and not sp.is_custom
            and not ('test'=any(e.operational_tags))
            and sp.status not in ('cancelled','failed')
          order by sp.created_at desc limit 1`;
        return {
          ...row,
          removed_unsent_polls: removed.length,
          active_poll_status: active?.status || null,
        };
      });
    },
    async deletePollExclusion(id) {
      const rows = await sql`delete from poll_release_exclusions where id=${id}::uuid returning id`;
      return rows[0] || null;
    },
    async isPollDateExcluded(telegramGroupId, eventDate) {
      const [row] = await sql`
        select exists(
          select 1 from poll_release_exclusions
          where telegram_group_id=${telegramGroupId}::uuid and event_date=${eventDate}::date
        ) as excluded`;
      return Boolean(row?.excluded);
    },
    async deleteScheduledPoll(id) {
      // Only delete polls that are in a terminal state (not active/sending).
      const rows = await sql`
        delete from scheduled_polls
        where id=${id}::uuid
          and status in ('cancelled','closed','sent','failed')
        returning id`;
      return rows[0] || null;
    },
    async deleteAllScheduledPolls() {
      return sql`delete from scheduled_polls returning id,status`;
    },
    async deleteScheduledPollsByIds(ids) {
      return sql`delete from scheduled_polls where id = any(${ids}::uuid[]) returning id,status`;
    },
    async updateScheduledPollAction(id, action) {
      const transitions = {
        cancel: sql`status in ('draft','scheduled','failed')`,
        retry: sql`status='failed'`,
        send_now: sql`status in ('draft','scheduled','failed')`,
      };
      if (!transitions[action]) return null;
      const next = action === 'cancel' ? 'cancelled' : 'scheduled';
      const release = action === 'send_now' ? sql`now()` : sql`resolved_release_at`;
      const rows = await sql`update scheduled_polls set status=${next},resolved_release_at=${release},
        last_error=null,updated_at=now() where id=${id}::uuid and ${transitions[action]} returning *`;
      return rows[0] || null;
    },
    async getScheduledPollDetails(id) {
      const [poll] = await sql`select sp.*,e.title,e.event_date,g.group_name,g.telegram_chat_id::text,
        cm.id as confirmation_id,cm.status as confirmation_status,cm.telegram_message_id as confirmation_message_id,
        cm.last_error as confirmation_error from scheduled_polls sp join events e on e.id=sp.event_id
        join telegram_groups g on g.id=sp.telegram_group_id
        left join confirmation_messages cm on cm.scheduled_poll_id=sp.id where sp.id=${id}::uuid`;
      if (!poll) return null;
      const responses = await sql`select telegram_update_id,telegram_user_id::text,selected_option_ids,
        qualifying_response,received_at from poll_response_events where scheduled_poll_id=${id}::uuid order by received_at`;
      const participants = await sql`select s.label,p.telegram_user_id::text,u.display_name,u.telegram_username,
        p.status,p.qualifying_since,p.confirmed_position,p.waiting_list_position
        from poll_participants p join event_shifts s on s.id=p.shift_id
        left join telegram_users u on u.telegram_user_id=p.telegram_user_id
        where p.event_id=${poll.event_id} order by s.display_order,p.qualifying_since,p.telegram_user_id`;
      const audit = await sql`select s.label,a.telegram_user_id::text,a.previous_status,a.new_status,
        a.previous_position,a.new_position,a.qualifying_timestamp,a.reason,a.created_at
        from allocation_audit_log a join event_shifts s on s.id=a.shift_id
        where a.event_id=${poll.event_id} order by a.created_at`;
      return { poll, responses, participants, audit };
    },
    async retryConfirmation(id) {
      const rows = await sql`update confirmation_messages set status='scheduled',resolved_send_at=now(),
        last_error=null,updated_at=now() where id=${id}::uuid and status='failed' returning *`;
      return rows[0] || null;
    },
    async getWeeklySchedule(id) {
      const [row] = await sql`select * from weekly_poll_schedules where id=${id}::uuid and enabled`;
      return row || null;
    },
    async getEventDate(eventId) {
      const [row] = await sql`select event_date::text from events where id=${eventId}::uuid`;
      return row?.event_date || null;
    },
    async getActivePollForDate(telegramGroupId, eventDate) {
      await initPromise;
      const [row] = await sql`
        select sp.id, sp.status, sp.is_custom, e.event_date::text
        from scheduled_polls sp join events e on e.id = sp.event_id
        where sp.telegram_group_id = ${telegramGroupId}::uuid
          and e.event_date = ${eventDate}::date
          and sp.status != 'cancelled'
          and not ('test' = any(e.operational_tags))
        limit 1`;
      return row || null;
    },
    async applyScheduledPollResponse(args) {
      const [row] = await sql`select apply_poll_response(${args.updateId},${args.pollId},
        ${args.userId},${args.username ?? null},${args.firstName ?? null},${args.lastName ?? null},
        ${args.displayName},${args.optionIds},${args.rawPayload},${args.botId}) as accepted`;
      return row.accepted;
    },
    async getScheduledPollByTelegramId(pollId) {
      const [row] = await sql`select id from scheduled_polls where telegram_poll_id=${pollId}`;
      return row || null;
    },
    async claimSpecificPoll(id) {
      const [row] = await sql`
        with claimed as (
          update scheduled_polls set status='sending', claim_token=gen_random_uuid(),
            claimed_at=now(), updated_at=now()
          where id=${id}::uuid and status in ('draft','scheduled','failed')
          returning *
        )
        select c.id, c.event_id, c.telegram_group_id, g.bot_id as service,
          g.telegram_chat_id, c.poll_question, c.poll_options, c.claim_token
        from claimed c join telegram_groups g on g.id=c.telegram_group_id and g.enabled
      `;
      return row || null;
    },
    async completePollSend(id, token, pollId, messageId) {
      const [row] = await sql`select complete_poll_send(${id}::uuid,${token}::uuid,
        ${pollId},${messageId}) as ok`;
      return row.ok;
    },
    async failPollSend(id, token, error) {
      await sql`select fail_poll_send(${id}::uuid,${token}::uuid,${error})`;
    },
    async claimDuePollClosures(limit = 10) { return sql`select * from claim_due_poll_closures(${limit})`; },
    async completePollClose(id, token, error = null) {
      const [row] = await sql`select complete_poll_close(${id}::uuid,${token}::uuid,${error}) as ok`;
      return row.ok;
    },
    async claimDuePolls(limit = 10) {
      await initPromise;
      return sql`select * from claim_due_polls(${limit})`;
    },
    async claimDueConfirmations(limit = 10) {
      await initPromise;
      return sql`select * from claim_due_confirmations(${limit})`;
    },
    async claimSpecificConfirmation(pollId) {
      const [row] = await sql`
        with claimed as (
          update confirmation_messages cm set status='sending', claim_token=gen_random_uuid(),
            claimed_at=now(), updated_at=now()
          where cm.scheduled_poll_id=${pollId}::uuid
            and cm.status in ('scheduled','failed')
            and cm.resolved_send_at <= now()
          returning cm.*
        )
        select c.id, c.event_id, c.scheduled_poll_id, g.bot_id as service,
          g.telegram_chat_id, c.telegram_message_id, c.header_text, c.footer_text, c.resolved_send_at,
          c.show_waiting_list, c.show_empty_shifts, c.claim_token
        from claimed c join telegram_groups g on g.id=c.telegram_group_id and g.enabled
      `;
      return row || null;
    },
    async claimSpecificConfirmationBatch(pollId) {
      return sql`
        with target as (
          select cm.resolved_send_at, cm.telegram_group_id, g.bot_id
          from confirmation_messages cm
          join telegram_groups g on g.id=cm.telegram_group_id and g.enabled
          where cm.scheduled_poll_id=${pollId}::uuid
            and cm.status in ('scheduled','failed')
            and cm.resolved_send_at <= now()
            and g.bot_id='PSA'
          limit 1
        ), claimed as (
          update confirmation_messages cm set status='sending', claim_token=gen_random_uuid(),
            claimed_at=now(), updated_at=now()
          from target t
          where cm.telegram_group_id=t.telegram_group_id
            and cm.resolved_send_at=t.resolved_send_at
            and cm.status in ('scheduled','failed')
          returning cm.*
        )
        select c.id, c.event_id, c.scheduled_poll_id, g.bot_id as service,
          g.telegram_chat_id, c.telegram_message_id, c.header_text, c.footer_text, c.resolved_send_at,
          c.show_waiting_list, c.show_empty_shifts, c.claim_token
        from claimed c join telegram_groups g on g.id=c.telegram_group_id and g.enabled
        order by c.resolved_send_at, c.id
      `;
    },
    async getAllocation(eventId) {
      return sql`select s.id as shift_id,s.label,s.capacity,s.display_order,p.status,p.confirmed_position,
        p.waiting_list_position,p.qualifying_since,u.telegram_user_id::text,u.telegram_username,u.display_name
        from event_shifts s left join poll_participants p on p.shift_id=s.id and p.current_response
        left join telegram_users u on u.telegram_user_id=p.telegram_user_id
        where s.event_id=${eventId}::uuid order by s.display_order,
          case p.status when 'confirmed' then 0 else 1 end,
          coalesce(p.confirmed_position,p.waiting_list_position)`;
    },
    async completeConfirmationSend(id, token, messageId, text, wasEdit) {
      const [row] = await sql`select complete_confirmation_send(${id}::uuid,${token}::uuid,
        ${messageId},${text},${wasEdit}) as ok`;
      return row.ok;
    },
    async failConfirmationSend(id, token, error) {
      await sql`select fail_confirmation_send(${id}::uuid,${token}::uuid,${error})`;
    },
    async close() { await sql.end(); },
  };
}

module.exports = { createPostgresDb, createSql };
