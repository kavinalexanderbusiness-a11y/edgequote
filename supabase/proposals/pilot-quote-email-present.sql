-- DORMANT fixed email-present profile; requires the unchanged reviewed email
-- core. This only welds its existing private owner lock and declares the profile.
-- Digests are generated from reviewed source in a fresh disposable reference,
-- never captured from the target being certified. No live profile switching.
begin;
do $$ begin
  if encode(sha256(convert_to(public._pilot_quote_email_catalogue()::text,'UTF8')),'hex')
    is distinct from 'aadd4ce4f5338807d4364f56191c364df123c884ab69e0b6954521c27a63343c' then
    raise exception 'pilot_quote_email_original_profile_unavailable' using errcode='55000'; end if;
end $$;
-- BEGIN OWNER LOCK WELD (reference generator executes these exact bytes).
create or replace function public._pilot_email_owner_lock(p_owner uuid) returns void
language sql volatile set search_path='' as $$
  select public._pilot_quote_owner_lock(p_owner);
$$;
revoke all on function public._pilot_email_owner_lock(uuid) from public,anon,authenticated,service_role;
-- END OWNER LOCK WELD
create function public._pilot_quote_email_expected_profile() returns jsonb
language sql immutable set search_path='' as $$
  select '{"version":1,"profile":"present","catalogue_sha256":"7c1050e8576b4616cf482b740c851ec7fe4edbf4bbd0222b13506a77f12865dd"}'::jsonb;
$$;
revoke all on function public._pilot_quote_email_expected_profile() from public,anon,authenticated,service_role;
do $$ begin
  if public._pilot_quote_email_profile()<>'present' then raise exception 'pilot_quote_email_profile_unavailable' using errcode='55000'; end if;
end $$;
commit;
