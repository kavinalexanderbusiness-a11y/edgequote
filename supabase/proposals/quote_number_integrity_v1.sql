-- ═══════════════════════════════════════════════════════════════════════════
-- QUOTE NUMBER INTEGRITY V1 — atomic, tenant-owned document numbering
-- Session 123.
--
-- ⛔⛔ PROPOSAL ONLY. NOT APPLIED, AND DELIBERATELY NOT IN supabase/migrations/.
-- It carries no version stamp because S106 takes the version from the LIVE
-- ledger at landing time. `supabase/proposals/` is not an apply path.
--
-- ⭐⭐ THIS FILE IS ORDER-SENSITIVE AND CONTAINS ONE ATOMIC CUTOVER (§7).
-- Read §7's header before applying it. There is no interval in which a newly
-- created quote escapes both the old behaviour and the new protection, and that
-- property comes from the ORDER of the statements, not from a timestamp anyone
-- has to remember to edit.
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
-- TWO objects, with two different jobs. Keeping them apart is the point.
--
--   • A COUNTER (§3) says what number to hand out next. It is a convenience and
--     a performance property: per (tenant, kind, prefix, year), advanced by a
--     single INSERT … ON CONFLICT DO UPDATE … RETURNING.
--   • A CLAIM REGISTRY (§6) says which numbers a tenant has ALREADY USED — ever,
--     including every number minted before this migration existed. Its PRIMARY
--     KEY is the barrier. A quote row cannot be written unless its number can be
--     claimed, and a number can only be claimed once.
--
-- ⭐⭐ WHY BOTH. A counter alone is a CONVENTION: it is only correct while every
-- caller agrees to use it. The registry is a DATABASE INVARIANT: it holds
-- against a stale tab, an old deployment, a hand-written INSERT, a replayed
-- request and a caller who simply makes a number up. Correctness lives in the
-- registry; the counter only decides which number to try first.
--
-- Why the counter is INSERT … ON CONFLICT DO UPDATE … RETURNING and not:
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
-- therefore tenant + prefix + year. ⭐ The CLAIM registry is deliberately NOT
-- scoped by year or prefix — it is scoped to the tenant and the literal string,
-- because "has this business ever issued this exact number" is the question that
-- protects history.
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


-- ── 2 · prefix resolution — ONE definition, and it is INTERNAL ──────────────
-- ⛔ NOT a hardcoded 'EPS'. The order matters and each step has a reason:
--   1. an explicit setting — the owner said so
--   2. the prefix this tenant's own quotes ALREADY use — continuity beats
--      cleverness; the founding tenant stays on EPS and its series never
--      restarts, which is the whole reason the old code could not simply be
--      re-prefixed
--   3. initials of company_name — a new business gets its OWN identity
--   4. 'Q' — a neutral last resort, never another company's initials
--
-- ⛔⛔ THIS FUNCTION READS ANOTHER BUSINESS'S NAME AND NUMBERING. It touches
-- business_settings.quote_prefix, business_settings.company_name and the tenant's
-- own quote_number series — all of which RLS otherwise keeps private. As a
-- SECURITY DEFINER with a direct EXECUTE grant it would have been a working
-- cross-tenant disclosure oracle: call it with any user id, learn that business's
-- configured prefix, and (via the initials branch) a compressed form of its
-- company name. TWO independent defences, because either one alone is a single
-- point of failure:
--
--   A. NO DIRECT GRANT. Execute is revoked from public, anon, authenticated and
--      service_role at the end of this section. It is an internal helper of
--      allocate_quote_number(), which reaches it as the definer role that owns
--      both. No client has a door to it at all.
--   B. THE SAME TENANT BOUNDARY THE ALLOCATOR ENFORCES. Even if a future
--      migration restores a grant by accident, a signed-in caller may only
--      resolve its OWN tenant. A definer path with no auth.uid() (the public
--      booking doors, reaching the tenant their token resolved) still works.
create or replace function public.quote_number_prefix(p_user uuid)
returns text
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_caller uuid := auth.uid();
  v_prefix text;
  v_name   text;
