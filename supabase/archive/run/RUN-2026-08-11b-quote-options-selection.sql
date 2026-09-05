-- ── Quote Options V1 — ONE writer of the choice, two doors into it ───────────
--
-- RUN-2026-08-11-quote-options.sql shipped the data contract: the table, the
-- composite FK, the shape triggers, and a `portal_accept_quote` that could record
-- a customer's choice. This completes the feature, and the only thing it adds to
-- the MODEL is a second way in — the owner recording a choice the customer made
-- on the phone.
--
-- ⭐ THE PROBLEM THIS FILE EXISTS TO SOLVE. There are now two callers who need to
-- say "option X is the choice": the portal (authorised by a customer token) and
-- the owner's own screen (authorised by auth.uid()). The naive shape is two
-- functions that each know the money rule —
--
--     initial_price  = the option's price
--     accepted_price = that price + travel
--
-- — and two copies of a money rule is how the owner's screen and the customer's
-- screen start disagreeing about what was bought. So the rule lives in exactly
-- ONE function, `quote_apply_option_choice`, and the two doors do nothing but
-- prove who is knocking before they call it.
--
--     portal_accept_quote      → token resolves a customer → this customer's quote, 'sent'
--     owner_select_quote_option → auth.uid() owns the quote
--                                          ↓
--                            quote_apply_option_choice
--                        (the option must belong to THIS quote,
--                         the quote must not already be decided)
--
-- ⛔ The core is granted to NOBODY. It carries no authorisation of its own, so a
-- direct grant would be a door with no lock — the exact shape of every tenancy
-- hole the 2026-08-10 boundary audit found (all of them on RLS-OFF surfaces:
-- DEFINER RPCs, service-role, storage). Both callers are SECURITY DEFINER and
-- owned by the same role, so they can still reach it; PostgREST must not.
--
-- ⚠️⚠️ AND `revoke ... from public` IS NOT ENOUGH TO ACHIEVE THAT. This project
-- has ALTER DEFAULT PRIVILEGES in `public` that grant EXECUTE to anon,
-- authenticated and service_role on every function AT CREATE TIME — as explicit
-- role grants, not through PUBLIC. The first apply of this file revoked PUBLIC
-- and left:
--
--     quote_apply_option_choice: postgres=X | anon=X | authenticated=X | service_role=X
--
-- i.e. the one function in the system that authorises nothing was callable over
-- the wire by an anonymous request. It is the mirror image of the boundary
-- audit's own finding ("revoke from anon ≠ removing a PUBLIC grant"), and it is
-- why the roles are now named one by one below and why verify:quote-options
-- reads pg_proc.proacl instead of trusting the word `revoke` appearing in a file.

-- ── 1. THE core: record the choice, and price the quote at it ────────────────
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
  -- ⭐ THE tenancy statement, and it is one line: `o.quote_id = p_quote_id`.
  -- Resolving the option THROUGH the quote is what makes "you may not name
  -- another quote's option" true here rather than true wherever someone
  -- remembered to check it. The composite foreign key on quotes.selected_option_id
  -- refuses the same thing again at write time — belt and braces on the one fact
  -- that decides whose money this is.
  --
  -- 'draft' or 'sent' — a quote that is NOT YET DECIDED. Anything else means a
  -- choice already stands (accepted / scheduled / completed / paid) or the quote
  -- is dead (declined), and re-deciding it here would silently rewrite the
  -- customer's approved price. Owner edits after approval go through the normal
  -- revision path, in the open, with the "they approved $X" warning attached.
  select o.price, coalesce(q.travel_fee, 0), coalesce(q.follow_up_count, 0)
    into v_price, v_travel, v_follow
    from public.quote_options o
    join public.quotes q on q.id = o.quote_id
   where o.id = p_option_id
     and o.quote_id = p_quote_id
     and q.status in ('draft', 'sent');
  -- No row: a ghost id, another quote's option, or a quote already decided.
  -- (A real $0 tier resolves to 0, not null — "Included" is a legitimate option.)
  if v_price is null then return false; end if;

  update public.quotes
     set status = 'accepted',
         selected_option_id = p_option_id,
         -- The chosen option BECOMES the price. `quotes.total` is generated over
         -- this column, and the invoice conversion, job costing, the deposit
         -- engine and pipeline reporting all read `total` — which is precisely
         -- why the alternatives can never reach any of them.
         initial_price = v_price,
         -- ⚠️ NOT coalesce(accepted_price, total). `total` is GENERATED over
         -- initial_price, and every SET expression in one UPDATE reads the OLD
         -- row — so `total` here is still whichever option was showing BEFORE the
         -- customer chose. Add travel to the option price directly.
         accepted_price = v_price + v_travel,
         -- The follow-up sensor markWonPatch writes on the owner's side. Recording
         -- it here means an option quote answers "did chasing win this?" the same
         -- way from both doors, instead of only when the owner happened to be the
         -- one clicking.
         accepted_after_followup = v_follow > 0,
         follow_up_count_at_acceptance = v_follow
   where id = p_quote_id and status in ('draft', 'sent');
  return found;
