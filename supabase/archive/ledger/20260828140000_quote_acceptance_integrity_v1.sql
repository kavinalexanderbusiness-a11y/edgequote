-- ═══════════════════════════════════════════════════════════════════════════
-- Quote Acceptance Integrity v1 — Session 121
--
-- ⛔ NOT APPLIED TO PRODUCTION BY THIS SESSION. Take the version from the LIVE
--    ledger at apply time; this filename only has to sort after the baseline
--    inside this branch.
--
-- ── THE PROBLEM ────────────────────────────────────────────────────────────
-- Before this migration the ONLY record that a quote was accepted lived in the
-- quote row itself: status='accepted', accepted_price, selected_option_id. That
-- row is mutable by its owner through an unrestricted RLS update policy, has no
-- acceptance timestamp, no actor, no source, and no snapshot of the document the
-- customer actually read. Everything a business would need in a dispute was
-- either absent or overwritable:
--
--   WHEN   nothing. `updated_at` moves on every later edit.
--   WHO    nothing on the row. audit_events INFERS an actor from the session
--          (which is good, and stays) but audit is a feed, not the record of
--          record, and no read path in the product consults it.
--   WHAT   accepted_price only — one number. The scope, the option's name and
--          price, the extras, the plan prices and the terms all lived in tables
--          the owner may edit afterwards.
--   WHICH  an options quote accepted through the plain status dropdown left
--          selected_option_id NULL: approved, with nobody able to name what.
--   HOW    quote_addons.selected_via carried 'portal'/'owner' — but only when
--          the quote HAD add-ons. A quote without them recorded no provenance at
--          all, so an owner ticking "Approved" in a dropdown and a customer
--          tapping Approve in their portal produced byte-identical rows.
--
-- ── THE FIVE EVENTS, WHICH ARE NOT ONE EVENT ───────────────────────────────
--   1. CUSTOMER ACCEPTED               → quote_acceptances, kind='customer'
--   2. OWNER ACCEPTED ON THEIR BEHALF  → quote_acceptances, kind='owner_on_behalf'
--                                        + a REASON. Never inferred, never
--                                        defaulted, never omitted.
--   3. ADMINISTRATIVE STATUS OVERRIDE  → NO acceptance row. An audit event only
--                                        ('quote_status_overridden'). An owner
--                                        repairing a stuck row has obtained
--                                        nobody's consent, and this schema
--                                        refuses to let the record say they did.
--   4. CONTRACT SIGNED                 → S74 documents/signatures + S83 contracts.
--                                        ⛔ NOT THIS TABLE. Nothing here mints,
--                                        stores or verifies a signature.
--   5. PAYMENT RECEIVED                → invoices/payments. Untouched.
--
-- ── THE ONE NEW RULE ───────────────────────────────────────────────────────
-- ⭐⭐ AN ACCEPTANCE IS EVIDENCE, SO IT IS APPEND-ONLY. Never updated, never
-- deleted while its quote lives. A reapproval after a commercial change is a NEW
-- ROW pointing back at the one it supersedes. "Changes require reapproval" is
-- therefore DERIVED — the live document's fingerprint against the standing
-- acceptance's — and never stored, exactly as `expired` is derived in
-- lib/quoteStatus and deposit readiness is derived from the ledger. There is no
-- second lifecycle to keep in sync.
--
-- ⛔⛔ THREE THINGS IN HERE ARE LANDING-CRITICAL AND EASY TO MISS:
--   §6b  quote_acceptance_is_current() is THE gate every acting path asks —
--        scheduling, invoicing and the deposit ask. Status authorizes nothing.
--   §8c  the old RPC arities are DROPPED, and the compatibility seam for
--        already-deployed clients is the DEFAULT VALUES on the survivors. A
--        shim function is not just unnecessary, it is uncallable — see the note.
--   §11  every quote ALREADY at accepted/scheduled/completed/paid is backfilled
--        with kind='legacy_unrecorded'. Without it, the gate §6b installs
--        answers "not authorized" for the entire existing book on day one.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1 · The material fingerprint ───────────────────────────────────────────
-- ⭐ THE definition of "did the deal change?", in one place. A commercial edit
-- is not judged by a human reading a diff, and not by a list of column names
-- copied into four call sites — it is this function, and both the reapproval
-- rule and the guard read it.
--
-- MATERIAL (changing any of these un-approves the quote):
--   the money        initial_price · travel_fee · addons_total
--   the plan prices  weekly · biweekly · monthly  — the portal's own approve
--                    dialog quotes these, so the customer consented to them
--   the payment ask  deposit_type · deposit_value
--   the scope        service_type · address · notes — all three print on the PDF
--                    and render in the portal; they ARE the document
--   the choice       selected_option_id
--   the lines        every quote_services row
--   the alternatives every quote_options row
--   the extras       every quote_addons row, INCLUDING which are selected
--
-- NOT MATERIAL (safe to correct after acceptance):
--   internal_notes · property_id · customer_id repairs · the measurement columns ·
--   pricing_confidence · value_grade · lead_meta · sent_at · valid_until ·
--   the follow-up counters · preferred_date/timing (a scheduling wish, not a term)
--
-- md5 is a FINGERPRINT, not a security primitive: its only job is to answer
-- "same or different" cheaply, and nothing downstream trusts it against an
-- adversary who can already write the row it is computed from.
create or replace function public.quote_material_fingerprint(p_quote_id uuid)
returns text
language sql
stable
security definer
set search_path to 'public'
as $function$
  select md5(
    coalesce((
      select concat_ws('|',
        'q',
        coalesce(q.initial_price, 0)::text,
        coalesce(q.travel_fee, 0)::text,
        coalesce(q.addons_total, 0)::text,
        coalesce(q.weekly_price, 0)::text,
        coalesce(q.biweekly_price, 0)::text,
        coalesce(q.monthly_price, 0)::text,
        coalesce(q.deposit_type, ''),
        coalesce(q.deposit_value, 0)::text,
        coalesce(btrim(q.service_type), ''),
        coalesce(btrim(q.address), ''),
        coalesce(btrim(q.notes), ''),
        coalesce(q.selected_option_id::text, '')
      ) from public.quotes q where q.id = p_quote_id
    ), '')
    -- Ordered by the owner's own sort, then by id so two rows sharing a sort
    -- order cannot make the fingerprint flap between reads. A fingerprint that
    -- changed when nothing changed would demand reapproval at random, which is
    -- the fastest way to teach an owner to ignore the banner.
    || coalesce((
      select string_agg(concat_ws('|', 's', s.service_type, s.quantity::text, coalesce(s.unit, ''),
                                  s.unit_price::text, coalesce(s.discount_type, ''),
                                  coalesce(s.discount_value, 0)::text, coalesce(btrim(s.notes), ''), s.kind),
                        E'\n' order by s.sort_order, s.id)
        from public.quote_services s where s.quote_id = p_quote_id
    ), '')
    || coalesce((
      select string_agg(concat_ws('|', 'o', o.id::text, o.name, coalesce(btrim(o.description), ''), o.price::text),
                        E'\n' order by o.sort_order, o.id)
        from public.quote_options o where o.quote_id = p_quote_id
    ), '')
    -- is_selected is IN the fingerprint deliberately: silently ticking an extra
    -- on a quote the customer already approved is the cheapest way there is to
    -- add money to a deal, and it must un-approve the quote like any price move.
    || coalesce((
      select string_agg(concat_ws('|', 'a', a.id::text, a.name, a.price::text, a.is_selected::text),
                        E'\n' order by a.sort_order, a.id)
        from public.quote_addons a where a.quote_id = p_quote_id
    ), '')
  );