begin
  if p_user is null then
    raise exception 'quote_number_prefix: no tenant in context';
  end if;
  -- ⛔ THE TENANT BOUNDARY (defence B). Identical in shape and wording to the
  -- allocator's, because it is the same rule: a signed-in caller speaks only for
  -- itself. auth.uid() is null on the trusted definer paths, which is what lets
  -- public booking resolve the tenant its token named.
  if v_caller is not null and v_caller <> p_user then
    raise exception 'quote_number_prefix: cannot resolve the prefix of another business';
  end if;

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
  'INTERNAL helper of allocate_quote_number(). THE resolver for a tenant''s quote prefix: explicit setting, else the prefix their existing quotes already use, else initials of company_name, else Q. ⛔ No direct EXECUTE grant — it reads another tenant''s configuration and name, and it also enforces the same signed-in-caller-may-only-resolve-itself boundary as the allocator.';

-- ⛔⛔ DEFENCE A — NO DIRECT DOOR. Not authenticated, not anon, not service_role.
-- The only caller is allocate_quote_number(), which runs as the role that owns
-- this function and therefore needs no grant.
revoke all on function public.quote_number_prefix(uuid) from public;
revoke all on function public.quote_number_prefix(uuid) from anon;
revoke all on function public.quote_number_prefix(uuid) from authenticated;
revoke all on function public.quote_number_prefix(uuid) from service_role;


-- ── 3 · the counter (which number to TRY next) ──────────────────────────────
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
  'Which number to hand out next, one row per tenant/kind/prefix/year. Advanced only by allocate_quote_number() via INSERT ... ON CONFLICT DO UPDATE ... RETURNING, which has no read-then-write window. ⛔ This is NOT the uniqueness barrier — document_number_claims is.';

alter table public.document_number_counters enable row level security;

-- ⭐ READ-ONLY to the owner. There is deliberately NO insert/update/delete
-- policy: the counter is advanced exclusively through the allocator, so a client
-- cannot rewind its own sequence to reissue a number, and cannot touch anyone
-- else's row at all.
create policy "document_number_counters: select own" on public.document_number_counters
  for select to authenticated using (auth.uid() = user_id);

revoke all on public.document_number_counters from anon;


-- ── 4 · seeding the counter — do not restart a live series ──────────────────
-- ⛔ WITHOUT THIS, THE FIRST ALLOCATION AFTER APPLY MINTS 0001 ON TOP OF A LIVE
-- SERIES. Seed every existing (tenant, prefix, year) from the highest number
-- that series has actually issued.
--
-- ⚠️ Only WELL-FORMED numbers seed. The legacy malformed ones (EPS-0002,
-- EPS-0009 — no year segment) belong to no year series, so they cannot say what
-- the 2026 counter should be. They are left exactly as they are — and §6 claims
-- them anyway, which is what actually stops them being reissued.
--
-- ⚠️ The bounds mirror the counter's own CHECK constraints (prefix ≤ 10 chars,
-- sequence ≤ 9 digits so it fits in an int, year 2000–2999). A legacy oddity
-- outside them must not abort the migration on a constraint violation.
insert into public.document_number_counters (user_id, kind, prefix, year, next_value)
select q.user_id,
       'quote',
       (regexp_match(q.quote_number, '^([A-Za-z][A-Za-z0-9]{0,9})-(\d{4})-(\d{1,9})$'))[1],
       ((regexp_match(q.quote_number, '^([A-Za-z][A-Za-z0-9]{0,9})-(\d{4})-(\d{1,9})$'))[2])::int,
       max(((regexp_match(q.quote_number, '^([A-Za-z][A-Za-z0-9]{0,9})-(\d{4})-(\d{1,9})$'))[3])::int) + 1
  from public.quotes q
 where q.quote_number ~ '^[A-Za-z][A-Za-z0-9]{0,9}-\d{4}-\d{1,9}$'
   and ((regexp_match(q.quote_number, '^[A-Za-z][A-Za-z0-9]{0,9}-(\d{4})-\d{1,9}$'))[1])::int between 2000 and 2999
 group by 1, 2, 3, 4
