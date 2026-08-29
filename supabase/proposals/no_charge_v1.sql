-- ═══════════════════════════════════════════════════════════════════════════
-- PROPOSAL — Explicit no-charge work, and an accept door that cannot approve
--            an unpriced quote.                          Session 114, P0 lane.
--
-- ⛔⛔ THIS FILE IS NOT IN THE APPLY PATH AND HAS NOT BEEN APPLIED.
--     `supabase/proposals/` is deliberately outside `supabase/migrations/`
--     (verify:migrations rule 4 — the apply path is migrations/ only). Nothing
--     here has run against production. To ship it, the owner moves it to
--     `supabase/migrations/<14-digit>_no_charge_v1.sql` with a version taken
--     from the LIVE ledger AT APPLY TIME — never from this file.
--
-- ⚠️ ORDERING IS LOAD-BEARING (the S111 42703 lesson, learned the expensive way):
--     APPLY THIS BEFORE any build that WRITES these columns. Reads are already
--     safe — every consumer reaches the fields through `select('*')`, so an
--     unapplied database simply omits them and `isNoCharge()` answers false,
--     which is the correct reading of "no decision was recorded". It is the
--     WRITE that would fail 42703, and the only writer is the new "No charge"
--     action, which reports the missing migration rather than corrupting a save.
--
-- ── WHY THIS EXISTS ────────────────────────────────────────────────────────
-- The app can currently express three of the four facts in the domain law:
--
--     UNPRICED  ≠  INTENTIONALLY FREE  ≠  $0 DUE  ≠  PAID
--
-- `$0 DUE` and `PAID` are the payment ledger's, and both are sound. UNPRICED is
-- now derivable in app code with no schema at all (lib/pricingState) because
-- `quotes.total` is GENERATED over a NULLABLE `initial_price`, so an unpriced
-- quote genuinely HAS no total — Postgres was telling the truth all along.
--
-- INTENTIONALLY FREE is the one fact with nowhere to live. It cannot be
-- derived, because it is not a computation: it is a DECISION, and a decision
-- with no reason, no actor and no timestamp is indistinguishable from the blank
-- field that started this whole lane. That is the entire content of this file.
--
-- ⛔ A bare `price = 0` is NOT free and must never be read as free. Zero is what
--    `Number('')` returns; it is the shape of an unanswered question.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ── 1 · The decision, on quotes and on jobs ─────────────────────────────────
-- Three columns, not one flag. A boolean would record THAT it is free and lose
-- every fact that makes the record defensible six months later in a dispute.
--
-- Deliberately NOT a shared polymorphic table: a single-column FK to a generic
-- `entity_id` cannot be tenant-welded, and this codebase has already paid for
-- that mistake once (see the B1/B2 tenant-FK triage). Two tables, six columns,
-- each welded to the row it describes.

alter table public."quotes"
  add column if not exists "no_charge_at"     timestamp with time zone,
  add column if not exists "no_charge_reason" text,
  add column if not exists "no_charge_by"     uuid;

alter table public."jobs"
  add column if not exists "no_charge_at"     timestamp with time zone,
  add column if not exists "no_charge_reason" text,
  add column if not exists "no_charge_by"     uuid;

-- ── 2 · All three parts, or none ───────────────────────────────────────────
-- ⭐ THE constraint that makes the app's `isNoCharge()` honest rather than
-- hopeful. Without it a half-written record (a timestamp with no reason) reads
-- as "not free" in one place and "free" in another, and the app would be back to
-- guessing what a partial row meant. The DATABASE answers it, once, for every
-- writer including a SQL editor.
--
-- An empty-string reason is not a reason. Same discipline as
-- quote_addons_name_check: absence is spelled NULL, so no reader has to test
-- for two flavours of it.

