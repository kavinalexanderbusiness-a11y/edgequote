-- ── Phone search that actually finds the customer ────────────────────────────
-- An unknown number rings. The owner types it into Cmd/K exactly as their handset
-- shows it — "(403) 681-9016" — and the app says "No matches" for a customer who
-- is sitting right there in the book.
--
-- Cause: phone is stored however it was typed. 34 of 36 numbers are digits-only
-- ("4036819016"), 2 are formatted ("403-852-1443"), and every search did a raw
-- `phone ilike '%term%'`. So BOTH directions miss:
--   typed 4038521443     vs stored 403-852-1443  → no match
--   typed (403) 681-9016 vs stored 4036819016    → no match
--
-- Fix: ONE canonical form, owned by the database rather than by each caller.
-- A stored generated column can't drift from `phone` the way a trigger-maintained
-- or app-maintained copy would — there is no write path that can forget it, and no
-- backfill to get wrong. lib/customers.ts's normalizePhone() is the same rule for
-- the client side (strip every non-digit); this is that rule where SQL can index it.
--
-- Additive and non-destructive: no column is dropped, no data is rewritten, and
-- `phone` itself is untouched — it stays exactly as the owner typed it, because
-- that's what they recognise when they read it back.

alter table public.customers
  add column if not exists phone_digits text
  generated always as (regexp_replace(coalesce(phone, ''), '\D', '', 'g')) stored;

comment on column public.customers.phone_digits is
  'Digits-only form of phone, for search only. Generated — never write to it. Display and dial from `phone`, which keeps the owner''s own formatting.';

-- Suffix matching ("last four digits", or a number typed without the area code) is
-- the real query shape, so this needs a trigram index — a b-tree can only serve a
-- prefix. pg_trgm is already installed for the address/name searches.
create extension if not exists pg_trgm;

create index if not exists customers_phone_digits_trgm_idx
  on public.customers using gin (phone_digits gin_trgm_ops);
