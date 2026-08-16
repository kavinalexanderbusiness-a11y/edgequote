-- ═══════════════════════════════════════════════════════════════════════════
-- DOCUMENTS + SIGNATURES V1 — pending migration (Session 74)
--
-- ⚠️ LIFECYCLE OF THIS FILE — read before touching:
--   This file is NOT in the apply path (supabase/migrations/) and NOT archive.
--   It is the documents schema, waiting for production. The intended flow is the
--   one change-orders used and Session 68 restated:
--     1. apply this file to production via MCP apply_migration
--        (MCP assigns the version; name it documents_signatures_v1),
--     2. npm run schema:contract && npm run schema:baseline
--        (the objects fold into the regenerated baseline),
--     3. DELETE this file in the same commit — once the baseline carries
--        `documents`, a second copy here is the retired-CANONICAL-file mistake.
--   verify:documents §1 pins exactly that lifecycle: it fails if this file and
--   the baseline both define `documents`, and if neither does.
--
--   ⭐ Living in pending/ is also why this change has NO migration version yet.
--   Sessions 65 and 69 both minted `20260815120000_*.sql` and now collide; a
--   pending file cannot collide with anything because MCP assigns the version at
--   apply time, against production's real ledger. Reconcile that collision (and
--   this file's eventual version) against the LATEST origin/main before landing.
--
-- WHAT THIS IS:
--   Durable files attached to the records a service business already operates
--   on, plus a plain acknowledgement signature. Work authorizations, permits,
--   inspection reports, warranties, site documents, completion acknowledgements,
--   customer-provided PDFs, equipment documentation.
--
--   It is NOT DocuSign, NOT Drive, NOT a PDF editor. There is no editing of file
--   content anywhere in this schema — a file arrives whole and leaves whole.
--
-- ⛔ WHAT THIS DELIBERATELY IS NOT (one engine per responsibility):
--   job execution data  → Session 69 Forms owns checklists, per-field responses
--                         and their photos. Documents owns durable FILES and
--                         signed ACKNOWLEDGEMENTS. Nothing here reads or writes
--                         form_templates / job_forms / job_form_responses, and
--                         no table here carries a "field" or "answer" column.
--                         THE SEAM: when Forms lands, a form that must produce a
--                         durable artefact emits a `documents` row pointing at a
--                         rendered file — it never stores answers here, and this
--                         schema never learns what a checklist item is.
--   field signatures    → also Forms' eventual territory (crew, on the job, mid
--                         checklist). V1 signature sources are 'portal' (the
--                         customer signs remotely) and 'dashboard' (the owner
--                         captures an in-person acknowledgement). Crew sessions
--                         get READ-ONLY document access here — deliberately no
--                         crew signing RPC exists to compete with Forms later.
--   generated quote/invoice PDFs → quotes and invoices already render their own
--                         canonical documents on demand. Duplicating them as
--                         `documents` rows would create a second, staler copy of
--                         a figure the ledger owns. Deliberately not linked.
--   audit trail         → Session 68 owns it, and it has NOT landed. There is
--                         deliberately NO audit call in this file, not even a
--                         conditional one: a speculative call to a function that
--                         does not exist is a guess about an interface nobody
--                         has published yet. Instead EVERY authoritative fact is
--                         kept inside this domain, where it is the source of
--                         truth rather than a description of one:
--                           uploaded by      → document_versions.uploaded_by
--                           uploaded at      → document_versions.uploaded_at
--                           visibility       → documents.visibility
--                           signer identity  → document_signatures.signer_name
--                                              + .customer_id (token-resolved)
--                           signed at        → document_signatures.signed_at
--                           version signed   → document_signatures.version_id
--                           statement agreed → document_signatures.statement
--                           archive state    → documents.archived_at
--                         ⭐ AFTER SESSION 68 LANDS: add document uploaded /
--                         shared / signed / visibility changed / archived /
--                         version-replaced events through its REAL interface.
--                         Audit will DESCRIBE those mutations; document_signatures
--                         stays authoritative. Never copy signature truth into an
--                         audit row, and never write a signature IMAGE or its
--                         bytes into audit metadata.
--
-- ⛔ NOT A QUALIFIED ELECTRONIC SIGNATURE. This captures an acknowledgement:
--   a named person, at a known time, agreeing to a stated sentence, against one
--   frozen version of one file, from a known surface. It makes no claim of
--   eIDAS/ESIGN/UETA conformance, no identity proofing beyond the portal token
--   the customer already holds, and no certificate authority is involved. The
--   product must never market it as one. What it IS good for is the ordinary
--   commercial record a service business actually needs: proof that this
--   customer saw THIS document and agreed to THIS sentence.
-- ═══════════════════════════════════════════════════════════════════════════


