-- ═══════════════════════════════════════════════════════════════════════════
-- PROPOSAL · Session 110 · RECURRENCE SEASON KEY
--
-- ⛔ NOT APPLIED, and deliberately unversioned. See the README in this
-- directory: nothing here is in the apply path. This session did not touch
-- production schema.
--
-- ── WHAT IS MISSING ────────────────────────────────────────────────────────
-- A recurring series has no way to say which season governs it. The only
-- available answer is a KEYWORD GUESS over the service's name
-- (lib/seasons.seasonForService), and on production that produced:
--
--   14 series named "…Mowing"/"Lawn Mowing" → matched → lawn season, bounded ✅
--    1 series named "Bi-weekly"             → matched nothing → NO season, NO
--                                             end_date, 24 future visits
--                                             generated to 2027-07-31
--    1 series named "General Upkeep"        → matched nothing → NO season
--
-- Identical cadence, identical intent, opposite outcome — decided by a name.
-- ⛔ A NAME IS NOT A RELATIONSHIP. Renaming a service must not change when it
-- runs, and a trade whose vocabulary we did not anticipate must not silently
-- lose its season.
--
-- ── THE TWO FACTS, KEPT APART ──────────────────────────────────────────────
--   job_recurrences.end_date    WHERE THIS SERIES STOPS.
--                               Session 39's canonical representation, and the
--                               only thing the recurrence engine reads. One
--                               concrete date, already respected everywhere.
--   job_recurrences.season_key  WHICH SEASON GOVERNS IT.
--                               What the end_date is DERIVED from, what the
--                               editor re-derives against, and what survives a
--                               rename. An input, not an output.
--
-- ⛔ Collapsing them would mean re-deriving intent from a date every time, which
-- is the same class of guess this proposal exists to delete.
--
-- ── WHY A TEXT KEY AND NOT A FOREIGN KEY ───────────────────────────────────
-- Seasons live in `business_settings.service_seasons`, a jsonb object keyed by
-- season name ({ lawn, snow, …owner-defined }). There is no seasons TABLE to
-- reference, and inventing one would be a much larger change that also removes
-- the owner's ability to add a season without a migration — the property that
-- lets a pool or pest business declare seasonality today with no code change.
-- So the key is text, and the app resolves it against the jsonb; an unresolvable
-- key is reported as `unknown` and NEVER downgraded to a name guess.
--
-- ⭐ `'none'` is a REAL value, not an absence: it means the owner decided this
-- series is year-round. NULL means nobody has said yet. Those are different
-- facts and the backfill below is the only thing allowed to turn one into the
-- other — collapsing them would make "not yet migrated" indistinguishable from
-- "runs all year", and the only safe treatment of the first is the unsafe
-- treatment of the second.
--
-- ── ADOPTING THIS ──────────────────────────────────────────────────────────
-- 1. Copy to supabase/migrations/<14-digit>_recurrence_season_key.sql, taking
--    the version AT APPLY TIME from the live ledger.
-- 2. Run the BACKFILL REPORT below FIRST (it selects, it does not write) and
--    have the owner confirm the suggested keys. The suggestion uses the legacy
--    name inference ONCE, as a proposal a human accepts — never as a runtime
--    rule. `npx tsx scripts/season-reconcile.ts` prints the same picture.
-- 3. Only then run the backfill UPDATE, and set the two ungoverned series by
--    hand — "Bi-weekly" and "General Upkeep" are exactly the rows a keyword
--    cannot classify, which is the whole point.
-- 4. Flip lib/seasons name inference off (`allowNameInference: false`) once no
--    NULL season_key remains. verify:season-recurrence already proves a
--    declaration resolves with inference disabled.
-- ⛔ Do NOT delete out-of-season visits as part of this migration. Session 39's
--    rule stands: history is never traded for a rule change, and only
--    `scheduled`, uninvoiced, non-anchor visits strictly past the end may ever
--    be removed — through the product, with the owner looking at it.
-- ═══════════════════════════════════════════════════════════════════════════

