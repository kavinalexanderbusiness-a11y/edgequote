-- ── S122D · The owner may attest to the CURRENT version, explicitly ─────────
--
-- ⛔ CANDIDATE — NOT APPLIED, outside supabase/migrations so it cannot apply by
-- accident. S106 picks the version from the LIVE ledger.
--
-- WHY THIS EXISTS
-- S122b made the ordinary owner path REFUSE a quote in this shape:
--     status = accepted · quote_acceptances = 0 · accepted_price ≠ current total
-- because clicking "they replied by text" cannot say WHICH version the customer
-- saw, and minting evidence there would manufacture consent to the current
-- document out of a stale number. That refusal is the right default.
--
-- It cannot be the end of the workflow. The owner genuinely knows a customer
-- accepted outside EdgeHQ, and must be able to say so about a NAMED version.
-- This is that attestation — deliberate, bounded and audited.
--
-- ⛔ IT IS NOT A STATUS OVERRIDE. owner_override_quote_status still exists and
-- still records NO evidence (S121). This writes REAL evidence, of kind
-- owner_on_behalf, and never claims the customer used the portal.
--
-- ⛔ WHY A NEW RPC. owner_record_customer_acceptance routes through
-- quote_apply_choice, which by design only accepts a quote in 'draft' or 'sent'
-- — a quote already flagged accepted can never reach it. Widening that function
-- would weaken the re-decide rule for every caller. This one path, bounded and
-- named, is the smaller change.

begin;

