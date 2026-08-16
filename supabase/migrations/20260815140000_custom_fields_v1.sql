-- ── Custom Fields V1 — the definition/value engine ───────────────────────────
--
-- Different service businesses need to record things EdgeHQ does not ship a
-- column for: a gate code on a service location, a permit number on a visit, a
-- referral partner on a customer. This is the ONE canonical place that lives.
--
-- ⚠️ NOT YET APPLIED TO PRODUCTION (2026-08-15). This file is committed so the
-- fresh-rebuild proof can apply it from zero, and so review happens against the
-- real statements. `verify:migrations` will ADVISE that it is in flight — that
-- advisory is correct and is the reconciliation gate.
--
-- ⚠️ VERSION: 20260815140000, chosen to sort AFTER the regenerated baseline
-- 20260815130001 (itself derived from the newest ledger entry 20260815130000,
-- job_forms_fix_photo_projection). It was originally 20260815000000, which sorted
-- BEFORE that baseline once S69 landed and would therefore have been applied
-- against tables that did not exist yet. Re-check this ordering after every
-- rebase onto main: a regenerated baseline moves the floor.
--
-- When it is applied, the 14-digit prefix MUST match the version production
-- actually records in supabase_migrations.schema_migrations, then supabase/
-- contract/ recaptured via `npm run schema:contract && npm run schema:baseline`.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- ⭐⭐ AUDIENCE: THESE VALUES ARE INTERNAL. FULL STOP.
-- ══════════════════════════════════════════════════════════════════════════════
-- src/lib/noteScope.ts states the product's rule: who may read a piece of text is
-- a property of the COLUMN, decided when the field is created and enforced by the
-- explicit projection that selects it — never by a `visibility` flag, because a
-- wrong flag value is one UPDATE away from publishing a gate code.
--
-- Custom fields are created at RUNTIME, so column-splitting is not available to
-- them. V1 therefore resolves the tension by NOT TAKING THE RISK: there is no
-- audience mechanism here at all. No worker_visible, no portal_visible, no
-- exposure enum. `get_portal_data` and `crew_day` are not touched by this
-- migration and do not learn these tables exist. A custom field value reaches
-- exactly one surface: the owner's own authenticated screens.
--
-- ⭐ THE SEAM, LEFT OPEN AND DELIBERATELY EMPTY. Exposing a chosen field later is
-- PURELY ADDITIVE and needs no redesign of anything below:
--   1. add a grant column to custom_field_definitions (default false),
--   2. add ONE predicate to the canonical projection that already answers for
--      that audience — get_portal_data for customers, the Session 64/65/66
--      worker-authorization path for crews.
-- Storage, typing, tenancy and history are unaffected by that change. What must
-- NOT happen is a second permissions engine living in these tables: the projection
-- stays the door. Until such a column exists, "is this readable by X" has exactly
-- one answer here, and it is no.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- ⭐ WHY THE CONSTRAINTS LOOK LIKE THIS: the database refuses, not the app
-- ══════════════════════════════════════════════════════════════════════════════
-- Every rule that CAN be structural is structural, because app-side validation is
-- one forgotten call site away from being absent:
--
--   foreign definition id / foreign tenant → the composite FK carries user_id, so
--       a value pointing at another owner's definition has no parent row to find.
--   foreign customer / property / job      → composite FKs to (id, user_id) on
--       those tables, so a record from another tenant likewise does not resolve.
--   type mismatch (a date into a number)   → field_type travels WITH the value and
--       a CHECK ties it to which value_* column may be populated. Putting a date
--       in a number field is not rejected — it is unrepresentable.
--   deleting a field that holds history    → ON DELETE RESTRICT. A definition with
--       values cannot be dropped; archive it instead. A definition created by
--       mistake a minute ago, with no values, still deletes cleanly.
--   forged user_id                         → RLS with_check (auth.uid() = user_id).
--
-- Only two rules genuinely cannot be expressed as a CHECK, because they read
-- another row: dropdown option validity, and "no new values on an archived
-- definition". Those two, and only those two, are a trigger.
--
-- ⚠️ ANON IS REVOKED EXPLICITLY. Supabase grants ALL to anon at CREATE TIME by
-- default; a gate code sitting behind nothing but RLS is not a risk worth taking
-- twice (see the crew_messages finding, 2026-08-13). `revoke from anon` alone is
-- not enough either — the PUBLIC grant is a separate thing and is revoked too.