set search_path to public, extensions;

-- ── 1 · The declaration ─────────────────────────────────────────────────────
-- Nullable ON PURPOSE: NULL is "nobody has said yet", which is what every
-- existing row honestly is until a human confirms the backfill.
alter table public."job_recurrences"
  add column if not exists "season_key" text;

-- A key is a season name or the year-round sentinel. Deliberately NOT an enum
-- and NOT a foreign key — the set of seasons is owner-defined jsonb, so the
-- database can police the SHAPE of the value but not its membership; the app
-- resolves membership and reports an unresolvable key rather than guessing.
alter table public."job_recurrences"
  drop constraint if exists "job_recurrences_season_key_check";
alter table public."job_recurrences"
  add constraint "job_recurrences_season_key_check"
  check (
    season_key is null
    or season_key = 'none'
    or (length(season_key) between 1 and 64 and season_key ~ '^[a-z0-9_]+$')
  );

comment on column public.job_recurrences.season_key is
  'Session 110. WHICH SEASON governs this series — a key in business_settings.service_seasons, or ''none'' for deliberately year-round. NULL means nobody has declared yet (pre-migration). Distinct from end_date, which is WHERE THIS SERIES STOPS and is what the recurrence engine reads; season_key is what that date is derived from and what survives a service rename. ⛔ Never inferred from the service name at runtime.';

-- The read the schedule and editor make: this owner's series, by season.
create index if not exists job_recurrences_user_season_idx
  on public.job_recurrences (user_id, season_key);

-- ── 2 · BACKFILL REPORT — run this FIRST. It writes nothing. ────────────────
-- Shows every series, the season the legacy keyword guess WOULD assign, and the
-- future visits at stake. The rows with a NULL suggestion are the ones a keyword
-- cannot classify — they need a human, and they are the defect.
--
--   select r.id,
--          c.name                                as customer,
--          coalesce(j.service_type, j.title)     as service_name,
--          r.start_date, r.end_date,
--          case
--            when coalesce(j.service_type, j.title) ~* '\m(snow|ice|plow|plough|salt|shovel)' then 'snow'
--            when coalesce(j.service_type, j.title) ~* '\m(mow|lawn|fertiliz|fertilis|grass|aerat|trim|edge)' then 'lawn'
--            else null
--          end                                   as suggested_season_key,
--          count(*) filter (where j.scheduled_date > current_date
--                             and j.status <> 'cancelled') as future_visits
--     from public.job_recurrences r
--     left join public.jobs j       on j.recurrence_id = r.id
--     left join public.customers c  on c.id = r.customer_id
--    where r.user_id = auth.uid()
--    group by r.id, c.name, coalesce(j.service_type, j.title), r.start_date, r.end_date
--    order by future_visits desc;
--
-- ⚠️ The regex above is the LEGACY inference, reproduced here ONLY so the
-- suggestion matches what the app used to do. It is a one-time proposal for a
-- human to accept or correct. ⛔ It must never become a runtime rule again —
-- that is the defect being repaired.

-- ── 3 · BACKFILL — only after the report has been reviewed ──────────────────
-- Commented out deliberately. Uncomment when the owner has confirmed the
-- suggestions, and set the unclassifiable rows by hand afterwards.
--
--   update public.job_recurrences r
--      set season_key = s.suggested
--     from (
--       select r2.id,
--              case
--                when coalesce(j.service_type, j.title) ~* '\m(snow|ice|plow|plough|salt|shovel)' then 'snow'
--                when coalesce(j.service_type, j.title) ~* '\m(mow|lawn|fertiliz|fertilis|grass|aerat|trim|edge)' then 'lawn'
--              end as suggested
--         from public.job_recurrences r2
--         left join public.jobs j on j.recurrence_id = r2.id
--        group by r2.id, coalesce(j.service_type, j.title)
--     ) s
--    where s.id = r.id
--      and s.suggested is not null
--      and r.season_key is null;
--
-- Rows still NULL after that are the ones the keyword could not classify. They
-- are set by a human, in the product, one at a time.
