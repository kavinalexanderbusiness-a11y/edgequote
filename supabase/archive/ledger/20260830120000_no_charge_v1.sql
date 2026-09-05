-- ═══════════════════════════════════════════════════════════════════════════
-- Explicit no-charge work, and an accept door that cannot approve an unpriced
-- quote.                                                  Session 114, P0 lane.
--
-- ⛔⛔ THE VERSION IN THIS FILENAME IS DELIBERATELY FAKE AND MUST BE REPLACED.
--     `29999999000000` is the year 2999. It sorts after every real migration, so
--     it can never land before the baseline by accident, and the filename says
--     out loud that it is unfinished business. (Same device S83 used for
--     contracts_v1_TEMP, for the same reason — this one is lower-case because
--     verify:migrations requires snake_case, and weakening that guard to shout
--     louder in a filename would have been the wrong trade.)
--
--     ⭐ S106 RE-VERSIONS THIS AT LANDING, from the LIVE LEDGER AT APPLY TIME —
--     never from this file, and never from a number chosen while writing it.
--     Two sessions have already been bitten by picking a version early: S76's
--     `20260815120000` was ALREADY IN PRODUCTION as a different body.
--
-- ⚠️ ORDERING IS LOAD-BEARING (the S111 42703 lesson, learned the expensive way):
--     APPLY THIS BEFORE deploying an app build that WRITES these columns. Reads
--     are already safe — every consumer reaches the fields through `select('*')`,
--     so an unapplied database simply omits them and `isNoCharge()` answers
--     false, which is the correct reading of "no decision was recorded". It is
--     the WRITE that fails 42703, and the only writer is the "No charge" action,
--     which detects the missing column and says so rather than corrupting a save.
--
-- ⚠️ EXPECT verify:rebuild TO BE RED UNTIL THE CONTRACT IS RECAPTURED.
--     The apply path will carry six columns, four constraints and a new function
--     body that the committed contract does not. That red is not a defect — it
--     is the from-zero rebuild proving this SQL applies cleanly. It clears at
--     step 7 of the landing plan (`npm run schema:contract && schema:baseline`),
--     after production has actually run it.
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

