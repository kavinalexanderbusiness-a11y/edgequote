-- DORMANT fixed email-absent profile. Reviewed quiescent installation only.
-- This creates no email table, trigger, index, FK or compatibility wrapper.
begin;
create function public._pilot_quote_email_expected_profile() returns jsonb
language sql immutable set search_path='' as $$
  select '{"version":1,"profile":"absent","catalogue_sha256":"f933cd59b92fd1f107bbf01fec03c71d9054297bb0c3c164228369ced70e88f9"}'::jsonb;
$$;
revoke all on function public._pilot_quote_email_expected_profile() from public,anon,authenticated,service_role;
do $$ begin
  if public._pilot_quote_email_profile()<>'absent' then raise exception 'pilot_quote_email_profile_unavailable' using errcode='55000'; end if;
end $$;
commit;
