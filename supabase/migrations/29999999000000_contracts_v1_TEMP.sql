-- ═══════════════════════════════════════════════════════════════════════════
-- CONTRACTS + SERVICE AGREEMENTS V1  (Session 83)
--
-- ⛔⛔ TEMPORARY MIGRATION IDENTITY. The `29999999000000` stamp is a DEVELOPMENT
-- placeholder chosen only so this file sorts last during a from-zero rebuild.
-- Session 74 (documents + signatures) has NOT landed on main, so the real
-- version cannot be known yet: it must be taken AT APPLY TIME from the live
-- ledger, after S74's own migration is applied. Re-stamp before landing.
-- This file has NEVER been applied to production.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHAT THIS OWNS, AND WHAT IT DELIBERATELY DOES NOT
--
-- ⭐⭐ A CONTRACT IS A COMMERCIAL RELATIONSHIP. It is not a file, not a
-- signature, and not a schedule. Those three already have owners, and this file
-- adds none of them:
--
--   the rendered artifact  → Session 74 document_versions (immutable)
--   the ask and the act    → Session 74 document_signature_requests /
--                            document_signatures
--   when visits happen     → job_recurrences (the OPERATIONAL series)
--   post-acceptance scope  → change_orders (Session 51). A contract is the
--                            commercial/legal relationship; a change order
--                            authorizes scope and value AFTER acceptance.
--   the event log          → audit_log() (Session 68). Audit DESCRIBES;
--                            this domain is authoritative.
--
-- ⭐⭐ THE THREE TRUTHS STAY INDEPENDENT (owner decision, 2026-08-16):
--   1. the customer signed/accepted an agreement  → contracts + S74 signatures
--   2. an operational recurring schedule exists   → job_recurrences
--   3. individual visits happened                 → jobs
-- A contract MAY reference a recurrence. It never IS one. Nothing in this file
-- inserts, updates or deletes a job_recurrences row, and nothing here reads a
-- recurrence to decide a contract date — that is what "independent term" means,
-- and verify:contracts pins it.
--
-- ⛔ NOT LEGAL ADVICE, AND NOT A QUALIFIED ELECTRONIC SIGNATURE. This records a
-- named person agreeing to a stated sentence against one immutable version, at a
-- known time, from a known surface. EdgeHQ provides the infrastructure and makes
-- no claim that the result is binding in any particular jurisdiction. The
-- signature semantics are Session 74's and are not restated here.
-- ═══════════════════════════════════════════════════════════════════════════


-- ── 0 · apply-order precondition ─────────────────────────────────────────────
-- ⛔ SESSION 74 FIRST. Every contract points at a Session 74 document and, once
-- sent, at one of its immutable versions.
--
-- ⚠️ WHY A BLOCK AND NOT A COMMENT: plpgsql compiles LAZILY, so a trigger that
-- references a missing table is created happily and only explodes on the first
-- real write — in production, long after the migration reported success. Failing
-- here names the actual cause instead of leaving an operator to decode a
-- constraint error.
do $$
begin
  if to_regclass('public.documents') is null
     or to_regclass('public.document_versions') is null
     or to_regclass('public.document_signature_requests') is null
     or to_regclass('public.document_signatures') is null then
    raise exception
      'contracts_v1 requires Session 74: apply the documents and signatures migration first (public.documents is missing)';
  end if;
  if to_regprocedure('public.audit_log(uuid,text,text,uuid,text,uuid,jsonb,jsonb,jsonb)') is null then
    raise exception
      'contracts_v1 requires the Session 68 audit trail: public.audit_log is missing';
  end if;
end $$;


-- ── 1 · tenant-weld enablers on Session 74 tables ────────────────────────────
-- ⭐ THE WELD IS THE WHOLE TENANCY STORY. This codebase's answer to "a child row
-- and its parent must belong to the same business" is a COMPOSITE foreign key
-- against a composite unique — 17 tables already do it (customers, quotes, jobs,
-- properties, job_recurrences, …). A single-column FK to documents(id) would let
-- one tenant attach another tenant's document, and no amount of app-side
-- checking makes that structurally impossible.
--
-- S74 did not need these on its own tables, so they are added here. A UNIQUE over
-- (user_id, id) where id is already the primary key cannot fail on existing data
-- and changes nothing about S74's behaviour.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'documents_user_id_id_key') then
    alter table public.documents add constraint documents_user_id_id_key unique (user_id, id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'document_versions_user_id_id_key') then
    alter table public.document_versions add constraint document_versions_user_id_id_key unique (user_id, id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'document_signature_requests_user_id_id_key') then
    alter table public.document_signature_requests add constraint document_signature_requests_user_id_id_key unique (user_id, id);
  end if;