end $$;

-- No caller but the two doors below. See the header: a core that authorises
-- nothing must not be reachable by anyone who hasn't been authorised — and the
-- three roles are named EXPLICITLY because revoking PUBLIC alone left every one
-- of them holding an EXECUTE grant handed out by ALTER DEFAULT PRIVILEGES.
revoke all on function public.quote_apply_option_choice(uuid, uuid)
  from public, anon, authenticated, service_role;

comment on function public.quote_apply_option_choice(uuid, uuid) is
  'THE single writer of quotes.selected_option_id and the option-derived price. Carries no '
  'authorisation — callers must prove access first. Deliberately granted to no role.';

-- ── 2. The customer's door ───────────────────────────────────────────────────
-- Same signature, same two-argument compatibility (a stale browser tab that
-- sends no option still lands here and behaves exactly as it always has). The
-- ONLY change is that the option branch now delegates instead of re-stating the
-- money rule.
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

  -- ── The caller named a choice ──────────────────────────────────────────────
  -- Branch on what was ASKED FOR, not on what the quote happens to have. An
  -- earlier cut branched on v_options first, so naming another quote's option
  -- against an option-less quote fell through to the plain path and returned
  -- TRUE — accepting the quote on a completely different basis from the one the
  -- caller asserted. Nothing leaked, but "I approved option X" must never be
  -- answered with "fine, I accepted something else".
  if p_option_id is not null then
    -- This door proves ONE thing: the quote is this token's customer's, and it is
    -- still out for approval. Whether the OPTION belongs to the quote is the
    -- core's question, asked in the same statement that reads its price.
    -- 'sent' specifically, not the core's 'draft or sent': a draft never reaches
    -- a customer (get_portal_data filters it out), so a customer approving one
    -- would mean something had already gone wrong.
    if not exists (
      select 1 from public.quotes
       where id = p_quote_id and customer_id = v_customer and status = 'sent'
    ) then
      return false;
    end if;
    return public.quote_apply_option_choice(p_quote_id, p_option_id);
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

-- ── 3. The owner's door ──────────────────────────────────────────────────────
-- "They rang and said they want the Premium." Without this the owner's only way
-- to record that was the status dropdown, which sets 'accepted' and leaves
-- selected_option_id NULL — an approved options quote with no recorded choice,
-- which is the one state this whole feature exists to make impossible.
--
-- Allowed from 'draft' as well as 'sent' (the core's rule): an owner who quoted
-- across a kitchen table and never pressed Send still had the conversation.
create or replace function public.owner_select_quote_option(p_quote_id uuid, p_option_id uuid)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  -- Stated rather than implied. `user_id = auth.uid()` would already never match
  -- for an unauthenticated caller — but a guard whose safety depends on a NULL
  -- comparison behaving is the shape that failed open in the measurement RPC.
  if auth.uid() is null then return false; end if;
  if not exists (
    select 1 from public.quotes where id = p_quote_id and user_id = auth.uid()
  ) then
    return false;
  end if;
  return public.quote_apply_option_choice(p_quote_id, p_option_id);
end $$;

-- anon and service_role named for the same reason as above. `authenticated` is
-- re-granted after the revoke, because that IS this door's caller: the owner,
-- signed in, on their own screen.
revoke all on function public.owner_select_quote_option(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.owner_select_quote_option(uuid, uuid) to authenticated;

comment on function public.owner_select_quote_option(uuid, uuid) is
  'Owner records the option a customer chose by phone/in person. Same core, same money rule '
  'as portal_accept_quote — the only difference is that auth.uid() proves access instead of a token.';
