-- ── Worker access V1: the job-forms doors learn the S65 assignment model ─────
--
-- WHAT IS WRONG TODAY. Session 65 made a visit assignable two ways — to a crew
-- (`jobs.crew_id`) XOR to one named person (`jobs.technician_id`) — and gave the
-- database ONE predicate for reading that back:
--
--     crew_assignment_covers(j_crew, j_technician, v_crew, v_tech)
--
-- Seven crew doors call it. Three do not. `crew_job_forms`,
-- `crew_save_form_response` and `ensure_job_forms` were written for job forms
-- against the PRE-S65 world and still ask the older, narrower question —
-- `crew_id = v_crew`, having first refused outright any worker whose `crew_id`
-- is null. The result is a worker who can SEE a stop on their board (crew_day
-- knows about by-name assignment) and then cannot open its checklist, cannot
-- answer it, and — because the completion gate is enforced by a trigger reading
-- those same forms — cannot finish the visit. One product, two answers to "is
-- this yours".
--
-- ⛔ THIS IS NOT A WIDENING OF ACCESS. Every row reachable after this migration
-- was already meant to be reachable by S65's model; the three functions were
-- simply never taught it. The tenant predicate (`user_id = v_employer`) is
-- untouched in all three, the completed/cancelled freezes are untouched, and a
-- worker with no assignment of either kind still matches nothing. What changes
-- is that being assigned BY NAME now counts as being assigned — which is the
-- entire point of the column S65 added.
--
-- ⚠️ DERIVED FROM THE CURRENT BASELINE (20260816095001), not from when this
-- lane was authored. `crew_day` was stomped once already by a CREATE OR REPLACE
-- written against an older copy of a shared function; every line below other
-- than the predicate itself is byte-identical to the baseline this migration
-- ships beside, so re-applying it cannot silently revert somebody else's work.
--
-- Idempotent: CREATE OR REPLACE only. No DDL, no data movement, no grants — the
-- three functions already carry the grants they need.

-- ── 1. crew_job_forms — reading this visit's checklists ──────────────────────
-- v_crew alone gated the lookup, so a by-name assignee got NULL (read: "no such
-- visit") for their own stop. Now: an ACTIVE worker (v_tech, which is what makes
-- somebody a worker at all) plus the canonical covers predicate.
CREATE OR REPLACE FUNCTION public.crew_job_forms(p_job_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_employer uuid := public.crew_employer();
  v_crew uuid := public.crew_crew_id();
  v_tech uuid := public.crew_technician_id();
  v_job public.jobs;
  v_out jsonb;
begin
  if v_employer is null or v_tech is null then return null; end if;
  select * into v_job from public.jobs
  where id = p_job_id and user_id = v_employer
    and public.crew_assignment_covers(crew_id, technician_id, v_crew, v_tech);
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
$function$;

-- ── 2. crew_save_form_response — answering a checklist field ─────────────────
-- The WRITE half of the same door. 'not_yours' remains the single refusal for
-- every kind of miss (wrong tenant, wrong assignment, no such form) — a worker
-- probing ids must not learn which one it was.
CREATE OR REPLACE FUNCTION public.crew_save_form_response(p_form_id uuid, p_field_id uuid, p_value_text text, p_value_number numeric, p_value_bool boolean, p_value_date date, p_value_time time without time zone, p_value_choice text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_employer uuid := public.crew_employer();
  v_crew uuid := public.crew_crew_id();
  v_tech uuid := public.crew_technician_id();
  v_form public.job_forms;
  v_job public.jobs;
  v_empty boolean;
begin
  if v_employer is null or v_tech is null then
    return jsonb_build_object('ok', false, 'reason', 'not_yours');
  end if;
  select * into v_form from public.job_forms where id = p_form_id and user_id = v_employer;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_yours'); end if;
  select * into v_job from public.jobs
  where id = v_form.job_id and user_id = v_employer
    and public.crew_assignment_covers(crew_id, technician_id, v_crew, v_tech);
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
$function$;

-- ── 3. ensure_job_forms — lazily minting this visit's checklist ──────────────
-- ⚠️ THIS ONE IS SHARED. It is called by the owner's path too, which is why the
-- crew branch is guarded by `v_uid <> v_job.user_id`: the owner falls straight
-- through, untouched. Only the crew branch changes, and only its predicate.
-- Getting this wrong in the other direction would be the serious mistake — a
-- worker who is NOT assigned must still mint nothing and say nothing.
CREATE OR REPLACE FUNCTION public.ensure_job_forms(p_job_id uuid)
 RETURNS SETOF job_forms
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_job public.jobs;
  v_uid uuid := auth.uid();
  v_employer uuid;
  v_crew uuid;
  v_tech uuid;
  v_default record;
begin
  select * into v_job from public.jobs where id = p_job_id;
  if not found then return; end if;

  if v_uid is not null and v_uid <> v_job.user_id then
    v_employer := public.crew_employer();
    v_crew := public.crew_crew_id();
    v_tech := public.crew_technician_id();
    if v_employer is null or v_employer <> v_job.user_id
       or v_tech is null
       or not public.crew_assignment_covers(v_job.crew_id, v_job.technician_id, v_crew, v_tech) then
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
$function$;