-- ── 1 · private storage ──────────────────────────────────────────────────────
-- Reuses the canonical private-bucket shape (equipment-docs / expense-receipts /
-- crew-media), NOT a new file subsystem: private bucket + owner-scoped first
-- path segment + short-lived signed URLs minted server-side.
--
-- ⛔ job-photos, booking-uploads, branding and lead-uploads are PUBLIC buckets.
-- A permit, a warranty or a signature image must never land in one — a public
-- object URL is guessable-forever and outlives every check in this file.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types, avif_autodetection)
values (
  'documents', 'documents', false, 26214400,
  array[
    'application/pdf',
    'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
    'text/plain',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ]::text[],
  false
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Owner-scoped folder rule, identical to equipment-docs: the first path segment
-- IS the owning tenant's uid, so one tenant's signed-in session cannot read,
-- overwrite or delete another tenant's object even with a guessed path.
--
-- ⚠️ There is deliberately NO anon policy. The customer portal is anonymous
-- (a token, not a JWT) and therefore reaches NOTHING in storage directly. Portal
-- and crew file access is minted server-side, by path the DATABASE returned,
-- after a SECURITY DEFINER function proved the caller may have it.

drop policy if exists "documents: read own" on storage."objects";
create policy "documents: read own" on storage."objects" as permissive for select to authenticated
  using (((bucket_id = 'documents'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)));

drop policy if exists "documents: insert own" on storage."objects";
create policy "documents: insert own" on storage."objects" as permissive for insert to authenticated
  with check (((bucket_id = 'documents'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)));

drop policy if exists "documents: update own" on storage."objects";
create policy "documents: update own" on storage."objects" as permissive for update to authenticated
  using (((bucket_id = 'documents'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)));

drop policy if exists "documents: delete own" on storage."objects";
create policy "documents: delete own" on storage."objects" as permissive for delete to authenticated
  using (((bucket_id = 'documents'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)));


-- ── 2 · the document ─────────────────────────────────────────────────────────
-- ⭐ NOT POLYMORPHIC. Four nullable typed FKs with a CHECK that exactly one is
-- set. This is the existing attachment architecture's answer (equipment_docs →
-- equipment, job_photos → jobs): a REAL foreign key, so a document cannot point
-- at a row that never existed, and cascade actually happens when the parent
-- dies. An (entity_type text, entity_id uuid) pair would buy generality at the
-- price of every one of those guarantees — and the referential integrity is the
-- whole reason a permit attached to a site is trustworthy a year later.

create table if not exists public.documents (
  "id"           uuid default gen_random_uuid() not null,
  "user_id"      uuid not null,

  -- What a human calls it, and how it is filed. `category` is free text on
  -- purpose: EdgeHQ serves whatever trade the owner runs, and an enum of
  -- lawn-care paperwork would be wrong for an electrician on day one.
  "name"         text not null,
  "category"     text,

  -- Exactly one of these. See documents_one_entity.
  "customer_id"  uuid,
  "property_id"  uuid,
  "job_id"       uuid,
  "equipment_id" uuid,

  -- ⭐ DEFAULT SAFE. A document nobody has deliberately shared is internal.
  --   internal — the tenant owner only
  --   worker   — owner + the crew assigned to the linked visit (job docs only)
  --   customer — owner + the customer this document resolves to
  "visibility"   text default 'internal' not null,

  "archived_at"  timestamp with time zone,
  "created_by"   uuid,
  "created_at"   timestamp with time zone default now() not null,
  "updated_at"   timestamp with time zone default now() not null,

  constraint documents_pkey primary key (id),
  constraint documents_user_id_fkey
    foreign key (user_id) references auth.users(id) on delete cascade,
  constraint documents_customer_id_fkey
    foreign key (customer_id) references public.customers(id) on delete cascade,
  constraint documents_property_id_fkey
    foreign key (property_id) references public.properties(id) on delete cascade,
  constraint documents_job_id_fkey
    foreign key (job_id) references public.jobs(id) on delete cascade,
  constraint documents_equipment_id_fkey
    foreign key (equipment_id) references public.equipment(id) on delete cascade,

  constraint documents_name_check check (char_length(name) between 1 and 200),
  constraint documents_category_check check (category is null or char_length(category) between 1 and 40),
  constraint documents_visibility_check check (visibility in ('internal', 'worker', 'customer')),

  -- One document, one home. Not zero (an unattached file is a file nobody can
  -- find), not two (two homes means two answers to "whose is this?").
  constraint documents_one_entity check (
    (customer_id is not null)::int + (property_id is not null)::int
    + (job_id is not null)::int + (equipment_id is not null)::int = 1
  ),

  -- ⭐ Worker visibility means "connected to authorized work", and the only
  -- thing a crew is authorized against is a VISIT. A customer- or equipment-
  -- linked document has no visit to authorize through, so 'worker' on one would
  -- be a promise the read path cannot keep — it would simply never appear, and
  -- an owner would believe they had shared something they had not.
  constraint documents_worker_needs_job check (
    visibility <> 'worker' or job_id is not null
  ),

  -- ⭐ Equipment belongs to the BUSINESS, not to a customer (public.equipment
  -- has no customer_id). So an equipment document resolves to no customer, and
  -- 'customer' visibility on one is unreachable by construction. Refusing it
  -- here is the honest answer; silently accepting it would be a share that
  -- never shares. A warranty a customer must see belongs on their job or site.
  constraint documents_equipment_not_customer check (
    visibility <> 'customer' or equipment_id is null
  )
);

comment on table public.documents is
  'Durable files attached to a customer, service location, visit or equipment. Content lives in document_versions and is immutable once signed; this row carries identity, filing, visibility and archive state. Documents owns durable files + signed acknowledgements; Session 69 Forms owns job execution data.';
comment on column public.documents.visibility is
  'internal (default, owner only) | worker (owner + assigned crew, job-linked only) | customer (owner + the resolved customer). Default is deliberately the safe one.';
comment on column public.documents.archived_at is
  'Archived documents leave the portal and the crew surface immediately, and stay readable to the owner forever. Archiving is NOT deletion: a signed document must remain retrievable.';