-- ── 0. this migration adds tables and touches nothing that exists ────────────
-- The tenant-carrying composite foreign keys below need a UNIQUE to point at on
-- each attachment table. All three ALREADY HAVE ONE — this schema has used the
-- pattern for a while (change_orders, quotes, service_bundles, technicians too):
--
--   customers   UNIQUE (user_id, id)   customers_user_id_id_key
--   properties  UNIQUE (id, user_id)   properties_id_user_unique
--   jobs        UNIQUE (id, user_id)   jobs_id_user_key
--
-- ⚠️ The column ORDER differs between them, and a composite FK must list its
-- columns in the referenced constraint's order. That is why the three foreign
-- keys below are not written identically. Adding matching-order duplicates would
-- have put three redundant indexes on production's largest tables for nothing.

-- ── 1. definitions ───────────────────────────────────────────────────────────
create table if not exists public."custom_field_definitions" (
  "id" uuid default extensions.uuid_generate_v4() not null,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null,
  "user_id" uuid not null,
  -- Which record this field hangs off. V1 supports the three the product already
  -- treats as durable CRM records. 'asset' is NOT here: Session 72 does not exist,
  -- and a value of an entity nothing can reference is a broken row waiting.
  "entity" text not null,
  -- The stable identity. Slugged once from the label, then IMMUTABLE, because it
  -- is what an export column header and a re-import match on. Renaming the label
  -- must never orphan history.
  "field_key" text not null,
  "label" text not null,
  "field_type" text not null,
  -- select only: [{ "value": "<stable slug>", "label": "<what the owner sees>" }]
  -- The stored VALUE is the slug, so relabelling an option leaves every historical
  -- row still resolving. Removing one leaves history intact and merely blocks new
  -- writes — see custom_field_value_guard().
  "options" jsonb default '[]'::jsonb not null,
  "help_text" text,
  "sort_order" integer default 0 not null,
  -- Archive, never delete. An archived definition stops being offered on forms and
  -- keeps every value it ever collected readable.
  "archived_at" timestamp with time zone,
  constraint custom_field_definitions_pkey primary key (id),
  constraint custom_field_definitions_entity_check
    check (entity in ('customer', 'property', 'job')),
  constraint custom_field_definitions_field_type_check
    check (field_type in ('text', 'textarea', 'number', 'boolean', 'date', 'select', 'currency')),
  -- A slug an export header can carry and an importer can match without quoting.
  constraint custom_field_definitions_field_key_check
    check (field_key ~ '^[a-z][a-z0-9_]{0,47}$'),
  constraint custom_field_definitions_label_check
    check (length(btrim(label)) between 1 and 60),
  -- options is an ARRAY, and only a select may carry one. A non-select holding
  -- options is a field that half-changed type.
  constraint custom_field_definitions_options_check
    check (jsonb_typeof(options) = 'array' and (field_type = 'select' or options = '[]'::jsonb)),
  -- One field_key per entity per owner. Two "po_number" fields on a visit is an
  -- ambiguity every downstream reader would have to invent a rule for.
  constraint custom_field_definitions_owner_key_unique unique (user_id, entity, field_key),
  -- ⭐ The target of the value composite FK. Redundant as a uniqueness statement
  -- (id alone is unique); load-bearing as an FK target — it is what drags user_id,
  -- entity and field_type across to the value row and keeps them honest there.
  constraint custom_field_definitions_fk_target unique (id, user_id, entity, field_type)
);