do $$ begin
  alter table public."quotes" add constraint "quotes_no_charge_complete_check" check (
    num_nonnulls("no_charge_at", "no_charge_reason", "no_charge_by") in (0, 3)
    and ("no_charge_reason" is null or btrim("no_charge_reason") <> '')
  );
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public."jobs" add constraint "jobs_no_charge_complete_check" check (
    num_nonnulls("no_charge_at", "no_charge_reason", "no_charge_by") in (0, 3)
    and ("no_charge_reason" is null or btrim("no_charge_reason") <> '')
  );
exception when duplicate_object then null; end $$;

-- A reason long enough to be useful, bounded so it cannot become a notes field.
do $$ begin
  alter table public."quotes" add constraint "quotes_no_charge_reason_len_check"
    check ("no_charge_reason" is null or char_length("no_charge_reason") between 3 and 500);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public."jobs" add constraint "jobs_no_charge_reason_len_check"
    check ("no_charge_reason" is null or char_length("no_charge_reason") between 3 and 500);
exception when duplicate_object then null; end $$;

comment on column public."quotes"."no_charge_at" is
  'When the owner DECIDED this quote is free. NULL = no such decision. ⛔ A $0 or absent price is UNPRICED (unknown), never free — see lib/pricingState.';
comment on column public."quotes"."no_charge_reason" is
  'Why this work is free, in the owner''s words. Required whenever no_charge_at is set (quotes_no_charge_complete_check) — a free-work record with no reason is indistinguishable from an unanswered price field.';
comment on column public."quotes"."no_charge_by" is
  'Which account made the no-charge decision. Audit evidence, not authorization: the RLS policies already decide who may write the row.';
comment on column public."jobs"."no_charge_at" is
  'When the owner DECIDED this visit is free. NULL = no such decision. ⛔ jobs.price IS NULL means "no job-level override, follow the quote" — it has never meant free, and must not start to.';
comment on column public."jobs"."no_charge_reason" is
  'Why this visit is free, in the owner''s words. Required whenever no_charge_at is set (jobs_no_charge_complete_check).';
comment on column public."jobs"."no_charge_by" is
  'Which account made the no-charge decision. Audit evidence.';

-- ── 3 · The accept door refuses an unpriced quote ──────────────────────────
-- ⭐⭐ THE HOLE THIS CLOSES, measured on the live function body:
--
--   `quote_apply_choice` loads `v_base` from `q.initial_price` and null-checks it
--   ONLY on the branch where an option was named. With no options, an unpriced
--   quote (initial_price IS NULL) reaches:
--
--       accepted_price = v_base + v_travel + v_addons   -- NULL + n + n = NULL
--       status         = 'accepted'
--
--   …so a quote nobody ever priced becomes CUSTOMER-AUTHORIZED PAID WORK with a
--   NULL accepted price, from the customer portal, with no owner involved. The
--   app-side send gate is what has been keeping unpriced quotes away from
--   customers — but the app is not the authority here, and a status set by any
--   other route walks straight through.
--
-- The fix is four lines and lives in the DATABASE, where every door meets:
-- resolve the price, then refuse if it is unknown AND the quote carries no
-- no-charge decision. Free work still accepts — that is the point of §1.
--
-- ⚠️ `create or replace function` with an IDENTICAL signature REPLACES the body.
-- It does not create an overload (the S121 trap was a function whose signature
-- CHANGED). The argument list below is byte-identical to the live one; changing
-- it would leave the old body callable with its existing grants.

create or replace function public.quote_apply_choice(p_quote_id uuid, p_option_id uuid, p_addon_ids uuid[], p_via text)
 returns boolean
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_status text; v_travel numeric(10,2); v_follow int;
  v_base numeric(10,2); v_addons numeric(10,2);
  v_ids uuid[]; v_known int; v_want int;
  v_free boolean;