$function$;

comment on function public.quote_material_fingerprint(uuid) is
  'THE definition of a commercial change to a quote: price, plan prices, deposit ask, scope (service_type/address/notes), the chosen option, and every quote_services / quote_options / quote_addons row including which extras are selected. Deliberately EXCLUDES internal_notes, the measurement columns, property/customer repairs, follow-up counters and scheduling preferences — those are corrections, not new terms. Read by quote_acceptance_state() to decide reapproval; mirrored, never re-derived, by src/lib/quoteAcceptance.';

-- The terms fingerprint is separate because the terms are TENANT-level and
-- unversioned: business_settings.terms_text is one mutable field printed on
-- every quote PDF and rendered in the portal. Editing it silently rewrites what
-- every past acceptance appears to have agreed to. Snapshotting the exact text
-- into the acceptance row is what makes that impossible; this function is how a
-- later read notices the live text has moved on.
create or replace function public.quote_terms_fingerprint(p_tenant uuid)
returns text
language sql
stable
security definer
set search_path to 'public'
as $function$
  select md5(coalesce((select btrim(coalesce(b.terms_text, '')) from public.business_settings b
                        where b.user_id = p_tenant limit 1), ''));
$function$;

-- ── 2 · The ledger ─────────────────────────────────────────────────────────
create table if not exists public.quote_acceptances (
  id uuid default extensions.uuid_generate_v4() not null,
  created_at timestamp with time zone default now() not null,
  user_id uuid not null,
  quote_id uuid not null,
  customer_id uuid,

  -- Position in this quote's own acceptance history. 1 = the original consent;
  -- 2+ are reapprovals after a commercial change. Assigned by the DATABASE
  -- (trigger below) so two racing writers cannot both read max()+1.
  seq integer not null,

  accepted_at timestamp with time zone default now() not null,

  -- ⭐ WHICH EVENT THIS WAS. The whole point of the table. An administrative
  -- status override is NOT in this enum, because an override is not an
  -- acceptance and must never be able to produce a row here.
  kind text not null,
  -- WHICH DOOR. Passed in by the door that knows it; never inferred here — the
  -- rule quote_apply_choice already states about p_via and change_orders states
  -- about decided_via.
  source text not null,

  -- WHO physically acted. For 'customer' this is the portal visitor holding the
  -- token; for 'owner_on_behalf' it is the signed-in owner — and saying so is
  -- the whole difference between a record and a fiction.
  actor_type text not null,
  actor_id uuid,
  actor_label text,

  -- Why the owner is recording someone else's decision, and any note about it.
  -- Required for 'owner_on_behalf' by a CHECK, not by a caller remembering.
  on_behalf_reason text,
  on_behalf_note text,

  -- ⭐ THE AUTHORIZED VALUE. Computed at the instant of consent from the option
  -- and extras actually chosen — never read back off `total` afterwards.
  accepted_amount numeric(10,2) not null,
  selected_option_id uuid,

  -- The immutable snapshot of what was accepted: quote number, the option's own
  -- name and price, every selected extra, the lines, the plan prices. Held as
  -- DATA rather than as foreign keys, so deleting an option row later cannot
  -- erase the record of it having been bought.
  document jsonb not null,
  document_fingerprint text not null,

  -- Terms acknowledged, EXACTLY as they read at the time.
  terms_required boolean default false not null,
  terms_acknowledged boolean default false not null,
  terms_text text,
  terms_fingerprint text,

  -- The acceptance this one replaces. Set on a reapproval; the superseded row is
  -- never touched.
  supersedes_id uuid
);

alter table public.quote_acceptances
  add constraint quote_acceptances_pkey primary key (id);

-- One row per position per quote. A retry that thinks it needs seq 2 when seq 2
-- exists collides here rather than forking the history.
alter table public.quote_acceptances
  add constraint quote_acceptances_quote_seq_unique unique (quote_id, seq);

-- The target half of this table's own tenant weld (supersedes_id, below). Same
-- shape quotes/customers/jobs already carry so a child can reference (owner, id)
-- as one fact rather than two independently-correct ones.
alter table public.quote_acceptances
  add constraint quote_acceptances_user_id_unique unique (user_id, id);

alter table public.quote_acceptances
  add constraint quote_acceptances_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete cascade;

-- ⭐⭐ TENANT WELDS, NOT PLAIN FOREIGN KEYS. A single-column quote_id FK would
-- say "this names a real quote" and stay silent about whose. Every writer here
-- is SECURITY DEFINER and therefore escapes RLS, which is exactly the shape that
-- turns an unwelded tenant relation into an exploitable one — so the composite
-- makes "an acceptance filed against another tenant's quote" unrepresentable
-- instead of merely unreached. Same shape change_orders already carries.
-- (verify:tenant-weld failed on the single-column versions of these; the guard
-- was right and this is the fix, not a raised threshold.)
--
-- CASCADE, not RESTRICT. Deleting a quote is already a deliberate, audited act
-- (audit_events keeps its own row and holds no FK to quotes), and the quote
-- list's bulk delete must not fail an entire batch because one row in it was
-- accepted. What this table refuses is the OTHER deletion — erasing the evidence
-- while keeping the quote. See the append-only trigger.
alter table public.quote_acceptances
  add constraint quote_acceptances_quote_same_owner
  foreign key (user_id, quote_id) references public.quotes(user_id, id) on delete cascade;

-- SET NULL on the customer column ONLY: a bare `on delete set null` across a
-- composite would null the TENANT too, quietly orphaning the evidence out of the
-- book it belongs to.
alter table public.quote_acceptances
  add constraint quote_acceptances_customer_same_owner
  foreign key (user_id, customer_id) references public.customers(user_id, id)
  on delete set null (customer_id);

-- The composite FK the quotes table already uses for its own selection: an
-- option is resolved THROUGH its quote, so "an option belonging to a different
-- quote" is unrepresentable rather than merely unchecked.
alter table public.quote_acceptances
  add constraint quote_acceptances_selected_option_fkey
  foreign key (selected_option_id, quote_id) references public.quote_options(id, quote_id)
  on delete restrict;

-- Welded to its own tenant for the same reason, and RESTRICT because the row it
-- points at is evidence that may not be deleted while anything still cites it.
alter table public.quote_acceptances
  add constraint quote_acceptances_supersedes_same_owner
  foreign key (user_id, supersedes_id) references public.quote_acceptances(user_id, id)
  on delete restrict;

alter table public.quote_acceptances
  add constraint quote_acceptances_kind_check
  check (kind = any (array['customer'::text, 'owner_on_behalf'::text, 'legacy_unrecorded'::text]));

alter table public.quote_acceptances
  add constraint quote_acceptances_source_check
  check (source = any (array['portal'::text, 'dashboard'::text, 'migration'::text]));

alter table public.quote_acceptances
  add constraint quote_acceptances_actor_type_check
  check (actor_type = any (array['customer'::text, 'owner'::text, 'system'::text]));

alter table public.quote_acceptances
  add constraint quote_acceptances_amount_check
  check (accepted_amount >= 0::numeric);

alter table public.quote_acceptances
  add constraint quote_acceptances_seq_check check (seq >= 1);

