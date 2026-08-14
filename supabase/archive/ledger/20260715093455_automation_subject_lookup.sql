-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260715093455
--   name    : automation_subject_lookup
--
-- Recovered on 2026-08-13 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file that was believed to match it.
-- Several of these migrations never had a repo file at all.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so the reason a column looks the way it does is answerable, and for
-- no other purpose. Re-running one replaces a live object with an older body —
-- silently, with no error. That has already broken the customer portal twice.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Per-subject lookup ───────────────────────────────────────────────────────
-- The subject drill-down asks "everything about THIS subject, ever" — the one
-- question the existing indexes cannot serve. Both unique indexes lead with
-- (user_id, signal) / (user_id, rule_key), so subject_id is not a usable prefix
-- and the query would seq-scan the whole ledger.
--
-- Deliberately NOT a foreign key to customers: subject is polymorphic
-- (subject_type/subject_id), and the ledger must outlive the row it describes —
-- "why did we chase a customer who was later deleted" is exactly the question an
-- audit log exists to answer. Orphans are the feature; the UI renders them as an
-- unknown subject.
--
-- Additive and idempotent. No data change.

create index if not exists automation_signals_subject
  on public.automation_signals (user_id, subject_id, detected_on desc);

create index if not exists automation_runs_subject
  on public.automation_runs (user_id, subject_id, evaluated_on desc);