end $$;


-- ── 2 · the template (BUSINESS MEANING, not the artifact) ────────────────────
-- ⭐ A template says what an agreement MEANS and how it should be asked for. The
-- rendered, sent, signed artifact is a Session 74 document version. Keeping the
-- two apart is what lets an owner fix a typo in next month's agreements without
-- touching anything a customer already signed.
--
-- `contract_type` is FREE TEXT on purpose. EdgeHQ serves whatever trade the owner
-- runs; an enum of landscaping paperwork would be wrong for an electrician on day
-- one, and a fixed five-word list would be wrong for the first owner who needs a
-- sixth word.
create table if not exists public.contract_templates (
  "id"          uuid default gen_random_uuid() not null,
  "user_id"     uuid not null,

  "name"        text not null,
  "contract_type" text,
  "body"        text not null,

  -- Default term behaviour. ⛔ NOT hardcoded to a year, a season or a month:
  -- null term_months with open_ended false means "the owner decides per contract".
  "term_months" integer,
  "open_ended"  boolean default false not null,
  "renewal_notice_days" integer,

  -- What signing this template should mean. `purpose` is Session 74's closed
  -- vocabulary and is NOT widened here — the CONTRACT TYPE carries the business
  -- kind, while purpose stays "what kind of acknowledgement is this".
  "signature_required" boolean default true not null,
  "purpose"     text default 'customer_acknowledgement' not null,
  "statement"   text not null,

  "archived_at" timestamp with time zone,
  "created_at"  timestamp with time zone default now() not null,
  "updated_at"  timestamp with time zone default now() not null,

  constraint contract_templates_pkey primary key (id),
  constraint contract_templates_user_id_fkey
    foreign key (user_id) references auth.users(id) on delete cascade,
  -- Lets a contract weld to its template by tenant.
  constraint contract_templates_id_user_key unique (id, user_id),

  constraint contract_templates_name_check check (char_length(name) between 1 and 160),
  constraint contract_templates_type_check
    check (contract_type is null or char_length(contract_type) between 1 and 60),
  constraint contract_templates_body_check check (char_length(body) between 1 and 100000),
  constraint contract_templates_statement_check check (char_length(statement) between 10 and 1000),
  constraint contract_templates_term_check check (term_months is null or term_months between 1 and 600),
  constraint contract_templates_notice_check
    check (renewal_notice_days is null or renewal_notice_days between 0 and 365),
  -- An open-ended template cannot also carry a fixed term: two different answers
  -- to "when does this end?" means the UI has to pick one silently.
  constraint contract_templates_open_ended_check
    check (not open_ended or term_months is null),
  constraint contract_templates_purpose_check
    check (purpose in ('work_authorization', 'customer_acknowledgement', 'completion_acknowledgement'))
);

comment on table public.contract_templates is
  'Reusable agreement definitions: business meaning, default term behaviour and signature requirement. The rendered artifact is always a Session 74 document version — this table never stores a sent or signed document.';
comment on column public.contract_templates.contract_type is
  'Free text (Service Agreement, Maintenance Agreement, Project Contract, Terms Acknowledgement, …). Deliberately not an enum: EdgeHQ is universal across trades.';

create index if not exists contract_templates_user_id_idx
  on public.contract_templates (user_id) where archived_at is null;


