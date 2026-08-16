-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260815120000
--   name    : job_forms_v1
--
-- Recovered 2026-08-15 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Job Forms + Checklists V1 (Session 69) ──────────────────────────────────
--
-- A service business standardises how work is performed and documented without
-- the product hardcoding any industry. Three ideas, kept strictly apart:
--
--   FORM TEMPLATE  (form_templates + form_template_fields)
--     The reusable definition the owner edits. Editing it changes FUTURE work
--     only — never a form already attached to a visit.
--
--   FORM INSTANCE  (job_forms)
--     A copy attached to one visit (a `jobs` row IS a visit). It carries a
--     frozen jsonb SNAPSHOT of the template's fields taken at attach time, so
--     historical truth cannot be rewritten by a later template edit. The
--     snapshot is guarded by trigger — only the waive columns may change.
--
--   FORM RESPONSE  (job_form_responses + job_form_response_photos)
--     Who answered what, and when. Attribution is recorded per answer
--     (answered_by / answered_role / answered_at) and never inferred: if the
--     owner filled it, it says the owner filled it.
--
-- AUDIENCE (the column-is-the-audience rule, lib/noteScope): everything in
-- these tables is CREW+OWNER material. No portal projection may ever select
-- them; there is deliberately no per-field "customer visible" switch — a
-- visibility flag is a control whose only use is to leak. If a result must one
-- day reach the customer portal, that is a new portal_get_* projection naming
-- its columns on purpose, not a flag here.
--
-- PHOTOS reuse the canonical proof-of-work catalogue (job_photos + the
-- job-photos bucket). A photo requirement is satisfied by rows in
-- job_form_response_photos that point at job_photos rows OF THE SAME VISIT —
-- enforced by trigger, so a worker cannot satisfy a requirement with a photo
-- of somebody else's job. No second upload path exists.
--
-- THE COMPLETION GATE: completing a visit (status → 'completed') is refused by
-- a BEFORE UPDATE trigger on jobs while a required checklist item is missing,
-- unless the owner has waived that form with a reason. This backstops EVERY
-- completion door at once (calendar Done, Day Ops dropdown, job form,
-- lib/jobStatus.completeVisit, /api/crew/complete, offline replay) without
-- rewriting any of them.  ⛔ "Stop for today" (status stays in_progress,
-- started_at → null) is not a completion and is structurally untouched.
--
-- Crew access follows the founding crew-mode rule: a crew session has ZERO
-- table access. Crew reads/writes go through typed SECURITY DEFINER RPCs
-- (crew_job_forms / crew_save_form_response) that re-prove employer + crew
-- assignment on every call. No crew RLS policy exists on any of these tables.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1 · Helper functions used by CHECK constraints (must exist before the
--     constraints that call them — a rebuild from zero resolves them at
--     ADD CONSTRAINT time).
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.form_options_ok(p jsonb)
returns boolean
language sql
immutable
as $$
  select jsonb_typeof(p) = 'array'
     and jsonb_array_length(p) between 1 and 30
     and not exists (
       select 1 from jsonb_array_elements(p) e
       where jsonb_typeof(e) <> 'string'
          or char_length(e #>> '{}') not between 1 and 100
     )
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2 · Tables
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.form_templates (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  description text,
  archived_at timestamptz,
  constraint form_templates_name_len check (char_length(btrim(name)) between 1 and 120),
  constraint form_templates_description_len check (description is null or char_length(description) <= 500),
  constraint form_templates_id_user_key unique (id, user_id)
);

create table if not exists public.form_template_fields (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  user_id uuid not null references auth.users (id) on delete cascade,
  template_id uuid not null,
  position integer not null default 0,
  field_type text not null,
  label text not null,
  help_text text,
  required boolean not null default false,
  options jsonb,
  unit text,
  photo_kind text,
  constraint form_template_fields_template_same_owner
    foreign key (template_id, user_id) references public.form_templates (id, user_id) on delete cascade,
  constraint form_template_fields_type_check check (field_type in
    ('section','instruction','checkbox','short_text','long_text','number','yes_no','dropdown','date','time','photo')),
  constraint form_template_fields_label_len check (char_length(btrim(label)) between 1 and 200),
  constraint form_template_fields_help_len check (help_text is null or char_length(help_text) <= 500),
  constraint form_template_fields_unit_len check (unit is null or char_length(unit) between 1 and 20),
  -- a unit label belongs to a number; anywhere else it is a stray control
  constraint form_template_fields_unit_scope check (unit is null or field_type = 'number'),
  -- choices belong to a dropdown, and must be a short list of short strings
  constraint form_template_fields_options_scope check (
    (field_type = 'dropdown' and public.form_options_ok(options))
    or (field_type <> 'dropdown' and options is null)),
  constraint form_template_fields_photo_kind_scope check (
    photo_kind is null or (field_type = 'photo' and photo_kind in ('before','after','general'))),
  -- headings and instructions cannot be "required": there is nothing to answer
  constraint form_template_fields_required_actionable check (
    not required or field_type not in ('section','instruction'))
);

create index if not exists form_template_fields_template_idx
  on public.form_template_fields (user_id, template_id, position);

create table if not exists public.job_forms (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  user_id uuid not null references auth.users (id) on delete cascade,
  job_id uuid not null,
  template_id uuid not null,
  template_name text not null,
  -- ⭐ THE SNAPSHOT. The template's fields as they stood at attach time.
  -- Immutable by trigger (job_forms_freeze_guard). Template edits change
  -- future instances only; this one is history.
  fields jsonb not null,
  source text not null default 'manual',
  -- The owner's completion-gate override. All three set together, or none:
  -- an override without a reason is not a record. This is the audit seam —
  -- when the audit-trail session lands, waives emit an event from here.
  waived_at timestamptz,
  waived_by uuid,
  waive_reason text,
  constraint job_forms_job_same_owner
    foreign key (job_id, user_id) references public.jobs (id, user_id) on delete cascade,
  -- RESTRICT is the point: a template with historical instances cannot be
  -- hard-deleted, by construction. Archive it instead (archived_at).
  constraint job_forms_template_same_owner
    foreign key (template_id, user_id) references public.form_templates (id, user_id) on delete restrict,
  constraint job_forms_id_user_key unique (id, user_id),
  constraint job_forms_job_template_uniq unique (job_id, template_id),
  constraint job_forms_source_check check (source in ('service_template','series','manual')),
  constraint job_forms_fields_shape check (jsonb_typeof(fields) = 'array'),
  constraint job_forms_waive_reason_len check (waive_reason is null or char_length(btrim(waive_reason)) between 1 and 300),
  constraint job_forms_waive_consistent check (
    ((waived_at is null) = (waived_by is null)) and ((waived_at is null) = (waive_reason is null)))
);

create index if not exists job_forms_job_idx on public.job_forms (user_id, job_id);
create index if not exists job_forms_template_idx on public.job_forms (user_id, template_id);

create table if not exists public.job_form_responses (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  user_id uuid not null references auth.users (id) on delete cascade,
  form_id uuid not null,
  field_id uuid not null,
  -- one column per answer shape; the response guard trigger enforces that
  -- exactly the column matching the snapshot field's type is set
  value_text text,
  value_number numeric,
  value_bool boolean,
  value_date date,
  value_time time,
  value_choice text,
  -- ⭐ ATTRIBUTION — recorded, never inferred. answered_by is the auth uid of
  -- whoever actually wrote the answer (trigger-checked against auth.uid()).
  answered_by uuid not null,
  answered_role text not null,
  answered_at timestamptz not null default now(),
  -- The explicit correction path for a completed visit's form: an owner may
  -- amend a frozen answer only by saying why. All three set together.
  corrected_at timestamptz,
  corrected_by uuid,
  correction_reason text,
  constraint job_form_responses_form_same_owner
    foreign key (form_id, user_id) references public.job_forms (id, user_id) on delete cascade,
  constraint job_form_responses_field_uniq unique (form_id, field_id),
  constraint job_form_responses_id_user_key unique (id, user_id),
  constraint job_form_responses_role_check check (answered_role in ('owner','crew')),
  constraint job_form_responses_text_len check (value_text is null or char_length(value_text) <= 2000),
  constraint job_form_responses_choice_len check (value_choice is null or char_length(value_choice) between 1 and 100),
  constraint job_form_responses_number_sane check (value_number is null or abs(value_number) <= 1000000000),
  constraint job_form_responses_correction_len check (correction_reason is null or char_length(btrim(correction_reason)) between 1 and 300),
  constraint job_form_responses_correction_consistent check (
    ((corrected_at is null) = (corrected_by is null)) and ((corrected_at is null) = (correction_reason is null)))
);

create index if not exists job_form_responses_form_idx on public.job_form_responses (user_id, form_id);

-- job_photos needs a composite key for same-owner FKs (the pattern every
-- child table here uses; jobs/service_templates/job_forms already expose one).
do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'job_photos_id_user_key'
  ) then
    alter table public.job_photos add constraint job_photos_id_user_key unique (id, user_id);
  end if;