CREATE OR REPLACE FUNCTION public.quote_apply_choice(p_quote_id uuid, p_option_id uuid, p_addon_ids uuid[], p_via text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_status text; v_travel numeric(10,2); v_follow int;
  v_base numeric(10,2); v_addons numeric(10,2);
  v_ids uuid[]; v_known int; v_want int;
  v_free boolean;
begin
  -- Provenance is passed in by the door that knows it, never inferred here.
  if p_via is null or p_via not in ('portal', 'owner') then return false; end if;

  -- 'draft' or 'sent' = NOT YET DECIDED. Anything else means a choice already
  -- stands, and re-deciding would silently rewrite the approved price. A
  -- REAPPROVAL therefore travels the same road as the first one: the owner sends
  -- the revised quote again, which returns it to 'sent'.
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

  -- SESSION 114 - UNPRICED WORK CANNOT BE AUTHORIZED.
  -- Placed AFTER the option branch on purpose: when the customer names an
  -- option, the price being judged is THAT option's, not the quote's headline.
  --
  -- v_base IS NULL is a quote nobody priced; v_base = 0 is the manufactured zero
  -- a blank input becomes. Neither is something a customer can agree to pay, so
  -- neither may become 'accepted'. A recorded no-charge decision IS agreeable -
  -- it is a KNOWN price of zero, which is exactly the distinction the columns
  -- above make expressible.
  --
  -- THIS IS THE ONLY CHOKEPOINT, and that is why the gate is here rather than in
  -- the app: portal_accept_quote, owner_record_customer_acceptance and
  -- owner_select_quote_option ALL route through this function. One gate covers
  -- the customer's door and both of the owner's.
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

  -- ⭐ The marker. Transaction-local (`true`), set by in-database code, in the
  -- same transaction as the write it authorises. Nothing a PostgREST caller can
  -- send reaches it, and it is gone the moment this transaction ends.
  perform set_config('app.quote_consent_writer', p_quote_id::text, true);

  -- ⭐⭐ AND THE KIND, FOR THE TRIGGERS THAT FIRE BEFORE THE LEDGER ROW EXISTS.
  -- ⚠️ This is an ORDERING TRAP the behavioural guard caught and reading did not:
  -- the doors update the quote FIRST and write the acceptance SECOND, so
  -- audit_quotes() and notify_quote_accepted() — AFTER ROW triggers on that
  -- update — run while the ledger is still empty. Reading the ledger alone, they
  -- called a genuine owner-recorded acceptance an administrative override.
  --
  -- p_via is not an inference: it is passed in by the door that knows, and this
  -- function already refuses every value but the two. Same shape as the
  -- app.audit_context GUC the audit engine already honours — transaction-local,
  -- settable only by in-database code, unreachable from any PostgREST request.
  perform set_config('app.quote_acceptance_kind',
    case p_via when 'portal' then 'customer' else 'owner_on_behalf' end, true);

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

  -- Both markers cleared the moment the write they authorise is done. An AFTER
  -- ROW trigger fires at the END of the UPDATE statement above, so it has
  -- already read them; anything that happens later in this transaction must not
  -- inherit them.
  perform set_config('app.quote_consent_writer', '', true);
  perform set_config('app.quote_acceptance_kind', '', true);
  return found;
end $function$;

comment on function public.quote_apply_choice(uuid, uuid, uuid[], text) is
  'THE acceptance core — the single chokepoint under portal_accept_quote, owner_record_customer_acceptance and owner_select_quote_option. Refuses to authorize an UNPRICED quote (null or <= 0 resolved price) unless the quote carries a complete no-charge decision. Unpriced work must never become customer-authorized paid work.';

-- ⚠️⚠️ REBASED ONTO SESSION 121, NOT WRITTEN OVER IT.
-- S121 landed while this lane was open and rewrote this same function, adding the
-- transaction-local consent markers (`app.quote_consent_writer`,
-- `app.quote_acceptance_kind`) that its AFTER-ROW triggers read before the
-- acceptance ledger row exists. A `create or replace` carrying the OLD body would
-- have silently reverted all of that — the function keeps its signature, so
-- nothing would have failed; acceptances would just have stopped being recorded
-- as evidence.
--
-- The body above is S121's, VERBATIM, with exactly four additions:
--   1. `v_free` declared,
--   2. the no-charge decision read in the SAME lookup (no second query),
--   3. the gate itself, placed AFTER the option branch so that when an option is
--      named it is THAT option's price being judged,
--   4. `coalesce(v_base, 0)` on accepted_price, so a no-charge acceptance
--      snapshots a KNOWN zero instead of NULL.
-- ⭐ S106: if this function moves again before landing, re-extract the live body
-- and re-apply those four — do not paste this one over a newer one.

-- ── 4 · The ONLY doors that write a no-charge decision ─────────────────────
-- ⭐⭐ Why an RPC and not an app-side UPDATE:
--
--   ATOMIC       one statement sets all three columns or none. An app writing
--                them in sequence could be interrupted between the reason and
--                the actor, and the CHECK in §2 would then reject the row —
--                correct, but a save that fails halfway is not a feature.
--   ACTOR        `auth.uid()`, taken from the SESSION. A client-supplied actor
--                is a signature anyone can forge; this one cannot be passed in
--                at all, which is why the parameter list has no actor.
--   AUDITED      `audit_log` is called from inside the same statement, so the
--                immutable trail and the columns cannot disagree. The existing
--                audit_quotes/audit_jobs triggers watch a FIXED list of columns
--                that does not include these, so without this the decision
--                would leave no trace in audit_events at all.
--   SCOPED       `user_id = auth.uid()` on the UPDATE. SECURITY DEFINER bypasses
--                RLS, so the tenancy predicate is written out by hand and is the
--                only thing standing between the door and another tenant's row.
--
-- ⛔ NOTHING ELSE MAY WRITE THESE COLUMNS. Ordinary price editing must never
--    manufacture or clear free-work evidence as a side effect — that is the
--    whole failure mode this lane exists to end.

create or replace function public.quote_set_no_charge(p_quote_id uuid, p_reason text)
 returns boolean
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_uid uuid; v_status text; v_reason text; v_had boolean;
begin
  v_uid := auth.uid();
  if v_uid is null then return false; end if;

  v_reason := nullif(btrim(coalesce(p_reason, '')), '');

  select status, (no_charge_at is not null) into v_status, v_had
    from public.quotes where id = p_quote_id and user_id = v_uid;
  if v_status is null then return false; end if;

  -- ⭐⭐ CLEARING IS THE DANGEROUS DIRECTION, and this is the guard on it.
  -- A no-charge quote that has been ACCEPTED was authorised BECAUSE it was
  -- explicitly free (§3 lets it through on exactly that basis). Removing the
  -- designation afterwards would leave customer-authorised work with no price
  -- and no free-work record — the precise state §3 exists to make impossible,
  -- reached by the back door. Correcting a mistake is only safe while the quote
  -- is still the owner's own document.
  if v_reason is null then
    if v_status not in ('draft', 'sent') then return false; end if;
    if not v_had then return true; end if;   -- already clear; nothing to record
    update public.quotes
       set no_charge_at = null, no_charge_reason = null, no_charge_by = null
     where id = p_quote_id and user_id = v_uid;
    perform public.audit_log(v_uid, 'quote_no_charge_cleared', 'quote', p_quote_id,
      null, null, jsonb_build_object('no_charge', true), jsonb_build_object('no_charge', false));
    return true;
  end if;

  update public.quotes
     set no_charge_at = now(), no_charge_reason = v_reason, no_charge_by = v_uid
   where id = p_quote_id and user_id = v_uid;
  perform public.audit_log(v_uid, 'quote_marked_no_charge', 'quote', p_quote_id,
    null, null, jsonb_build_object('no_charge', v_had),
    jsonb_build_object('no_charge', true, 'reason', v_reason));
  return true;
end $function$;

create or replace function public.job_set_no_charge(p_job_id uuid, p_reason text)
 returns boolean
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_uid uuid; v_status text; v_reason text; v_had boolean;
begin
  v_uid := auth.uid();
  if v_uid is null then return false; end if;

  v_reason := nullif(btrim(coalesce(p_reason, '')), '');

  select status, (no_charge_at is not null) into v_status, v_had
    from public.jobs where id = p_job_id and user_id = v_uid;
  if v_status is null then return false; end if;

  -- The visit equivalent of the rule above: once the work is DONE the record is
  -- history, and history is a record rather than a draft. A completed visit that
  -- was delivered free stays that way; correct it before completion.
  if v_reason is null then
    if v_status = 'completed' then return false; end if;
    if not v_had then return true; end if;
    update public.jobs
       set no_charge_at = null, no_charge_reason = null, no_charge_by = null
     where id = p_job_id and user_id = v_uid;
    perform public.audit_log(v_uid, 'job_no_charge_cleared', 'job', p_job_id,
      null, null, jsonb_build_object('no_charge', true), jsonb_build_object('no_charge', false));
    return true;
  end if;

  update public.jobs
     set no_charge_at = now(), no_charge_reason = v_reason, no_charge_by = v_uid
   where id = p_job_id and user_id = v_uid;
  perform public.audit_log(v_uid, 'job_marked_no_charge', 'job', p_job_id,
    null, null, jsonb_build_object('no_charge', v_had),
    jsonb_build_object('no_charge', true, 'reason', v_reason));
  return true;
end $function$;

-- Owners only. ⛔ Not anon, and not the customer portal: deciding that work is
-- free is the BUSINESS's call, and a portal token proves which customer someone
-- is, never what they may forgive themselves.
revoke all on function public.quote_set_no_charge(uuid, text) from public, anon;
revoke all on function public.job_set_no_charge(uuid, text) from public, anon;
grant execute on function public.quote_set_no_charge(uuid, text) to authenticated;
grant execute on function public.job_set_no_charge(uuid, text) to authenticated;

comment on function public.quote_set_no_charge(uuid, text) is
  'THE only door that writes a quote''s no-charge decision. A non-empty reason SETS it (actor = auth.uid(), timestamp = now(), all three atomically); NULL CLEARS it, and clearing is refused once the quote is past draft/sent because an accepted no-charge quote was authorised on that basis. Every call is written to audit_events.';
comment on function public.job_set_no_charge(uuid, text) is
  'THE only door that writes a visit''s no-charge decision. Same contract as quote_set_no_charge; clearing is refused once the visit is completed.';

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- AFTER APPLYING — regenerate, do not hand-edit:
--   npm run schema:contract && npm run schema:baseline
-- and re-run `npm run verify` so verify:rebuild replays from zero.
-- ═══════════════════════════════════════════════════════════════════════════