-- ── 3 · the contract (the relationship and its lifecycle) ────────────────────
-- ⭐⭐ STATUS IS STORED; EXPIRY IS DERIVED. The stored statuses are the ones a
-- human DECIDES: draft, sent, active, terminated, superseded. "Expired" is not a
-- decision — it is the calendar passing end_date, so it is computed on every read
-- (see contract_is_expired). A stored expired flag would be wrong the morning
-- after it was written and would need a cron to stay honest; this codebase has
-- already learned that a stored status can outlive the truth it describes.
--
-- ⭐ customer_id is NOT NULL. An agreement with nobody is not an agreement. Every
-- other link is optional, and every one of them is tenant-welded.
create table if not exists public.contracts (
  "id"          uuid default gen_random_uuid() not null,
  "user_id"     uuid not null,

  -- Provenance, frozen. `template_name` is COPIED at creation exactly the way
  -- job_forms copies template_name: renaming or deleting the template later must
  -- never restate what this contract was made from.
  "template_id"   uuid,
  "template_name" text,

  -- WHO. Required.
  "customer_id" uuid not null,

  -- WHERE / WHAT IT RELATES TO. All optional, all welded to the same tenant.
  -- ⭐ job_recurrence_id means "this agreement GOVERNS that series". It does not
  -- make the contract a scheduler, and the contract's own dates are never read
  -- from it.
  "property_id"        uuid,
  "job_id"             uuid,
  "quote_id"           uuid,
  "job_recurrence_id"  uuid,
  "service_template_id" uuid,

  "title"         text not null,
  "contract_type" text,

  "status"        text default 'draft' not null,

  -- Signature requirement, COPIED from the template at creation so a later
  -- template edit cannot change what an already-sent contract required.
  "signature_required" boolean default true not null,

  -- ── TERM. Explicit, and independent of any recurrence. ────────────────────
  -- end_date NULL means OPEN-ENDED. ⛔ No annual default, no seasonal dates, and
  -- no assumption that a monthly-billed agreement implies monthly visits.
  "effective_date" date,
  "end_date"       date,
  "renewal_notice_days" integer,

  -- ── The Session 74 artifact this contract was sent/signed as. ─────────────
  "document_id"          uuid,
  "document_version_id"  uuid,
  "signature_request_id" uuid,

  "sent_at"        timestamp with time zone,
  "activated_at"   timestamp with time zone,
  "terminated_at"  timestamp with time zone,
  "termination_reason" text,
  -- Replacement chain. The old contract is PRESERVED and points forward.
  "superseded_by_id" uuid,

  "created_by"  uuid,
  "created_at"  timestamp with time zone default now() not null,
  "updated_at"  timestamp with time zone default now() not null,

  constraint contracts_pkey primary key (id),
  constraint contracts_user_id_fkey
    foreign key (user_id) references auth.users(id) on delete cascade,
  constraint contracts_user_id_id_key unique (user_id, id),

  -- ⭐ EVERY LINK IS A TENANT WELD. Note the column ORDER differs per parent
  -- because the existing composite uniques differ — each pair below matches its
  -- parent's real key, not a guessed one.
  constraint contracts_customer_same_tenant
    foreign key (user_id, customer_id) references public.customers(user_id, id) on delete cascade,
  constraint contracts_property_same_tenant
    foreign key (property_id, user_id) references public.properties(id, user_id) on delete set null (property_id),
  constraint contracts_job_same_tenant
    foreign key (job_id, user_id) references public.jobs(id, user_id) on delete set null (job_id),
  constraint contracts_quote_same_tenant
    foreign key (user_id, quote_id) references public.quotes(user_id, id) on delete set null (quote_id),
  constraint contracts_recurrence_same_tenant
    foreign key (user_id, job_recurrence_id) references public.job_recurrences(user_id, id) on delete set null (job_recurrence_id),
  constraint contracts_service_template_same_tenant
    foreign key (service_template_id, user_id) references public.service_templates(id, user_id) on delete set null (service_template_id),
  constraint contracts_template_same_tenant
    foreign key (template_id, user_id) references public.contract_templates(id, user_id) on delete set null (template_id),
  constraint contracts_superseded_same_tenant
    foreign key (user_id, superseded_by_id) references public.contracts(user_id, id) on delete set null (superseded_by_id),

  -- ⭐ The Session 74 welds. A foreign tenant's document can never be linked.
  constraint contracts_document_same_tenant
    foreign key (user_id, document_id) references public.documents(user_id, id) on delete set null (document_id),
  -- ⛔ RESTRICT, not SET NULL: the signed version IS the evidence. Losing the
  -- pointer would leave a signed contract that cannot say what was signed.
  constraint contracts_version_same_tenant
    foreign key (user_id, document_version_id) references public.document_versions(user_id, id) on delete restrict,
  constraint contracts_request_same_tenant
    foreign key (user_id, signature_request_id) references public.document_signature_requests(user_id, id) on delete restrict,

  constraint contracts_title_check check (char_length(title) between 1 and 200),
  constraint contracts_type_check
    check (contract_type is null or char_length(contract_type) between 1 and 60),
  constraint contracts_status_check
    check (status in ('draft', 'sent', 'active', 'terminated', 'superseded')),
  constraint contracts_notice_check
    check (renewal_notice_days is null or renewal_notice_days between 0 and 365),
  constraint contracts_reason_check
    check (termination_reason is null or char_length(termination_reason) between 1 and 500),

  -- ⭐ A term that ends before it starts is not a term.
  constraint contracts_term_order_check
    check (end_date is null or effective_date is null or end_date >= effective_date),

  -- ⭐ THE STATUS/EVIDENCE PAIRS. Each of these makes a status mean something
  -- the row can actually prove.
  --   sent       → there is an artifact to have sent
  --   active     → it started on a date somebody chose
  --   terminated → there is a moment it ended
  --   superseded → there is a successor to point at
  constraint contracts_sent_needs_artifact
    check (status not in ('sent', 'active') or (document_id is not null and document_version_id is not null)),
  -- ⭐⭐ THE TERM IS DECIDED BEFORE SENDING, NOT AFTER SIGNING. The rendered
  -- document states "Effective: …", so the date is part of what the customer
  -- actually agreed to — setting it afterwards would mean the signed page and
  -- the record disagreed. It also removes a genuine deadlock the guard caught:
  -- if a term could first be set at ACTIVATION, activation would have to edit
  -- the term of an already-signed contract, which the freeze below (correctly)
  -- refuses — leaving a signed contract that could never become active.
  constraint contracts_sent_needs_term
    check (status not in ('sent', 'active') or effective_date is not null),
  constraint contracts_terminated_needs_stamp
    check ((status = 'terminated') = (terminated_at is not null)),
  constraint contracts_superseded_needs_successor
    check (status <> 'superseded' or superseded_by_id is not null),
  -- A contract cannot supersede itself.
  constraint contracts_not_self_superseded
    check (superseded_by_id is null or superseded_by_id <> id)
);