on conflict (user_id, kind, prefix, year) do update
  set next_value = greatest(public.document_number_counters.next_value, excluded.next_value);


-- ── 5 · THE allocator ───────────────────────────────────────────────────────
-- ⭐⭐ ONE STATEMENT. The INSERT … ON CONFLICT DO UPDATE … RETURNING takes a row
-- lock on the counter and returns the value it just claimed. There is no moment
-- at which two callers can both hold the same number, because nobody ever reads
-- a value and writes it back — the read and the write are the same statement.
--
-- ⭐⭐ RETURNING next_value - 1, AND NOTHING CLEVERER. `next_value` after the
-- statement is, in BOTH branches, one past the value this call claimed:
--   • INSERT branch  — the row is created with next_value = 2, so it claimed 1.
--   • UPDATE branch  — next_value became old + 1, so it claimed old.
-- So `next_value - 1` IS the contract, stated once, covering both branches.
-- ⛔ An earlier draft used `case when xmax = 0 then 1 else next_value - 1 end`.
-- That is the same arithmetic routed through a system column whose value is an
-- implementation detail of MVCC, and it made "which number did I just claim"
-- depend on how the row happened to be written. Numbering correctness must not
-- read xmax. verify:quote-number-integrity pins the FIRST allocation (the insert
-- branch) and a SUBSEQUENT one (the update branch) separately, so both are
-- measured rather than assumed.
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
--
-- ⭐ WHAT THIS FUNCTION IS NOT. It is not the uniqueness guarantee. It hands out
-- a number that is very likely free; §6 is what makes writing a duplicate
-- impossible. If those two ever disagree, the write is refused — never doubled.
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
    returning next_value - 1 into v_value;

  return v_prefix || '-' || v_year::text || '-' || lpad(v_value::text, 4, '0');
end;
$function$;

comment on function public.allocate_quote_number(uuid) is
  'THE only way a quote number is minted. Atomic per tenant/prefix/year; gaps are possible and acceptable, duplicates are not. Returns next_value - 1 in both the insert and the update branch. ⛔ Not the barrier — document_number_claims is.';

revoke all on function public.allocate_quote_number(uuid) from public, anon, authenticated, service_role;
grant execute on function public.allocate_quote_number(uuid) to authenticated;
grant execute on function public.allocate_quote_number(uuid) to service_role;


-- ═══════════════════════════════════════════════════════════════════════════
-- 6 · THE BARRIER — a claim registry that includes HISTORY
-- ═══════════════════════════════════════════════════════════════════════════
-- ⭐⭐ THE INVARIANT THIS ENFORCES, STATED ONCE:
--
--     A NEW QUOTE ROW CANNOT CARRY A NUMBER THIS TENANT HAS ALREADY USED —
--     INCLUDING A NUMBER USED BEFORE THIS MIGRATION EXISTED.
--
-- ⛔ WHY A PARTIAL INDEX OVER `created_at >= cutoff` IS NOT ENOUGH, which is what
-- an earlier draft of this file relied on. A partial index only sees rows its
-- predicate admits. The historical row EPS-2026-0042 sits OUTSIDE the predicate,
-- so a post-cutoff row carrying EPS-2026-0042 does not collide with it and is
-- written happily. The counter seed makes the canonical allocator unlikely to
-- emit that number — but "unlikely, provided every caller is current" is a
-- convention. A stale tab, an old deployment, a replayed request or a
-- hand-written INSERT are all outside that provision, and those are exactly the
-- callers this session exists because of.
--
-- ⭐⭐ THE REGISTRY IS SEEDED FROM DISTINCT HISTORICAL NUMBERS, so the two
-- duplicated pairs collapse into ONE claim each and NOT ONE HISTORICAL ROW IS
-- TOUCHED, RENUMBERED OR DELETED. History keeps its duplicates; the future
-- cannot add to them.
--
-- ⭐ AND IT IS NOT RACEABLE, because it is not a check. There is no
-- `select exists(...)` guarding the write anywhere in this path. The claim is an
-- INSERT against a PRIMARY KEY, so two concurrent writers of the same number
-- serialise on the index and exactly one of them survives — the same mechanism
-- as any unique constraint, which is the only kind of guarantee worth having.
create table if not exists public.document_number_claims (
  "user_id"    uuid not null,
  "kind"       text not null,
  -- ⭐ THE LITERAL NUMBER AS DISPLAYED. Not parsed, not normalised, not split
  -- into prefix/year/sequence — because the malformed legacy numbers (EPS-0002,
  -- EPS-0009) have no year to split on, and they must be claimed too.
  "number"     text not null,
  "claimed_at" timestamp with time zone default now() not null,

  constraint document_number_claims_pkey primary key (user_id, kind, number),
  constraint document_number_claims_user_id_fkey
    foreign key (user_id) references auth.users(id) on delete cascade,
  constraint document_number_claims_kind_check check (kind in ('quote'))
);

