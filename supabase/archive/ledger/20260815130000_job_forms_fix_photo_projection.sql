-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION 
—
 HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260815130000
--   name    : job_forms_fix_photo_projection
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

-- ─── Job Forms V1: crew_job_forms photo projection fix ───
-- The photos sub-select referenced p.id on job_form_response_photos, whose
-- primary key is composite (response_id, photo_id) — no id column exists.
-- plpgsql resolves that at FIRST EXECUTION, so it applied cleanly and failed
-- on the first real call. The photo's own id (ph.id) is what the client needs.

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
          select jsonb_agg(jsonb_build_object('id', ph.id, 'storage_path', ph.storage_path)
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

