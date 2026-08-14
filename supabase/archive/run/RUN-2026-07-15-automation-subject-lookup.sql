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
-- Depends on RUN-2026-07-14-automation-signals.sql + RUN-2026-07-15-automation-runs.sql.
-- Additive and idempotent. No data change. Applied to prod 2026-07-15 via MCP.

create index if not exists automation_signals_subject
  on public.automation_signals (user_id, subject_id, detected_on desc);

create index if not exists automation_runs_subject
  on public.automation_runs (user_id, subject_id, evaluated_on desc);
