-- Hourly, timezone-aware owner reminder producer.
--
-- Secrets stay in Supabase Vault and are never embedded in a migration:
--   edgehq_app_url     the deployed app origin (no trailing slash required)
--   edgehq_cron_secret the same value as the app's CRON_SECRET
--
-- Until both secrets exist, the scheduled SELECT produces no HTTP request. This
-- makes the schema safe to land before provider setup and keeps activation an
-- explicit S106 rollout step.

create extension if not exists pg_cron;

select cron.schedule(
  'edgehq-owner-reminders-hourly',
  '5 * * * *',
  $cron$
    with config as (
      select
        max(decrypted_secret) filter (where name = 'edgehq_app_url') as app_url,
        max(decrypted_secret) filter (where name = 'edgehq_cron_secret') as cron_secret
      from vault.decrypted_secrets
      where name in ('edgehq_app_url', 'edgehq_cron_secret')
    )
    select net.http_post(
      url := rtrim(app_url, '/') || '/api/cron/owner-reminders',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || cron_secret
      ),
      body := jsonb_build_object('scheduled_at', now()),
      timeout_milliseconds := 15000
    )
    from config
    where nullif(app_url, '') is not null
      and nullif(cron_secret, '') is not null;
  $cron$
);
