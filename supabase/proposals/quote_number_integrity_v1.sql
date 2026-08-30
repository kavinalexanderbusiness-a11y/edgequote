-- ═══════════════════════════════════════════════════════════════════════════
-- QUOTE NUMBER INTEGRITY V1 — atomic, tenant-owned document numbering
-- Session 123.
--
-- ⛔⛔ PROPOSAL ONLY. NOT APPLIED, AND DELIBERATELY NOT IN supabase/migrations/.
-- It carries no version stamp because S106 takes the version from the LIVE
-- ledger at landing time. `supabase/proposals/` is not an apply path.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHAT IS ACTUALLY BROKEN (measured against main bcd1d001, 2026-08-30)
--
-- Quote numbers are allocated in FOUR places by reading the existing numbers and
-- adding one, and there is NO uniqueness constraint anywhere to catch the
-- result. `quotes` carries only quotes_pkey (id) and quotes_user_id_id_key
-- (user_id, id).
--
--   browser  src/lib/utils.ts generateQuoteNumber(maxNumericSuffix(rows) + 1)
--            — used by the quote builder, pricing recovery, single duplicate
--              and bulk duplicate. Reads EVERY quote number for the tenant and
--              takes the trailing digits, so it is scoped to NEITHER year NOR
--              prefix.
--   database public.book_service()  and  public.submit_booking()
--            — max(regexp_match(quote_number,'([0-9]+)$')) + 1 filtered by
--              like 'EPS-<year>-%', so these ARE year- and prefix-scoped.
--
-- ⭐⭐ THOSE TWO RULES DISAGREE, and the disagreement is a collision generator in
-- its own right. At a year boundary the database restarts at 0001 while the
-- browser keeps counting from the all-time maximum; the database then walks
-- upward into numbers the browser has already issued. No concurrency is needed
-- for that one — only a calendar.
--
-- ⭐⭐ AND THE PRODUCTION DUPLICATES WERE NOT A RACE. EPS-2026-0008 and
-- EPS-2026-0009 are each duplicated 70 and 76 minutes after their originals. At
-- 23:28 the series had already reached 0009; the 00:40 and 00:45 creations
-- minted 0008 and then 0009 again, which is what an allocator does when it is
-- adding one to a snapshot it read when the maximum was 0007. The defect is
-- read-then-insert with no atomicity — contention is one way to lose that race,
-- and a stale tab is another. Both are cured here the same way.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- THE DESIGN, AND WHY THIS PRIMITIVE
--
-- A per-(tenant, kind, prefix, year) COUNTER ROW, advanced by a single
-- INSERT … ON CONFLICT DO UPDATE … RETURNING.
--
-- Why this and not the alternatives:
--   • A Postgres SEQUENCE cannot be scoped per tenant without minting one
--     sequence per tenant per year — unbounded DDL driven by data.
--   • An ADVISORY LOCK would serialise correctly but leaves the number itself
--     derived from a MAX() scan, so it stays O(quotes) forever and still trusts
--     a scan for correctness rather than a stored fact.
--   • ON CONFLICT DO UPDATE takes a row lock and returns the updated value in
--     ONE statement. There is no window between reading and writing because
--     there is no separate read. Concurrent callers serialise on the row and
--     each receives a distinct value.
--
-- ⭐ GAPS ARE ACCEPTED. A rolled-back insert leaves its number spent, exactly as
-- a sequence would. Production already has 42 gaps in the 2026 series, so the
-- product plainly never promised gapless numbering, and buying gaplessness would
-- mean holding a lock across the whole quote insert.
--
-- ⭐ YEAR SEMANTICS: NUMBERING RESETS ANNUALLY. Evidence, not preference — the
-- year is inside the customer-visible number, and both database allocators
-- already filter by it. The browser's non-resetting behaviour is the outlier
-- (it is also why the malformed legacy numbers EPS-0002 / EPS-0009, which carry
-- no year at all, can still contaminate a 2026 maximum). Allocation scope is
-- therefore tenant + prefix + year.
--
-- ⭐ PREFIX: `EPS` is Edge Property Services' initials, currently minted for
-- EVERY tenant. This file does not rename one existing quote. It moves the
-- prefix to a resolved value with a real configuration home
-- (business_settings.quote_prefix) and a resolution order that keeps the
-- founding tenant on EPS while never branding a new business with it.
-- ═══════════════════════════════════════════════════════════════════════════