create index if not exists documents_user_id_idx on public.documents (user_id);
create index if not exists documents_customer_id_idx on public.documents (customer_id) where customer_id is not null;
create index if not exists documents_property_id_idx on public.documents (property_id) where property_id is not null;
create index if not exists documents_job_id_idx on public.documents (job_id) where job_id is not null;
create index if not exists documents_equipment_id_idx on public.documents (equipment_id) where equipment_id is not null;
-- The portal and crew reads both filter on visibility + not archived.
create index if not exists documents_shared_idx on public.documents (user_id, visibility)
  where archived_at is null;


-- ── 3 · the version (immutable content) ──────────────────────────────────────
-- ⭐ The CONTENT POINTER IS THE VERSION. A document's file is never updated in
-- place; a replacement is a new row with the next version_no. That is what makes
-- "the thing you signed" a stable, nameable object a year later.
--
-- There is deliberately no documents.current_version_id: the current version is
-- the highest version_no, derived, so it cannot drift out of sync with the rows
-- it points at. A signature pins its version_id explicitly and never asks what
-- "current" means.

create table if not exists public.document_versions (
  "id"           uuid default gen_random_uuid() not null,
  "document_id"  uuid not null,
  "user_id"      uuid not null,
  "version_no"   integer not null,

  -- Path inside the PRIVATE 'documents' bucket. Always <user_id>/… — the
  -- storage policies above enforce it, lib/documents.ts is the only thing that
  -- builds it, and no client ever supplies one to a read path.
  "storage_path" text not null,
  "file_name"    text not null,
  "mime"         text,
  "size_bytes"   bigint,

  "uploaded_by"  uuid,
  "uploaded_at"  timestamp with time zone default now() not null,
  -- Why this version exists. Set when a signed version is superseded.
  "replaced_note" text,

  constraint document_versions_pkey primary key (id),
  constraint document_versions_document_id_fkey
    foreign key (document_id) references public.documents(id) on delete cascade,
  constraint document_versions_user_id_fkey
    foreign key (user_id) references auth.users(id) on delete cascade,
  constraint document_versions_version_no_check check (version_no >= 1),
  constraint document_versions_file_name_check check (char_length(file_name) between 1 and 260),
  constraint document_versions_storage_path_check check (char_length(storage_path) between 1 and 1024),
  constraint document_versions_size_check check (size_bytes is null or size_bytes >= 0),
  constraint document_versions_unique_no unique (document_id, version_no),
  -- One object, one version row. Two rows sharing a path would let deleting one
  -- version destroy another version's bytes.
  constraint document_versions_unique_path unique (storage_path)
);

comment on table public.document_versions is
  'Immutable content pointers. A version row is never UPDATEd (trigger-refused) and cannot be DELETEd once a signature references it. Replacing a document''s content means inserting the next version_no, never rewriting bytes under a signature.';

create index if not exists document_versions_document_id_idx on public.document_versions (document_id, version_no desc);
create index if not exists document_versions_user_id_idx on public.document_versions (user_id);


-- ── 4 · the request (the sentence being agreed to) ───────────────────────────
-- A signature without a STATEMENT is a scribble. The statement is captured here,
-- at request time, and copied onto the signature at signing time so the signed
-- record carries the exact words even if the request is later cancelled.

create table if not exists public.document_signature_requests (
  "id"           uuid default gen_random_uuid() not null,
  "user_id"      uuid not null,
  "document_id"  uuid not null,
  -- ⭐ The version is PINNED at request time. If the owner uploads a new version
  -- before the customer signs, the request no longer matches the current version
  -- and the sign path refuses it (see portal_sign_document). Nobody is ever
  -- asked to agree to one file and recorded as agreeing to another.
  "version_id"   uuid not null,
  "customer_id"  uuid not null,

  -- The meaning. Shown verbatim above the signature control on every surface.
  "statement"    text not null,
  -- What kind of acknowledgement this is. V1 keeps this to the three cases the
  -- product can honestly describe.
  "purpose"      text not null,

  "requested_by" uuid,
  "requested_at" timestamp with time zone default now() not null,
  "cancelled_at" timestamp with time zone,

  constraint document_signature_requests_pkey primary key (id),
  constraint document_signature_requests_user_id_fkey
    foreign key (user_id) references auth.users(id) on delete cascade,
  constraint document_signature_requests_document_id_fkey
    foreign key (document_id) references public.documents(id) on delete cascade,
  constraint document_signature_requests_version_id_fkey
    foreign key (version_id) references public.document_versions(id) on delete cascade,
  constraint document_signature_requests_customer_id_fkey
    foreign key (customer_id) references public.customers(id) on delete cascade,
  constraint document_signature_requests_statement_check
    check (char_length(statement) between 10 and 1000),
  constraint document_signature_requests_purpose_check
    check (purpose in ('work_authorization', 'customer_acknowledgement', 'completion_acknowledgement'))
);

comment on table public.document_signature_requests is
  'The ask: this customer, this pinned version, this sentence. V1 purposes are the three a service business can state plainly — work authorization, customer acknowledgement, completion acknowledgement.';

create index if not exists document_signature_requests_user_id_idx on public.document_signature_requests (user_id);
create index if not exists document_signature_requests_document_id_idx on public.document_signature_requests (document_id);
create index if not exists document_signature_requests_customer_id_idx on public.document_signature_requests (customer_id);

-- ⭐ REPLAY DEFENCE, PART 1. At most ONE open request per document. Without this
-- a caller could hold two pending request ids for the same file and satisfy both
-- with one act of consent.
create unique index if not exists document_signature_requests_one_open
  on public.document_signature_requests (document_id)
  where cancelled_at is null;


-- ── 5 · the signature (the act) ──────────────────────────────────────────────

