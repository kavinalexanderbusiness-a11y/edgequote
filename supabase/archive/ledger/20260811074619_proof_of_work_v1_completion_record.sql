-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260811074619
--   name    : proof_of_work_v1_completion_record
--
-- Recovered on 2026-08-13 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file that was believed to match it.
-- Several of these migrations never had a repo file at all.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so the reason a column looks the way it does is answerable, and for
-- no other purpose. Re-running one replaces a live object with an older body —
-- silently, with no error. That has already broken the customer portal twice.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.jobs
  add column if not exists completion_summary text,
  add column if not exists completion_issue   text;

comment on column public.jobs.completion_summary is
  'CUSTOMER-VISIBLE. What was done, written for the person who paid for it. Selected by get_portal_data and rendered verbatim in the portal visit history. Never put internal remarks here.';
comment on column public.jobs.completion_issue is
  'INTERNAL ONLY. What the field found that needs attention (leaking sprinkler head, wants a hedge quote). MUST NOT be selected by get_portal_data or reach any customer surface.';
comment on column public.jobs.notes is
  'INTERNAL ONLY. The access/instruction note for whoever does the work (gate code, where to park). Shipped to the crew by crew_day. Removed from get_portal_data 2026-08-11 — it was being rendered to customers. Customer-facing words go in completion_summary.';

create or replace function public.crew_set_completion_record(
  p_job_id  uuid,
  p_summary text default null,
  p_issue   text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_employer uuid := public.crew_employer();
  v_crew     uuid := public.crew_crew_id();
  v_summary  text := nullif(btrim(coalesce(p_summary, '')), '');
  v_issue    text := nullif(btrim(coalesce(p_issue, '')), '');
  v_prev     text;
  v_job      record;
begin
  if v_employer is null or v_crew is null then
    raise exception 'you are not on an active crew' using errcode = '42501';
  end if;

  v_summary := left(v_summary, 500);
  v_issue   := left(v_issue, 500);

  select j.completion_issue into v_prev
    from public.jobs j
   where j.id = p_job_id and j.user_id = v_employer and j.crew_id = v_crew
     and j.status <> 'cancelled';

  update public.jobs j
     set completion_summary = v_summary,
         completion_issue   = v_issue
   where j.id = p_job_id
     and j.user_id = v_employer
     and j.crew_id = v_crew
     and j.status <> 'cancelled'
  returning j.id, j.title, j.customer_id into v_job;

  if v_job.id is null then
    return jsonb_build_object('ok', false, 'reason', 'not_yours');
  end if;

  if v_issue is not null and v_prev is distinct from v_issue then
    insert into public.notifications (user_id, type, title, body, customer_id, entity_type, entity_id, href)
    select v_employer, 'crew_visit_issue', 'Your crew flagged something',
           coalesce(v_job.title, 'A visit') || ': ' || v_issue,
           v_job.customer_id, 'job', v_job.id, '/dashboard/dispatch'
     where not exists (
       select 1 from public.notifications n
        where n.user_id = v_employer and n.type = 'crew_visit_issue' and n.entity_id = v_job.id
     );
  end if;

  return jsonb_build_object('ok', true);
end
$$;

revoke all on function public.crew_set_completion_record(uuid, text, text) from anon;
revoke all on function public.crew_set_completion_record(uuid, text, text) from public;
grant execute on function public.crew_set_completion_record(uuid, text, text) to authenticated;

comment on function public.crew_set_completion_record(uuid, text, text) is
  'Crew Mode: record what was done (customer-visible) and what needs attention (internal) on an assigned, non-cancelled visit. Typed parameters only — writes exactly two columns and no lifecycle field. Re-checks employer + crew because DEFINER runs past RLS.';