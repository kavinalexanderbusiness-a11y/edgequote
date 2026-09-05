-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260814074818
--   name    : quote_addons_v1_schema
--
-- Recovered 2026-08-15 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

-- ══════════════════════════════════════════════════════════════════════════════
-- QUOTE ADD-ONS V1 — optional extras the customer chooses BEFORE approving
-- ══════════════════════════════════════════════════════════════════════════════
-- ⛔ NOT change orders. A change order is additional scope AFTER approval, and it
--    is its own authorisation (public.change_orders). Nothing here may be edited
--    once the quote is decided — that is what the freeze below is for.
-- ⛔ NOT quote options. An option is a mutually exclusive ALTERNATIVE: its price
--    REPLACES the quote's price. A selected add-on's price ADDS to it.
--
-- ⭐ THE ONE MONEY RULE, unchanged in shape from quote options:
--       quotes.total  =  initial_price + travel_fee + addons_total
--    `initial_price` still holds exactly ONE price (the base, or the active
--    option's). `addons_total` holds the sum of the SELECTED add-ons and is
--    maintained by a trigger — never by application code, which is why no
--    surface can sum an unselected extra: it has no column to sum into.
--    Because `total` is still THE figure, the invoice conversion, job costing,
--    the deposit engine and pipeline reporting need zero changes.

create table if not exists public.quote_addons (
  id uuid primary key default uuid_generate_v4(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  quote_id uuid not null,
  user_id  uuid not null references auth.users(id) on delete cascade,
  name text not null,
  description text,
  price numeric(10,2) not null,
  sort_order int not null default 0,
  -- ⭐ THE fact that costs money. Default FALSE: an extra is never charged for
  --    because it exists, only because somebody chose it.
  is_selected boolean not null default false,
  -- Who made that choice. 'default' = the owner pre-ticked it when writing the
  -- quote; 'portal' = the customer ticked it; 'owner' = recorded on their behalf.
  -- ⛔ NEVER inferred — every screen can say which.
  selected_via text,
  selected_at timestamptz,
  constraint quote_addons_name_check check (btrim(name) <> ''),
  constraint quote_addons_price_check check (price >= 0),
  constraint quote_addons_via_check check (selected_via in ('default','portal','owner')),
  -- A half-recorded choice is not a state this table can hold.
  constraint quote_addons_selection_check check (
    (is_selected and selected_via is not null and selected_at is not null)
    or (not is_selected and selected_via is null and selected_at is null)
  ),
  -- ⭐ COMPOSITE FK, not a bare quote_id: "this extra belongs to THIS tenant's
  --    quote" is a database fact. A single-column FK is what let one tenant
  --    attach priced work to another's job in actual-cost-capture.
  constraint quote_addons_quote_fkey
    foreign key (user_id, quote_id) references public.quotes(user_id, id) on delete cascade,
  constraint quote_addons_id_quote_unique unique (id, quote_id)
);

create index if not exists quote_addons_quote_idx on public.quote_addons (quote_id, sort_order);
create index if not exists quote_addons_user_idx  on public.quote_addons (user_id);

-- ── The money column, and the one generated total that now includes it ────────
alter table public.quotes add column if not exists addons_total numeric(10,2) not null default 0;
alter table public.quotes
  alter column total set expression as (initial_price + coalesce(travel_fee, 0) + coalesce(addons_total, 0));

-- ── Write guard: the freeze, the invariant, and the cap ───────────────────────
create or replace function public.quote_addons_write_guard() returns trigger
language plpgsql set search_path to 'public' as $fn$
declare v_quote uuid; v_status text; v_count int;
begin
  v_quote := coalesce(new.quote_id, old.quote_id);
  select q.status into v_status from public.quotes q where q.id = v_quote;

  -- The parent quote is already gone: this row is going with it via ON DELETE
  -- CASCADE. Refusing here would make an APPROVED quote impossible to delete.
  if v_status is null then return coalesce(new, old); end if;

  -- ⭐⭐ THE FREEZE. 'draft'/'sent' = not yet decided. Any other status means a
  -- real person approved an exact set of extras at an exact price, and that set
  -- IS the record. Additional scope after approval is a CHANGE ORDER.
  if v_status not in ('draft', 'sent') then
    raise exception 'This quote has been decided — its optional extras are part of the record now. Additional work goes on a change order.'
      using errcode = 'check_violation';
  end if;

  if tg_op = 'DELETE' then return old; end if;

  -- The selection invariant is the DATABASE's to keep, so app code only ever has
  -- to say `is_selected` and cannot leave a half-recorded choice behind.
  if new.is_selected then
    if new.selected_via is null then new.selected_via := 'default'; end if;
    if new.selected_at  is null then new.selected_at  := now();     end if;
  else
    new.selected_via := null;
    new.selected_at  := null;
  end if;
  new.updated_at := now();

  select count(*) into v_count from public.quote_addons where quote_id = v_quote and id <> new.id;
  if v_count + 1 > 6 then
    raise exception 'A quote may offer at most 6 optional extras (this one would have %)', v_count + 1
      using errcode = 'check_violation';
  end if;
  return new;
end $fn$;

-- ── The sum. THE only writer of quotes.addons_total. ──────────────────────────
create or replace function public.quote_addons_sync_total() returns trigger
language plpgsql set search_path to 'public' as $fn$
declare v_quote uuid; v_sum numeric(10,2);
begin
  v_quote := coalesce(new.quote_id, old.quote_id);
  if v_quote is null then return null; end if;
  select coalesce(sum(a.price), 0) into v_sum
    from public.quote_addons a where a.quote_id = v_quote and a.is_selected;
  update public.quotes q set addons_total = v_sum
   where q.id = v_quote and q.addons_total is distinct from v_sum;
  return null;
end $fn$;

drop trigger if exists quote_addons_write_trg on public.quote_addons;
create trigger quote_addons_write_trg before insert or update or delete on public.quote_addons
  for each row execute function public.quote_addons_write_guard();

drop trigger if exists quote_addons_total_trg on public.quote_addons;
create trigger quote_addons_total_trg after insert or update or delete on public.quote_addons
  for each row execute function public.quote_addons_sync_total();

-- ── RLS ───────────────────────────────────────────────────────────────────────
alter table public.quote_addons enable row level security;

drop policy if exists "quote_addons: select own" on public.quote_addons;
create policy "quote_addons: select own" on public.quote_addons
  for select using (auth.uid() = user_id);

drop policy if exists "quote_addons: insert own" on public.quote_addons;
create policy "quote_addons: insert own" on public.quote_addons
  for insert with check (auth.uid() = user_id and exists (
    select 1 from public.quotes q
     where q.id = quote_id and q.user_id = auth.uid() and q.status in ('draft', 'sent')));

drop policy if exists "quote_addons: update own" on public.quote_addons;
create policy "quote_addons: update own" on public.quote_addons
  for update using (auth.uid() = user_id and exists (
    select 1 from public.quotes q
     where q.id = quote_id and q.user_id = auth.uid() and q.status in ('draft', 'sent')))
  with check (auth.uid() = user_id);

drop policy if exists "quote_addons: delete own" on public.quote_addons;
create policy "quote_addons: delete own" on public.quote_addons
  for delete using (auth.uid() = user_id and exists (
    select 1 from public.quotes q
     where q.id = quote_id and q.user_id = auth.uid() and q.status in ('draft', 'sent')));

-- ⚠️⚠️ Supabase's ALTER DEFAULT PRIVILEGES grants DML to anon at CREATE time.
-- Naming the role is the only thing that removes it; the portal reads add-ons
-- through get_portal_data (SECURITY DEFINER) and needs no table grant at all.
revoke all on table public.quote_addons from anon;
grant select, insert, update, delete on table public.quote_addons to authenticated;
grant all on table public.quote_addons to service_role;