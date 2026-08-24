-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION 
—
 HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260815124500
--   name    : job_forms_attach_rpc
--
-- Applied to production 2026-08-15 via the management API (Session 69) and
-- recorded in supabase_migrations.schema_migrations. The SQL below is the
-- text production executed.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body 
—
 silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Job Forms V1: the owner's manual-attach door ─────────────────────────────
-- Attaching a template to one visit by hand must mint the SAME frozen snapshot
-- the default path mints — one snapshot builder (form_template_snapshot), not a
-- TypeScript copy of it. Scoped to the caller's own tenant; archived templates
-- refuse to attach (they are history, not catalogue).

create or replace function public.attach_job_form(p_job_id uuid, p_template_id uuid)
returns setof public.job_forms
language plpgsql
volatile
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_uid uuid := auth.uid();
  v_job public.jobs;
  v_tpl public.form_templates;
begin
  if v_uid is null then return; end if;
  select * into v_job from public.jobs where id = p_job_id and user_id = v_uid;
  if not found then return; end if;
  select * into v_tpl from public.form_templates
  where id = p_template_id and user_id = v_uid and archived_at is null;
  if not found then return; end if;

  insert into public.job_forms (user_id, job_id, template_id, template_name, fields, source)
  values (v_uid, v_job.id, v_tpl.id, v_tpl.name,
          public.form_template_snapshot(v_tpl.id, v_uid), 'manual')
  on conflict (job_id, template_id) do nothing;

  return query select * from public.job_forms
    where job_id = v_job.id and user_id = v_uid and template_id = v_tpl.id;
end;
$$;

revoke all on function public.attach_job_form(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.attach_job_form(uuid, uuid) to authenticated, service_role;

do $$ begin
  if has_function_privilege('anon', 'public.attach_job_form(uuid, uuid)', 'execute') then
    raise exception 'anon must not execute attach_job_form';
  end if;
end $$;