end $$;

create table if not exists public.job_form_response_photos (
  response_id uuid not null,
  photo_id uuid not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint job_form_response_photos_pkey primary key (response_id, photo_id),
  constraint job_form_response_photos_response_same_owner
    foreign key (response_id, user_id) references public.job_form_responses (id, user_id) on delete cascade,
  -- deleting the photo releases the requirement (it is no longer satisfied) —
  -- a link row must never outlive the photo it points at
  constraint job_form_response_photos_photo_same_owner
    foreign key (photo_id, user_id) references public.job_photos (id, user_id) on delete cascade
);

create index if not exists job_form_response_photos_photo_idx
  on public.job_form_response_photos (user_id, photo_id);

-- ── Template attachment points ──────────────────────────────────────────────
-- A service template may name a default checklist ("Furnace Tune-Up" → the
-- furnace checklist); a recurring series may name its own. Both RESTRICT
-- template deletion — unlink or archive first, never silently orphan.

alter table public.service_templates add column if not exists form_template_id uuid;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'service_templates_form_template_same_owner') then
    alter table public.service_templates
      add constraint service_templates_form_template_same_owner
      foreign key (form_template_id, user_id) references public.form_templates (id, user_id) on delete restrict;
  end if;
end $$;

alter table public.job_recurrences add column if not exists form_template_id uuid;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'job_recurrences_form_template_same_owner') then
    alter table public.job_recurrences
      add constraint job_recurrences_form_template_same_owner
      foreign key (form_template_id, user_id) references public.form_templates (id, user_id) on delete restrict;
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3 · Engine functions (one home per question)
-- ─────────────────────────────────────────────────────────────────────────────

-- "Which checklist applies to this visit by default?" — THE resolution order:
--   1. the recurring series' own default        (job_recurrences.form_template_id)
--   2. the quote's service template's default   (quotes.service_template_id →)
--   3. a service template whose name matches the visit's service_type
-- Archived templates never resolve. Manual attachments are not resolution —
-- they are instances that already exist.
create or replace function public.job_form_default_template(p_job public.jobs)
returns table (template_id uuid, source text)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_id uuid;
begin
  if p_job.recurrence_id is not null then
    select r.form_template_id into v_id
    from public.job_recurrences r
    join public.form_templates ft on ft.id = r.form_template_id and ft.user_id = r.user_id
    where r.id = p_job.recurrence_id and r.user_id = p_job.user_id
      and r.form_template_id is not null and ft.archived_at is null;
    if v_id is not null then
      template_id := v_id; source := 'series'; return next; return;
    end if;
  end if;

  if p_job.quote_id is not null then
    select st.form_template_id into v_id
    from public.quotes q
    join public.service_templates st on st.id = q.service_template_id and st.user_id = q.user_id
    join public.form_templates ft on ft.id = st.form_template_id and ft.user_id = st.user_id
    where q.id = p_job.quote_id and q.user_id = p_job.user_id
      and st.form_template_id is not null and ft.archived_at is null;
    if v_id is not null then
      template_id := v_id; source := 'service_template'; return next; return;
    end if;
  end if;

  if p_job.service_type is not null and btrim(p_job.service_type) <> '' then
    select st.form_template_id into v_id
    from public.service_templates st
    join public.form_templates ft on ft.id = st.form_template_id and ft.user_id = st.user_id
    where st.user_id = p_job.user_id
      and lower(btrim(st.name)) = lower(btrim(p_job.service_type))
      and st.form_template_id is not null and ft.archived_at is null
    order by st.sort_order nulls last, st.created_at
    limit 1;
    if v_id is not null then
      template_id := v_id; source := 'service_template'; return next; return;
    end if;
  end if;

  return;