create table if not exists public.document_signatures (
  "id"           uuid default gen_random_uuid() not null,
  "user_id"      uuid not null,
  "request_id"   uuid not null,
  "document_id"  uuid not null,
  "version_id"   uuid not null,

  -- ⭐ WHO, twice, on purpose:
  --   customer_id — authoritative. Resolved from the portal token by the
  --                 database, never accepted from the client. This is the
  --                 identity the record actually rests on.
  --   signer_name — what the person typed/what the owner recorded. A display
  --                 identity. It is evidence of intent, not proof of identity,
  --                 and the product must never present it as the latter.
  "customer_id"  uuid not null,
  "signer_name"  text not null,

  -- The sentence agreed to, copied from the request so the signed record is
  -- self-contained and survives the request being cancelled or reworded.
  "statement"    text not null,
  "purpose"      text not null,

  -- Where the act happened. 'portal' = the customer, through their own token.
  -- 'dashboard' = the owner recording an in-person acknowledgement, which the
  -- UI must label as owner-recorded rather than dress up as remote consent.
  "source"       text not null,

  -- ⛔ The drawn mark lives in the PRIVATE bucket, by path — never inline in
  -- this row, and never in any audit/meta jsonb anywhere in the product. It is
  -- biometric-adjacent personal data; it belongs behind the same signed-URL
  -- door as the document itself.
  "signature_path" text,

  "signed_at"    timestamp with time zone default now() not null,

  constraint document_signatures_pkey primary key (id),
  constraint document_signatures_user_id_fkey
    foreign key (user_id) references auth.users(id) on delete cascade,
  constraint document_signatures_request_id_fkey
    foreign key (request_id) references public.document_signature_requests(id) on delete restrict,
  constraint document_signatures_document_id_fkey
    foreign key (document_id) references public.documents(id) on delete cascade,
  -- ⛔ RESTRICT, not CASCADE: deleting the version a signature rests on would
  -- destroy the evidence. The version delete trigger refuses first with a clear
  -- message; this is the constraint that makes the refusal structural.
  constraint document_signatures_version_id_fkey
    foreign key (version_id) references public.document_versions(id) on delete restrict,
  constraint document_signatures_customer_id_fkey
    foreign key (customer_id) references public.customers(id) on delete cascade,
  constraint document_signatures_signer_name_check check (char_length(signer_name) between 1 and 120),
  constraint document_signatures_statement_check check (char_length(statement) between 10 and 1000),
  constraint document_signatures_source_check check (source in ('portal', 'dashboard')),
  constraint document_signatures_purpose_check
    check (purpose in ('work_authorization', 'customer_acknowledgement', 'completion_acknowledgement')),

  -- ⭐ REPLAY DEFENCE, PART 2. One request can be satisfied exactly once. A
  -- replayed sign call — same token, same payload, sent twice — hits this
  -- unique constraint and is refused by the DATABASE, not by app-layer
  -- politeness that a retry or a double-tap could slip past.
  constraint document_signatures_one_per_request unique (request_id)
);

comment on table public.document_signatures is
  'The authoritative signature record: token-resolved customer, typed display name, the exact statement, the exact version, when, and from which surface. NOT a qualified electronic signature — an acknowledgement. Append-only (document_signatures_no_mutate).';
comment on column public.document_signatures.signature_path is
  'Path in the PRIVATE documents bucket. The drawn mark is never stored inline, never returned to a list view, and never written into audit metadata.';

create index if not exists document_signatures_user_id_idx on public.document_signatures (user_id);
create index if not exists document_signatures_document_id_idx on public.document_signatures (document_id);
create index if not exists document_signatures_customer_id_idx on public.document_signatures (customer_id);


-- ── 6 · immutability ─────────────────────────────────────────────────────────

-- 6a · a version's content pointer never changes -----------------------------
-- The whole promise of "you can trust what you signed" reduces to this trigger.
-- Note it refuses the swap even when the document is UNSIGNED: a version is an
-- immutable object by definition, and allowing pre-signature edits would mean
-- the rule depends on a race with the customer's tap.
create or replace function public.document_versions_immutable()
returns trigger
language plpgsql
as $function$
begin
  if tg_op = 'UPDATE' then
    if new.storage_path is distinct from old.storage_path
       or new.file_name  is distinct from old.file_name
       or new.mime       is distinct from old.mime
       or new.size_bytes is distinct from old.size_bytes
       or new.document_id is distinct from old.document_id
       or new.version_no  is distinct from old.version_no
       or new.user_id     is distinct from old.user_id
       or new.uploaded_by is distinct from old.uploaded_by
       or new.uploaded_at is distinct from old.uploaded_at then
      raise exception
        'A document version is immutable. Upload a new version instead of replacing the contents of version % (document %).',
        old.version_no, old.document_id
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  -- DELETE: refused outright once anything has been signed against it.
  if exists (select 1 from public.document_signatures s where s.version_id = old.id) then
    raise exception
      'Version % of document % has been signed and cannot be deleted. Archive the document instead — a signed record must stay retrievable.',
      old.version_no, old.document_id
      using errcode = 'check_violation';
  end if;
  return old;
end;
$function$;

drop trigger if exists trg_document_versions_immutable on public.document_versions;
create trigger trg_document_versions_immutable
  before update or delete on public.document_versions
  for each row execute function public.document_versions_immutable();

-- 6b · a signature is never edited or erased ---------------------------------
-- Append-only for EVERY role, service_role included. Nothing in the product has
-- a legitimate reason to rewrite an acknowledgement, and a path that could would
-- be the first thing worth attacking.
create or replace function public.document_signatures_no_mutate()
returns trigger
language plpgsql
as $function$
begin
  raise exception
    'document_signatures is append-only: a signature cannot be % once recorded.',
    lower(tg_op)
    using errcode = 'check_violation';