comment on table public.contracts is
  'The commercial agreement: who it is with, what it relates to, its term, and its lifecycle. The rendered artifact and the signature live in Session 74. A contract may reference a job_recurrence; it never schedules anything.';
comment on column public.contracts.end_date is
  'NULL means OPEN-ENDED. There is no annual or seasonal default anywhere in this domain.';
comment on column public.contracts.job_recurrence_id is
  'Optional: "this agreement governs that operational series". The recurrence is NOT the agreement, and contract dates are never derived from it.';
comment on column public.contracts.status is
  'draft | sent | active | terminated | superseded. Expiry is NOT stored — it is derived from end_date on every read (contract_is_expired).';

create index if not exists contracts_user_id_idx on public.contracts (user_id);
create index if not exists contracts_customer_idx on public.contracts (user_id, customer_id);
create index if not exists contracts_status_idx on public.contracts (user_id, status);
create index if not exists contracts_end_date_idx on public.contracts (user_id, end_date)
  where end_date is not null and status = 'active';
create index if not exists contracts_recurrence_idx on public.contracts (job_recurrence_id)
  where job_recurrence_id is not null;
create index if not exists contracts_document_idx on public.contracts (document_id)
  where document_id is not null;


-- ── 4 · derived expiry — the one definition ──────────────────────────────────
-- ⭐ ONE READER. The app has a matching pure function (lib/contracts.ts), and
-- verify:contracts pins the two to the same rule. Anything that needs to know
-- whether an agreement has lapsed asks here, so no two surfaces can disagree.
create or replace function public.contract_is_expired(
  p_status text, p_end_date date, p_today date default current_date
)
returns boolean
language sql
immutable
as $function$
  -- Only a LIVE agreement can lapse. A draft was never in force; a terminated or
  -- superseded one already has a truer word for what happened to it.
  select p_status = 'active' and p_end_date is not null and p_end_date < p_today;