comment on table public.document_number_claims is
  'THE uniqueness barrier for document numbers. One row per (tenant, kind, number) the tenant has ever used, seeded from DISTINCT historical quote numbers so a pre-existing number can never be reissued. Its PRIMARY KEY is the guarantee — claiming is an INSERT, not a check, so it cannot be raced.';

alter table public.document_number_claims enable row level security;

-- ⭐ READ-ONLY to the owner, exactly like the counter. No client write policy:
-- a client that could DELETE a claim could free a number and then reissue it.
create policy "document_number_claims: select own" on public.document_number_claims
  for select to authenticated using (auth.uid() = user_id);

revoke all on public.document_number_claims from anon;


-- ── 6a · claiming, on the way in ────────────────────────────────────────────
-- ⛔ SECURITY DEFINER because the claim registry and the counter have NO client
-- write policy — by design. The trigger therefore writes them as the owning
-- role. The tenant it writes for is NEW.user_id, and that value is already
-- constrained by the quotes RLS insert policy (`with check (auth.uid() =
-- user_id)`), so a client cannot aim this at another business.
--
-- ⭐⭐ IT ALSO ADVANCES THE COUNTER TO MATCH — the watermark bump. Any row that
-- arrives carrying a number the allocator did not mint (an old deployment still
-- running MAX()+1, a restore, an import) pushes the counter past it. That is
-- what makes the schema-first cutover in §7 safe: while the OLD app is still
-- deployed against the NEW schema, its inserts keep the counter AHEAD of the
-- data instead of leaving it behind, so the first call from the NEW app cannot
-- land on a number the old one just used.
create or replace function public.claim_document_number()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_parts text[];
  v_year  int;
begin
  if new.quote_number is null then
    return new;
  end if;
  -- An UPDATE that does not move the number has nothing to claim.
  -- ⚠️ Nested, not `and`-ed: OLD is null on INSERT and plpgsql does not promise
  -- to short-circuit a boolean expression before evaluating both sides.
  if tg_op = 'UPDATE' then
    if new.quote_number is not distinct from old.quote_number then
      return new;
    end if;
  end if;

  -- ⭐ THE BARRIER. An INSERT against a PRIMARY KEY — not a check, not a scan.
  begin
    insert into public.document_number_claims (user_id, kind, number)
         values (new.user_id, 'quote', new.quote_number);
  exception when unique_violation then
    raise exception 'quote number % has already been used by this business', new.quote_number
      using errcode = '23505',
            hint = 'Quote numbers are issued by allocate_quote_number(). Ask for a new one rather than setting this field by hand.';
  end;

  -- ── the watermark bump ──────────────────────────────────────────────────
  -- ⚠️ Only for numbers that parse as prefix-year-sequence, and only inside the
  -- ranges the counter's own CHECK constraints allow — otherwise a legacy or
  -- imported oddity (EPS-0002, or a year of 1999) would make this trigger raise
  -- a constraint violation and block a write that is otherwise perfectly legal.
  v_parts := regexp_match(new.quote_number, '^([A-Za-z][A-Za-z0-9]{0,9})-(\d{4})-(\d{1,9})$');
  if v_parts is not null then
    v_year := (v_parts[2])::int;
    if v_year between 2000 and 2999 then
      insert into public.document_number_counters (user_id, kind, prefix, year, next_value)
           values (new.user_id, 'quote', v_parts[1], v_year, (v_parts[3])::int + 1)
      on conflict (user_id, kind, prefix, year) do update
           set next_value = greatest(public.document_number_counters.next_value, excluded.next_value),
               updated_at = now();
    end if;
  end if;

  return new;
