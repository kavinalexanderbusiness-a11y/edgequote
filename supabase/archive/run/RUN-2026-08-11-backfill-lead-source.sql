-- ════════════════════════════════════════════════════════════════════════════
-- Source capture V1 — the ONE deterministic historical repair.
-- APPLIED to production 2026-08-11 via MCP (row count verified before/after).
-- Idempotent: the blank-guard means a second run updates 0 rows. Data-only —
-- no DDL, no function, no grant.
-- ════════════════════════════════════════════════════════════════════════════
--
-- WHY THIS ONE AND NOTHING ELSE. Of the 46 customers with no recorded
-- acquisition source (measured 2026-08-11), exactly ONE has strong deterministic
-- evidence on file: rows in `website_leads` pointing at their customer id — the
-- record the 'Website' intake door writes on every submission. That customer
-- predates the door's source backfill (landed in resolve_intake_customer,
-- ba1d88ab), so the door knew where they came from and, at the time, threw it
-- away. This UPDATE is that landed rule — fill a blank from a door touch, never
-- overwrite — applied retroactively to the rows the rule missed.
--
-- ⛔ DELIBERATELY NOT REPAIRED: the other 45. They have no lead row, no
-- quotes.lead_meta (0 across the whole cohort), no booking record. Inferring
-- their source from neighborhood, note wording, timing, or campaign dates would
-- be manufacturing data; "Not recorded" is the truthful answer and stays.
--
-- 'Website' is written RAW (not a category key) because that is exactly what
-- submit_website_lead's door label writes today — the read-time normalizer in
-- src/lib/attribution.ts owns what it MEANS (online_form), here as everywhere.

update public.customers c
set acquisition_source = 'Website'
where coalesce(btrim(c.acquisition_source), '') = ''   -- fills a blank, never overwrites
  and exists (select 1 from public.website_leads wl where wl.customer_id = c.id);

-- ── The production metric for this lane ──────────────────────────────────────
-- "Of customers created after source capture landed, what share have a known
-- source?" No new dashboard: the Intelligence page's acquisition panel already
-- reports the whole-book unknown share, and the NEW-customer rate is one
-- canonical query (swap the date for the landing date of this commit):
--
--   select count(*) filter (where coalesce(btrim(acquisition_source), '') <> '')
--            as known,
--          count(*) as created,
--          round(100.0 * count(*) filter (where coalesce(btrim(acquisition_source), '') <> '')
--                / greatest(count(*), 1)) as known_pct
--   from public.customers
--   where archived_at is null and created_at >= '2026-08-12';
--
-- Baseline to beat: 55% known (57 of 103) across the book at landing.