alter table public.quote_acceptances
  add constraint quote_acceptances_fingerprint_check
  check (btrim(document_fingerprint) <> ''::text);

-- ⭐⭐ THE ANTI-IMPERSONATION CONSTRAINT. Every way of saying "the customer did
-- this" is welded to every other way. An owner-recorded acceptance cannot claim
-- a customer actor, cannot claim to have arrived through the portal, and cannot
-- omit the reason it was taken second-hand. The misleading row is not
-- constructible, so no read path has to remember to distrust one.
alter table public.quote_acceptances
  add constraint quote_acceptances_on_behalf_shape_check check (
    case kind
      when 'owner_on_behalf' then
        actor_type = 'owner' and source = 'dashboard'
        and on_behalf_reason is not null and btrim(on_behalf_reason) <> ''
      when 'customer' then
        actor_type = 'customer' and source = 'portal'
        and on_behalf_reason is null and on_behalf_note is null
      -- ⭐ THE BACKFILL SHAPE, and it is welded shut just as hard. A legacy row
      -- can ONLY come from the migration, can ONLY be attributed to the system,
      -- and can never carry a reason — because there is no reason to carry: the
      -- product was not recording one. It is a statement that a deal exists and
      -- that WHO ACCEPTED IT IS UNKNOWN, and no surface may render it as consent
      -- from a named person.
      when 'legacy_unrecorded' then
        actor_type = 'system' and source = 'migration'
        and actor_id is null
        and on_behalf_reason is null and on_behalf_note is null
        and not terms_required and not terms_acknowledged
      else false
    end
  );

alter table public.quote_acceptances
  add constraint quote_acceptances_reason_check check (
    on_behalf_reason is null or on_behalf_reason = any (
      array['phone'::text, 'email'::text, 'text_message'::text,
            'in_person'::text, 'written'::text, 'other'::text])
  );

-- Terms that were REQUIRED must have been acknowledged, and the acknowledgement
-- must carry the text it was given for. "I agree" with nothing recorded beside
-- it is not evidence of anything.
alter table public.quote_acceptances
  add constraint quote_acceptances_terms_check check (
    not terms_required
    or (terms_acknowledged and terms_fingerprint is not null and terms_text is not null)
  );

create index if not exists quote_acceptances_quote_idx
  on public.quote_acceptances using btree (quote_id, seq desc);
create index if not exists quote_acceptances_user_idx
  on public.quote_acceptances using btree (user_id, accepted_at desc);
create index if not exists quote_acceptances_customer_idx
  on public.quote_acceptances using btree (customer_id, accepted_at desc);

comment on table public.quote_acceptances is
  'Append-only evidence of quote acceptance: WHAT was accepted (an immutable document snapshot + fingerprint), BY WHOM (kind/actor/source), for HOW MUCH (accepted_amount), WHEN, and against WHICH terms. Never updated; never deleted while its quote exists. A reapproval after a commercial change appends a new row with supersedes_id set. NOT a signature store — S74 documents/signatures and S83 contracts own signatures; nothing here mints or verifies one.';
comment on column public.quote_acceptances.kind is
  'customer = the customer decided, through their own portal door. owner_on_behalf = staff recorded a decision the customer made elsewhere, and on_behalf_reason says where. An ADMINISTRATIVE STATUS OVERRIDE is neither and produces NO row here — it is an audit event only.';
comment on column public.quote_acceptances.document is
  'The quote as accepted: quote_number, service_type, address, notes, the line items, the option chosen (its own name and price, copied not referenced), every selected add-on, the plan prices and the deposit ask. Copied so later edits — or deleting an option row — cannot rewrite what was agreed.';
comment on column public.quote_acceptances.document_fingerprint is
  'quote_material_fingerprint() at the instant of consent, compared against the live value to decide whether the quote still stands accepted. This is why reapproval is DERIVED and never stored.';
comment on column public.quote_acceptances.terms_text is
  'The exact business_settings.terms_text the customer was shown. Snapshotted because that field is tenant-level and unversioned: editing it would otherwise retroactively change what every past acceptance appears to have agreed to.';
comment on column public.quote_acceptances.supersedes_id is
  'The acceptance this one replaces after a commercial change. The superseded row is never modified — history is appended to, never rewritten.';

-- ── 3 · Append-only, and the seq the database assigns ──────────────────────
create or replace function public.quote_acceptances_assign_seq()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare v_prev public.quote_acceptances;
begin
  if new.seq is null then
    select coalesce(max(a.seq), 0) + 1 into new.seq
      from public.quote_acceptances a where a.quote_id = new.quote_id;
  end if;

  -- A reapproval must point at a REAL earlier acceptance OF THIS QUOTE. Pointing
  -- at another quote's acceptance would let one customer's consent stand as the
  -- ancestor of another's.
  if new.supersedes_id is not null then
    select * into v_prev from public.quote_acceptances p where p.id = new.supersedes_id;
    if not found or v_prev.quote_id <> new.quote_id then
      raise exception 'supersedes_id must name an earlier acceptance of the same quote'
        using errcode = 'foreign_key_violation';
    end if;
    if v_prev.seq >= new.seq then
      raise exception 'an acceptance may only supersede an EARLIER one (seq % cannot supersede seq %)',
        new.seq, v_prev.seq using errcode = 'check_violation';
    end if;
  elsif exists (select 1 from public.quote_acceptances a where a.quote_id = new.quote_id) then
    -- ⭐ HISTORY CANNOT BE FORKED. A second acceptance that does not say what it
    -- replaces would leave two unrelated "current" consents on one quote and no
    -- rule for choosing between them.
    raise exception 'this quote already has an acceptance — a reapproval must set supersedes_id'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_quote_acceptances_assign_seq on public.quote_acceptances;
create trigger trg_quote_acceptances_assign_seq
  before insert on public.quote_acceptances
  for each row execute function public.quote_acceptances_assign_seq();

-- ⭐⭐ APPEND-ONLY FOR EVERY ROLE, service_role included. Nothing in the product
-- has a legitimate reason to rewrite a recorded acceptance, and a path that
-- could would be the first thing worth attacking. The one deletion allowed is
-- the CASCADE from deleting the quote itself — detected by the parent already
-- being gone from this command's view, which a direct DELETE can never be.
-- (Proved BOTH WAYS in verify:quote-acceptance-integrity rather than assumed.)
create or replace function public.quote_acceptances_append_only()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
begin
  if tg_op = 'DELETE' then
    if not exists (select 1 from public.quotes q where q.id = old.quote_id) then
      return old;   -- the quote is going; its evidence goes with it
    end if;
    raise exception
      'quote_acceptances is append-only: acceptance evidence cannot be deleted while its quote exists.'
      using errcode = 'check_violation';
  end if;
  raise exception
    'quote_acceptances is append-only: an acceptance cannot be % once recorded — record a REAPPROVAL instead.',
    lower(tg_op)
    using errcode = 'check_violation';
end;
$function$;

drop trigger if exists trg_quote_acceptances_append_only on public.quote_acceptances;
create trigger trg_quote_acceptances_append_only
  before update or delete on public.quote_acceptances
  for each row execute function public.quote_acceptances_append_only();

-- ── 4 · Tenancy ────────────────────────────────────────────────────────────
alter table public.quote_acceptances enable row level security;