create or replace function public.owner_confirm_current_acceptance(
  p_quote_id uuid,
  p_reason text,
  p_note text,
  p_expected_fingerprint text,
  p_expected_amount numeric
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_q public.quotes;
  v_prev public.quote_acceptances;
  v_opt public.quote_options;
  v_addon_total numeric(10,2);
  v_amount numeric(10,2);
  v_fp text;
  v_label text;
  v_id uuid;
  v_jobs int;
  v_bad_invoices int;
begin
  -- ⛔ Tenant comes from the SESSION, never from the caller. There is no tenant
  -- parameter on this function and there must never be one.
  if v_uid is null then
    return jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    return jsonb_build_object('ok', false, 'reason', 'reason_required');
  end if;

  -- ⭐ LOCK FIRST. Everything below is a decision about this row's exact
  -- contents; without the lock a concurrent edit could land between the
  -- fingerprint check and the write, which is the precise failure the
  -- fingerprint exists to prevent.
  select * into v_q from public.quotes
   where id = p_quote_id and user_id = v_uid
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  -- ── Bounds ────────────────────────────────────────────────────────────────
  -- ⛔ 'accepted' EXACTLY. A scheduled, completed or paid quote has downstream
  -- commercial truth hanging off it — crews dispatched, work done, money taken —
  -- and rewriting the consent under that is not a hotfix, it is a reconciliation.
  if v_q.status <> 'accepted' then
    return jsonb_build_object('ok', false, 'reason', 'status_not_repairable', 'status', v_q.status);
  end if;

  select count(*) into v_jobs from public.jobs where quote_id = p_quote_id;
  if v_jobs > 0 then
    return jsonb_build_object('ok', false, 'reason', 'work_scheduled');
  end if;

  -- The authorized figure, computed from the PARTS exactly as
  -- quote_record_acceptance computes it — never read off `total`, which is a
  -- generated column over the pre-update row inside the same statement.
  if v_q.selected_option_id is not null then
    select * into v_opt from public.quote_options
     where id = v_q.selected_option_id and quote_id = p_quote_id;
  end if;
  select coalesce(sum(a.price), 0) into v_addon_total
    from public.quote_addons a where a.quote_id = p_quote_id and a.is_selected;
  v_amount := coalesce(v_opt.price, v_q.initial_price, 0)
              + coalesce(v_q.travel_fee, 0) + v_addon_total;

  -- ⛔ S114: an unpriced quote is not free and cannot be accepted for a figure.
  -- A DECIDED no-charge quote is a real, priced-at-zero thing and is allowed.
  if v_amount <= 0 and v_q.no_charge_at is null then
    return jsonb_build_object('ok', false, 'reason', 'unpriced');
  end if;

  -- An invoice already issued for a DIFFERENT figure means the books and this
  -- attestation disagree. Refuse rather than quietly making one of them wrong.
  select count(*) into v_bad_invoices
    from public.invoices i
   where i.quote_id = p_quote_id
     and abs(coalesce(i.amount, 0) - v_amount) > 0.005;
  if v_bad_invoices > 0 then
    return jsonb_build_object('ok', false, 'reason', 'invoice_amount_mismatch');
  end if;

  -- ── Concurrency: the version the owner READ is the version they attest to ──
  v_fp := public.quote_material_fingerprint(p_quote_id);
  if p_expected_fingerprint is null or p_expected_fingerprint <> v_fp then
    return jsonb_build_object('ok', false, 'reason', 'fingerprint_mismatch',
                              'current_fingerprint', v_fp);
  end if;
  if p_expected_amount is null or abs(p_expected_amount - v_amount) > 0.005 then
    return jsonb_build_object('ok', false, 'reason', 'amount_mismatch',
                              'current_amount', v_amount);
  end if;

  -- ── Idempotency, and the no-competing-evidence bound ──────────────────────
  -- ⭐ A replay of the SAME attestation returns the SAME row rather than writing
  -- a second one. Anything else on the record — a customer acceptance, or an
  -- attestation for a different version — means this repair is not the right
  -- tool and must not add a competing claim beside it.
  select * into v_prev from public.quote_acceptances
   where quote_id = p_quote_id order by seq desc limit 1;
  if found then
    if v_prev.kind = 'owner_on_behalf'
       and v_prev.document_fingerprint = v_fp
       and abs(coalesce(v_prev.accepted_amount, 0) - v_amount) <= 0.005 then
      return jsonb_build_object('ok', true, 'acceptance_id', v_prev.id,
                                'amount', v_amount, 'idempotent', true);
    end if;
    -- ⭐⭐⭐ A LEGACY ROW IS NOT A COMPETING CLAIM — IT IS THE ABSENCE OF ONE.
    -- `legacy_unrecorded` says a deal exists and that WHO agreed to it was never
    -- captured. Refusing here left the owner with nowhere to go: this RPC said
    -- "evidence already exists", while the ordinary path routes through
    -- quote_apply_choice, which only accepts draft/sent and can never reach an
    -- accepted quote. So a legacy quote whose deposit link is now withheld for
    -- want of a named acceptance could never GET one — the refusal and the remedy
    -- excluded each other, and the owner was trapped between them.
    --
    -- ⛔ It is an UPGRADE, not an overwrite. quote_record_acceptance sets
    -- supersedes_id to the row it found, so the backfill row stays on the record
    -- forever with the attestation pointing back at it — the append-only rule is
    -- untouched, and `quote_acceptances_assign_seq` enforces that linkage anyway.
    -- Every other kind still refuses: a customer's own acceptance needs no repair,
    -- and a second attestation for a different version is a competing claim.
    if v_prev.kind <> 'legacy_unrecorded' then
      return jsonb_build_object('ok', false, 'reason', 'evidence_exists',
                                'kind', v_prev.kind);
    end if;
  end if;

  select coalesce(nullif(btrim(b.owner_name), ''), nullif(btrim(b.company_name), ''))
    into v_label from public.business_settings b where b.user_id = v_uid limit 1;

  -- ── The write ─────────────────────────────────────────────────────────────
  -- ⭐ The consent-writer marker, transaction-local, set by in-database code in
  -- the same transaction as the write it authorises. Nothing a PostgREST caller
  -- can send reaches it. Without it quotes_protect_consent_snapshot refuses the
  -- accepted_price update — which is exactly the protection working.
  perform set_config('app.quote_consent_writer', p_quote_id::text, true);
  perform set_config('app.quote_acceptance_kind', 'owner_on_behalf', true);

  -- ⭐⭐⭐ S122E · CARRY THE EXPECTATION INTO THE WRITER (RUN-S122E).
  -- The fingerprint check above is not enough on its own: quote_record_acceptance
  -- RECOMPUTES the fingerprint from a fresh snapshot and stores THAT, and the only
  -- lock held here is on public.quotes while the fingerprint spans four tables. A
  -- concurrent service-line write between the two evaluations made this function
  -- store a version the owner never saw — and return ok:true, turning the refusal
  -- it owes into an authorisation. Declaring the checked version here makes the
  -- writer assert that what it STORED is what was CHECKED, and raise otherwise; the
  -- raise rolls back the accepted_price stamp above with the evidence.
  --
  -- ⛔ Inert without RUN-S122E applied. That is deliberate — this is a marker, not
  -- a behaviour, and an unpatched writer simply ignores it.
  perform set_config('app.quote_expected_fingerprint', v_fp, true);
  perform set_config('app.quote_expected_amount', v_amount::text, true);

  -- Stamp the CURRENT authorized figure. This is the repair: the stale snapshot
  -- is replaced by the amount the owner is attesting to, not the other way round.
  update public.quotes set accepted_price = v_amount where id = p_quote_id;

  -- ⭐ THE evidence writer — the same one every other path uses, so every S121
  -- and S122 rule (options named, terms acknowledged, terms not contradicting
  -- the payment schedule) applies here unchanged. If the terms contradict, this
  -- RAISES and the whole transaction — including the accepted_price stamp —
  -- rolls back. That atomicity is the point.
  v_id := public.quote_record_acceptance(
    p_quote_id, 'owner_on_behalf', 'dashboard', v_uid, v_label,
    btrim(p_reason), nullif(btrim(coalesce(p_note, '')), ''), true);

  perform public.audit_log(
    v_uid, 'quote_acceptance_repaired', 'quote', p_quote_id, v_q.quote_number, v_q.customer_id,
    -- ⚠️ The BEFORE state must say what was actually there. A legacy upgrade is
    -- not a repair of nothing, and an audit row claiming 'evidence', 0 over a
    -- superseded backfill row would misdescribe the one event this log exists for.
    jsonb_build_object('accepted_price', v_q.accepted_price,
                       'evidence', case when v_prev.id is null then 0 else 1 end,
                       'kind', v_prev.kind),
    jsonb_build_object('accepted_price', v_amount, 'evidence', 1, 'kind', 'owner_on_behalf',
                       'supersedes', v_prev.id),
    jsonb_build_object('reason', btrim(p_reason), 'material_fingerprint', v_fp));

  return jsonb_build_object('ok', true, 'acceptance_id', v_id, 'amount', v_amount,
                            'idempotent', false);
end;
$function$;

-- ⛔ NO ANON GRANT. This writes commercial truth on the owner's behalf and is
-- reachable only by an authenticated session, whose identity it takes from
-- auth.uid() rather than from any argument.
revoke all on function public.owner_confirm_current_acceptance(uuid, text, text, text, numeric)
  from public, anon, authenticated, service_role;
grant execute on function public.owner_confirm_current_acceptance(uuid, text, text, text, numeric)
  to authenticated;

comment on function public.owner_confirm_current_acceptance(uuid, text, text, text, numeric) is
  'Owner attests that the customer accepted the CURRENT version of a quote that was flagged accepted with no evidence. Bounded to status=accepted, zero evidence, no job, no mismatched invoice, priced, and an exact material-fingerprint + amount match. Writes ONE owner_on_behalf acceptance through quote_record_acceptance, so every S121/S122 rule still applies. Never presents as customer portal acceptance.';

commit;