begin
  -- Provenance is passed in by the door that knows it, never inferred here.
  if p_via is null or p_via not in ('portal', 'owner') then return false; end if;

  -- 'draft' or 'sent' = NOT YET DECIDED. Anything else means a choice already
  -- stands, and re-deciding would silently rewrite the approved price.
  select q.status, coalesce(q.travel_fee, 0), coalesce(q.follow_up_count, 0), q.initial_price,
         (q.no_charge_at is not null and q.no_charge_reason is not null and q.no_charge_by is not null)
    into v_status, v_travel, v_follow, v_base, v_free
    from public.quotes q
   where q.id = p_quote_id and q.status in ('draft', 'sent');
  if v_status is null then return false; end if;

  -- THE tenancy statement: o.quote_id = p_quote_id. Resolving the option THROUGH
  -- the quote is what makes "you may not name another quote's option" true here
  -- rather than wherever someone remembered to check it.
  if p_option_id is not null then
    select o.price into v_base from public.quote_options o
     where o.id = p_option_id and o.quote_id = p_quote_id;
    if v_base is null then return false; end if;
  elsif exists (select 1 from public.quote_options where quote_id = p_quote_id) then
    -- A quote that offers alternatives cannot be approved without naming one.
    return false;
  end if;

  -- ⭐⭐ NEW — UNPRICED WORK CANNOT BE AUTHORIZED.
  -- `v_base is null` is a quote nobody priced; `v_base = 0` is the manufactured
  -- zero a blank input becomes. Neither is something a customer can agree to
  -- pay, so neither may become 'accepted'. A recorded no-charge decision IS
  -- agreeable — it is a known price of zero, which is exactly the distinction
  -- this migration exists to make expressible.
  if not v_free and (v_base is null or v_base <= 0) then
    return false;
  end if;

  -- Every id must resolve THROUGH this quote, and an id we cannot name is a
  -- REFUSAL, never a silent drop: approving "the ones we recognised" would record
  -- consent to a configuration the customer never saw. De-duplicated first, so
  -- naming the same extra twice cannot bill it twice.
  select coalesce(array_agg(distinct x), '{}'::uuid[]) into v_ids
    from unnest(coalesce(p_addon_ids, '{}'::uuid[])) x where x is not null;
  v_want := coalesce(array_length(v_ids, 1), 0);
  if v_want > 0 then
    select count(*) into v_known from public.quote_addons
     where quote_id = p_quote_id and id = any(v_ids);
    if v_known <> v_want then return false; end if;
  end if;

  -- The selection is set for EVERY add-on on the quote, not just the chosen ones:
  -- an extra the customer unticked must stop being selected, or a pre-ticked
  -- suggestion would be billed because nobody said no loudly enough.
  update public.quote_addons
     set is_selected  = (id = any(v_ids)),
         selected_via = case when id = any(v_ids) then p_via else null end,
         selected_at  = case when id = any(v_ids) then now()  else null end
   where quote_id = p_quote_id;

  select coalesce(sum(price), 0) into v_addons
    from public.quote_addons where quote_id = p_quote_id and is_selected;

  update public.quotes
     set status = 'accepted',
         selected_option_id = coalesce(p_option_id, selected_option_id),
         initial_price = v_base,
         -- ⭐ Computed EXPLICITLY, never coalesce(accepted_price, total): `total`
         -- is GENERATED over initial_price/addons_total and every SET expression
         -- reads the OLD row, so it would snapshot the pre-choice price.
         accepted_price = coalesce(v_base, 0) + v_travel + v_addons,
         accepted_after_followup = v_follow > 0,
         follow_up_count_at_acceptance = v_follow
   where id = p_quote_id and status in ('draft', 'sent');
  return found;
end $function$;

comment on function public.quote_apply_choice(uuid, uuid, uuid[], text) is
  'THE acceptance core, reached by portal_accept_quote and the owner''s own approval. Refuses to authorize an UNPRICED quote (null or <= 0 resolved price) unless the quote carries a complete no-charge decision — unpriced work must never become customer-authorized paid work.';

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- AFTER APPLYING — regenerate, do not hand-edit:
--   npm run schema:contract && npm run schema:baseline
-- and re-run `npm run verify` so verify:rebuild replays from zero.
-- ═══════════════════════════════════════════════════════════════════════════
