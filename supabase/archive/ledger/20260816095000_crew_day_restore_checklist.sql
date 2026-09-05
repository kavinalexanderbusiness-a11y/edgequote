-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION 
—
 HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260816095000
--   name    : crew_day_restore_checklist
--
-- Applied to production 2026-08-16 via the management API (Session 75) and
-- recorded in the ledger. Restores the checklist key session 65 dropped;
-- folded into the baseline by npm run schema:baseline.
--
-- ═══════════════════════════════════════════════════════════════════════════

-- ── crew_day: restore the checklist summary S65 dropped ─────────────────────
--
-- NOT a session 75 feature. Session 69 landed job forms and added ONE key to
-- crew_day:
--     'checklist', public.job_form_summary(j.id, j.user_id)
-- so the crew Today list can answer "how much is left" per stop without
-- shipping a single field. Session 65 then applied crews_team_assignments_v1
-- (ledger 20260816043000) whose crew_day body was written against a PRE-S69
-- base: its new 'personal' key landed on exactly the line the checklist key
-- occupied, and CREATE OR REPLACE silently dropped it. Production has been
-- serving a crew Today list with no checklist counts ever since.
--
-- This is the failure docs/MIGRATIONS.md warns about in its own words — an
-- older function body replayed over a newer one, no error, less product.
-- Found by verify:job-forms only after session 75 resynced the baseline from
-- production; on main the baseline still held the S69 body, so nothing failed.
--
-- The repair keeps BOTH keys. S65's crew-assignment logic is untouched — the
-- body below is production's current definition with one line added back.
CREATE OR REPLACE FUNCTION public.crew_day(p_date date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
            'personal', (j.technician_id is not null and j.technician_id = v_tech),
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
          and public.crew_assignment_covers(j.crew_id, j.technician_id, v_crew, v_tech)
          and j.scheduled_date = p_date
      ) x
    ), '[]'::jsonb)
  ) into v_out;
  return v_out;
end
$function$;