end;
$function$;

drop trigger if exists trg_document_signatures_no_mutate on public.document_signatures;
create trigger trg_document_signatures_no_mutate
  before update or delete on public.document_signatures
  for each row execute function public.document_signatures_no_mutate();

-- 6c · the next version number is assigned by the DATABASE --------------------
-- Two uploads racing would otherwise both read max()+1 in app code and collide
-- (or worse, silently overwrite). The unique constraint would catch it; this
-- makes the correct value the DEFAULT so callers never compute it at all.
create or replace function public.document_versions_assign_no()
returns trigger
language plpgsql
as $function$
begin
  if new.version_no is null then
    select coalesce(max(v.version_no), 0) + 1 into new.version_no
      from public.document_versions v where v.document_id = new.document_id;
  end if;
  -- The version's tenant is the DOCUMENT's tenant, always. A caller cannot file
  -- a version of somebody else's document into their own book.
  select d.user_id into new.user_id from public.documents d where d.id = new.document_id;
  if new.user_id is null then
    raise exception 'document % does not exist', new.document_id using errcode = 'foreign_key_violation';
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_document_versions_assign_no on public.document_versions;
create trigger trg_document_versions_assign_no
  before insert on public.document_versions
  for each row execute function public.document_versions_assign_no();

-- 6d · touch updated_at, and keep a signed document's entity/link honest ------
-- Renaming, refiling and re-sharing a document are all legitimate after signing
-- (an owner may correct a filing mistake). MOVING it to a different customer is
-- not: the signature names a customer, and re-parenting the document would make
-- that signature describe a record it was never given for.
create or replace function public.documents_guard_update()
returns trigger
language plpgsql
as $function$
begin
  new.updated_at := now();

  if (new.customer_id  is distinct from old.customer_id
   or new.property_id  is distinct from old.property_id
   or new.job_id       is distinct from old.job_id
   or new.equipment_id is distinct from old.equipment_id)
     and exists (select 1 from public.document_signatures s where s.document_id = old.id) then
    raise exception
      'Document % has been signed and cannot be re-attached to a different record. Upload it as a new document instead.',
      old.id
      using errcode = 'check_violation';
  end if;

  -- The tenant of a row never changes. Belt-and-braces against a crafted update
  -- that RLS would already refuse.
  if new.user_id is distinct from old.user_id then
    raise exception 'a document cannot change tenant' using errcode = 'check_violation';
  end if;

  return new;
end;
$function$;

drop trigger if exists trg_documents_guard_update on public.documents;
create trigger trg_documents_guard_update
  before update on public.documents
  for each row execute function public.documents_guard_update();

-- 6e · a signature request must be answerable ---------------------------------
-- Cross-row rules a CHECK cannot express: the pinned version must belong to the
-- document, and the customer must be the one the document actually resolves to.
-- Without the second rule an owner could request customer B's signature on
-- customer A's document, and B's portal would faithfully show it.
create or replace function public.document_signature_requests_guard()
returns trigger
language plpgsql
as $function$
declare
  v_doc record;
  v_resolved uuid;
begin
  select d.id, d.user_id, d.visibility, d.archived_at,
         d.customer_id, d.property_id, d.job_id, d.equipment_id
    into v_doc
    from public.documents d where d.id = new.document_id;

  if not found then
    raise exception 'document % does not exist', new.document_id using errcode = 'foreign_key_violation';
  end if;

  new.user_id := v_doc.user_id;

  if v_doc.archived_at is not null then
    raise exception 'document % is archived and cannot be sent for signature', new.document_id
      using errcode = 'check_violation';
  end if;

  -- A signature request the customer cannot see is a request nobody can answer.
  if v_doc.visibility <> 'customer' then
    raise exception
      'document % must be shared with the customer before a signature can be requested (visibility is %)',
      new.document_id, v_doc.visibility
      using errcode = 'check_violation';
  end if;

  if not exists (
    select 1 from public.document_versions v
     where v.id = new.version_id and v.document_id = new.document_id
  ) then
    raise exception 'version % does not belong to document %', new.version_id, new.document_id
      using errcode = 'check_violation';
  end if;

  v_resolved := public.document_customer_id(v_doc.customer_id, v_doc.property_id, v_doc.job_id);
  if v_resolved is null or v_resolved <> new.customer_id then
    raise exception
      'document % does not belong to customer % — a signature can only be requested from the customer the document resolves to',
      new.document_id, new.customer_id
      using errcode = 'check_violation';
  end if;

  return new;
end;
$function$;


-- ── 7 · who a document belongs to ────────────────────────────────────────────
-- ⭐ ONE resolver. Every customer-facing decision in this file — the portal
-- projection, the request guard, the sign path — calls THIS, so "which customer
-- is this document about?" has exactly one answer that can be reasoned about and
-- exactly one place to fix. Equipment resolves to NULL by design (see the
-- documents_equipment_not_customer constraint).
create or replace function public.document_customer_id(
  p_customer_id uuid, p_property_id uuid, p_job_id uuid
)
returns uuid
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select coalesce(
    p_customer_id,
    (select p.customer_id from public.properties p where p.id = p_property_id),
    (select j.customer_id from public.jobs j where j.id = p_job_id)
  );
$function$;

-- Now that the resolver exists, attach the request guard that calls it.
drop trigger if exists trg_document_signature_requests_guard on public.document_signature_requests;
create trigger trg_document_signature_requests_guard
  before insert on public.document_signature_requests
  for each row execute function public.document_signature_requests_guard();


