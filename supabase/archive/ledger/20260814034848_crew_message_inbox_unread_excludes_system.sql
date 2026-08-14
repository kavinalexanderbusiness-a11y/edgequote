-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260814034848
--   name    : crew_message_inbox_unread_excludes_system
--
-- Recovered 2026-08-14 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

-- Unread is ONE rule, spelled the same in SQL and in lib/crewMessages: a
-- PERSON'S words are unread; a system line is context. A system event has no
-- author, so counting it would badge the owner for their own reschedule.
create or replace function public.crew_message_inbox()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_employer uuid := public.crew_employer();
  v_crew     uuid := public.crew_crew_id();
  v_uid      uuid := auth.uid();
begin
  if v_employer is null or v_crew is null then
    return null;
  end if;

  return coalesce((
    select jsonb_agg(t.row order by t.unread desc, t.last_at desc)
    from (
      select jsonb_build_object(
               'job_id', j.id,
               'title', j.title,
               'customer_name', c.name,
               'scheduled_date', j.scheduled_date,
               'status', j.status,
               'unread', count(*) filter (
                 where m.created_at > coalesce(r.last_read_at, '-infinity'::timestamptz)
                   and m.created_by is distinct from v_uid
                   and m.author_kind <> 'system'),
               'last_at', max(m.created_at),
               'last_author', (array_agg(m.author_name order by m.created_at desc))[1],
               'last_body',   (array_agg(m.body        order by m.created_at desc))[1]
             ) as row,
             count(*) filter (
               where m.created_at > coalesce(r.last_read_at, '-infinity'::timestamptz)
                 and m.created_by is distinct from v_uid
                 and m.author_kind <> 'system') as unread,
             max(m.created_at) as last_at
        from public.crew_messages m
        join public.jobs j on j.id = m.job_id
        left join public.customers c on c.id = j.customer_id
        left join public.crew_message_reads r on r.job_id = j.id and r.reader_id = v_uid
       where m.user_id = v_employer
         and j.user_id = v_employer
         and j.crew_id = v_crew
         and m.created_at > now() - interval '30 days'
       group by j.id, j.title, c.name, j.scheduled_date, j.status
    ) t
  ), '[]'::jsonb);
end
$$;

revoke execute on function public.crew_message_inbox() from public, anon;
grant  execute on function public.crew_message_inbox() to authenticated;