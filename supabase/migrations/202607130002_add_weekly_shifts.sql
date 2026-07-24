ALTER TABLE public.weekly_poll_schedules ADD COLUMN IF NOT EXISTS shifts jsonb default '[]'::jsonb;