-- ── 8 · row level security (owner surface) ───────────────────────────────────
-- The owner's dashboard talks to these tables directly, through RLS, exactly
-- like every other tenant table in this schema. Portal and crew do NOT: they
-- have no grant at all and reach documents only through the definer RPCs below.

alter table public.documents enable row level security;
alter table public.document_versions enable row level security;
alter table public.document_signature_requests enable row level security;
alter table public.document_signatures enable row level security;

drop policy if exists "documents: select own" on public.documents;
create policy "documents: select own" on public.documents as permissive for select to authenticated
  using ((auth.uid() = user_id));
drop policy if exists "documents: insert own" on public.documents;
create policy "documents: insert own" on public.documents as permissive for insert to authenticated
  with check ((auth.uid() = user_id));
drop policy if exists "documents: update own" on public.documents;
create policy "documents: update own" on public.documents as permissive for update to authenticated
  using ((auth.uid() = user_id)) with check ((auth.uid() = user_id));
drop policy if exists "documents: delete own" on public.documents;
create policy "documents: delete own" on public.documents as permissive for delete to authenticated
  using ((auth.uid() = user_id));

drop policy if exists "document_versions: select own" on public.document_versions;
create policy "document_versions: select own" on public.document_versions as permissive for select to authenticated
  using ((auth.uid() = user_id));
drop policy if exists "document_versions: insert own" on public.document_versions;
create policy "document_versions: insert own" on public.document_versions as permissive for insert to authenticated
  with check ((auth.uid() = (select d.user_id from public.documents d where d.id = document_id)));
drop policy if exists "document_versions: delete own" on public.document_versions;
create policy "document_versions: delete own" on public.document_versions as permissive for delete to authenticated
  using ((auth.uid() = user_id));
-- ⛔ No UPDATE policy: a version is immutable, so the owner has no update path
-- to reach in the first place. The trigger is the backstop, this is the door.

drop policy if exists "document_signature_requests: select own" on public.document_signature_requests;
create policy "document_signature_requests: select own" on public.document_signature_requests as permissive for select to authenticated
  using ((auth.uid() = user_id));
drop policy if exists "document_signature_requests: insert own" on public.document_signature_requests;
create policy "document_signature_requests: insert own" on public.document_signature_requests as permissive for insert to authenticated
  with check ((auth.uid() = (select d.user_id from public.documents d where d.id = document_id)));
drop policy if exists "document_signature_requests: update own" on public.document_signature_requests;
create policy "document_signature_requests: update own" on public.document_signature_requests as permissive for update to authenticated
  using ((auth.uid() = user_id)) with check ((auth.uid() = user_id));

drop policy if exists "document_signatures: select own" on public.document_signatures;
create policy "document_signatures: select own" on public.document_signatures as permissive for select to authenticated
  using ((auth.uid() = user_id));
-- ⛔ No insert/update/delete policy. Signatures are written ONLY by the definer
-- RPCs below, which prove the signer first. There is no client insert path for
-- an acknowledgement, from any role.


-- ── 9 · grants ───────────────────────────────────────────────────────────────
-- ⚠️⚠️ `revoke ... from anon` is NOT the same as removing the PUBLIC grant, and
-- Supabase hands new tables full DML to anon at CREATE TIME. Both lessons are
-- already written in blood in this codebase, so every role is stripped first and
-- only what is needed is handed back.
--
-- ⭐ anon gets NOTHING on any of these tables. The customer portal is anonymous;
-- if anon could select `documents` directly, every internal permit in the
-- business would be one PostgREST call away.

revoke all on table public.documents from public, anon, authenticated, service_role;
revoke all on table public.document_versions from public, anon, authenticated, service_role;
revoke all on table public.document_signature_requests from public, anon, authenticated, service_role;
revoke all on table public.document_signatures from public, anon, authenticated, service_role;

grant select, insert, update, delete on table public.documents to authenticated;
grant select, insert, delete on table public.document_versions to authenticated;
grant select, insert, update on table public.document_signature_requests to authenticated;
grant select on table public.document_signatures to authenticated;

grant all on table public.documents to service_role;
grant all on table public.document_versions to service_role;
grant all on table public.document_signature_requests to service_role;
grant all on table public.document_signatures to service_role;


-- ── 10 · the customer portal door ────────────────────────────────────────────
-- ⭐ A TOKEN PROVES WHICH TENANT, NOT WHICH ROW. Every function here joins
-- customer_portal_tokens and then re-scopes to THAT token's customer_id, the
-- same shape portal_get_messages uses. Passing a document id belonging to
-- another customer of the same tenant returns nothing — the id is not trusted,
-- it is filtered.
--
-- ⛔ get_portal_data is untouched. This is a separate projection alongside
-- portal_get_messages / portal_get_prefs, naming its columns on purpose.

