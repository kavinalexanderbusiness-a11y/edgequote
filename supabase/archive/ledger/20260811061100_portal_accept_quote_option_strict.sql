-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260811061100
--   name    : portal_accept_quote_option_strict
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

create or replace function public.portal_accept_quote(
  p_token text,
  p_quote_id uuid,
  p_option_id uuid default null
) returns boolean
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_customer uuid;
  v_options int;
  v_price numeric(10,2);
  v_travel numeric(10,2);
begin
  select customer_id into v_customer from public.customer_portal_tokens where token = p_token and not revoked;
  if v_customer is null then return false; end if;

  select count(*) into v_options from public.quote_options where quote_id = p_quote_id;

  -- ── The caller named a choice ──────────────────────────────────────────────
  -- Branch on what was ASKED FOR, not on what the quote happens to have. An
  -- earlier cut branched on v_options first, so naming another quote's option
  -- against an option-less quote fell through to the plain path and returned
  -- TRUE — accepting the quote on a completely different basis from the one the
  -- caller asserted. Nothing leaked, but "I approved option X" must never be
  -- answered with "fine, I accepted something else".
  if p_option_id is not null then
    -- Option, quote, customer and status resolved in ONE query. `o.quote_id =
    -- p_quote_id` is what stops any other quote's option being named here.
    select o.price, coalesce(q.travel_fee, 0) into v_price, v_travel
      from public.quote_options o
      join public.quotes q on q.id = o.quote_id
     where o.id = p_option_id
       and o.quote_id = p_quote_id
       and q.customer_id = v_customer
       and q.status = 'sent';
    if v_price is null then return false; end if;

    update public.quotes
       set status = 'accepted',
           selected_option_id = p_option_id,
           -- The chosen option becomes THE price. Everything downstream (the
           -- generated `total`, the invoice's `amount: quote.total`, job costing,
           -- pipeline) reads that one column, which is what makes the unselected
           -- alternatives incapable of reaching any of them.
           initial_price = v_price,
           -- ⚠️ NOT coalesce(accepted_price, total): `total` is GENERATED over
           -- initial_price and an UPDATE's SET expressions all read the OLD row,
           -- so it would snapshot whichever option was showing BEFORE the choice.
           accepted_price = v_price + v_travel
     where id = p_quote_id and customer_id = v_customer and status = 'sent';
    return found;
  end if;

  -- ── No choice named ────────────────────────────────────────────────────────
  -- A quote that offers alternatives cannot be approved without one: "approved"
  -- against three different prices records nothing anyone could act on.
  if v_options > 0 then return false; end if;

  -- The original single-scope path, unchanged.
  update public.quotes
     set status = 'accepted',
         accepted_price = coalesce(accepted_price, total)
   where id = p_quote_id and customer_id = v_customer and status = 'sent';
  return found;
end $$;