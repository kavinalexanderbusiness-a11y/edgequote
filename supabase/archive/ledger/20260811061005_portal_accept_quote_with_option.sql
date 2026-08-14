-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260811061005
--   name    : portal_accept_quote_with_option
--
-- Recovered 2026-08-14 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

-- Replaced, not overloaded: adding a defaulted 3rd parameter alongside the 2-arg
-- version would leave PostgREST with two candidates for a 2-argument call and
-- "function is not unique". Dropping first means a stale browser tab still
-- sending {p_token, p_quote_id} resolves here via the default and behaves
-- exactly as it did before.
drop function if exists public.portal_accept_quote(text, uuid);

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

  -- ── No options: the original path, unchanged ───────────────────────────────
  if v_options = 0 then
    update public.quotes
       set status = 'accepted',
           accepted_price = coalesce(accepted_price, total)
     where id = p_quote_id and customer_id = v_customer and status = 'sent';
    return found;
  end if;

  -- ── Options: a choice is REQUIRED, and it must be one of THIS quote's ──────
  -- Refusing a null choice is the honest answer: approving "the quote" when the
  -- quote is three different prices records nothing anyone could act on.
  if p_option_id is null then return false; end if;

  -- The option, the quote, the customer and the status are all resolved in ONE
  -- query. `o.quote_id = p_quote_id` is what stops another quote's option (even
  -- the same customer's, even the same owner's) being named here.
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
         -- The chosen option becomes THE price of the quote. Everything
         -- downstream (the generated `total`, the invoice's `amount: quote.total`,
         -- job costing, pipeline) reads that one column, so this single
         -- assignment is what makes the unselected alternatives incapable of
         -- reaching any of them.
         initial_price = v_price,
         -- ⚠️ NOT coalesce(accepted_price, total). `total` is a GENERATED column
         -- over initial_price, and an UPDATE's SET expressions all read the OLD
         -- row — so `total` here would snapshot the price of whichever option was
         -- showing BEFORE the customer chose. Computed from the option instead.
         accepted_price = v_price + v_travel
   where id = p_quote_id and customer_id = v_customer and status = 'sent';
  return found;
end $$;

revoke all on function public.portal_accept_quote(text, uuid, uuid) from public;
grant execute on function public.portal_accept_quote(text, uuid, uuid) to anon, authenticated, service_role;