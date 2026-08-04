create unique index if not exists bots_telegram_bot_id_key
  on public.bots (telegram_bot_id)
  where telegram_bot_id is not null;