-- ⛔ NO INSERT POLICY AND NO UPDATE POLICY, DELIBERATELY. The only writer is
-- quote_record_acceptance() (SECURITY DEFINER), reached through the two named
-- doors. An owner can READ their evidence and can never hand-write it — which is
-- what makes the row worth anything in a dispute. Deleting is the trigger's
-- call, not a policy's, so the cascade still works.
drop policy if exists "quote_acceptances: select own" on public.quote_acceptances;
create policy "quote_acceptances: select own" on public.quote_acceptances
  as permissive for select to public
  using ((auth.uid() = user_id));

revoke all on table public.quote_acceptances from public, anon, authenticated, service_role;
grant select on table public.quote_acceptances to authenticated;

-- ── 5 · Recording an acceptance — the one writer ───────────────────────────
-- ⭐ ONE ENGINE. Both doors reach this; there is no second implementation of
-- "what did they agree to". It builds the snapshot, computes the authorized
-- value, links the reapproval chain, and refuses anything it cannot state
-- truthfully. It does NOT decide who may accept — that is each door's question,
-- because a token proves WHICH CUSTOMER and a session proves WHICH OWNER, and
-- neither proves the other.
create or replace function public.quote_record_acceptance(
  p_quote_id uuid,
  p_kind text,
  p_source text,
  p_actor_id uuid,
  p_actor_label text,
  p_reason text,
  p_note text,
  p_terms_ack boolean
) returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_q public.quotes;
  v_prev public.quote_acceptances;
  v_opt public.quote_options;
  v_addons jsonb;
  v_addon_total numeric(10,2);
  v_amount numeric(10,2);
  v_terms text;
  v_terms_required boolean;
  v_id uuid;
begin
  select * into v_q from public.quotes where id = p_quote_id;
  if not found then return null; end if;

  select * into v_prev from public.quote_acceptances
   where quote_id = p_quote_id order by seq desc limit 1;

  -- ⭐ AN OPTIONS QUOTE CANNOT BE ACCEPTED WITHOUT NAMING ONE. That rule lived
  -- in quote_apply_choice and in one React handler; the plain status dropdown
  -- reached neither. Stating it HERE puts it on every path that can ever record
  -- consent, which is the only place it is safe.
  if v_q.selected_option_id is null
     and exists (select 1 from public.quote_options where quote_id = p_quote_id) then
    raise exception 'this quote offers options — the accepted one must be named'
      using errcode = 'check_violation';
  end if;

  if v_q.selected_option_id is not null then
    select * into v_opt from public.quote_options
     where id = v_q.selected_option_id and quote_id = p_quote_id;
    if not found then
      raise exception 'the selected option does not belong to this quote'
        using errcode = 'check_violation';
    end if;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'price', a.price)
                            order by a.sort_order, a.id), '[]'::jsonb),
         coalesce(sum(a.price), 0)
    into v_addons, v_addon_total
    from public.quote_addons a where a.quote_id = p_quote_id and a.is_selected;

  -- ⭐ THE AUTHORIZED VALUE, computed from the parts and never read off `total`.
  -- `total` is a GENERATED column over the OLD row inside the same statement
  -- that sets the choice, which is exactly how a pre-choice price gets recorded
  -- as consent (the trap quote_apply_choice already names).
  v_amount := coalesce(v_opt.price, v_q.initial_price, 0)
              + coalesce(v_q.travel_fee, 0) + v_addon_total;

  select btrim(coalesce(b.terms_text, '')) into v_terms
    from public.business_settings b where b.user_id = v_q.user_id limit 1;
  v_terms := nullif(coalesce(v_terms, ''), '');
  -- Terms are REQUIRED exactly when the business has any. "Nothing to agree to"
  -- and "agreed to nothing" are different facts and neither is recorded as the
  -- other: terms_required is what tells them apart forever afterwards.
  v_terms_required := v_terms is not null;

  if v_terms_required and not coalesce(p_terms_ack, false) then
    raise exception 'the quoted scope and terms must be acknowledged before acceptance can be recorded'
      using errcode = 'check_violation';
  end if;

  insert into public.quote_acceptances (
    user_id, quote_id, customer_id, accepted_at,
    kind, source, actor_type, actor_id, actor_label,
    on_behalf_reason, on_behalf_note,
    accepted_amount, selected_option_id,
    document, document_fingerprint,
    terms_required, terms_acknowledged, terms_text, terms_fingerprint,
    supersedes_id
  ) values (
    v_q.user_id, p_quote_id, v_q.customer_id, now(),
    p_kind, p_source,
    case when p_kind = 'customer' then 'customer' else 'owner' end,
    p_actor_id, nullif(btrim(coalesce(p_actor_label, '')), ''),
    case when p_kind = 'owner_on_behalf' then btrim(p_reason) else null end,
    case when p_kind = 'owner_on_behalf' then nullif(btrim(coalesce(p_note, '')), '') else null end,
    v_amount, v_q.selected_option_id,
    jsonb_build_object(
      'quote_number',    v_q.quote_number,
      'customer_name',   v_q.customer_name,
      'address',         v_q.address,
      'service_type',    v_q.service_type,
      'notes',           v_q.notes,
      'initial_price',   v_q.initial_price,
      'travel_fee',      v_q.travel_fee,
      'total',           v_q.total,
      'valid_until',     v_q.valid_until,
      'deposit_type',    v_q.deposit_type,
      'deposit_value',   v_q.deposit_value,
      'plan_prices',     jsonb_build_object('weekly', v_q.weekly_price,
                                            'biweekly', v_q.biweekly_price,
                                            'monthly', v_q.monthly_price),
      'option',          case when v_opt.id is null then null else
                           jsonb_build_object('id', v_opt.id, 'name', v_opt.name,
                                              'description', v_opt.description, 'price', v_opt.price) end,
      'options_offered', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name, 'price', o.price)
                                                    order by o.sort_order, o.id)
                                     from public.quote_options o where o.quote_id = p_quote_id), '[]'::jsonb),
      'addons',          v_addons,
      'services',        coalesce((select jsonb_agg(jsonb_build_object(
                                     'service_type', s.service_type, 'quantity', s.quantity, 'unit', s.unit,
                                     'unit_price', s.unit_price, 'discount_type', s.discount_type,
                                     'discount_value', s.discount_value, 'notes', s.notes, 'kind', s.kind)
                                     order by s.sort_order, s.id)
                                    from public.quote_services s where s.quote_id = p_quote_id), '[]'::jsonb)
    ),
    public.quote_material_fingerprint(p_quote_id),
    v_terms_required,
    v_terms_required and coalesce(p_terms_ack, false),
    v_terms,
    case when v_terms_required then public.quote_terms_fingerprint(v_q.user_id) else null end,
    v_prev.id
  ) returning id into v_id;

  return v_id;
end;
$function$;

revoke all on function public.quote_record_acceptance(uuid, text, text, uuid, text, text, text, boolean)
  from public, anon, authenticated, service_role;