-- ── 1 · the configuration home for the prefix ───────────────────────────────
-- ⭐ business_settings is where per-tenant configuration already lives, so the
-- prefix goes there rather than into a new settings engine. NULL means "resolve
-- it for me", which is what every existing tenant will be.
alter table public.business_settings
  add column if not exists quote_prefix text;

comment on column public.business_settings.quote_prefix is
  'Document prefix for this tenant''s quote numbers (e.g. ABC in ABC-2026-0001). NULL = derived: the prefix this tenant''s existing quotes already use, else the initials of company_name, else Q. Never defaults to another business''s initials.';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'business_settings_quote_prefix_check') then
    alter table public.business_settings
      add constraint business_settings_quote_prefix_check
      check (quote_prefix is null or quote_prefix ~ '^[A-Za-z][A-Za-z0-9]{0,9}$');
  end if;
end $$;


-- ── 2 · prefix resolution — ONE definition ──────────────────────────────────
-- ⛔ NOT a hardcoded 'EPS'. The order matters and each step has a reason:
--   1. an explicit setting — the owner said so
--   2. the prefix this tenant's own quotes ALREADY use — continuity beats
--      cleverness; the founding tenant stays on EPS and its series never
--      restarts, which is the whole reason the old code could not simply be
--      re-prefixed
--   3. initials of company_name — a new business gets its OWN identity
--   4. 'Q' — a neutral last resort, never another company's initials
create or replace function public.quote_number_prefix(p_user uuid)
returns text
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_prefix text;
  v_name   text;
begin
  select nullif(btrim(quote_prefix), '') into v_prefix
    from public.business_settings where user_id = p_user;
  if v_prefix is not null then return v_prefix; end if;

  -- The prefix this tenant is already using, taken from its most recent
  -- well-formed number.
  select (regexp_match(quote_number, '^([A-Za-z][A-Za-z0-9]*)-\d{4}-\d+$'))[1]
    into v_prefix
    from public.quotes
   where user_id = p_user
     and quote_number ~ '^[A-Za-z][A-Za-z0-9]*-\d{4}-\d+$'
   order by created_at desc
   limit 1;
  if v_prefix is not null then return v_prefix; end if;

  select nullif(btrim(company_name), '') into v_name
    from public.business_settings where user_id = p_user;
  if v_name is not null then
    -- Initials, letters and digits only, capped — "Jones & Co Ltd" → "JCL".
    v_prefix := upper(left(regexp_replace(
      array_to_string(array(
        select left(w, 1) from regexp_split_to_table(v_name, '\s+') as w where w <> ''
      ), ''), '[^A-Za-z0-9]', '', 'g'), 10));
    if v_prefix ~ '^[A-Za-z]' then return v_prefix; end if;
  end if;

  return 'Q';
end;
$function$;

comment on function public.quote_number_prefix(uuid) is
  'THE resolver for a tenant''s quote prefix. Explicit setting, else the prefix their existing quotes already use, else initials of company_name, else Q.';