end;
$function$;

comment on function public.claim_document_number() is
  'BEFORE INSERT/UPDATE OF quote_number on quotes: claims the number in document_number_claims (PK = the barrier, so a number this tenant already used is refused) and advances the counter past it. ⛔ Trigger use only — no EXECUTE grant.';


-- ── 6b · releasing, on the way out ──────────────────────────────────────────
-- ⭐ WITHOUT THIS, UNDO WOULD BE BROKEN. Both delete paths in the app offer a
-- full-row Undo that RE-INSERTS the original row keeping its original number
-- (src/app/dashboard/quotes/page.tsx and src/components/quotes/QuoteList.tsx).
-- If a claim outlived its row, the restore would be refused and the quote would
-- be unrecoverable — a data-loss bug introduced by a data-integrity feature.
--
-- ⭐⭐ IT RELEASES ONLY WHEN NO ROW STILL HOLDS THE NUMBER. That single condition
-- is what keeps the historical duplicate pairs safe: EPS-2026-0008 exists twice
-- and shares ONE claim, so deleting one of them must not free a number the other
-- one is still showing a customer.
--
-- ⚠️ THE RACE, NAMED AND ACCEPTED. Two concurrent transactions each deleting one
-- row of a duplicate pair will each still see the other's row and neither will
-- release, leaving a claim with no holder. That direction is CONSERVATIVE — the
-- number stays reserved and simply cannot be reused. The opposite error (freeing
-- a number a live quote still displays) cannot happen, because the surviving row
-- is visible to any snapshot that could reach this code.
create or replace function public.release_document_number()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if old.quote_number is null then
    return null;
  end if;
  if tg_op = 'UPDATE' then
    if new.quote_number is not distinct from old.quote_number then
      return null;
    end if;
  end if;

  if not exists (
    select 1 from public.quotes
     where user_id = old.user_id and quote_number = old.quote_number
  ) then
    delete from public.document_number_claims
     where user_id = old.user_id and kind = 'quote' and number = old.quote_number;
  end if;

  return null;
end;
$function$;

comment on function public.release_document_number() is
  'AFTER DELETE/UPDATE OF quote_number on quotes: frees the claim only when no quote row still carries that number, so Undo can restore a deleted quote with its original number while a surviving duplicate keeps its own claim. ⛔ Trigger use only — no EXECUTE grant.';

-- ⛔ Neither trigger function is callable directly (Postgres refuses to call a
-- trigger function from SQL), but the grants are removed anyway: a future change
-- that alters a return type should not silently inherit a public door.
revoke all on function public.claim_document_number() from public, anon, authenticated, service_role;
revoke all on function public.release_document_number() from public, anon, authenticated, service_role;


