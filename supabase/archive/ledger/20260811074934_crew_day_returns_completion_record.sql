-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260811074934
--   name    : crew_day_returns_completion_record
--
-- Recovered 2026-08-14 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.crew_day(p_date date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
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