end;
$$;

-- The frozen snapshot a new instance carries: the template's fields as they
-- stand RIGHT NOW, ordered, nulls stripped. This is the only place a snapshot
-- is built.
create or replace function public.form_template_snapshot(p_template_id uuid, p_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'id', f.id,
           'position', f.position,
           'type', f.field_type,
           'label', f.label,
           'help', f.help_text,
           'required', case when f.required then true else null end,
           'options', f.options,
           'unit', f.unit,
           'photo_kind', f.photo_kind
         )) order by f.position, f.created_at, f.id), '[]'::jsonb)
  from public.form_template_fields f
  where f.template_id = p_template_id and f.user_id = p_user_id
$$;

-- Attach whatever should be attached, idempotently. Called lazily by every
-- surface (crew open, owner panel, completion pre-check) — which is why NO
-- job-creation door needed rewriting, and why a template edit reaches exactly
-- the visits whose forms have not yet been minted.
-- Permission: the tenant owner, an assigned active crew member, or service_role.
create or replace function public.ensure_job_forms(p_job_id uuid)
returns setof public.job_forms
language plpgsql
volatile
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_job public.jobs;
  v_uid uuid := auth.uid();
  v_employer uuid;
  v_crew uuid;
  v_default record;
begin
  select * into v_job from public.jobs where id = p_job_id;
  if not found then return; end if;

  if v_uid is not null and v_uid <> v_job.user_id then
    v_employer := public.crew_employer();
    v_crew := public.crew_crew_id();
    if v_employer is null or v_employer <> v_job.user_id
       or v_crew is null or v_job.crew_id is distinct from v_crew then
      return; -- not yours: say nothing, mint nothing
    end if;
  end if;

  select * into v_default from public.job_form_default_template(v_job);
  if v_default.template_id is not null then
    insert into public.job_forms (user_id, job_id, template_id, template_name, fields, source)
    select v_job.user_id, v_job.id, ft.id, ft.name,
           public.form_template_snapshot(ft.id, v_job.user_id), v_default.source
    from public.form_templates ft
    where ft.id = v_default.template_id and ft.user_id = v_job.user_id
    on conflict (job_id, template_id) do nothing;
  end if;

  return query select * from public.job_forms
    where job_id = v_job.id and user_id = v_job.user_id
    order by created_at;
end;
$$;

-- "Is this field answered?" has ONE definition, used by the gate, the summary
-- and the crew payload alike:
--   photo fields   → at least one linked photo of this visit
--   anything else  → a response row exists (the response guard trigger already
--                    refused empty or mis-typed answers on the way in)
-- Headings and instructions are never answerable and never counted.