-- ── 3 · the counter ─────────────────────────────────────────────────────────
-- ⭐ `kind` exists so invoices can adopt this allocator later WITHOUT a second
-- counter engine. Only 'quote' is wired in this change; src/lib/invoicing.ts
-- still carries the same read-then-insert defect and is deliberately untouched
-- here (another session owns invoicing).
create table if not exists public.document_number_counters (
  "user_id"    uuid not null,
  "kind"       text not null,
  "prefix"     text not null,
  "year"       integer not null,
  -- The NEXT value to hand out. Advanced by the allocator, never by hand.
  "next_value" integer not null default 1,
  "updated_at" timestamp with time zone default now() not null,

  constraint document_number_counters_pkey primary key (user_id, kind, prefix, year),
  constraint document_number_counters_user_id_fkey
    foreign key (user_id) references auth.users(id) on delete cascade,
  constraint document_number_counters_kind_check check (kind in ('quote')),
  constraint document_number_counters_prefix_check check (prefix ~ '^[A-Za-z][A-Za-z0-9]{0,9}$'),
  constraint document_number_counters_year_check check (year between 2000 and 2999),
  constraint document_number_counters_next_check check (next_value >= 1)
);

comment on table public.document_number_counters is
  'Atomic document-number allocation, one row per tenant/kind/prefix/year. Advanced only by allocate_quote_number() via INSERT ... ON CONFLICT DO UPDATE ... RETURNING, which has no read-then-write window.';

alter table public.document_number_counters enable row level security;

-- ⭐ READ-ONLY to the owner. There is deliberately NO insert/update/delete
-- policy: the counter is advanced exclusively through the allocator, so a client
-- cannot rewind its own sequence to reissue a number, and cannot touch anyone
-- else's row at all.
create policy "document_number_counters: select own" on public.document_number_counters
  for select to authenticated using (auth.uid() = user_id);

revoke all on public.document_number_counters from anon;


-- ── 4 · seeding — the counter must not restart the founding tenant ──────────
-- ⛔ WITHOUT THIS, THE FIRST ALLOCATION AFTER APPLY MINTS 0001 ON TOP OF A LIVE
-- SERIES. Seed every existing (tenant, prefix, year) from the highest number
-- that series has actually issued.
--
-- ⚠️ Only WELL-FORMED numbers seed. The legacy malformed ones (EPS-0002,
-- EPS-0009 — no year segment) belong to no year series, so they cannot say what
-- the 2026 counter should be. They are left exactly as they are.
insert into public.document_number_counters (user_id, kind, prefix, year, next_value)
select q.user_id,
       'quote',
       (regexp_match(q.quote_number, '^([A-Za-z][A-Za-z0-9]*)-(\d{4})-(\d+)$'))[1],
       ((regexp_match(q.quote_number, '^([A-Za-z][A-Za-z0-9]*)-(\d{4})-(\d+)$'))[2])::int,
       max(((regexp_match(q.quote_number, '^([A-Za-z][A-Za-z0-9]*)-(\d{4})-(\d+)$'))[3])::int) + 1
  from public.quotes q
 where q.quote_number ~ '^[A-Za-z][A-Za-z0-9]*-\d{4}-\d+$'
 group by 1, 2, 3, 4
on conflict (user_id, kind, prefix, year) do update
  set next_value = greatest(public.document_number_counters.next_value, excluded.next_value);


-- ── 5 · THE allocator ───────────────────────────────────────────────────────
-- ⭐⭐ ONE STATEMENT. The INSERT … ON CONFLICT DO UPDATE … RETURNING takes a row
-- lock on the counter and returns the value it just claimed. There is no moment
-- at which two callers can both hold the same number, because nobody ever reads
-- a value and writes it back — the read and the write are the same statement.
--
-- ⛔ SECURITY DEFINER, AND HERE IS THE JUSTIFICATION. It is required because the
-- anonymous booking doors (book_service, submit_booking) must allocate for the
-- tenant their token resolves to, and that caller has no session of their own.
-- The risk that creates is answered explicitly:
--   • search_path is pinned.
--   • A SIGNED-IN caller may only ever allocate for THEMSELVES: if auth.uid() is
--     present it must equal the requested tenant, so tenant A can never consume
--     tenant B's counter.
--   • EXECUTE is granted to authenticated and service_role. ⛔ NOT to anon —
--     the public booking RPCs reach it as the definer role that owns them, not
--     as the anonymous caller, so anon gets no direct door.
--   • It allocates a number and nothing else. It writes no quote, reads no
--     customer data, and cannot be used to discover another tenant's totals.
create or replace function public.allocate_quote_number(p_user uuid default null)
returns text
language plpgsql
volatile
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_user   uuid := coalesce(p_user, auth.uid());
  v_caller uuid := auth.uid();
  v_prefix text;
  v_year   int;
  v_value  int;
