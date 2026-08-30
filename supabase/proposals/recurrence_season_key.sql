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
--   14 series whose names hit a keyword → matched → a season, correctly bounded ✅
--    1 series whose name hit nothing    → NO season, NO end_date, and a full
--                                         year of visits generated through
--                                         winter into the following summer
--    2 more whose names hit nothing     → NO season
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
-- ── LANDING-READY. Version assigned by S106 from the LIVE ledger. ──────────
-- ⛔ Deliberately unversioned here. S106 copies this to
--    supabase/migrations/<14-digit>_recurrence_season_key.sql, taking the
--    version AT APPLY TIME from the live ledger.
--
-- ⚠️⚠️ SCHEMA FIRST, THEN APP. The application on branch
-- session110/recurrence-season-repair has NO runtime name inference left:
-- resolveSeriesSeason takes only a key, and there is no parameter a service
-- name could arrive through. Until this column exists and is backfilled, every
-- series resolves 'unknown' and the 14 currently-governed series lose their
-- seasonal signal. Land this migration WITH that code, never after it.
--
-- ── THE LIVE CLASSIFICATION (measured 2026-08-30, read-only) ───────────────
-- `npx tsx scripts/season-reconcile.ts` prints this and writes nothing:
--
--   AUTO-SAFE     14   a keyword matched AND no future visit falls outside the
--                      suggested season ⇒ backfilled by section 3
--   OWNER REVIEW   3   no keyword matched ⇒ a human declares the season.
--                      One has an unbounded horizon and future visits that
--                      would fall outside any season it could be assigned;
--                      one is already bounded by its own end_date; one is an
--                      orphan row with no customer and no service name.
--   YEAR-ROUND     0   no series has completed work spanning every season
--
-- ⛔ NO CUSTOMER OR SERVICE NAME APPEARS ANYWHERE IN THIS MIGRATION, and that is
-- deliberate: a migration that names rows is a migration that only works on one
-- book, and the classification is a DATA RULE, not a list. The report
-- (scripts/season-reconcile.ts) names them for the human; the SQL never does.
--
-- ⛔ NOTHING HERE DELETES OR EDITS A VISIT. Out-of-season visits stay until
-- Kavin approves a specific action, taken in-product under Session 39's rules —
-- only a SCHEDULED, uninvoiced, non-anchor visit strictly past the end may ever
-- be removed. History is never traded for a rule change.
--
-- ── STEPS ──────────────────────────────────────────────────────────────────
-- 1. Apply section 1 (column, constraint, index). Additive and reversible.
-- 2. Run the reconciliation report; the owner reads it.
-- 3. Apply the AUTO-SAFE backfill in section 3 for the 14 matched series.
-- 4. The owner declares the 3 OWNER REVIEW series in-product, using the Season
--    control on the series editor (Year-round is an explicit choice there).
-- 5. When no NULL season_key remains the app is already correct — there is no
--    inference flag left to turn off, because there is no inference left.
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


-- ── 3 · AUTO-SAFE BACKFILL — a DATA RULE, not a list of rows ────────────────
-- Run AFTER the report in section 2 has been read.
--
-- ⭐ A row is AUTO-SAFE when BOTH hold, and neither mentions a customer or a
-- service by name:
--     (a) the legacy keyword lists produce exactly one season for its service
--         name — the same suggestion the app used to act on silently; and
--     (b) NO future active visit of that series falls outside that season, so
--         declaring it changes nothing that is already on the calendar.
--
-- (b) is what makes this safe rather than merely convenient. A row that would
-- strand real visits is left NULL on purpose and becomes an OWNER REVIEW row.
--
-- ⛔ IT SETS season_key AND NOTHING ELSE. No end_date is written, no visit is
-- touched. Bounding a series to its season is a separate, owner-visible action.
--
-- ⛔ IT IS PAUSABLE. Rows it cannot classify stay NULL, the application keeps
-- working through the transitional bridge, and the completion flag stays false
-- until a human resolves them. That is a supported resting state, not a failure.
with seasons as (
  -- Each configured season as (key, start_md, end_md) — month*100+day anchors,
  -- read from the owner's own settings. Nothing about seasons is hardcoded.
  select b.user_id,
         s.key                                                as season_key,
         (s.value->>'startMonth')::int * 100 + (s.value->>'startDay')::int as start_md,
         (s.value->>'endMonth')::int   * 100 + (s.value->>'endDay')::int   as end_md
    from public.business_settings b
    cross join lateral jsonb_each(coalesce(b.service_seasons, '{}'::jsonb)) as s(key, value)
   where s.value ? 'startMonth' and s.value ? 'endMonth'
),
series_service as (
  -- The service name a series is known by — the same value the app reads.
  select r.id, r.user_id,
         min(coalesce(j.service_type, j.title)) as service_name
    from public.job_recurrences r
    left join public.jobs j on j.recurrence_id = r.id
   where r.season_key is null
   group by r.id, r.user_id
),
suggested as (
  -- (a) the legacy keyword suggestion, reproduced ONCE, here, as a proposal.
  -- ⚠️ Word-start matching, exactly as the app's lists did: 'ice' inside
  -- "serv·ice" once classified every service as snow.
  select ss.id, ss.user_id,
         case
           when ss.service_name ~* '\m(snow|ice|plow|plough|salt|shovel)'                    then 'snow'
           when ss.service_name ~* '\m(mow|lawn|fertiliz|fertilis|grass|aerat|trim|edge)'    then 'lawn'
         end as season_key
    from series_service ss
),
offending as (
  -- (b) future active visits that would fall OUTSIDE the suggested season.
  -- The CASE handles a season that wraps the new year (e.g. Nov 1 → Mar 31).
  select sg.id, count(*) as n
    from suggested sg
    join seasons se on se.user_id = sg.user_id and se.season_key = sg.season_key
    join public.jobs j on j.recurrence_id = sg.id
   where sg.season_key is not null
     and j.scheduled_date > current_date
     and j.status <> 'cancelled'
     and not (
       case when se.start_md <= se.end_md
            then (extract(month from j.scheduled_date)::int * 100
                  + extract(day from j.scheduled_date)::int) between se.start_md and se.end_md
            else (extract(month from j.scheduled_date)::int * 100
                  + extract(day from j.scheduled_date)::int) >= se.start_md
              or (extract(month from j.scheduled_date)::int * 100
                  + extract(day from j.scheduled_date)::int) <= se.end_md
       end
     )
   group by sg.id
)
update public.job_recurrences r
   set season_key = sg.season_key
  from suggested sg
  left join offending o on o.id = sg.id
 where r.id = sg.id
   and r.season_key is null
   and sg.season_key is not null
   and coalesce(o.n, 0) = 0;

-- ── 4 · WHAT REMAINS, and how the transition ends ──────────────────────────
-- After section 3, any row still NULL is one no rule could classify. Show them:
--
--   select r.id, r.start_date, r.end_date
--     from public.job_recurrences r
--    where r.season_key is null
--      and (r.end_date is null or r.end_date >= current_date);
--
-- Each is declared BY A HUMAN, in the product, using the Season control on the
-- series editor — a configured season, or 'none' for genuinely year-round.
--
-- ⭐⭐ THE TRANSITION ENDS WHEN THAT SET IS EMPTY. At that point flip
-- SEASON_DECLARATIONS_COMPLETE to true in src/lib/legacySeasonInference.ts, and
-- the keyword guess becomes unreachable at runtime.
-- ⚠️ verify:season-recurrence §9 FAILS if the set is empty and the flag is still
-- false, so the transition cannot quietly never end. It also fails if the flag
-- is flipped while rows remain undeclared.