-- What still blocks completion. Includes forms not yet minted: if a default
-- template with required fields WOULD attach, completing without ever opening
-- it must not slip past the gate.
create or replace function public.job_form_missing_items(p_job_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_job public.jobs;
  v_missing jsonb := '[]'::jsonb;
  v_default record;
  v_form record;
  v_field record;
  v_answered boolean;
begin
  select * into v_job from public.jobs where id = p_job_id and user_id = p_user_id;
  if not found then return '[]'::jsonb; end if;

  for v_form in
    select jf.id, jf.template_name, jf.fields, jf.waived_at
    from public.job_forms jf
    where jf.job_id = v_job.id and jf.user_id = v_job.user_id
  loop
    if v_form.waived_at is not null then continue; end if;
    for v_field in
      select (f ->> 'id')::uuid as id, f ->> 'label' as label, f ->> 'type' as type
      from jsonb_array_elements(v_form.fields) f
      where (f ->> 'required')::boolean is true
        and f ->> 'type' not in ('section','instruction')
    loop
      if v_field.type = 'photo' then
        select exists (
          select 1 from public.job_form_responses r
          join public.job_form_response_photos p on p.response_id = r.id and p.user_id = r.user_id
          where r.form_id = v_form.id and r.user_id = v_job.user_id and r.field_id = v_field.id
        ) into v_answered;
      else
        select exists (
          select 1 from public.job_form_responses r
          where r.form_id = v_form.id and r.user_id = v_job.user_id and r.field_id = v_field.id
        ) into v_answered;
      end if;
      if not v_answered then
        v_missing := v_missing || jsonb_build_object(
          'form_id', v_form.id, 'form', v_form.template_name,
          'field_id', v_field.id, 'label', v_field.label, 'type', v_field.type);
      end if;
    end loop;
  end loop;

  -- A default that never got opened still gates: count its required fields
  -- from the LIVE template (nothing was snapshotted yet, so the live
  -- definition is exactly what would have attached).
  select * into v_default from public.job_form_default_template(v_job);
  if v_default.template_id is not null and not exists (
    select 1 from public.job_forms jf
    where jf.job_id = v_job.id and jf.user_id = v_job.user_id and jf.template_id = v_default.template_id
  ) then
    for v_field in
      select f.id, f.label, f.field_type as type, ft.name as form_name
      from public.form_template_fields f
      join public.form_templates ft on ft.id = f.template_id and ft.user_id = f.user_id
      where f.template_id = v_default.template_id and f.user_id = v_job.user_id
        and f.required and f.field_type not in ('section','instruction')
    loop
      v_missing := v_missing || jsonb_build_object(
        'form_id', null, 'form', v_field.form_name,
        'field_id', v_field.id, 'label', v_field.label, 'type', v_field.type);
    end loop;
  end if;

  return v_missing;
end;
$$;

-- Counts for a day board / Today list: cheap, no field content, no N+1.
-- Returns null when the visit has no checklist at all (minted or prospective).
create or replace function public.job_form_summary(p_job_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_job public.jobs;
  v_total int := 0;
  v_done int := 0;
  v_req_total int := 0;
  v_req_done int := 0;
  v_forms int := 0;
  v_waived boolean := false;
  v_default record;
  v_form record;
  v_field record;
  v_answered boolean;
begin
  select * into v_job from public.jobs where id = p_job_id and user_id = p_user_id;
  if not found then return null; end if;

  for v_form in
    select jf.id, jf.fields, jf.waived_at
    from public.job_forms jf
    where jf.job_id = v_job.id and jf.user_id = v_job.user_id
  loop
    v_forms := v_forms + 1;
    if v_form.waived_at is not null then v_waived := true; end if;
    for v_field in
      select (f ->> 'id')::uuid as id, f ->> 'type' as type,
             coalesce((f ->> 'required')::boolean, false) as required
      from jsonb_array_elements(v_form.fields) f
      where f ->> 'type' not in ('section','instruction')
    loop
      if v_field.type = 'photo' then
        select exists (
          select 1 from public.job_form_responses r
          join public.job_form_response_photos p on p.response_id = r.id and p.user_id = r.user_id
          where r.form_id = v_form.id and r.user_id = v_job.user_id and r.field_id = v_field.id
        ) into v_answered;
      else
        select exists (
          select 1 from public.job_form_responses r
          where r.form_id = v_form.id and r.user_id = v_job.user_id and r.field_id = v_field.id
        ) into v_answered;
      end if;
      v_total := v_total + 1;
      if v_answered then v_done := v_done + 1; end if;
      if v_field.required then
        v_req_total := v_req_total + 1;
        if v_answered then v_req_done := v_req_done + 1; end if;
      end if;
    end loop;
  end loop;

  select * into v_default from public.job_form_default_template(v_job);
  if v_default.template_id is not null and not exists (
    select 1 from public.job_forms jf
    where jf.job_id = v_job.id and jf.user_id = v_job.user_id and jf.template_id = v_default.template_id
  ) then
    v_forms := v_forms + 1;
    select v_total + count(*),
           v_req_total + count(*) filter (where f.required)
      into v_total, v_req_total
    from public.form_template_fields f
    where f.template_id = v_default.template_id and f.user_id = v_job.user_id
      and f.field_type not in ('section','instruction');
  end if;

  if v_forms = 0 then return null; end if;
  return jsonb_build_object(
    'forms', v_forms, 'items', v_total, 'done', v_done,
    'required', v_req_total, 'required_done', v_req_done,
    'waived', v_waived);
end;
$$;

-- The owner-facing gate read: "may this visit complete, and if not, why not."
-- Scopes to the CALLER's tenant — the uid comes from the session, never a
-- parameter, so it cannot be pointed at another business's visit.
create or replace function public.job_form_gate(p_job_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_uid uuid := auth.uid();
  v_missing jsonb;
begin
  if v_uid is null then return null; end if;
  if not exists (select 1 from public.jobs where id = p_job_id and user_id = v_uid) then
    return null;
  end if;
  v_missing := public.job_form_missing_items(p_job_id, v_uid);
  return jsonb_build_object('ready', jsonb_array_length(v_missing) = 0, 'missing', v_missing);
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4 · Guard triggers (the contracts the app cannot break)
-- ─────────────────────────────────────────────────────────────────────────────

-- The snapshot is history. Once minted, only the waive columns (and
-- updated_at) may change — a template edit, a rename, a re-point all bounce.
create or replace function public.job_forms_freeze_guard()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if new.fields is distinct from old.fields
     or new.template_name is distinct from old.template_name
     or new.template_id is distinct from old.template_id
     or new.job_id is distinct from old.job_id
     or new.user_id is distinct from old.user_id
     or new.source is distinct from old.source
     or new.created_at is distinct from old.created_at then
    raise exception 'a job form is a historical record — its snapshot cannot be edited (only waive fields may change)';
  end if;
  -- a waive is an override with a name on it: the waiver must be the session
  if new.waived_at is not null and old.waived_at is null then
    if auth.uid() is not null and new.waived_by is distinct from auth.uid() then
      raise exception 'a waive must name the person who waived it';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists job_forms_freeze on public.job_forms;
create trigger job_forms_freeze
  before update on public.job_forms
  for each row execute function public.job_forms_freeze_guard();

-- Every answer is validated against the SNAPSHOT it answers, on the way in:
-- right field, right value column, non-empty, honest attribution — and once
-- the visit is completed the form is frozen (owner corrections must carry a
-- reason; crew edits are refused outright; deletes are refused for everyone).
create or replace function public.job_form_response_guard()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_row public.job_form_responses;
  v_form public.job_forms;
  v_job public.jobs;
  v_field jsonb;
  v_type text;
  v_values int;
begin
  if tg_op = 'DELETE' then v_row := old; else v_row := new; end if;
  select * into v_form from public.job_forms where id = v_row.form_id and user_id = v_row.user_id;
  if not found then
    raise exception 'response does not belong to a form of this business';
  end if;
  select * into v_job from public.jobs where id = v_form.job_id;

  -- ── the freeze ─────────────────────────────────────────────────────────────
  if v_job.status = 'completed' then
    if tg_op = 'DELETE' then
      raise exception 'this visit is completed — its checklist is a historical record and answers cannot be removed';
    end if;
    if new.correction_reason is null or new.corrected_at is null or new.corrected_by is null then
      raise exception 'this visit is completed — a change to its checklist must be an explicit correction with a reason';
    end if;
    if auth.uid() is not null and new.corrected_by is distinct from auth.uid() then
      raise exception 'a correction must name the person who made it';
    end if;
    if new.answered_role = 'crew' and tg_op = 'UPDATE' then
      raise exception 'a completed checklist is frozen for crew — ask the office to correct it';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;

  -- ── attribution is real ───────────────────────────────────────────────────
  -- A new answer names the session that wrote it. A re-answer moves the
  -- attribution to the re-answerer. The ONE exception: an owner CORRECTION may
  -- keep the original answered_by (history says who answered; corrected_by
  -- says who amended it) — but then corrected_by must be the session.
  if auth.uid() is not null and new.answered_by is distinct from auth.uid() then
    if not (tg_op = 'UPDATE'
            and new.answered_by = old.answered_by
            and new.corrected_by = auth.uid()) then
      raise exception 'an answer must be attributed to the session that wrote it';
    end if;
  end if;

  -- ── the field must exist in the snapshot, and be answerable ───────────────
  select f into v_field
  from jsonb_array_elements(v_form.fields) f
  where (f ->> 'id')::uuid = new.field_id;
  if v_field is null then
    raise exception 'that field is not on this form';
  end if;
  v_type := v_field ->> 'type';
  if v_type in ('section','instruction') then
    raise exception 'headings and instructions are not answerable';
  end if;

  -- ── exactly the right value, never an empty one ───────────────────────────
  v_values := (new.value_text is not null)::int + (new.value_number is not null)::int
            + (new.value_bool is not null)::int + (new.value_date is not null)::int
            + (new.value_time is not null)::int + (new.value_choice is not null)::int;

  if v_type = 'photo' then
    if v_values <> 0 then
      raise exception 'a photo field carries photos, not a typed value';
    end if;
  elsif v_values <> 1 then
    raise exception 'a response carries exactly one value (got %)', v_values;
  elsif v_type = 'checkbox' then
    if new.value_bool is not true then
      raise exception 'a checkbox is either checked (true) or has no response row at all';
    end if;
  elsif v_type = 'yes_no' then
    if new.value_bool is null then
      raise exception 'a yes/no answer is the value_bool column';
    end if;
  elsif v_type in ('short_text','long_text') then
    if new.value_text is null or btrim(new.value_text) = '' then
      raise exception 'a text answer cannot be blank';
    end if;
    if v_type = 'short_text' and char_length(new.value_text) > 200 then
      raise exception 'a short answer is at most 200 characters';
    end if;
  elsif v_type = 'number' then
    if new.value_number is null then
      raise exception 'a number answer is the value_number column';
    end if;
  elsif v_type = 'dropdown' then
    if new.value_choice is null then
      raise exception 'a dropdown answer is the value_choice column';
    end if;
    if not exists (
      select 1 from jsonb_array_elements(coalesce(v_field -> 'options', '[]'::jsonb)) o
      where o #>> '{}' = new.value_choice
    ) then
      raise exception 'that choice is not one of this field''s options';
    end if;
  elsif v_type = 'date' then
    if new.value_date is null then
      raise exception 'a date answer is the value_date column';
    end if;
  elsif v_type = 'time' then
    if new.value_time is null then
      raise exception 'a time answer is the value_time column';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists job_form_response_gate on public.job_form_responses;
create trigger job_form_response_gate
  before insert or update or delete on public.job_form_responses
  for each row execute function public.job_form_response_guard();

-- A checklist photo must be a photo OF THIS VISIT, linked to a photo field,
-- and never added after the visit completed.
create or replace function public.job_form_response_photo_guard()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_resp public.job_form_responses;
  v_form public.job_forms;
  v_job public.jobs;
  v_photo public.job_photos;
  v_field jsonb;
begin
  select * into v_resp from public.job_form_responses where id = new.response_id and user_id = new.user_id;
  if not found then raise exception 'that response does not exist in this business'; end if;
  select * into v_form from public.job_forms where id = v_resp.form_id and user_id = v_resp.user_id;
  select * into v_job from public.jobs where id = v_form.job_id;
  select * into v_photo from public.job_photos where id = new.photo_id and user_id = new.user_id;
  if not found then raise exception 'that photo does not exist in this business'; end if;

  if v_photo.job_id is distinct from v_form.job_id then
    raise exception 'a checklist photo must be a photo of this visit, not another one';
  end if;
  select f into v_field
  from jsonb_array_elements(v_form.fields) f
  where (f ->> 'id')::uuid = v_resp.field_id;
  if v_field is null or (v_field ->> 'type') <> 'photo' then
    raise exception 'photos attach to photo fields only';
  end if;
  if v_job.status = 'completed' then
    raise exception 'this visit is completed — its checklist evidence is a historical record';
  end if;
  return new;
end;
$$;

drop trigger if exists job_form_response_photo_gate on public.job_form_response_photos;
create trigger job_form_response_photo_gate
  before insert or update on public.job_form_response_photos
  for each row execute function public.job_form_response_photo_guard();

-- ⭐ THE COMPLETION GATE. Fires on the TRANSITION to completed only — never on
-- a re-save of a finished visit, never on Stop-for-today (which keeps
-- in_progress), never on insert. Backstops every completion door at once.
create or replace function public.job_forms_completion_gate()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_missing jsonb;
  v_labels text;
begin
  if new.status = 'completed' and old.status is distinct from 'completed' then
    v_missing := public.job_form_missing_items(new.id, new.user_id);
    if jsonb_array_length(v_missing) > 0 then
      select string_agg(m ->> 'label', ' · ') into v_labels
      from (select m from jsonb_array_elements(v_missing) m limit 4) s;
      raise exception 'CHECKLIST_INCOMPLETE Before completing: %', v_labels
        using hint = 'Finish the required checklist items, or waive the checklist with a reason.';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists ab_job_forms_completion_gate on public.jobs;
create trigger ab_job_forms_completion_gate
  before update on public.jobs
  for each row execute function public.job_forms_completion_gate();

-- updated_at bookkeeping, the house trigger
drop trigger if exists form_templates_updated_at on public.form_templates;
create trigger form_templates_updated_at
  before update on public.form_templates
  for each row execute function public.handle_updated_at();
drop trigger if exists form_template_fields_updated_at on public.form_template_fields;
create trigger form_template_fields_updated_at
  before update on public.form_template_fields
  for each row execute function public.handle_updated_at();
drop trigger if exists job_forms_updated_at on public.job_forms;
create trigger job_forms_updated_at
  before update on public.job_forms
  for each row execute function public.handle_updated_at();
drop trigger if exists job_form_responses_updated_at on public.job_form_responses;
create trigger job_form_responses_updated_at
  before update on public.job_form_responses
  for each row execute function public.handle_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- 5 · Crew RPCs — the ONLY crew doors (a crew session has zero table access)
-- ─────────────────────────────────────────────────────────────────────────────

-- Open a visit's checklist(s): re-proves employer + crew, mints any default
-- that should exist (so "the form is attached when the job is created" is
-- true the moment anyone looks), and returns snapshots + answers + photo
-- links. Returns NULL for a visit that is not this worker's — "not yours" and
-- "no checklist" are different answers.
create or replace function public.crew_job_forms(p_job_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_employer uuid := public.crew_employer();
  v_crew uuid := public.crew_crew_id();
  v_job public.jobs;
  v_out jsonb;
begin
  if v_employer is null or v_crew is null then return null; end if;
  select * into v_job from public.jobs
  where id = p_job_id and user_id = v_employer and crew_id = v_crew;
  if not found then return null; end if;

  perform public.ensure_job_forms(p_job_id);

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', jf.id,
    'template_name', jf.template_name,
    'fields', jf.fields,
    'waived', jf.waived_at is not null,
    'frozen', v_job.status = 'completed',
    'responses', coalesce((
      select jsonb_agg(jsonb_build_object(
        'field_id', r.field_id,
        'value_text', r.value_text,
        'value_number', r.value_number,
        'value_bool', r.value_bool,
        'value_date', r.value_date,
        'value_time', r.value_time,
        'value_choice', r.value_choice,
        'answered_role', r.answered_role,
        'answered_at', r.answered_at,
        'answered_name', coalesce(
          (select t.name from public.technicians t
           where t.auth_user_id = r.answered_by and t.user_id = jf.user_id
           limit 1),
          'Office'),
        'photos', coalesce((
          select jsonb_agg(jsonb_build_object('id', p.id, 'storage_path', ph.storage_path)
                           order by p.created_at)
          from public.job_form_response_photos p
          join public.job_photos ph on ph.id = p.photo_id and ph.user_id = p.user_id
          where p.response_id = r.id and p.user_id = r.user_id
        ), '[]'::jsonb)
      ) order by r.created_at)
      from public.job_form_responses r
      where r.form_id = jf.id and r.user_id = jf.user_id
    ), '[]'::jsonb)
  ) order by jf.created_at), '[]'::jsonb)
  into v_out
  from public.job_forms jf
  where jf.job_id = v_job.id and jf.user_id = v_job.user_id;

  return v_out;
end;
$$;

-- Write ONE answer, typed parameters only — never a jsonb patch a client
-- could stuff a column name into. All value parameters null = clear the
-- answer. The response guard trigger re-validates everything on the way in.
create or replace function public.crew_save_form_response(
  p_form_id uuid,
  p_field_id uuid,
  p_value_text text,
  p_value_number numeric,
  p_value_bool boolean,
  p_value_date date,
  p_value_time time,
  p_value_choice text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_employer uuid := public.crew_employer();
  v_crew uuid := public.crew_crew_id();
  v_form public.job_forms;
  v_job public.jobs;
  v_empty boolean;
begin
  if v_employer is null or v_crew is null then
    return jsonb_build_object('ok', false, 'reason', 'not_yours');
  end if;
  select * into v_form from public.job_forms where id = p_form_id and user_id = v_employer;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_yours'); end if;
  select * into v_job from public.jobs
  where id = v_form.job_id and user_id = v_employer and crew_id = v_crew;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_yours'); end if;
  if v_job.status = 'cancelled' then
    return jsonb_build_object('ok', false, 'reason', 'cancelled');
  end if;
  if v_job.status = 'completed' then
    return jsonb_build_object('ok', false, 'reason', 'completed');
  end if;

  v_empty := p_value_text is null and p_value_number is null and p_value_bool is null
         and p_value_date is null and p_value_time is null and p_value_choice is null;

  if v_empty then
    delete from public.job_form_responses
    where form_id = v_form.id and user_id = v_employer and field_id = p_field_id;
    return jsonb_build_object('ok', true, 'cleared', true);
  end if;

  insert into public.job_form_responses as r
    (user_id, form_id, field_id, value_text, value_number, value_bool,
     value_date, value_time, value_choice, answered_by, answered_role, answered_at)
  values
    (v_employer, v_form.id, p_field_id, p_value_text, p_value_number, p_value_bool,
     p_value_date, p_value_time, p_value_choice, auth.uid(), 'crew', now())
  on conflict (form_id, field_id) do update set
    value_text = excluded.value_text,
    value_number = excluded.value_number,
    value_bool = excluded.value_bool,
    value_date = excluded.value_date,
    value_time = excluded.value_time,
    value_choice = excluded.value_choice,
    answered_by = excluded.answered_by,
    answered_role = excluded.answered_role,
    answered_at = now();

  return jsonb_build_object('ok', true);
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6 · crew_day: the Today list carries a counts-only checklist summary per
--     stop (no field content, no N+1 — the full form loads when a visit is
--     opened via crew_job_forms). This is the ONLY change to crew_day; the
--     definition below is otherwise production's verbatim (pulled from
--     pg_get_functiondef on 2026-08-15 and reconciled — never trust a repo
--     copy of a live function).
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.crew_day(p_date date)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_employer uuid := public.crew_employer();
  v_crew     uuid := public.crew_crew_id();
  v_tech     uuid := public.crew_technician_id();
  v_out      jsonb;
begin
  if v_employer is null then
    return null;
  end if;
  select jsonb_build_object(
    'date', p_date,
    'me', (
      select jsonb_build_object('id', t.id, 'name', t.name, 'role', t.role, 'status', t.status)
      from public.technicians t where t.id = v_tech
    ),
    'crew', (
      select jsonb_build_object('id', c.id, 'name', c.name, 'color', c.color, 'day_start', c.day_start)
      from public.crews c where c.id = v_crew and c.user_id = v_employer
    ),
    'business', (
      select jsonb_build_object('name', b.company_name, 'phone', b.phone, 'work_start_time', b.work_start_time)
      from public.business_settings b where b.user_id = v_employer
    ),
    'teammates', coalesce((
      select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'role', t.role) order by t.name)
      from public.technicians t
      where t.user_id = v_employer and t.crew_id = v_crew
        and t.is_active and t.archived_at is null and t.id is distinct from v_tech
    ), '[]'::jsonb),
    'day_note', (
      select d.body from public.dispatch_notes d
      where d.user_id = v_employer and d.date = p_date and d.crew_id is null
    ),
    'crew_note', (
      select d.body from public.dispatch_notes d
      where d.user_id = v_employer and d.date = p_date and d.crew_id = v_crew
    ),
    'stops', coalesce((
      select jsonb_agg(x.stop order by x.route_rank, x.start_key, x.created_at)
      from (
        select
          jsonb_build_object(
            'id', j.id,
            'title', j.title,
            'service_type', j.service_type,
            'scheduled_date', j.scheduled_date,
            'start_time', j.start_time,
            'duration_minutes', j.duration_minutes,
            'crew_size', j.crew_size,
            'status', j.status,
            'started_at', j.started_at,
            'completed_at', j.completed_at,
            'actual_minutes', j.actual_minutes,
            'on_my_way_at', j.on_my_way_at,
            'route_order', j.route_order,
            'updated_at', j.updated_at,
            'notes', j.notes,
            'completion_summary', j.completion_summary,
            'completion_issue', j.completion_issue,
            'checklist', public.job_form_summary(j.id, j.user_id),
            'customer', case when cu.id is null then null else
              jsonb_build_object('name', cu.name, 'phone', cu.phone) end,
            'property', case when p.id is null then null else
              jsonb_build_object('address', p.address, 'lat', p.lat, 'lng', p.lng) end
          ) as stop,
          coalesce(j.route_order, 999999) as route_rank,
          coalesce(j.start_time::text, '99:99') as start_key,
          j.created_at
        from public.jobs j
        left join public.customers cu on cu.id = j.customer_id
        left join public.properties p on p.id = j.property_id
        where j.user_id = v_employer
          and j.crew_id = v_crew
          and j.scheduled_date = p_date
      ) x
    ), '[]'::jsonb)
  ) into v_out;
  return v_out;