-- ── 2. values ────────────────────────────────────────────────────────────────
create table if not exists public."custom_field_values" (
  "id" uuid default extensions.uuid_generate_v4() not null,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null,
  "user_id" uuid not null,
  "definition_id" uuid not null,
  -- Carried from the definition by the composite FK below, never set independently.
  -- They exist on this row so that "does this value match its field's type" and
  -- "does it hang off the right kind of record" are answerable by a CHECK.
  "entity" text not null,
  "field_type" text not null,
  -- Exactly one of these is set, and which one must agree with `entity`.
  "customer_id" uuid,
  "property_id" uuid,
  "job_id" uuid,
  -- Exactly one of these is set, and which one must agree with `field_type`.
  -- One typed column per storage class: a single text column holding "2026-03-01"
  -- would make every reader re-parse, and would let a bad write survive as a
  -- string that only fails later, at read time, on someone else's screen.
  "value_text" text,
  "value_number" numeric,
  "value_boolean" boolean,
  "value_date" date,
  constraint custom_field_values_pkey primary key (id),

  -- ⭐ THE TENANCY + TYPE FK. Four columns travel together. A value cannot name a
  -- definition belonging to another owner (no such parent), cannot disagree with
  -- its definition's entity, and cannot disagree with its type.
  -- ON UPDATE CASCADE so a definition whose type is corrected while it holds NO
  -- values carries its values along; combined with the CHECK below, a type change
  -- on a definition that DOES hold values aborts, which is the intent.
  -- ON DELETE RESTRICT so history cannot be dropped by deleting its field.
  constraint custom_field_values_definition_fkey
    foreign key (definition_id, user_id, entity, field_type)
    references public."custom_field_definitions" (id, user_id, entity, field_type)
    on update cascade on delete restrict,

  -- ⭐ THE ATTACHMENT FKs. Each carries user_id, so the record must belong to the
  -- same owner as the value and the definition. Deleting the record it describes
  -- takes its custom values with it — a value about a deleted customer is not
  -- history, it is a leak with no subject.
  -- Column order follows each target's EXISTING unique constraint — see §0.
  constraint custom_field_values_customer_fkey
    foreign key (user_id, customer_id) references public."customers" (user_id, id) on delete cascade,
  constraint custom_field_values_property_fkey
    foreign key (property_id, user_id) references public."properties" (id, user_id) on delete cascade,
  constraint custom_field_values_job_fkey
    foreign key (job_id, user_id) references public."jobs" (id, user_id) on delete cascade,

  -- Exactly one attachment, and it must be the one `entity` names.
  constraint custom_field_values_attachment_check check (
    (entity = 'customer' and customer_id is not null and property_id is null and job_id is null) or
    (entity = 'property' and property_id is not null and customer_id is null and job_id is null) or
    (entity = 'job'      and job_id      is not null and customer_id is null and property_id is null)
  ),

  -- ⭐ THE TYPE CHECK. This is what makes "a date into a number field" impossible
  -- rather than merely validated. text/textarea/select store text; number and
  -- currency store numeric; boolean stores boolean; date stores date.
  constraint custom_field_values_type_check check (
    (field_type in ('text', 'textarea', 'select')
       and value_text is not null and value_number is null and value_boolean is null and value_date is null) or
    (field_type in ('number', 'currency')
       and value_number is not null and value_text is null and value_boolean is null and value_date is null) or
    (field_type = 'boolean'
       and value_boolean is not null and value_text is null and value_number is null and value_date is null) or
    (field_type = 'date'
       and value_date is not null and value_text is null and value_number is null and value_boolean is null)
  ),

  -- ⭐ ONE ANSWER PER FIELD PER RECORD, and inferrable by ON CONFLICT.
  -- NULLS NOT DISTINCT is load-bearing: in a plain UNIQUE two NULLs differ, so
  -- (def, customer, NULL, NULL) would not collide with itself and duplicates
  -- would accumulate silently. It also has to be a full (non-partial) unique for
  -- PostgREST to target it — Postgres can only infer a PARTIAL index when the
  -- statement repeats the index predicate, which an upsert through PostgREST
  -- cannot express. The attachment CHECK above guarantees exactly one of the
  -- three id columns is set, so this reads as "one answer per field per record".
  constraint custom_field_values_one_answer
    unique nulls not distinct (definition_id, customer_id, property_id, job_id),

  -- A stored blank is not an answer; it is an empty row pretending to be one.
  -- Clearing a field DELETES its value row, so "unanswered" has one representation.
  -- The upper bound is hygiene rather than security (only the owner can write
  -- here at all): it keeps one pasted document out of every subsequent export.
  constraint custom_field_values_text_not_blank
    check (value_text is null or length(btrim(value_text)) between 1 and 4000)
);