begin
  if v_user is null then
    raise exception 'allocate_quote_number: no tenant in context';
  end if;
  -- ⛔ THE TENANT BOUNDARY. A signed-in caller cannot allocate for anyone else.
  -- (A definer path such as book_service has no auth.uid() and passes the tenant
  -- it resolved from the booking token itself.)
  if v_caller is not null and v_caller <> v_user then
    raise exception 'allocate_quote_number: cannot allocate a number for another business';
  end if;

  v_prefix := public.quote_number_prefix(v_user);
  v_year   := extract(year from now())::int;

  -- ⭐ THE ATOMIC STEP.
  insert into public.document_number_counters (user_id, kind, prefix, year, next_value)
       values (v_user, 'quote', v_prefix, v_year, 2)
  on conflict (user_id, kind, prefix, year) do update
       set next_value = public.document_number_counters.next_value + 1,
           updated_at = now()
    returning case when xmax = 0 then 1 else next_value - 1 end into v_value;

  return v_prefix || '-' || v_year::text || '-' || lpad(v_value::text, 4, '0');
end;
$function$;

comment on function public.allocate_quote_number(uuid) is
  'THE only way a quote number is minted. Atomic per tenant/prefix/year; gaps are possible and acceptable, duplicates are not.';

revoke all on function public.allocate_quote_number(uuid) from public, anon, authenticated, service_role;
grant execute on function public.allocate_quote_number(uuid) to authenticated;
grant execute on function public.allocate_quote_number(uuid) to service_role;

revoke all on function public.quote_number_prefix(uuid) from public, anon, authenticated, service_role;
grant execute on function public.quote_number_prefix(uuid) to authenticated;
grant execute on function public.quote_number_prefix(uuid) to service_role;


-- ── 6 · THE BARRIER (stage 1 of 2) ──────────────────────────────────────────
-- ⭐⭐ A UNIQUE INDEX IS THE ONLY REAL DEFENCE, and it cannot be created over
-- this data: production already holds EPS-2026-0008 ×2 and EPS-2026-0009 ×2.
-- Renumbering a customer-facing document is the owner's decision, not a
-- migration's, so stage 1 protects everything from here on WITHOUT touching one
-- historical row:
--
--   a PARTIAL unique index over rows created from the cutoff onward.
--
-- This is a genuine index — it locks and serialises like any other — so it is a
-- real concurrency barrier for every new quote, not a check that can be raced.
-- The historical duplicates simply fall outside its predicate.
--
-- ⚠️ The cutoff is a literal timestamp and must be edited to the apply date when
-- S106 stamps this file. It must be AT OR AFTER the moment of apply, or rows
-- created during the migration window escape the barrier.
do $$
declare
  v_cutoff constant timestamptz := timestamptz '2026-08-30 00:00:00+00';
begin
  if not exists (select 1 from pg_class where relname = 'quotes_user_qnum_new_unique') then
    execute format(
      'create unique index quotes_user_qnum_new_unique on public.quotes (user_id, quote_number) where created_at >= %L',
      v_cutoff);
  end if;
end $$;

comment on index public.quotes_user_qnum_new_unique is
  'STAGE 1 barrier: within a tenant, a quote number issued from the cutoff onward identifies exactly one quote. Partial because two historical duplicates predate it and renumbering a customer-facing document is the owner''s call. Stage 2 replaces this with the full constraint once those are resolved.';