$function$;

comment on function public.contract_is_expired(text, date, date) is
  'THE definition of an expired contract. Expiry is derived, never stored: a stored flag is wrong the morning after it is written.';


-- ── 5 · lifecycle and immutability ───────────────────────────────────────────
-- ⭐⭐ SIGNED TRUTH IS NOT EDITABLE. Once a contract has been sent, the artifact
-- it points at is frozen; once it is signed, so is the agreement it represents.
-- Session 74 already refuses to let the bytes under a signature change; this
-- trigger refuses to let the contract point somewhere else instead, which is the
-- same lie told one level up.
create or replace function public.contracts_guard_update()
returns trigger
language plpgsql
as $function$
declare
  v_signed boolean;
begin
  -- Is this contract's acceptance condition already satisfied?
  v_signed := old.signature_request_id is not null and exists (
    select 1 from public.document_signatures s where s.request_id = old.signature_request_id
  );

  -- ⛔ The tenant never moves.
  if new.user_id is distinct from old.user_id then
    raise exception 'A contract cannot change hands between businesses.';
  end if;

  -- ⛔ Once sent, the artifact is fixed. Re-pointing a sent contract at a
  -- different document or version would silently restate what was sent.
  if old.status in ('sent', 'active', 'terminated', 'superseded') then
    if new.document_id is distinct from old.document_id then
      raise exception 'This contract has already been sent. Its document cannot be swapped — supersede it with a new contract instead.';
    end if;
    if new.document_version_id is distinct from old.document_version_id then
      raise exception 'This contract has already been sent. The version it points at is the record of what was sent.';
    end if;
    if new.signature_request_id is distinct from old.signature_request_id then
      raise exception 'This contract has already been sent. Its signature request cannot be replaced.';
    end if;
  end if;

  -- ⛔ Once signed, the AGREEMENT is fixed too: who it is with, what it says it
  -- is, and the term that was agreed. Changing terms after signature is a new
  -- contract, which is what supersede is for.
  if v_signed then
    if new.customer_id is distinct from old.customer_id then
      raise exception 'A signed contract cannot be moved to a different customer.';
    end if;
    if new.effective_date is distinct from old.effective_date
       or new.end_date is distinct from old.end_date then
      raise exception 'The term of a signed contract cannot be edited. Supersede it with a replacement contract.';
    end if;
    if new.title is distinct from old.title or new.contract_type is distinct from old.contract_type then
      raise exception 'A signed contract cannot be retitled.';
    end if;
    if new.template_id is distinct from old.template_id
       or new.template_name is distinct from old.template_name then
      raise exception 'A signed contract keeps the template it was made from.';
    end if;
    if new.signature_required is distinct from old.signature_required then
      raise exception 'A signed contract already met its signature requirement.';
    end if;
  end if;

  -- ⛔ Terminated and superseded are ENDINGS. Nothing reopens.
  if old.status in ('terminated', 'superseded') and new.status is distinct from old.status then
    raise exception 'A % contract cannot be reopened.', old.status;
  end if;

  -- ⭐⭐ ACTIVE MEANS THE ACCEPTANCE CONDITION IS SATISFIED. This is the whole
  -- promise of the word. If the contract requires a signature, one must exist —
  -- and it must be a signature against the version this contract actually sent,
  -- not merely any signature the customer ever gave.
  if new.status = 'active' and old.status <> 'active' then
    if new.signature_required then
      if new.signature_request_id is null then
        raise exception 'This contract requires a signature, so it cannot be activated before one is requested.';
      end if;
      if not exists (
        select 1 from public.document_signatures s
         where s.request_id = new.signature_request_id
           and s.version_id = new.document_version_id
      ) then
        raise exception 'This contract requires a signature. It becomes active when the customer signs.';
      end if;
    end if;
  end if;

  new.updated_at := now();
  return new;
end;
$function$;

create trigger trg_contracts_guard_update
  before update on public.contracts
  for each row execute function public.contracts_guard_update();