-- Read paths: "every custom value for this record" and "every value for this
-- field". The first is what a detail screen asks; the second is what export and
-- the archive-safety check ask.
create index if not exists custom_field_values_customer_idx
  on public."custom_field_values" (user_id, customer_id) where customer_id is not null;
create index if not exists custom_field_values_property_idx
  on public."custom_field_values" (user_id, property_id) where property_id is not null;
create index if not exists custom_field_values_job_idx
  on public."custom_field_values" (user_id, job_id) where job_id is not null;
create index if not exists custom_field_values_definition_idx
  on public."custom_field_values" (definition_id);

-- ⭐ SEARCH, scoped on purpose. Only text-bearing values are indexed, and only for
-- EXACT/prefix lookup — a PO number or a project code is something an owner types
-- in full. There is deliberately no trigram or full-text index over every value:
-- "find any record whose any custom field contains any substring" is the query
-- that makes an arbitrary-attribute store expensive, and nobody has asked for it.
create index if not exists custom_field_values_text_lookup
  on public."custom_field_values" (user_id, lower(btrim(value_text)))
  where value_text is not null;

create index if not exists custom_field_definitions_owner_idx
  on public."custom_field_definitions" (user_id, entity, sort_order);

-- ── 3. the two rules a CHECK cannot express ──────────────────────────────────
create or replace function public.custom_field_value_guard()
 returns trigger
 language plpgsql
 set search_path to 'public'
as $function$
declare
  v_archived timestamptz;
  v_type     text;
  v_options  jsonb;
begin
  select archived_at, field_type, options
    into v_archived, v_type, v_options
    from public.custom_field_definitions
   where id = new.definition_id;

  -- The FK guarantees a parent exists; this is the belt to its braces and keeps
  -- the failure legible if the FK is ever relaxed.
  if not found then
    raise exception 'custom field definition % not found', new.definition_id
      using errcode = 'foreign_key_violation';
  end if;

  -- ARCHIVED: existing values stay readable and editable-to-empty, but no NEW
  -- answer may be recorded against a field the owner has retired. Historical
  -- truth is the point of archiving; letting new writes land would make an
  -- archived field a live field with a confusing label.
  if v_archived is not null then
    raise exception 'custom field "%" is archived and no longer accepts values', new.definition_id
      using errcode = 'check_violation';
  end if;

  -- DROPDOWN VALIDITY: the stored text must be one of the option slugs the
  -- definition currently offers. Removing an option therefore blocks NEW writes
  -- of it while leaving every row already holding it untouched — which is the
  -- honest behaviour, and why this is checked on write and never on read.
  if v_type = 'select' then
    if not exists (
      select 1 from jsonb_array_elements(v_options) o
       where o->>'value' = new.value_text
    ) then
      raise exception 'value % is not one of the choices offered by this field', new.value_text
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end $function$;

drop trigger if exists custom_field_values_guard on public."custom_field_values";
create trigger custom_field_values_guard
  before insert or update on public."custom_field_values"
  for each row execute function custom_field_value_guard();

-- Identity is immutable. field_key is what an export header and a re-import match
-- on; entity is what every value's FK was resolved against. Both are set once.
create or replace function public.custom_field_definition_guard()
 returns trigger
 language plpgsql
 set search_path to 'public'
as $function$
begin
  if new.field_key is distinct from old.field_key then
    raise exception 'a custom field''s key cannot change once created'
      using errcode = 'check_violation';
  end if;
  if new.entity is distinct from old.entity then
    raise exception 'a custom field cannot be moved to a different kind of record'
      using errcode = 'check_violation';
  end if;
  -- Changing the type of a field that already holds answers would silently
  -- reinterpret them. The composite FK would abort this anyway; saying so plainly
  -- is the difference between a fixable message and a constraint-name dump.
  if new.field_type is distinct from old.field_type
     and exists (select 1 from public.custom_field_values v where v.definition_id = old.id) then
    raise exception 'this field already holds answers, so its type cannot change — archive it and create a new one'
      using errcode = 'check_violation';
  end if;
  return new;
