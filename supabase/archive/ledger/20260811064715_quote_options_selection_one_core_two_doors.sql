-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260811064715
--   name    : quote_options_selection_one_core_two_doors
--
-- Recovered 2026-08-14 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.quote_apply_option_choice(p_quote_id uuid, p_option_id uuid)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_price numeric(10,2);
  v_travel numeric(10,2);
  v_follow int;
begin
  -- THE tenancy statement: o.quote_id = p_quote_id. Resolving the option THROUGH
  -- the quote is what makes "you may not name another quote's option" true here
  -- rather than wherever someone remembered to check it.
  -- 'draft' or 'sent' = NOT YET DECIDED. Anything else means a choice already
  -- stands, and re-deciding would silently rewrite the approved price.
  select o.price, coalesce(q.travel_fee, 0), coalesce(q.follow_up_count, 0)
    into v_price, v_travel, v_follow
    from public.quote_options o
    join public.quotes q on q.id = o.quote_id
   where o.id = p_option_id
     and o.quote_id = p_quote_id
     and q.status in ('draft', 'sent');
  if v_price is null then return false; end if;

  update public.quotes
     set status = 'accepted',
         selected_option_id = p_option_id,
         initial_price = v_price,
         -- NOT coalesce(accepted_price, total): total is GENERATED over
         -- initial_price and every SET expression reads the OLD row.
         accepted_price = v_price + v_travel,
         accepted_after_followup = v_follow > 0,
         follow_up_count_at_acceptance = v_follow
   where id = p_quote_id and status in ('draft', 'sent');
  return found;
end $$;

revoke all on function public.quote_apply_option_choice(uuid, uuid) from public;

comment on function public.quote_apply_option_choice(uuid, uuid) is
  'THE single writer of quotes.selected_option_id and the option-derived price. Carries no authorisation - callers must prove access first. Deliberately granted to no role.';

create or replace function public.portal_accept_quote(p_token text, p_quote_id uuid, p_option_id uuid default null)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_customer uuid;
  v_options int;
begin
  select customer_id into v_customer from public.customer_portal_tokens where token = p_token and not revoked;
  if v_customer is null then return false; end if;

  select count(*) into v_options from public.quote_options where quote_id = p_quote_id;

  -- Branch on what was ASKED FOR, not on what the quote happens to have.
  if p_option_id is not null then
    -- This door proves the quote is this token's customer's and still out for
    -- approval. Whether the OPTION belongs to the quote is the core's question.
    if not exists (
      select 1 from public.quotes
       where id = p_quote_id and customer_id = v_customer and status = 'sent'
    ) then
      return false;
    end if;
    return public.quote_apply_option_choice(p_quote_id, p_option_id);
  end if;

  -- A quote that offers alternatives cannot be approved without one.
  if v_options > 0 then return false; end if;

  update public.quotes
     set status = 'accepted',
         accepted_price = coalesce(accepted_price, total)
   where id = p_quote_id and customer_id = v_customer and status = 'sent';
  return found;
end $$;

create or replace function public.owner_select_quote_option(p_quote_id uuid, p_option_id uuid)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  -- Stated rather than implied: a guard whose safety depends on a NULL
  -- comparison behaving is the shape that failed open in the measurement RPC.
  if auth.uid() is null then return false; end if;
  if not exists (
    select 1 from public.quotes where id = p_quote_id and user_id = auth.uid()
  ) then
    return false;
  end if;
  return public.quote_apply_option_choice(p_quote_id, p_option_id);
end $$;

revoke all on function public.owner_select_quote_option(uuid, uuid) from public;
grant execute on function public.owner_select_quote_option(uuid, uuid) to authenticated;

comment on function public.owner_select_quote_option(uuid, uuid) is
  'Owner records the option a customer chose by phone/in person. Same core, same money rule as portal_accept_quote - only auth.uid() proves access instead of a token.';