-- ⛔ A signed contract is never deleted. Archiving/terminating keeps the record;
-- deletion would destroy evidence the business may need to stand behind.
create or replace function public.contracts_guard_delete()
returns trigger
language plpgsql
as $function$
begin
  if old.signature_request_id is not null and exists (
    select 1 from public.document_signatures s where s.request_id = old.signature_request_id
  ) then
    raise exception 'A signed contract cannot be deleted. Terminate it, or supersede it with a replacement.';
  end if;
  return old;
end;
$function$;

create trigger trg_contracts_guard_delete
  before delete on public.contracts
  for each row execute function public.contracts_guard_delete();


-- ── 6 · row level security ───────────────────────────────────────────────────
-- Owner-only, by tenant. ⛔ There is deliberately NO worker policy: a crew member
-- has no business reading the commercial terms of an agreement, and Session 74
-- already gives them the only document access they need (job-scoped, via RPC).
-- ⛔ There is no portal policy either — the customer sees the DOCUMENT through
-- Session 74's portal projection, never a contract row.
alter table public.contract_templates enable row level security;
alter table public.contracts enable row level security;

create policy "contract_templates: select own" on public.contract_templates
  for select to authenticated using (auth.uid() = user_id);
create policy "contract_templates: insert own" on public.contract_templates
  for insert to authenticated with check (auth.uid() = user_id);
create policy "contract_templates: update own" on public.contract_templates
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "contract_templates: delete own" on public.contract_templates
  for delete to authenticated using (auth.uid() = user_id);

create policy "contracts: select own" on public.contracts
  for select to authenticated using (auth.uid() = user_id);
create policy "contracts: insert own" on public.contracts
  for insert to authenticated with check (auth.uid() = user_id);
create policy "contracts: update own" on public.contracts
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "contracts: delete own" on public.contracts
  for delete to authenticated using (auth.uid() = user_id);

-- ⛔ anon gets nothing. Supabase grants DML to anon by default at table-create
-- time, which is how a previous session shipped an openly writable table.
revoke all on public.contract_templates from anon;
revoke all on public.contracts from anon;


-- ── 7 · audit ────────────────────────────────────────────────────────────────
-- ⭐ SESSION 68'S ENGINE, NOT A SECOND ONE. No audit table, no audit function and
-- no history projection is defined here.
-- ⛔ NOT IN ANY PAYLOAD: storage paths, signature images, or template bodies.
-- Audit DESCRIBES the mutation; `contracts` stays authoritative.
create or replace function public.audit_contracts()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if tg_op = 'INSERT' then
    perform public.audit_log(new.user_id, 'contract_created', 'contract', new.id,
      new.title, new.customer_id, null,
      jsonb_build_object('status', new.status, 'contract_type', new.contract_type));
    return new;
  end if;

  if tg_op = 'DELETE' then
    perform public.audit_log(old.user_id, 'contract_deleted', 'contract', old.id,
      old.title, old.customer_id,
      jsonb_build_object('status', old.status), null);
    return old;
  end if;

  if new.status is distinct from old.status then
    perform public.audit_log(new.user_id,
      case new.status
        when 'sent' then 'contract_sent'
        when 'active' then 'contract_activated'
        when 'terminated' then 'contract_terminated'
        when 'superseded' then 'contract_superseded'
        else 'contract_status_changed'
      end,
      'contract', new.id, new.title, new.customer_id,
      jsonb_build_object('status', old.status),
      jsonb_build_object('status', new.status));
  elsif new.effective_date is distinct from old.effective_date
     or new.end_date is distinct from old.end_date then
    perform public.audit_log(new.user_id, 'contract_term_changed', 'contract', new.id,
      new.title, new.customer_id,
      jsonb_build_object('effective_date', old.effective_date, 'end_date', old.end_date),
      jsonb_build_object('effective_date', new.effective_date, 'end_date', new.end_date));
  end if;
  return new;
end;
$function$;

create trigger trg_audit_contracts
  after insert or update or delete on public.contracts
  for each row execute function public.audit_contracts();


-- ── 8 · grants ───────────────────────────────────────────────────────────────
revoke all on function public.contract_is_expired(text, date, date) from public, anon, authenticated, service_role;
grant execute on function public.contract_is_expired(text, date, date) to authenticated;
grant execute on function public.contract_is_expired(text, date, date) to service_role;