end $function$;

drop trigger if exists custom_field_definitions_guard on public."custom_field_definitions";
create trigger custom_field_definitions_guard
  before update on public."custom_field_definitions"
  for each row execute function custom_field_definition_guard();

drop trigger if exists custom_field_definitions_updated_at on public."custom_field_definitions";
create trigger custom_field_definitions_updated_at
  before update on public."custom_field_definitions"
  for each row execute function handle_updated_at();

drop trigger if exists custom_field_values_updated_at on public."custom_field_values";
create trigger custom_field_values_updated_at
  before update on public."custom_field_values"
  for each row execute function handle_updated_at();

-- ── 4. tenancy ───────────────────────────────────────────────────────────────
alter table public."custom_field_definitions" enable row level security;
alter table public."custom_field_values" enable row level security;

drop policy if exists "custom_field_definitions: select own" on public."custom_field_definitions";
create policy "custom_field_definitions: select own" on public."custom_field_definitions" as permissive for select to public
  using ((auth.uid() = user_id));
drop policy if exists "custom_field_definitions: insert own" on public."custom_field_definitions";
create policy "custom_field_definitions: insert own" on public."custom_field_definitions" as permissive for insert to public
  with check ((auth.uid() = user_id));
drop policy if exists "custom_field_definitions: update own" on public."custom_field_definitions";
create policy "custom_field_definitions: update own" on public."custom_field_definitions" as permissive for update to public
  using ((auth.uid() = user_id)) with check ((auth.uid() = user_id));
drop policy if exists "custom_field_definitions: delete own" on public."custom_field_definitions";
create policy "custom_field_definitions: delete own" on public."custom_field_definitions" as permissive for delete to public
  using ((auth.uid() = user_id));

drop policy if exists "custom_field_values: select own" on public."custom_field_values";
create policy "custom_field_values: select own" on public."custom_field_values" as permissive for select to public
  using ((auth.uid() = user_id));
drop policy if exists "custom_field_values: insert own" on public."custom_field_values";
create policy "custom_field_values: insert own" on public."custom_field_values" as permissive for insert to public
  with check ((auth.uid() = user_id));
drop policy if exists "custom_field_values: update own" on public."custom_field_values";
create policy "custom_field_values: update own" on public."custom_field_values" as permissive for update to public
  using ((auth.uid() = user_id)) with check ((auth.uid() = user_id));
drop policy if exists "custom_field_values: delete own" on public."custom_field_values";
create policy "custom_field_values: delete own" on public."custom_field_values" as permissive for delete to public
  using ((auth.uid() = user_id));

-- ── 5. grants ────────────────────────────────────────────────────────────────
-- ⚠️ Deliberately NARROWER than this schema's historical default of
-- `grant ALL to anon, authenticated, service_role`. A crew session authenticates,
-- so `authenticated` is not a synonym for "the owner" — RLS is what separates
-- them, and it does. But `anon` is nobody, and nobody has no business holding DML
-- on a table that stores gate codes. PUBLIC is revoked separately: revoking anon
-- does not remove a grant made to PUBLIC (tenant-boundary audit, 2026-08-10).
revoke all on table public."custom_field_definitions" from public;
revoke all on table public."custom_field_definitions" from anon;
revoke all on table public."custom_field_values" from public;
revoke all on table public."custom_field_values" from anon;
grant select, insert, update, delete on table public."custom_field_definitions" to authenticated;
grant select, insert, update, delete on table public."custom_field_values" to authenticated;
grant all on table public."custom_field_definitions" to service_role;
grant all on table public."custom_field_values" to service_role;

revoke all on function public."custom_field_value_guard"() from public, anon, authenticated, service_role;
grant execute on function public."custom_field_value_guard"() to service_role;
revoke all on function public."custom_field_definition_guard"() from public, anon, authenticated, service_role;
grant execute on function public."custom_field_definition_guard"() to service_role;
