-- ════════════════════════════════════════════════════════════
-- RUN THIS in the Supabase SQL editor BEFORE deploying.
-- AI Vision — atomic "exactly one ACTIVE analysis per property".
-- Idempotent + additive — safe to re-run. Mirrors supabase/schema.sql.
-- Builds on RUN-2026-06-25h (property_intelligence).
-- ════════════════════════════════════════════════════════════
--
-- Guarantees property_intelligence has EXACTLY ONE active row per
-- (user_id, property_id) — never zero, never multiple. Replaces the old
-- app-side "UPDATE superseded; INSERT active" two-step (non-atomic: a failed
-- insert could leave zero active; a race could leave two).
--
--   (1) Collapse any pre-existing duplicate actives (keep the newest) so the
--       unique index can build.
--   (2) Partial unique index → the DB structurally forbids >1 active.
--   (3) BEFORE INSERT trigger → inserting a new active row supersedes the prior
--       active in the SAME statement (one transaction). If the insert fails, the
--       supersede rolls back too → never zero. The app now just INSERTs.


-- ════════════════════════════════════════════════════════════
-- MIGRATION 2026-06-27 — Vision active-analysis integrity
-- ════════════════════════════════════════════════════════════

-- (1) Collapse existing duplicate actives (keep newest per property) so (2) builds.
with ranked as (
  select id, row_number() over (
           partition by user_id, property_id
           order by created_at desc, id desc
         ) as rn
  from public.property_intelligence
  where status = 'active'
)
update public.property_intelligence p
   set status = 'superseded'
  from ranked r
 where p.id = r.id and r.rn > 1;

-- (2) At most ONE active analysis per property (structural guarantee).
create unique index if not exists property_intelligence_one_active
  on public.property_intelligence (user_id, property_id)
  where status = 'active';

-- (3) Inserting a new active row atomically supersedes the prior active.
-- SECURITY INVOKER (default) so RLS still applies; the WHERE is scoped to the
-- inserting row's own user_id + property_id, so it can never touch other tenants.
create or replace function public.vision_supersede_prior_active()
returns trigger language plpgsql as $$
begin
  if new.status = 'active' then
    update public.property_intelligence
       set status = 'superseded'
     where user_id = new.user_id
       and property_id = new.property_id
       and status = 'active'
       and id <> new.id;
  end if;
  return new;
end $$;

drop trigger if exists trg_property_intelligence_one_active on public.property_intelligence;
create trigger trg_property_intelligence_one_active
  before insert on public.property_intelligence
  for each row execute function public.vision_supersede_prior_active();