-- ── 7 · re-route the two public booking doors ───────────────────────────────
-- ⭐⭐ IN-PLACE, GUARDED REPLACEMENT — NOT A REWRITE. `book_service` and
-- `submit_booking` are large functions that other sessions also touch. Pasting a
-- whole new body here would silently discard whatever landed in them between
-- this file being written and being applied. So the allocation lines are swapped
-- out of the CURRENT definition, and the swap REFUSES if the text it expects is
-- not found — a failed apply is recoverable, a silently-unrouted booking door is
-- not.
do $$
declare
  v_fn   text;
  v_new  text;
  v_hits int;
begin
  -- ── book_service ────────────────────────────────────────────────────────
  select pg_get_functiondef(p.oid) into v_fn
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'book_service'
   limit 1;
  if v_fn is null then
    raise exception 'quote_number_integrity: public.book_service() not found';
  end if;

  v_new := replace(v_fn,
    E'    select coalesce(max((regexp_match(quote_number,\'([0-9]+)$\'))[1]::int),0)+1 into v_num from public.quotes where user_id=v_user and quote_number like \'EPS-\'||extract(year from now())::text||\'-%\';\n'
    || E'    v_qnum := \'EPS-\'||extract(year from now())::text||\'-\'||lpad(v_num::text,4,\'0\');',
    E'    v_qnum := public.allocate_quote_number(v_user);');
  if v_new = v_fn then
    raise exception 'quote_number_integrity: book_service() no longer contains the expected MAX()+1 allocation — re-measure before applying';
  end if;
  execute v_new;

  -- ── submit_booking ──────────────────────────────────────────────────────
  select pg_get_functiondef(p.oid) into v_fn
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'submit_booking'
   limit 1;
  if v_fn is null then
    raise exception 'quote_number_integrity: public.submit_booking() not found';
  end if;

  v_new := replace(v_fn,
    E'  select coalesce(max((regexp_match(quote_number, \'([0-9]+)$\'))[1]::int), 0) + 1 into v_num\n'
    || E'    from public.quotes where user_id = v_user and quote_number like \'EPS-\' || extract(year from now())::text || \'-%\';\n'
    || E'  v_qnum := \'EPS-\' || extract(year from now())::text || \'-\' || lpad(v_num::text, 4, \'0\');',
    E'  v_qnum := public.allocate_quote_number(v_user);');
  if v_new = v_fn then
    raise exception 'quote_number_integrity: submit_booking() no longer contains the expected MAX()+1 allocation — re-measure before applying';
  end if;
  execute v_new;

  -- ⛔ NOTHING may still scan quotes for a maximum.
  select count(*) into v_hits
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and pg_get_functiondef(p.oid) ilike '%max((regexp_match(quote_number%';
  if v_hits > 0 then
    raise exception 'quote_number_integrity: % function(s) still allocate quote numbers with MAX()+1', v_hits;
  end if;
end $$;


-- ── 8 · stage 2, deliberately NOT executed here ─────────────────────────────
-- ⛔ DO NOT UNCOMMENT UNTIL THE OWNER HAS RESOLVED THE HISTORICAL DUPLICATES.
-- Run the preflight first; it REPORTS and REFUSES rather than modifying data.
--
--   do $$
--   declare v_dupes text;
--   begin
--     select string_agg(format('%s ×%s (%s)', quote_number, n, ids), E'\n')
--       into v_dupes
--       from (select user_id, quote_number, count(*) n,
--                    string_agg(id::text, ', ' order by created_at) ids
--               from public.quotes group by 1,2 having count(*) > 1) d;
--     if v_dupes is not null then
--       raise exception E'Cannot add UNIQUE (user_id, quote_number) — duplicates remain:\n%', v_dupes;
--     end if;
--     drop index if exists public.quotes_user_qnum_new_unique;
--     alter table public.quotes
--       add constraint quotes_user_quote_number_key unique (user_id, quote_number);
--   end $$;
--
-- ⭐ Note what stage 2 does NOT do: it does not append "-2", does not mint a
-- replacement, and does not pick a winner. A quote number is on documents the
-- customer already holds.
