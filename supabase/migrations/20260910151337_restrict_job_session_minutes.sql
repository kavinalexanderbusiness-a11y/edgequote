-- This aggregate is an internal trigger helper, not a client RPC.
-- Its SECURITY DEFINER body reads work sessions without tenant filtering.
-- Both callers (bank_job_clock_session and sync_job_actual_minutes) run as
-- postgres, so removing client EXECUTE leaves clock accounting intact.
revoke execute on function public.job_session_minutes(uuid) from public, anon, authenticated;

do $$
begin
  if has_function_privilege('anon', 'public.job_session_minutes(uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.job_session_minutes(uuid)', 'EXECUTE') then
    raise exception 'Work-session aggregate remains client-executable';
  end if;
  if not has_function_privilege('service_role', 'public.job_session_minutes(uuid)', 'EXECUTE')
     or not has_function_privilege('postgres', 'public.job_session_minutes(uuid)', 'EXECUTE') then
    raise exception 'Internal work-session accounting lost access';
  end if;
end;
$$;