create or replace function public.portal_get_documents(p_token text)
returns json
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select coalesce(json_agg(x order by x.created_at desc), '[]'::json)
  from (
    select
      d.id,
      d.name,
      d.category,
      d.created_at,
      v.id            as version_id,
      v.version_no,
      v.file_name,
      v.mime,
      v.size_bytes,
      r.id            as request_id,
      r.statement     as signature_statement,
      r.purpose       as signature_purpose,
      -- signed | awaiting_signature | null. Derived, never stored: a status
      -- column would be a second answer to a question the rows already settle.
      case
        when s.id is not null then 'signed'
        when r.id is not null then 'awaiting_signature'
        else null
      end             as signature_state,
      s.signed_at,
      s.signer_name
    from public.customer_portal_tokens t
    join public.documents d
      on d.user_id = t.user_id
     and d.visibility = 'customer'
     and d.archived_at is null
     -- The document must resolve to THIS token's customer.
     and public.document_customer_id(d.customer_id, d.property_id, d.job_id) = t.customer_id
    -- The current version, and only it: the portal shows what is current, and
    -- superseded drafts are the business's history, not the customer's reading.
    join lateral (
      select dv.* from public.document_versions dv
       where dv.document_id = d.id
       order by dv.version_no desc limit 1
    ) v on true
    left join public.document_signature_requests r
      on r.document_id = d.id and r.cancelled_at is null and r.version_id = v.id
    left join public.document_signatures s on s.request_id = r.id
    where t.token = p_token and not t.revoked
  ) x;
$function$;

comment on function public.portal_get_documents(text) is
  'Customer-visible, non-archived documents for the customer THIS token addresses. Never returns storage paths — the file is fetched through portal_document_file, and the signature image is never projected at all.';

-- The file, by path the DATABASE chose ---------------------------------------
-- ⭐ The caller names a DOCUMENT, never a path. The route then mints a
-- short-lived signed URL for the path this function returned. That is what makes
-- "foreign storage object" unreachable: a crafted path never enters the flow.
create or replace function public.portal_document_file(p_token text, p_document_id uuid)
returns json
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select json_build_object(
           'storage_path', v.storage_path,
           'file_name', v.file_name,
           'mime', v.mime,
           'version_id', v.id,
           'version_no', v.version_no
         )
    from public.customer_portal_tokens t
    join public.documents d
      on d.id = p_document_id
     and d.user_id = t.user_id
     and d.visibility = 'customer'
     and d.archived_at is null
     and public.document_customer_id(d.customer_id, d.property_id, d.job_id) = t.customer_id
    join lateral (
      select dv.* from public.document_versions dv
       where dv.document_id = d.id
       order by dv.version_no desc limit 1
    ) v on true
   where t.token = p_token and not t.revoked;
$function$;

-- Signing ---------------------------------------------------------------------
-- Two phases, because a file must be written to storage between them, and the
-- second phase RE-PROVES everything the first proved. Nothing the route learned
-- in phase one is trusted in phase two.
create or replace function public.portal_signature_target(p_token text, p_document_id uuid)
returns json
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select json_build_object(
           'ok', true,
           'request_id', r.id,
           'version_id', r.version_id,
           'statement', r.statement,
           'purpose', r.purpose,
           'document_name', d.name,
           'tenant_id', d.user_id,
           'customer_id', r.customer_id
         )
    from public.customer_portal_tokens t
    join public.documents d
      on d.id = p_document_id
     and d.user_id = t.user_id
     and d.visibility = 'customer'
     and d.archived_at is null
     and public.document_customer_id(d.customer_id, d.property_id, d.job_id) = t.customer_id
    join public.document_signature_requests r
      on r.document_id = d.id and r.cancelled_at is null and r.customer_id = t.customer_id
    -- Still the current version: if the owner replaced the file after asking,
    -- there is nothing here to sign until they ask again.
    join lateral (
      select dv.id from public.document_versions dv
       where dv.document_id = d.id order by dv.version_no desc limit 1
    ) v on v.id = r.version_id
   where t.token = p_token and not t.revoked
     and not exists (select 1 from public.document_signatures s where s.request_id = r.id);
$function$;

create or replace function public.portal_sign_document(
  p_token         text,
  p_document_id   uuid,
  p_request_id    uuid,
  p_signer_name   text,
  p_signature_path text default null
)
returns json
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_tenant   uuid;
  v_customer uuid;
  v_req      record;
  v_name     text;
  v_id       uuid;
begin
  v_name := btrim(coalesce(p_signer_name, ''));
  if char_length(v_name) < 1 or char_length(v_name) > 120 then
    return json_build_object('ok', false, 'reason', 'name_required');
  end if;

  -- WHO, from the token. Never from the payload.
  select t.user_id, t.customer_id into v_tenant, v_customer
    from public.customer_portal_tokens t
   where t.token = p_token and not t.revoked;
  if v_tenant is null then
    return json_build_object('ok', false, 'reason', 'not_authorized');
  end if;

  -- WHAT, re-proved from scratch: the request, its document, its visibility,
  -- its customer, and that the pinned version is still the current one.
  select r.id, r.version_id, r.statement, r.purpose, r.customer_id, r.document_id
    into v_req
    from public.document_signature_requests r
    join public.documents d on d.id = r.document_id
   where r.id = p_request_id
     and r.document_id = p_document_id
     and r.cancelled_at is null
     and r.customer_id = v_customer
     and d.user_id = v_tenant
     and d.visibility = 'customer'
     and d.archived_at is null
     and public.document_customer_id(d.customer_id, d.property_id, d.job_id) = v_customer
     and r.version_id = (
       select dv.id from public.document_versions dv
        where dv.document_id = d.id order by dv.version_no desc limit 1
     );
  if not found then
    return json_build_object('ok', false, 'reason', 'not_authorized');
  end if;

  -- A signature path is only ever accepted if it lives under this tenant's own
  -- folder in the private bucket. A crafted path pointing at another tenant's
  -- object cannot be recorded as this customer's mark.
  if p_signature_path is not null
     and p_signature_path not like (v_tenant::text || '/%') then
    return json_build_object('ok', false, 'reason', 'bad_signature_path');
  end if;

  begin
    insert into public.document_signatures
      (user_id, request_id, document_id, version_id, customer_id,
       signer_name, statement, purpose, source, signature_path)
    values
      (v_tenant, v_req.id, v_req.document_id, v_req.version_id, v_customer,
       v_name, v_req.statement, v_req.purpose, 'portal', p_signature_path)
    returning id into v_id;
  exception when unique_violation then
    -- REPLAY. The request was already satisfied; say so plainly rather than
    -- minting a second acknowledgement or pretending this one was the first.
    return json_build_object('ok', false, 'reason', 'already_signed');
  end;

  return json_build_object('ok', true, 'signature_id', v_id, 'signed_at', now());