end
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7 · RLS + grants (the grants trap: default privileges hand every role
--     everything at CREATE time — revoke by role name, then grant on purpose)
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.form_templates enable row level security;
alter table public.form_template_fields enable row level security;
alter table public.job_forms enable row level security;
alter table public.job_form_responses enable row level security;
alter table public.job_form_response_photos enable row level security;

drop policy if exists "form_templates: select own" on public.form_templates;
create policy "form_templates: select own" on public.form_templates for select using (auth.uid() = user_id);
drop policy if exists "form_templates: insert own" on public.form_templates;
create policy "form_templates: insert own" on public.form_templates for insert with check (auth.uid() = user_id);
drop policy if exists "form_templates: update own" on public.form_templates;
create policy "form_templates: update own" on public.form_templates for update using (auth.uid() = user_id);
drop policy if exists "form_templates: delete own" on public.form_templates;
create policy "form_templates: delete own" on public.form_templates for delete using (auth.uid() = user_id);

drop policy if exists "form_template_fields: select own" on public.form_template_fields;
create policy "form_template_fields: select own" on public.form_template_fields for select using (auth.uid() = user_id);
drop policy if exists "form_template_fields: insert own" on public.form_template_fields;
create policy "form_template_fields: insert own" on public.form_template_fields for insert with check (auth.uid() = user_id);
drop policy if exists "form_template_fields: update own" on public.form_template_fields;
create policy "form_template_fields: update own" on public.form_template_fields for update using (auth.uid() = user_id);
drop policy if exists "form_template_fields: delete own" on public.form_template_fields;
create policy "form_template_fields: delete own" on public.form_template_fields for delete using (auth.uid() = user_id);

