-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260816031500
--   name    : job_forms_waive_audit
--
-- Applied to production 2026-08-16 via the management API (Session 68) and
-- recorded in supabase_migrations.schema_migrations. The SQL below is the
-- text production executed.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

-- â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
-- JOB FORMS: the waive joins the audit trail â€” pending migration (Session 69)
--
-- âš ï¸ LIFECYCLE â€” the same one 2026-08-15-audit-trail-v1.sql documents for
-- itself, because this file DEPENDS on that one (audit_log does not exist
-- until it runs):
--   1. apply audit-trail-v1 to production first, then this file
--      (name it job_forms_waive_audit),
--   2. npm run schema:contract && npm run schema:baseline,
--   3. DELETE both files in the same commit â€” the baseline then carries them.
--   Until then, waives are still fully recorded on the instance itself
--   (job_forms.waived_at / waived_by / waive_reason â€” written only with a
--   reason, enforced by trigger); this adds the same fact to the ONE audit
--   feed so "who overrode a checklist, and why" appears beside every other
--   accountability event.
--
-- WHY A TRIGGER (not app code): the same choke-point reasoning as every other
-- audit_* function â€” the waive is a browser supabase-js write with no server
-- seam, and the event must commit and roll back WITH the write it describes.
-- â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

create or replace function public.audit_job_forms()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_job public.jobs;
begin
  select * into v_job from public.jobs where id = new.job_id;

  if new.waived_at is not null and old.waived_at is null then
    perform public.audit_log(new.user_id, 'checklist_waived', 'visit', new.job_id,
      coalesce(v_job.title, new.template_name), v_job.customer_id,
      null,
      jsonb_build_object('form', new.template_name, 'reason', new.waive_reason),
      jsonb_build_object('form_id', new.id));
  elsif new.waived_at is null and old.waived_at is not null then
    perform public.audit_log(new.user_id, 'checklist_waive_removed', 'visit', new.job_id,
      coalesce(v_job.title, new.template_name), v_job.customer_id,
      jsonb_build_object('form', new.template_name, 'reason', old.waive_reason),
      null,
      jsonb_build_object('form_id', new.id));
  end if;

  return null;
end;
$function$;

drop trigger if exists trg_audit_job_forms_waive on public.job_forms;
create trigger trg_audit_job_forms_waive
  after update of waived_at on public.job_forms
  for each row execute function public.audit_job_forms();

revoke all on function public.audit_job_forms() from public, anon, authenticated, service_role;
grant execute on function public.audit_job_forms() to service_role;
