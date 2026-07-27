-- ── Invoice discounts (fixed $ or %) ──────────────────────────────────────────
-- Two nullable columns. invoices.amount stays the NET (post-discount) subtotal, so
-- every existing reader — the Stripe charge routes (checkout / portal pay / autopay),
-- the revenue & outstanding aggregates, and GST via invoiceTotals() — stays correct
-- with no other change. discount_type / discount_value are display + recompute
-- metadata only. Safe to re-run.
alter table public.invoices
  add column if not exists discount_type  text,
  add column if not exists discount_value numeric(10,2);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'invoices_discount_type_check') then
    alter table public.invoices
      add constraint invoices_discount_type_check
      check (discount_type is null or discount_type in ('amount','percent'));
  end if;
end $$;

-- get_portal_data: also return the invoice discount columns so the customer portal can
-- show the discount in its totals breakdown. Faithful copy of the deployed function
-- with discount_type, discount_value added to the invoices projection (everything else
-- is byte-for-byte the live definition). The charged total is unaffected (amount is the
-- net subtotal). Safe to re-run.
-- ══════════════════════════════════════════════════════════════════════════
-- ⚠️  SUPERSEDED — DO NOT RESTORE THIS BODY.  (INF-2, 2026-07-17)
--
--   get_portal_data now has exactly ONE definition:
--       supabase/CANONICAL-get_portal_data.sql
--
--   A complete, runnable OLDER copy stood here. Running this file replaced the
--   live function with it — silently, with no error — dropping
--   the `services` and `properties` keys.
--   Nothing failed; the portal just started returning less. That is why the
--   body is gone rather than merely commented "outdated".
--
--   Everything else in this file is UNCHANGED and still safe to run.
-- ══════════════════════════════════════════════════════════════════════════
grant execute on function public.get_portal_data(text) to anon, authenticated;