drop policy if exists "job_forms: select own" on public.job_forms;
create policy "job_forms: select own" on public.job_forms for select using (auth.uid() = user_id);
drop policy if exists "job_forms: insert own" on public.job_forms;
create policy "job_forms: insert own" on public.job_forms for insert with check (auth.uid() = user_id);
drop policy if exists "job_forms: update own" on public.job_forms;
create policy "job_forms: update own" on public.job_forms for update using (auth.uid() = user_id);
drop policy if exists "job_forms: delete own" on public.job_forms;
create policy "job_forms: delete own" on public.job_forms for delete using (auth.uid() = user_id);

drop policy if exists "job_form_responses: select own" on public.job_form_responses;
create policy "job_form_responses: select own" on public.job_form_responses for select using (auth.uid() = user_id);
drop policy if exists "job_form_responses: insert own" on public.job_form_responses;
create policy "job_form_responses: insert own" on public.job_form_responses for insert with check (auth.uid() = user_id);
drop policy if exists "job_form_responses: update own" on public.job_form_responses;
create policy "job_form_responses: update own" on public.job_form_responses for update using (auth.uid() = user_id);
drop policy if exists "job_form_responses: delete own" on public.job_form_responses;
create policy "job_form_responses: delete own" on public.job_form_responses for delete using (auth.uid() = user_id);

