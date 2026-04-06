-- ============================================================
-- SCALO: Scheduled Tasks via pg_cron + pg_net
-- Run this in Supabase SQL Editor (Dashboard > SQL Editor)
-- ============================================================
-- Prerequisites:
--   1. Enable pg_cron: Dashboard > Database > Extensions > search "pg_cron" > Enable
--   2. Enable pg_net: Dashboard > Database > Extensions > search "pg_net" > Enable
--   3. Deploy Edge Functions first:
--      supabase functions deploy scrape-profiles
--      supabase functions deploy send-inspo-email
--      supabase functions deploy notify-expiring-clients
-- ============================================================

-- 0. DAILY: Scrape profile stats — followers, posts, views (every day at 6:00 AM UTC)
--    This is the ONLY daily scrape. Content library and inspo are on-demand (student clicks Refresh).
SELECT cron.schedule(
  'scrape-profiles-daily',
  '0 6 * * *',  -- 6:00 AM UTC daily
  $$
  SELECT net.http_post(
    url := 'https://kadgzthwuzzjwxxcbgzi.supabase.co/functions/v1/scrape-profiles',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key')
    ),
    body := '{}'::jsonb
  );
  $$
);

-- 1. WEEKLY: Send inspo email (every Monday at 8:00 AM UTC)
SELECT cron.schedule(
  'send-inspo-email-weekly',
  '0 8 * * 1',  -- Monday 8:00 AM UTC
  $$
  SELECT net.http_post(
    url := 'https://kadgzthwuzzjwxxcbgzi.supabase.co/functions/v1/send-inspo-email',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key')
    ),
    body := '{}'::jsonb
  );
  $$
);

-- 2. DAILY: Notify admin of expiring clients (every day at 8:00 AM UTC)
SELECT cron.schedule(
  'notify-expiring-clients-daily',
  '0 8 * * *',  -- 8:00 AM UTC daily
  $$
  SELECT net.http_post(
    url := 'https://kadgzthwuzzjwxxcbgzi.supabase.co/functions/v1/notify-expiring-clients',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key')
    ),
    body := '{}'::jsonb
  );
  $$
);

-- View scheduled jobs:
-- SELECT * FROM cron.job;

-- To remove a job:
-- SELECT cron.unschedule('job-name-here');

-- REMOVED CRONS (on-demand only, triggered by student clicking Refresh):
-- scrape-reels-daily (Content Library)
-- scrape-inspo-daily (Inspo)