-- ── 6 · Reading the state — reapproval is DERIVED here, and only here ──────
create or replace function public.quote_acceptance_state(p_quote_id uuid)
returns table(
  accepted boolean,
  acceptance_id uuid,
  acceptance_seq integer,
  accepted_at timestamp with time zone,
  kind text,
  source text,
  actor_label text,
  on_behalf_reason text,
  accepted_amount numeric,
  selected_option_id uuid,
  document jsonb,
  terms_acknowledged boolean,
  needs_reapproval boolean,
  terms_changed boolean
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare v_a public.quote_acceptances; v_tenant uuid;
begin
  select q.user_id into v_tenant from public.quotes q where q.id = p_quote_id;
  if v_tenant is null then return; end if;
  -- ⛔ Tenancy is asserted HERE, not left to the caller. This function is
  -- SECURITY DEFINER, so without it any signed-in user could read any tenant's
  -- acceptance evidence by quote id.
  if auth.uid() is distinct from v_tenant then return; end if;

  select * into v_a from public.quote_acceptances
   where quote_id = p_quote_id order by seq desc limit 1;
  if not found then
    return query select false, null::uuid, null::integer, null::timestamptz, null::text, null::text,
                        null::text, null::text, null::numeric, null::uuid, null::jsonb,
                        false, false, false;
    return;
  end if;

  return query select
    true, v_a.id, v_a.seq, v_a.accepted_at, v_a.kind, v_a.source, v_a.actor_label,
    v_a.on_behalf_reason, v_a.accepted_amount, v_a.selected_option_id, v_a.document,
    v_a.terms_acknowledged,
    -- ⭐⭐ THE REAPPROVAL RULE, in one expression. Not a stored flag and not a
    -- column anyone can forget to set: the document either still fingerprints
    -- the way it did when they said yes, or it does not.
    public.quote_material_fingerprint(p_quote_id) is distinct from v_a.document_fingerprint,
    v_a.terms_required
      and public.quote_terms_fingerprint(v_tenant) is distinct from v_a.terms_fingerprint;
end;
$function$;

revoke all on function public.quote_acceptance_state(uuid) from public, anon, authenticated, service_role;
grant execute on function public.quote_acceptance_state(uuid) to authenticated;

-- ── 6b · THE ONE QUESTION EVERY ACTING PATH ASKS ───────────────────────────
-- ⭐⭐ "May I act on this quote's commercial terms right now?" Scheduling a job,
-- converting to an invoice and asking for a deposit are all the same question
-- wearing different clothes, and before this they each answered it themselves by
-- reading `status`. Status is not evidence: it survives the edit that invalidated
-- the consent behind it.
--
-- FALSE means one of two different things, and the caller is told which by
-- quote_acceptance_state: nobody ever accepted, or somebody did and the deal has
-- moved since. Both block; they do not read alike to a human.
--
-- ⛔ NOT a security boundary — it is a TRUTH boundary. Tenancy is still each
-- door's own job; this answers "is the consent current", nothing else.
create or replace function public.quote_acceptance_is_current(p_quote_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare v_a public.quote_acceptances; v_tenant uuid;
begin
  select q.user_id into v_tenant from public.quotes q where q.id = p_quote_id;
  if v_tenant is null then return false; end if;
  -- ⛔ A SIGNED-IN CALLER MAY ONLY ASK ABOUT THEIR OWN QUOTES. This is
  -- SECURITY DEFINER and resolves a quote BY ID, so without this an authenticated
  -- user could probe another tenant's quote ids and learn which of them carry a
  -- live acceptance. Answering `false` — indistinguishable from "not current" —
  -- leaks nothing at all.
  -- ⭐ auth.uid() IS NULL is the server path, not a hole: the portal's deposit
  -- route has no JWT (a token proves the customer, and the route has already
  -- matched the quote to that token) and is the reason service_role is granted
  -- execute. anon is granted nothing here.
  if auth.uid() is not null and auth.uid() is distinct from v_tenant then return false; end if;
  select * into v_a from public.quote_acceptances
   where quote_id = p_quote_id order by seq desc limit 1;
  -- No evidence at all: a status somebody typed is not an acceptance.
  if not found then return false; end if;
  if public.quote_material_fingerprint(p_quote_id) is distinct from v_a.document_fingerprint then
    return false;
  end if;
  if v_a.terms_required
     and public.quote_terms_fingerprint(v_tenant) is distinct from v_a.terms_fingerprint then
    return false;
  end if;
  return true;
end;
$function$;

comment on function public.quote_acceptance_is_current(uuid) is
  'THE gate: does a live, un-drifted acceptance authorize this quote''s CURRENT commercial terms? False when nothing ever accepted it, when a material fact changed since, or when the tenant''s terms moved. Mirrored (never re-derived) by hasCurrentValidAcceptance() in src/lib/quoteAcceptance.';

revoke all on function public.quote_acceptance_is_current(uuid) from public, anon, authenticated, service_role;
grant execute on function public.quote_acceptance_is_current(uuid) to authenticated;
-- ⭐ service_role too, and ONLY this function of the set. The portal's deposit
-- route runs with no user session — it proves the customer with a token, not a
-- JWT — so it cannot call quote_acceptance_state (which asserts auth.uid() =
-- tenant). This one answers a boolean about consent currency and leaks no
-- evidence, which is exactly why it was written without a tenancy assertion.
-- ⛔ anon is NOT granted: a customer must never be able to probe quote ids.
grant execute on function public.quote_acceptance_is_current(uuid) to service_role;

-- ── 7 · The consent snapshot has exactly one writer ────────────────────────
-- quote_apply_choice is unchanged in every rule it already enforced. The one
-- addition is the transaction-local marker that lets the protection trigger in
-- section 8 tell "the acceptance engine is writing" from "somebody sent a PATCH".
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
begin
  -- Provenance is passed in by the door that knows it, never inferred here.
  if p_via is null or p_via not in ('portal', 'owner') then return false; end if;

  -- 'draft' or 'sent' = NOT YET DECIDED. Anything else means a choice already
  -- stands, and re-deciding would silently rewrite the approved price. A
  -- REAPPROVAL therefore travels the same road as the first one: the owner sends
  -- the revised quote again, which returns it to 'sent'.
  select q.status, coalesce(q.travel_fee, 0), coalesce(q.follow_up_count, 0), q.initial_price
    into v_status, v_travel, v_follow, v_base
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
         accepted_price = v_base + v_travel + v_addons,
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

-- ⭐⭐ accepted_price and selected_option_id are the two columns that say what
-- the customer bought, and the owner's RLS update policy covers every column on
-- the row. Editing a quote after acceptance is a SUPPORTED flow — corrections
-- are real, and the app warns about them — but rewriting the CONSENT SNAPSHOT is
-- not an edit to the quote, it is an edit to the customer's answer.
--
-- So there is exactly ONE writer, for the whole life of the row: quote_apply_
-- choice, which both acceptance doors reach and which no PATCH can imitate. A
-- status override may still set status='accepted' (an owner repairing a stuck
-- row is a real need) — it simply cannot invent a figure to go with it, which is
-- what made an override indistinguishable from consent.
create or replace function public.quotes_protect_consent_snapshot()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
begin
  if coalesce(current_setting('app.quote_consent_writer', true), '') = new.id::text then
    return new;
  end if;
  if new.accepted_price is distinct from old.accepted_price then
    raise exception 'accepted_price records what the customer agreed to and is written only when an acceptance is recorded'
      using errcode = 'check_violation';
  end if;
  if new.selected_option_id is distinct from old.selected_option_id then
    raise exception 'the accepted option is written only when an acceptance is recorded — send a revised quote to change it'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_quotes_protect_consent_snapshot on public.quotes;
create trigger trg_quotes_protect_consent_snapshot
  before update of accepted_price, selected_option_id on public.quotes
  for each row execute function public.quotes_protect_consent_snapshot();

-- ── 8 · The doors ──────────────────────────────────────────────────────────
--
-- ⛔⛔ `create or replace function` WITH A NEW PARAMETER CREATES AN OVERLOAD; it
-- does not replace anything. Left alone, both old signatures survive, keep their
-- grants, and stay callable:
--
--   portal_accept_quote(text, uuid, uuid, uuid[])   granted to ANON, and with no
--     p_terms_ack — so the terms acknowledgement is bypassable by any caller who
--     simply omits the argument.
--   owner_select_quote_option(uuid, uuid, uuid[])   granted to authenticated,
--     with no reason — the mis-attributing door this session exists to close.
--
-- Found by verify:quote-acceptance-integrity failing, not by reading: the guard
-- called the 3-argument owner door and Postgres answered "function is not unique".
--
-- They are retired in §8c-drop below, and the DEFAULTS on the surviving
-- functions — not a second function — are what carry the clients deployed
-- before the app ships. §8c-drop explains why a shim function is not merely
-- unnecessary here but impossible.

-- 8a · THE CUSTOMER'S DOOR. Unchanged in what it proves (a token names a
-- customer; the quote must be that customer's and still 'sent'). It now also
-- carries the terms acknowledgement and writes the evidence in the SAME
-- transaction as the status change — so "accepted with no acceptance row" is a
-- state this door cannot produce.
create or replace function public.portal_accept_quote(
  p_token text, p_quote_id uuid,
  p_option_id uuid default null::uuid,
  p_addon_ids uuid[] default null::uuid[],
  p_terms_ack boolean default false
) returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_customer uuid; v_user uuid; v_name text;
begin
  select t.customer_id, t.user_id into v_customer, v_user
    from public.customer_portal_tokens t where t.token = p_token and not t.revoked;
  if v_customer is null then return false; end if;

  -- ⛔ 'sent' only: a draft is the owner's unfinished document and is never shown
  -- to a customer, so it can never be approved from here.
  if not exists (
    select 1 from public.quotes
     where id = p_quote_id and customer_id = v_customer and user_id = v_user and status = 'sent'
  ) then
    return false;
  end if;

  if not public.quote_apply_choice(p_quote_id, p_option_id, p_addon_ids, 'portal') then
    return false;
  end if;

  select c.name into v_name from public.customers c where c.id = v_customer and c.user_id = v_user;
  perform public.quote_record_acceptance(
    p_quote_id, 'customer', 'portal', v_customer, v_name, null, null, coalesce(p_terms_ack, false));
  return true;
end;
$function$;

revoke all on function public.portal_accept_quote(text, uuid, uuid, uuid[], boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.portal_accept_quote(text, uuid, uuid, uuid[], boolean) to anon;
grant execute on function public.portal_accept_quote(text, uuid, uuid, uuid[], boolean) to authenticated;

-- 8b · THE OWNER'S DOOR — "Record customer acceptance".
-- ⭐⭐ THE REASON IS NOT OPTIONAL AND HAS NO DEFAULT. An owner recording a
-- decision that reached them by phone is making a claim about someone else; the
-- record must say so, and say how. A null reason is a REFUSAL, never a silently
-- -'other' row: failing closed here is the whole difference between evidence and
-- an assertion.
create or replace function public.owner_record_customer_acceptance(
  p_quote_id uuid,
  p_reason text,
  p_option_id uuid default null::uuid,
  p_addon_ids uuid[] default null::uuid[],
  p_note text default null::text
) returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_uid uuid := auth.uid(); v_label text;
begin
  if v_uid is null then return null; end if;
  if p_reason is null or btrim(p_reason) = '' then return null; end if;
  if not exists (select 1 from public.quotes where id = p_quote_id and user_id = v_uid) then
    return null;
  end if;
  if not public.quote_apply_choice(p_quote_id, p_option_id, p_addon_ids, 'owner') then
    return null;
  end if;
  select coalesce(nullif(btrim(b.owner_name), ''), nullif(btrim(b.company_name), ''))
    into v_label from public.business_settings b where b.user_id = v_uid limit 1;
  -- ⭐ The terms acknowledgement is TRUE by a different route here, and the row
  -- says which route: the owner is attesting the customer agreed, and
  -- kind='owner_on_behalf' + on_behalf_reason is exactly that attestation. It is
  -- never presented later as the customer having ticked a box.
  return public.quote_record_acceptance(
    p_quote_id, 'owner_on_behalf', 'dashboard', v_uid, v_label,
    btrim(p_reason), p_note, true);
end;
$function$;

revoke all on function public.owner_record_customer_acceptance(uuid, text, uuid, uuid[], text)
  from public, anon, authenticated, service_role;
grant execute on function public.owner_record_customer_acceptance(uuid, text, uuid, uuid[], text) to authenticated;

-- 8c · The old owner door, made honest.
-- It used to accept on the customer's behalf with no reason and no record,
-- producing a quote row byte-identical to a real portal approval. It is kept
-- (callers exist, and dropping a granted function is destructive DDL) but it now
-- REFUSES rather than mis-attributes. An older client that has not been deployed
-- yet therefore fails CLOSED — the owner sees "could not record that choice"
-- instead of the app quietly writing a consent nobody gave.
create or replace function public.owner_select_quote_option(
  p_quote_id uuid,
  p_option_id uuid default null::uuid,
  p_addon_ids uuid[] default null::uuid[],
  p_reason text default null::text,
  p_note text default null::text
) returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if auth.uid() is null then return false; end if;
  if p_reason is null or btrim(p_reason) = '' then return false; end if;
  return public.owner_record_customer_acceptance(
    p_quote_id, p_reason, p_option_id, p_addon_ids, p_note) is not null;
end;
$function$;

revoke all on function public.owner_select_quote_option(uuid, uuid, uuid[], text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.owner_select_quote_option(uuid, uuid, uuid[], text, text) to authenticated;

-- ── 8c-drop · RETIRE THE OLD ARITIES — the DEFAULTS are the seam ───────────
--
-- ⭐⭐ MEASURED, NOT ASSUMED: TWO OVERLOADS THAT DIFFER ONLY BY A DEFAULTED
-- TRAILING PARAMETER ARE UNCALLABLE. An earlier cut of this migration kept the
-- old arities as separate shim functions. Postgres refuses every call to either:
--
--     ERROR 42725: function public.portal_accept_quote(text, uuid, uuid, uuid[])
--                  is not unique
--     HINT: Could not choose a best candidate function.
--
-- because `(text, uuid, uuid, uuid[])` matches the 4-argument function exactly
-- AND matches the 5-argument one with p_terms_ack defaulted, and nothing breaks
-- the tie. PostgREST resolves RPCs by parameter NAME, so it lands in the same
-- ambiguity: the shim would not have degraded the deploy window, it would have
-- broken it outright, for old and new clients alike. Caught by
-- verify:quote-acceptance-integrity refusing to call its own shim.
--
-- ⭐ SO THE COMPATIBILITY SEAM IS THE DEFAULT VALUE, not a second function —
-- which is simpler, and is the thing that was going to do the work anyway:
--
--   portal_accept_quote(…, p_terms_ack boolean DEFAULT false)
--     A pre-deploy client omits the argument and gets `false`. A tenant with no
--     terms is completely unaffected. A tenant WITH terms refuses — which is
--     correct and is the only safe answer: the alternative is recording an
--     acknowledgement the customer never made. FAILS CLOSED, and heals the
--     moment the new app is serving.
--
--   owner_select_quote_option(…, p_reason text DEFAULT null)
--     A pre-deploy client omits it, gets null, and is refused (returns false →
--     the owner sees "could not record that choice"). Owner-side only, visible,
--     and it lasts as long as the app rollout does. It CANNOT be softened by
--     defaulting the reason to 'other': a default reason is a fabricated reason,
--     which is the exact defect this session exists to remove.
--
-- ⛔ These two drops are therefore load-bearing and are the only destructive
-- statements in this migration. They drop FUNCTIONS, never data, and each is
-- replaced in the same transaction by a strictly stricter version of itself
-- whose defaults carry the old callers.
drop function if exists public.portal_accept_quote(text, uuid, uuid, uuid[]);
drop function if exists public.owner_select_quote_option(uuid, uuid, uuid[]);

-- ── 8d · "What kind of accepted is this?", asked in ONE place ──────────────
-- Both the audit trigger and the notification trigger need the same answer, and
-- two copies of this lookup is exactly how they would start disagreeing about
-- the same event. It reads the in-flight marker first (the doors set it; the
-- ledger row does not exist yet at trigger time), then the ledger (a later
-- transaction — a re-send, a status repair — reading history), then answers
-- NULL, which means: nobody accepted this, somebody changed a label.
create or replace function public.quote_acceptance_kind_now(p_quote_id uuid)
returns text
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare v_marker text; v_kind text;
begin
  v_marker := nullif(coalesce(current_setting('app.quote_acceptance_kind', true), ''), '');
  if v_marker in ('customer', 'owner_on_behalf') then return v_marker; end if;
  select a.kind into v_kind from public.quote_acceptances a
   where a.quote_id = p_quote_id order by a.seq desc limit 1;
  return v_kind;
end;
$function$;

comment on function public.quote_acceptance_kind_now(uuid) is
  'Which kind of acceptance is being (or was) recorded for this quote: customer, owner_on_behalf, or NULL meaning an administrative status change with no acceptance behind it. Reads the doors'' in-flight marker first because the AFTER UPDATE triggers on quotes fire BEFORE the acceptance row is inserted.';

-- ── 9 · The bell used to lie ───────────────────────────────────────────────
-- ⭐⭐ notify_quote_accepted fired on ANY transition into 'accepted' and said
-- "<customer name> accepted a quote" — including when the owner had just picked
-- Approved from a dropdown themselves. Now it says what the LEDGER says, and
-- where there is no ledger row it says the true, duller thing.
create or replace function public.notify_quote_accepted()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_kind text; v_title text;
begin
  if new.status = 'accepted' and old.status is distinct from 'accepted' then
    v_kind := public.quote_acceptance_kind_now(new.id);
    v_title := case v_kind
      when 'customer' then coalesce(nullif(new.customer_name,''), 'A customer') || ' accepted a quote'
      when 'owner_on_behalf' then 'You recorded ' || coalesce(nullif(new.customer_name,''), 'a customer') || '''s acceptance'
      -- No evidence: an administrative status change. Naming the customer here
      -- would put words in their mouth, in the owner's own notification bell.
      else 'Quote marked accepted — no customer acceptance on record'
    end;
    insert into public.notifications (user_id, type, title, body, customer_id, entity_type, entity_id, amount, href)
    values (new.user_id, 'quote_accepted', v_title,
      'Quote ' || coalesce(new.quote_number, '') || ' · $' || trim(to_char(coalesce(new.total,0), 'FM999990D00')),
      new.customer_id, 'quote', new.id, new.total, '/dashboard/quotes/' || new.id);
  end if;
  return new;
end;
$function$;

-- ── 10 · Audit: an override is named as an override ────────────────────────
-- audit_quotes already emitted 'quote_accepted' on the transition, and
-- audit_actor_context already attributed it honestly (owner vs customer). What
-- it could not say was WHICH KIND of accepted — so a manual dropdown change and
-- a portal approval both read "Approved quote" in the business feed. The ledger
-- settles it, and the audit row now carries the answer.
create or replace function public.audit_quotes()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_action text;
  v_kind text;
  v_reason text;
begin
  if tg_op = 'INSERT' then
    perform public.audit_log(new.user_id, 'quote_created', 'quote', new.id,
      new.quote_number, new.customer_id,
      null,
      jsonb_build_object('status', new.status, 'total', new.total));
    return null;
  end if;

  if tg_op = 'DELETE' then
    perform public.audit_log(old.user_id, 'quote_deleted', 'quote', old.id,
      old.quote_number, old.customer_id,
      jsonb_build_object('status', old.status, 'total', old.total),
      null);
    return null;
  end if;

  if new.status is distinct from old.status then
    if new.status = 'accepted' then
      -- ⭐ THREE EVENTS, THREE ACTIONS, ONE READER. 'quote_status_overridden' is
      -- the honest name for "someone set this to accepted and no customer said
      -- yes". quote_acceptance_kind_now is shared with the notification trigger
      -- so the feed and the bell can never describe one event two ways.
      v_kind := public.quote_acceptance_kind_now(new.id);
      v_action := case v_kind
        when 'customer' then 'quote_accepted'
        when 'owner_on_behalf' then 'quote_acceptance_recorded'
        else 'quote_status_overridden' end;
    else
      v_action := case new.status
        when 'sent'      then 'quote_sent'
        when 'declined'  then 'quote_declined'
        when 'scheduled' then 'quote_scheduled'
        when 'completed' then 'quote_completed'
        when 'paid'      then 'quote_paid'
        else 'quote_status_changed'
      end;
    end if;
    -- ⭐ An OVERRIDE carries the owner's own words for why. Set transaction-locally
    -- by owner_override_quote_status and read here, so the reason rides the ONE
    -- audit row this trigger already writes — rather than a second audit table,
    -- or a second row saying the same thing twice.
    v_reason := nullif(coalesce(current_setting('app.quote_status_override_reason', true), ''), '');
    perform public.audit_log(new.user_id, v_action, 'quote', new.id,
      new.quote_number, new.customer_id,
      jsonb_build_object('status', old.status),
      jsonb_build_object('status', new.status)
        || case when new.status = 'accepted' then
             jsonb_build_object('accepted_price', new.accepted_price,
                                'selected_cadence', new.selected_cadence,
                                'acceptance_kind', v_kind)
           else '{}'::jsonb end
        || case when v_reason is not null then jsonb_build_object('override_reason', v_reason)
           else '{}'::jsonb end);
  end if;

  -- Price edits. `total` is GENERATED from initial_price + travel_fee — the one
  -- money path — so before/after quote the generated figure, not the parts.
  if (new.initial_price is distinct from old.initial_price
      or new.travel_fee is distinct from old.travel_fee) then
    perform public.audit_log(new.user_id, 'quote_price_changed', 'quote', new.id,
      new.quote_number, new.customer_id,
      jsonb_build_object('total', old.total),
      jsonb_build_object('total', new.total));
  end if;

  return null;
end;
$function$;

-- ── 11 · THE BACKFILL — without this the existing book stops working ───────
--
-- ⛔⛔ THIS IS A LANDING BLOCKER, NOT A NICETY. Every quote already sitting at
-- 'accepted' / 'scheduled' / 'completed' / 'paid' in production was accepted
-- before any evidence existed. The moment quote_acceptance_is_current() becomes
-- the gate on scheduling, invoicing and deposits, every one of those quotes
-- answers FALSE — because there is no ledger row — and the entire existing book
-- becomes unschedulable and unbillable in one deploy.
--
-- ⭐ SO THE HONEST FIX IS TO SAY WHAT IS TRUE, NOT TO EXEMPT THEM. A third kind,
-- `legacy_unrecorded`, means precisely: "a deal exists here, and WHO accepted it,
-- WHEN, and against WHICH terms was never recorded, because the product was not
-- recording it." That is a different fact from a customer accepting and a
-- different fact from an owner recording one, and the shape CHECK welds it shut
-- so it can never be rendered as either: actor_type='system', source='migration',
-- no actor id, no reason, and terms_required=false — because nothing was
-- acknowledged and pretending otherwise would be the very forgery this table
-- exists to prevent.
--
-- ⭐ accepted_at is the quote's own updated_at, and it is a BEST GUESS. It is
-- the closest thing the row carries to "when this was decided" — and it is only
-- ever an upper bound, because a later edit moved it. The kind says the
-- provenance is unknown; nothing downstream should read this timestamp as
-- precise, and no UI presents it as one.
--
-- ⭐ THE FINGERPRINT IS TAKEN AS THE QUOTE STANDS TODAY. That is the point: a
-- backfilled quote starts life NOT needing reapproval (nothing has changed since
-- we started watching), and from this migration forward any material change to
-- it flags reapproval exactly like a freshly accepted one. Fingerprinting some
-- imagined original would invent drift that never happened and demand reapproval
-- across the whole book on day one.
--
-- Idempotent by construction: `where not exists`, so re-running is a no-op, and
-- a quote that has since been accepted properly is never given a legacy row.
insert into public.quote_acceptances (
  user_id, quote_id, customer_id, seq, accepted_at,
  kind, source, actor_type, actor_id, actor_label,
  accepted_amount, selected_option_id,
  document, document_fingerprint,
  terms_required, terms_acknowledged, terms_text, terms_fingerprint
)
select
  q.user_id, q.id, q.customer_id, 1, coalesce(q.updated_at, q.created_at),
  'legacy_unrecorded', 'migration', 'system', null,
  'Recorded before EdgeHQ kept acceptance evidence',
  -- The authorized amount is whatever the row already claims: accepted_price if
  -- something snapshotted one, else the current total. Both are the best the old
  -- model could offer, and neither is invented here.
  round(coalesce(q.accepted_price, q.total, 0)::numeric, 2),
  q.selected_option_id,
  jsonb_build_object(
    'quote_number',   q.quote_number,
    'customer_name',  q.customer_name,
    'address',        q.address,
    'service_type',   q.service_type,
    'notes',          q.notes,
    'initial_price',  q.initial_price,
    'travel_fee',     q.travel_fee,
    'total',          q.total,
    'valid_until',    q.valid_until,
    'deposit_type',   q.deposit_type,
    'deposit_value',  q.deposit_value,
    'plan_prices',    jsonb_build_object('weekly', q.weekly_price,
                                         'biweekly', q.biweekly_price,
                                         'monthly', q.monthly_price),
    'option',         (select jsonb_build_object('id', o.id, 'name', o.name,
                                                 'description', o.description, 'price', o.price)
                         from public.quote_options o
                        where o.id = q.selected_option_id and o.quote_id = q.id),
    'options_offered', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name, 'price', o.price)
                                                  order by o.sort_order, o.id)
                                   from public.quote_options o where o.quote_id = q.id), '[]'::jsonb),
    'addons',          coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'price', a.price)
                                                  order by a.sort_order, a.id)
                                   from public.quote_addons a where a.quote_id = q.id and a.is_selected), '[]'::jsonb),
    'services',        coalesce((select jsonb_agg(jsonb_build_object(
                                   'service_type', s.service_type, 'quantity', s.quantity, 'unit', s.unit,
                                   'unit_price', s.unit_price, 'discount_type', s.discount_type,
                                   'discount_value', s.discount_value, 'notes', s.notes, 'kind', s.kind)
                                   order by s.sort_order, s.id)
                                  from public.quote_services s where s.quote_id = q.id), '[]'::jsonb),
    'backfilled',      true
  ),
  public.quote_material_fingerprint(q.id),
  -- ⛔ NOTHING WAS ACKNOWLEDGED. Stamping the tenant's CURRENT terms here would
  -- assert these customers agreed to text they may never have seen — and would
  -- then quietly go stale the next time the owner edits Settings, demanding
  -- reapproval across the whole book for a promise nobody ever made.
  false, false, null, null
from public.quotes q
where q.status in ('accepted', 'scheduled', 'completed', 'paid')
  and not exists (select 1 from public.quote_acceptances a where a.quote_id = q.id);

-- ── 12 · THE ADMINISTRATIVE OVERRIDE, made a door instead of a side effect ──
--
-- ⭐⭐ CHANGING A STATUS IS NOT ACCEPTANCE, and this is the function that makes
-- that structurally true rather than merely documented. It moves the label, it
-- demands the owner's own words for why, and it writes NO acceptance evidence —
-- so a quote overridden to 'accepted' still answers FALSE to
-- quote_acceptance_is_current, and scheduling, invoicing and the deposit ask all
-- still refuse it. The label moves; the authority does not.
--
-- ⛔ IT CANNOT REACH quote_acceptances. There is no insert here, and the table
-- has no INSERT policy or grant for any client role — the only writer is
-- quote_record_acceptance, which this never calls. That is the guarantee, not
-- this comment.
--
-- ⭐ THE REASON RIDES THE EXISTING AUDIT ROW. audit_quotes() already emits one
-- event per status change; this sets a transaction-local GUC that trigger reads,
-- so the reason lands in that row's `after` payload as `override_reason`. No
-- second audit table, no second row, no duplicate infrastructure.
--
-- ⛔ It deliberately CANNOT set 'draft' or 'sent'. Those are ordinary lifecycle
-- moves with their own doors (markSentPatch stamps the expiry clock and the
-- chase anchor); routing them through an "override" would teach an owner that
-- sending a quote is an emergency action.
create or replace function public.owner_override_quote_status(
  p_quote_id uuid,
  p_status text,
  p_reason text
) returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_uid uuid := auth.uid(); v_current text;
begin
  if v_uid is null then return false; end if;
  -- ⛔ A reason is not optional. An override with no stated cause is
  -- indistinguishable, a month later, from a mistake — which is the state this
  -- whole session exists to stop the record being in.
  if p_reason is null or btrim(p_reason) = '' then return false; end if;
  if p_status is null or p_status not in ('accepted', 'scheduled', 'completed', 'paid', 'declined') then
    return false;
  end if;

  select status into v_current from public.quotes where id = p_quote_id and user_id = v_uid;
  if v_current is null then return false; end if;
  if v_current = p_status then return false; end if;   -- nothing to override

  perform set_config('app.quote_status_override_reason', btrim(p_reason), true);
  update public.quotes set status = p_status where id = p_quote_id and user_id = v_uid;
  perform set_config('app.quote_status_override_reason', '', true);
  return true;
end;
$function$;

comment on function public.owner_override_quote_status(uuid, text, text) is
  'Administrative status override. Moves quotes.status and records the owner''s stated reason on the audit row audit_quotes() already writes. ⛔ Writes NO acceptance evidence: an overridden quote still fails quote_acceptance_is_current(), so scheduling, invoicing and the deposit ask keep refusing it. Changing a label is not obtaining consent.';

revoke all on function public.owner_override_quote_status(uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.owner_override_quote_status(uuid, text, text) to authenticated;