drop policy if exists "job_form_response_photos: select own" on public.job_form_response_photos;
create policy "job_form_response_photos: select own" on public.job_form_response_photos for select using (auth.uid() = user_id);
drop policy if exists "job_form_response_photos: insert own" on public.job_form_response_photos;
create policy "job_form_response_photos: insert own" on public.job_form_response_photos for insert with check (auth.uid() = user_id);
drop policy if exists "job_form_response_photos: delete own" on public.job_form_response_photos;
create policy "job_form_response_photos: delete own" on public.job_form_response_photos for delete using (auth.uid() = user_id);

revoke all on table public.form_templates from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.form_templates to authenticated;
grant all on table public.form_templates to service_role;

revoke all on table public.form_template_fields from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.form_template_fields to authenticated;
grant all on table public.form_template_fields to service_role;

revoke all on table public.job_forms from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.job_forms to authenticated;
grant all on table public.job_forms to service_role;

revoke all on table public.job_form_responses from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.job_form_responses to authenticated;
grant all on table public.job_form_responses to service_role;

revoke all on table public.job_form_response_photos from public, anon, authenticated, service_role;
grant select, insert, delete on table public.job_form_response_photos to authenticated;
grant all on table public.job_form_response_photos to service_role;

-- Functions: internal engines are service_role-only; the crew doors and the
-- owner gate are authenticated. Revoke BY ROLE NAME — `revoke from public`
-- does not undo what default privileges handed a named role at CREATE time.