end;
$function$;

comment on function public.portal_sign_document(text, uuid, uuid, text, text) is
  'Records a customer acknowledgement. Identity comes from the portal token, not the payload; the pinned version must still be current; one request can be satisfied exactly once (unique_violation → already_signed).';


-- ── 11 · the crew door ───────────────────────────────────────────────────────
-- ⭐ A crew session has ZERO table access — the founding crew-mode rule — so
-- there is no crew RLS policy anywhere in this file. Crew reads go through this
-- definer RPC, which re-proves employer AND crew assignment on every call.
--
-- ⛔ Job-scoped ONLY. There is deliberately no business-wide document browser
-- for workers: a worker asks about a VISIT they are on, and gets the documents
-- shared to that visit. Customer/site/equipment documents are unreachable here.
--
-- ⭐ SEAM FOR SESSION 65: `j.crew_id = v_crew` is main's current assignment
-- truth. When S65 lands its assignment model (crew_assignment_covers), THIS
-- predicate is the only line in the documents domain that changes.
create or replace function public.crew_job_documents(p_job_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_employer uuid := public.crew_employer();
  v_crew     uuid := public.crew_crew_id();
  v_job      uuid;
  v_docs     jsonb;
begin
  if v_employer is null or v_crew is null then
    return jsonb_build_object('ok', false, 'reason', 'not_authorized');
  end if;

  select j.id into v_job
    from public.jobs j
   where j.id = p_job_id and j.user_id = v_employer and j.crew_id = v_crew;
  if v_job is null then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  select coalesce(jsonb_agg(x.doc order by x.created_at desc), '[]'::jsonb)
    into v_docs
    from (
      select jsonb_build_object(
               'id', d.id,
               'name', d.name,
               'category', d.category,
               'file_name', v.file_name,
               'mime', v.mime,
               'size_bytes', v.size_bytes,
               'version_no', v.version_no,
               'created_at', d.created_at
             ) as doc,
             d.created_at
        from public.documents d
        join lateral (
          select dv.* from public.document_versions dv
           where dv.document_id = d.id order by dv.version_no desc limit 1
        ) v on true
       where d.user_id = v_employer
         and d.job_id = v_job
         -- 'customer' documents are the customer's copy; a worker sees what was
         -- shared TO THE WORK. Widening this to include customer-shared files
         -- would leak pricing letters and acknowledgements onto the crew phone.
         and d.visibility = 'worker'
         and d.archived_at is null
    ) x;

  return jsonb_build_object('ok', true, 'job_id', v_job, 'documents', v_docs);
end;
$function$;

-- Same "the database names the path" rule as the portal.
create or replace function public.crew_document_file(p_document_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_employer uuid := public.crew_employer();
  v_crew     uuid := public.crew_crew_id();
  v_row      record;
begin
  if v_employer is null or v_crew is null then
    return jsonb_build_object('ok', false, 'reason', 'not_authorized');
  end if;

  select v.storage_path, v.file_name, v.mime, v.version_no
    into v_row
    from public.documents d
    join public.jobs j
      on j.id = d.job_id and j.user_id = v_employer and j.crew_id = v_crew
    join lateral (
      select dv.* from public.document_versions dv
       where dv.document_id = d.id order by dv.version_no desc limit 1
    ) v on true
   where d.id = p_document_id
     and d.user_id = v_employer
     and d.visibility = 'worker'
     and d.archived_at is null;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  return jsonb_build_object(
    'ok', true, 'storage_path', v_row.storage_path,
    'file_name', v_row.file_name, 'mime', v_row.mime, 'version_no', v_row.version_no
  );
end;
$function$;


-- ── 12 · function grants ─────────────────────────────────────────────────────
-- Portal functions are reachable by anon BY DESIGN (the portal has no JWT) and
-- are safe because each one re-scopes by the token it was handed. Crew functions
-- require a signed-in crew session: anon has no crew_employer(), so granting it
-- would be pointless as well as wrong.

revoke all on function public.document_customer_id(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.document_customer_id(uuid, uuid, uuid) to authenticated, service_role;

revoke all on function public.portal_get_documents(text) from public;
grant execute on function public.portal_get_documents(text) to anon, authenticated, service_role;

revoke all on function public.portal_document_file(text, uuid) from public;
grant execute on function public.portal_document_file(text, uuid) to anon, authenticated, service_role;

revoke all on function public.portal_signature_target(text, uuid) from public;
grant execute on function public.portal_signature_target(text, uuid) to anon, authenticated, service_role;

revoke all on function public.portal_sign_document(text, uuid, uuid, text, text) from public;
grant execute on function public.portal_sign_document(text, uuid, uuid, text, text) to anon, authenticated, service_role;

revoke all on function public.crew_job_documents(uuid) from public, anon;
grant execute on function public.crew_job_documents(uuid) to authenticated, service_role;

revoke all on function public.crew_document_file(uuid) from public, anon;
grant execute on function public.crew_document_file(uuid) to authenticated, service_role;
