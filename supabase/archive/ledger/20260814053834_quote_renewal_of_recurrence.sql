-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260814053834
--   name    : quote_renewal_of_recurrence
--
-- Recovered 2026-08-14 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── A quote can be the RENEWAL of a service plan ─────────────────────────────
-- One backward-pointing link, written once when the renewal quote is created.
--
-- It exists so the renewal queue can tell "I already offered this" from "I have
-- not looked at this yet" as a FACT rather than a guess. Without it the only
-- available test is "did a quote appear for this customer recently, for roughly
-- this service" — which is wrong in both directions: an unrelated quote silences
-- a renewal that is still owed, and a renewal for one of two plans silences both.
--
-- It is also the consent trail. lib/renewals.createRenewedPlan refuses to build
-- next season unless an ACCEPTED quote carries this column pointing at the plan
-- being renewed, so "the customer agreed to this" is a row in the database, not
-- a claim in a comment.
--
-- ⭐ The link points BACKWARDS and the old plan is never written to. Last season's
-- recurrence, its visits, its prices and its invoices stay exactly as delivered.

-- Composite FK target. A single-column FK would only ask that the recurrence
-- exist SOMEWHERE — which is how tenant A ends up able to name tenant B's plan as
-- the thing their quote renews. The pair (user_id, id) makes the tenancy a
-- schema-level fact instead of something React is trusted to check.
alter table public.job_recurrences
  add constraint job_recurrences_user_id_id_key unique (user_id, id);

alter table public.quotes
  add column if not exists renewal_of_recurrence_id uuid;

-- SET NULL names its column explicitly (PG 15+). The default form nulls EVERY
-- referencing column, and user_id is NOT NULL — deleting a plan would fail with a
-- constraint violation on an unrelated table. Deleting the old plan must leave
-- the renewal quote standing: the quote is money and a customer decision; the
-- link is only provenance.
alter table public.quotes
  add constraint quotes_renewal_of_recurrence_fkey
  foreign key (user_id, renewal_of_recurrence_id)
  references public.job_recurrences (user_id, id)
  on delete set null (renewal_of_recurrence_id)
  on update cascade;

-- Partial: the column is null on virtually every quote, and the only query that
-- reads it asks for the non-null ones.
create index if not exists quotes_renewal_of_recurrence_idx
  on public.quotes (renewal_of_recurrence_id)
  where renewal_of_recurrence_id is not null;

comment on column public.quotes.renewal_of_recurrence_id is
  'The service plan this quote renews. Set once, points backwards; the renewed plan is a NEW job_recurrences row and the old one is never modified. lib/renewals requires this link plus status=accepted before any visits are created.';