revoke all on function public.form_options_ok(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.form_options_ok(jsonb) to authenticated, service_role;

revoke all on function public.job_form_default_template(public.jobs) from public, anon, authenticated, service_role;
grant execute on function public.job_form_default_template(public.jobs) to service_role;

revoke all on function public.form_template_snapshot(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.form_template_snapshot(uuid, uuid) to service_role;

revoke all on function public.job_form_missing_items(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.job_form_missing_items(uuid, uuid) to service_role;

revoke all on function public.job_form_summary(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.job_form_summary(uuid, uuid) to service_role;

revoke all on function public.ensure_job_forms(uuid) from public, anon, authenticated, service_role;
grant execute on function public.ensure_job_forms(uuid) to authenticated, service_role;

revoke all on function public.job_form_gate(uuid) from public, anon, authenticated, service_role;
grant execute on function public.job_form_gate(uuid) to authenticated, service_role;

revoke all on function public.crew_job_forms(uuid) from public, anon, authenticated, service_role;
grant execute on function public.crew_job_forms(uuid) to authenticated, service_role;

revoke all on function public.crew_save_form_response(uuid, uuid, text, numeric, boolean, date, time, text) from public, anon, authenticated, service_role;
grant execute on function public.crew_save_form_response(uuid, uuid, text, numeric, boolean, date, time, text) to authenticated, service_role;

revoke all on function public.job_forms_freeze_guard() from public, anon, authenticated, service_role;
grant execute on function public.job_forms_freeze_guard() to service_role;
revoke all on function public.job_form_response_guard() from public, anon, authenticated, service_role;
grant execute on function public.job_form_response_guard() to service_role;
revoke all on function public.job_form_response_photo_guard() from public, anon, authenticated, service_role;
grant execute on function public.job_form_response_photo_guard() to service_role;
revoke all on function public.job_forms_completion_gate() from public, anon, authenticated, service_role;
grant execute on function public.job_forms_completion_gate() to service_role;

-- Prove the lockdown from inside the migration (the baseline's own habit):
do $$ begin
  if has_function_privilege('anon', 'public.crew_job_forms(uuid)', 'execute') then
    raise exception 'anon must not execute crew_job_forms';
  end if;
  if has_function_privilege('anon', 'public.job_form_missing_items(uuid, uuid)', 'execute') then
    raise exception 'anon must not execute job_form_missing_items';
  end if;
  if has_table_privilege('anon', 'public.job_forms', 'select') then
    raise exception 'anon must not read job_forms';
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8 · Contracts, in the catalogue where the next reader will look
-- ─────────────────────────────────────────────────────────────────────────────

comment on table public.form_templates is
  'Reusable checklist/form definitions (Job Forms V1). Owner+crew audience — no portal projection may select these tables. Archive (archived_at), never hard-delete: job_forms.template_id RESTRICTs deletion once instances exist.';
comment on table public.form_template_fields is
  'The fields of a form template. Editing them affects FUTURE instances only — job_forms carries a frozen snapshot.';
comment on table public.job_forms is
  'A form instance attached to ONE visit (a jobs row). fields = frozen snapshot at attach time, immutable by trigger. waived_* = the owner''s recorded completion-gate override (the audit-trail seam).';
comment on column public.job_forms.fields is
  'Frozen snapshot of the template''s fields at attach time. Historical record — guarded by job_forms_freeze.';
comment on table public.job_form_responses is
  'Answers, one row per (form, field). answered_by/answered_role/answered_at record who actually wrote it — never inferred. Frozen with the visit: post-completion changes require correction_reason (owner only).';
comment on table public.job_form_response_photos is
  'Links a photo-field response to canonical job_photos rows OF THE SAME VISIT (trigger-enforced). No second upload path exists.';
comment on column public.service_templates.form_template_id is
  'Default checklist for work created from this service. Resolved at attach time (lazily) — changing it never rewrites an already-minted job form.';
comment on column public.job_recurrences.form_template_id is
  'Default checklist for this recurring series'' visits; wins over the service template''s default. Each visit mints its own independent instance.';