-- ═══════════════════════════════════════════════════════════════════════════
-- 7 · THE CUTOVER ATOM — one transaction, no escape window
-- ═══════════════════════════════════════════════════════════════════════════
-- ⭐⭐ EVERYTHING ABOVE THIS POINT IS INERT. The counter has been seeded and the
-- allocator exists, but nothing yet enforces anything and no existing behaviour
-- has changed. A quote created while §1–§6 were running behaved exactly as it
-- did yesterday. This block is the instant the invariant starts holding, and it
-- is written so there is NO INTERVAL in which a new quote escapes both the old
-- behaviour and the new protection.
--
-- ⛔ THE MISTAKE THIS REPLACES. The previous draft created a partial unique index
-- over `created_at >= <a literal timestamp>` and left a note asking whoever
-- applied it to edit that literal to the apply date. Two failures in one:
--   • A cutoff BEFORE apply cannot be indexed (history would violate it).
--   • A cutoff AFTER apply leaves every row created in between unprotected —
--     the window is exactly the thing the barrier exists to close.
-- There is no correct literal, so the literal is gone. The cutoff is now taken
-- INSIDE this transaction, AFTER the lock, from clock_timestamp().
--
-- ⭐⭐ WHY IT IS AIRTIGHT, IN ORDER:
--   1. LOCK TABLE … IN SHARE ROW EXCLUSIVE MODE conflicts with the ROW EXCLUSIVE
--      lock every INSERT/UPDATE/DELETE holds. Acquiring it therefore WAITS for
--      every in-flight quote write to commit or roll back, and blocks any new
--      one from starting. Reads are unaffected — the app keeps rendering.
--   2. With no quote write possible, the claim registry is seeded from a stable
--      snapshot. Every number that exists is now claimed.
--   3. The triggers are created in the SAME transaction, so they are visible to
--      every writer that was waiting on the lock.
--   4. The cutoff is read after the lock, so no row that could still be written
--      can predate it, and the partial index is created over it.
--   5. COMMIT releases the lock. The first write to proceed already fires the
--      triggers. There is no gap between "seeded" and "enforced" because the two
--      are the same commit.
--
-- ⭐ A DO BLOCK IS ONE STATEMENT, therefore one transaction, in every apply path
-- this repo uses — psql, the Supabase Management API's /database/query, and the
-- statement-at-a-time PGlite harness in scripts/verify-quote-number-integrity.ts.
-- That is why the cutover is written as a DO block rather than as a bare
-- BEGIN/COMMIT pair, which the statement splitter would have torn apart.
--
-- ⚠️ THE LOCK IS HELD FOR THE LENGTH OF A SELECT DISTINCT OVER `quotes` AND AN
-- INDEX BUILD OVER ZERO QUALIFYING ROWS. Production holds 114 quotes; this is
-- milliseconds. It is stated because on a large table it would not be, and the
-- next person to reuse this pattern should know what they are holding.
do $$
declare
  v_cutoff timestamptz;
begin
  -- 1 · quiesce writers (readers are untouched)
  lock table public.quotes in share row exclusive mode;

  -- 2 · claim every number that already exists, DISTINCT so the duplicate pairs
  --     collapse into one claim each and no historical row is touched
  insert into public.document_number_claims (user_id, kind, number)
  select distinct q.user_id, 'quote', q.quote_number
    from public.quotes q
   where q.quote_number is not null
  on conflict (user_id, kind, number) do nothing;

  -- 3 · from here on, every write claims
  drop trigger if exists quotes_claim_document_number on public.quotes;
  create trigger quotes_claim_document_number
    before insert or update of quote_number on public.quotes
    for each row execute function public.claim_document_number();

  drop trigger if exists quotes_release_document_number on public.quotes;
  create trigger quotes_release_document_number
    after delete or update of quote_number on public.quotes
    for each row execute function public.release_document_number();

  -- 4 · ⭐ DEFENCE IN DEPTH, NOT THE BARRIER. The claim registry above is what
  --     makes reuse impossible. This partial index is a second, independent
  --     guarantee written directly on `quotes`, so uniqueness among NEW rows
  --     survives even a future change that drops or disables the trigger.
  --     It is partial ONLY because the historical duplicate pairs exist; §9
  --     replaces it with the full constraint once the owner has ruled on them.
  v_cutoff := clock_timestamp();
  if not exists (select 1 from pg_class where relname = 'quotes_user_qnum_new_unique') then
    execute format(
      'create unique index quotes_user_qnum_new_unique on public.quotes (user_id, quote_number) where created_at >= %L',
      v_cutoff);
  end if;
