-- ── Quote Options V1 — mutually exclusive alternatives inside one quote ──────
--
-- THE REQUIREMENT
-- "Budget $3,900 / Recommended $5,400 / Premium $7,100" — three versions of the
-- SAME job, of which the customer picks ONE. EdgeQuote had no way to express
-- that: `quote_services` rows are ADDITIVE scope (they sum into initial_price),
-- so three alternatives modelled as lines would quote $16,400 for a $5,400 job.
--
-- ⭐ WHY THIS IS SMALL: `quotes.total` is a STORED GENERATED column
--     total = initial_price + coalesce(travel_fee, 0)
-- so there is exactly ONE money path out of a quote. Every downstream system —
-- the send gate, the invoice conversion (`amount: quote.total`), job costing,
-- pipeline reporting, and the deposit engine (which lives on the INVOICE, so it
-- only ever sees a figure that already came from `total`) — reads that one
-- number. Make the options drive `initial_price` and every one of them is
-- correct by construction, with no change to any of their code.
--
-- THE INVARIANT, stated once:
--     a quote with options has  initial_price = the price of ONE of its options
--       • before the customer chooses → the RECOMMENDED option (else the first)
--       • after they choose           → the SELECTED option
-- Never the sum. There is no arrangement of this data in which the alternatives
-- add up, because nothing adds them: `initial_price` is a single column holding
-- a single option's price.
--
-- ⛔ NOT the recurring cadence columns. weekly/biweekly/monthly are CADENCE
-- alternatives for one scope and stay exactly as they are — separate columns,
-- separate UI block, still not selectable (portal_accept_quote has never
-- recorded a cadence and still doesn't). Options are SCOPE alternatives. The two
-- may coexist on a quote and never interact.
--
-- ⛔ NO per-option line items in V1. An option is a name, a description and a
-- price — which is how the owner actually writes one, and what keeps every
-- reader of `quote_services` untouched. See the mutual-exclusion trigger below.

-- ── 1. The options themselves ────────────────────────────────────────────────
create table if not exists public.quote_options (
  id uuid primary key default uuid_generate_v4(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  quote_id uuid not null references public.quotes(id) on delete cascade,
  -- Denormalised owner, exactly as quote_services carries it: it is what the RLS
  -- policies below test, so a policy never has to join to the parent quote.
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (btrim(name) <> ''),
  description text,
  price numeric(10,2) not null check (price >= 0),
  sort_order int not null default 0,
  is_recommended boolean not null default false,
  -- Redundant against the primary key, and load-bearing anyway: it is the target
  -- quotes.selected_option_id points at, which is how "the selected option
  -- belongs to THIS quote" becomes a foreign key instead of a hope. See §2.
  constraint quote_options_id_quote_unique unique (id, quote_id)
);

create index if not exists quote_options_quote_idx on public.quote_options (quote_id, sort_order);
create index if not exists quote_options_user_idx on public.quote_options (user_id);

-- At most one option may wear the "Recommended" badge. A quote showing two
-- recommendations is telling the customer nothing.
create unique index if not exists quote_options_one_recommended
  on public.quote_options (quote_id) where is_recommended;

alter table public.quote_options enable row level security;

-- The same four policies quote_services carries, tested on the same column.
-- The customer side never reads through these: get_portal_data is SECURITY
-- DEFINER and does its own token→customer resolution.
drop policy if exists "quote_options: select own" on public.quote_options;
drop policy if exists "quote_options: insert own" on public.quote_options;
drop policy if exists "quote_options: update own" on public.quote_options;
drop policy if exists "quote_options: delete own" on public.quote_options;
create policy "quote_options: select own" on public.quote_options for select using (auth.uid() = user_id);
create policy "quote_options: insert own" on public.quote_options for insert with check (auth.uid() = user_id);
create policy "quote_options: update own" on public.quote_options for update using (auth.uid() = user_id);
create policy "quote_options: delete own" on public.quote_options for delete using (auth.uid() = user_id);

-- ── 2. Which one did the customer choose ─────────────────────────────────────
alter table public.quotes add column if not exists selected_option_id uuid;

-- ⭐ A COMPOSITE foreign key, not a plain one. `(selected_option_id, id)` against
-- `(id, quote_id)` makes "the selected option belongs to this quote" a database
-- fact: there is no write, from any client, RPC or psql session, that can point
-- a quote at another quote's option. A single-column FK would have allowed
-- exactly that and left the check to whoever remembered to write it.
--
-- ON DELETE RESTRICT, deliberately, and it is the whole history guarantee: once
-- a customer has selected an option, that row can no longer be deleted. The
-- alternatives they were shown stay on the record to prove what was offered, and
-- the one they approved cannot quietly disappear from underneath the approval.
-- Before any selection, selected_option_id is NULL and options delete freely.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'quotes_selected_option_fkey') then
    alter table public.quotes
      add constraint quotes_selected_option_fkey
      foreign key (selected_option_id, id)
      references public.quote_options (id, quote_id)
      on delete restrict;
  end if;
end $$;

create index if not exists quotes_selected_option_idx on public.quotes (selected_option_id);

-- ── 3. The two shape rules ───────────────────────────────────────────────────
-- A constraint TRIGGER rather than a CHECK because both rules span two tables.
-- DEFERRABLE INITIALLY DEFERRED so a delete-then-reinsert of the whole option
-- set (how the builder saves an edit) is judged on the state at COMMIT, not
-- midway through.
create or replace function public.quote_options_shape_guard() returns trigger
language plpgsql
set search_path to 'public'
as $$
declare v_quote uuid; v_options int; v_lines int;
begin
  v_quote := coalesce(new.quote_id, old.quote_id);
  if v_quote is null then return null; end if;
  -- The parent may already be gone (deleting a quote cascades to both children);
  -- there is nothing left to be inconsistent about.
  if not exists (select 1 from public.quotes where id = v_quote) then return null; end if;

  select count(*) into v_options from public.quote_options where quote_id = v_quote;
  select count(*) into v_lines   from public.quote_services where quote_id = v_quote;

  -- Comparison is the point of this feature and it stops working somewhere
  -- around four columns on a phone. The cap is a product decision made once,
  -- here, rather than in whichever screen happens to be adding a row.
  if v_options > 4 then
    raise exception 'A quote may offer at most 4 options (this one would have %)', v_options
      using errcode = 'check_violation';
  end if;

  -- ⛔ ALTERNATIVES AND ADDITIVE LINES CANNOT COEXIST. quote_services rows sum
  -- into the quote total; an option price IS the whole scope price. Allowing
  -- both would make "does this line come on top of my option, or is it already
  -- in it?" unanswerable — which is the exact ambiguity this feature exists to
  -- remove. Add-ons on top of a chosen option are a real future feature and a
  -- deliberate V2.
  if v_options > 0 and v_lines > 0 then
    raise exception 'A quote cannot have both alternative options and additive service lines'
      using errcode = 'check_violation';
  end if;
  return null;
end $$;

drop trigger if exists quote_options_shape_trg on public.quote_options;
create constraint trigger quote_options_shape_trg
  after insert or update or delete on public.quote_options
  deferrable initially deferred
  for each row execute function public.quote_options_shape_guard();

-- The mirror. Without it the rule holds only when options are written last.
drop trigger if exists quote_services_shape_trg on public.quote_services;
create constraint trigger quote_services_shape_trg
  after insert or update on public.quote_services
  deferrable initially deferred
  for each row execute function public.quote_options_shape_guard();

comment on table public.quote_options is
  'Mutually exclusive alternatives for one quote (Budget/Recommended/Premium). NOT additive: '
  'quotes.initial_price always equals ONE option''s price — the recommended one before the '
  'customer chooses, the selected one after. Cannot coexist with quote_services rows.';
comment on column public.quotes.selected_option_id is
  'The option the customer approved. Composite FK guarantees it belongs to THIS quote; '
  'ON DELETE RESTRICT keeps the approved alternative on the record permanently.';