end $$;

comment on index public.quotes_user_qnum_new_unique is
  'STAGE 1, defence in depth: within a tenant, a quote number issued from the cutover onward identifies exactly one quote. Partial because two historical duplicates predate it. ⛔ Not the barrier that protects HISTORY — document_number_claims is. Stage 2 replaces this with the full constraint once the pairs are resolved.';


-- ── 7b · the invariant, asserted before this migration is allowed to finish ─
-- ⭐ A migration that silently half-applied is worse than one that refused.
do $$
declare
  v_unclaimed int;
  v_missing   int;
begin
  select count(*) into v_unclaimed
    from public.quotes q
   where q.quote_number is not null
     and not exists (select 1 from public.document_number_claims c
                      where c.user_id = q.user_id and c.kind = 'quote'
                        and c.number = q.quote_number);
  if v_unclaimed > 0 then
    raise exception 'quote_number_integrity: % existing quote(s) are not in the claim registry — history is not protected', v_unclaimed;
  end if;

  -- ⚠️ SCOPED TO public.quotes. `pg_trigger.tgname` is unique per TABLE, not per
  -- database, so an unscoped lookup would be satisfied by a same-named trigger on
  -- some other table — an assertion that passes for the wrong reason is worse
  -- than no assertion.
  select count(*) into v_missing
    from (values ('quotes_claim_document_number'), ('quotes_release_document_number')) t(n)
   where not exists (select 1 from pg_trigger g
                      where g.tgname = t.n
                        and g.tgrelid = 'public.quotes'::regclass
                        and not g.tgisinternal);
  if v_missing > 0 then
    raise exception 'quote_number_integrity: % claim trigger(s) missing — new quotes are not protected', v_missing;
  end if;
end $$;


-- ── 8 · re-route the two public booking doors ───────────────────────────────
-- ⭐⭐ IN-PLACE, GUARDED REPLACEMENT — NOT A REWRITE. `book_service` and
-- `submit_booking` are large functions that other sessions also touch. Pasting a
-- whole new body here would silently discard whatever landed in them between
-- this file being written and being applied. So the allocation lines are swapped
-- out of the CURRENT definition, and the swap REFUSES if the text it expects is
-- not found — a failed apply is recoverable, a silently-unrouted booking door is
-- not.
--
-- ⭐ THIS RUNS AFTER THE BARRIER ON PURPOSE. If the swap fails, the booking doors
-- keep their old MAX()+1 — and the claim registry created above refuses the
-- duplicate that would produce. The failure mode of this section is a refused
-- booking, never a duplicated number.
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
  -- ⚠️ prokind = 'f' is NOT optional: pg_proc also lists aggregates and window
  -- functions, and pg_get_functiondef() raises on those ("array_agg is an
  -- aggregate function"), which would abort this migration for a reason that has
  -- nothing to do with quote numbers.
  select count(*) into v_hits
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     and pg_get_functiondef(p.oid) ilike '%max((regexp_match(quote_number%';
  if v_hits > 0 then
    raise exception 'quote_number_integrity: % function(s) still allocate quote numbers with MAX()+1', v_hits;
  end if;
end $$;


-- ── 9 · stage 2, deliberately NOT executed here ─────────────────────────────
-- ⛔ DO NOT UNCOMMENT UNTIL THE OWNER HAS RESOLVED THE HISTORICAL DUPLICATES.
-- Run the preflight first; it REPORTS and REFUSES rather than modifying data.
--
-- ⭐ WHAT STAGE 2 IS AND IS NOT. It is NOT what protects history — §6 already
-- does that, from the moment §7 commits, and it does it without renaming a
-- single quote. Stage 2 only collapses two barriers into one: it retires the
-- partial index in favour of a full UNIQUE on `quotes` itself. It is worth doing
-- because it removes a predicate that has to be reasoned about, not because
-- anything is unprotected without it.
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
-- customer already holds. scripts/report-duplicate-quote-numbers.ts assembles the
-- evidence the owner needs in order to rule on each pair.
