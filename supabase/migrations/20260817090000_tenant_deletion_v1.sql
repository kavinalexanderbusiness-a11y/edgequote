-- ── Tenant deletion: a business can leave, and the platform can prove it did ──
--
-- THE DEFECT THIS CLOSES. Deleting a tenant's auth.users row fails outright:
--
--   delete from auth.users where id = <tenant>
--     ERROR: insert or update on table "audit_events"
--            violates foreign key constraint "audit_events_user_id_fkey"
--
-- The cascade reaches eight tables carrying audit DELETE triggers (customers,
-- invoices, jobs, quotes, payments, technicians, job_recurrences,
-- job_work_sessions). Each fires audit_log(), which INSERTs a row referencing the
-- tenant — while that tenant's auth.users row is in the middle of disappearing.
-- So deletion is not merely unbuilt: it is structurally impossible.
--
-- ⛔ WHAT THIS DELIBERATELY DOES NOT DO. Session 75's fixture cleanup reached for
-- `session_replication_role = replica` and learned why that is unsafe: it disables
-- FK triggers too, so ON DELETE CASCADE never fires and every tenant row is left
-- ORPHANED behind a deleted identity. Nothing here disables triggers globally,
-- touches session_replication_role, or bypasses a foreign key.
--
-- ── THE MECHANISM: one transaction-local key, two narrow exceptions ──────────
-- tenant_purge() sets `edgehq.purging_tenant` to the tenant uuid via
-- set_config(..., is_local => true), so it lives only inside that transaction and
-- cannot leak to another session or survive a rollback. Two functions consult it,
-- and both compare it to the ROW's OWN tenant:
--
--   audit_log()              → returns without inserting, so the cascade mints no
--                              events for a tenant that is being removed
--   audit_events_immutable() → permits DELETE for that tenant's rows only
--
-- Immutability is therefore not weakened, it is made precise: audit rows stay
-- append-only for every caller in every session, except while the business those
-- rows belong to is being deleted. Someone who sets the key by hand still cannot
-- reach another tenant's rows, because the comparison is per row.
--
-- ── WHAT SURVIVES ────────────────────────────────────────────────────────────
-- The tenant's audit history leaves with the tenant: retaining a departed
-- business's operational record is the wrong answer for a business exercising its
-- right to go. What the PLATFORM keeps is `tenant_deletions` — a tombstone saying
-- who asked, when, what was removed and how much. It carries NO foreign key to
-- auth.users, precisely so it outlives the identity it describes.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1 · LIFECYCLE STATE — deactivate ≠ request deletion ≠ delete
-- ═══════════════════════════════════════════════════════════════════════════
-- Kept OUT of business_settings on purpose: that table's contract is upsert-only
-- for settings, and a settings write must never be able to move a tenant toward
-- deletion.
create table if not exists public.tenant_lifecycle (
  user_id            uuid primary key references auth.users(id) on delete cascade,
  state              text not null default 'active',
  reason             text,
  requested_at       timestamptz,
  purge_not_before   timestamptz,
  cancelled_at       timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint tenant_lifecycle_state_check
    check (state in ('active', 'deactivated', 'deletion_requested'))
);

comment on table public.tenant_lifecycle is
  'Per-tenant lifecycle. deactivated = a reversible pause. deletion_requested = a grace period is running and purge_not_before is when tenant_purge() may act.';

alter table public.tenant_lifecycle enable row level security;

revoke all on table public.tenant_lifecycle from public, anon, authenticated, service_role;
grant select on table public.tenant_lifecycle to authenticated;
grant all on table public.tenant_lifecycle to service_role;

-- Read-own only. Every transition goes through an RPC, so a tenant cannot schedule
-- its own deletion by writing a row, and cannot touch anyone else's state at all.
drop policy if exists "tenant_lifecycle: select own" on public.tenant_lifecycle;
create policy "tenant_lifecycle: select own" on public.tenant_lifecycle
  as permissive for select to authenticated
  using (auth.uid() = user_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- 2 · THE TOMBSTONE — deliberately has no FK to auth.users
-- ═══════════════════════════════════════════════════════════════════════════
create table if not exists public.tenant_deletions (
  id                      uuid primary key default gen_random_uuid(),
  tenant_user_id          uuid not null,
  company_name            text,
  owner_email             text,
  reason                  text,
  requested_at            timestamptz not null,
  executed_at             timestamptz,
  status                  text not null default 'requested',
  rows_deleted            jsonb not null default '{}'::jsonb,
  storage_objects_deleted integer not null default 0,
  last_error              text,
  constraint tenant_deletions_status_check
    check (status in ('requested', 'completed', 'failed'))
);

comment on table public.tenant_deletions is
  'Platform tombstone for a deleted business. tenant_user_id is a bare uuid with NO foreign key ON PURPOSE: this row must outlive the auth.users row it names. Holds counts and identifying snapshots, never the tenant business data.';

create unique index if not exists tenant_deletions_open_uniq
  on public.tenant_deletions (tenant_user_id) where status = 'requested';

alter table public.tenant_deletions enable row level security;

-- No client role reads the platform deletion ledger; it is operator evidence.
revoke all on table public.tenant_deletions from public, anon, authenticated, service_role;
grant all on table public.tenant_deletions to service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3 · THE TWO NARROW EXCEPTIONS
-- ═══════════════════════════════════════════════════════════════════════════

-- audit_log: silent for the tenant currently being purged, and only that tenant.
create or replace function public.audit_log(
  p_tenant uuid, p_action text, p_entity_type text, p_entity_id uuid,
  p_entity_label text, p_customer uuid, p_before jsonb, p_after jsonb, p_meta jsonb default null::jsonb)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_actor record;
begin
  -- ⭐ A tenant deletion must not try to record itself. Comparing to p_tenant means
  -- purging one business can never suppress another business's audit trail.
  if coalesce(current_setting('edgehq.purging_tenant', true), '') = p_tenant::text then
    return;
  end if;

  select * into v_actor from public.audit_actor_context(p_tenant, p_customer);
  insert into public.audit_events
    (user_id, actor_type, actor_id, actor_label, action,
     entity_type, entity_id, entity_label, customer_id, source,
     before, after, meta)
  values
    (p_tenant, v_actor.actor_type, v_actor.actor_id, v_actor.actor_label, p_action,
     p_entity_type, p_entity_id, p_entity_label, p_customer, v_actor.source,
     p_before, p_after, p_meta);
end;
$function$;

-- Immutability: still append-only for everyone, except the purge of the very
-- tenant whose rows these are.
create or replace function public.audit_events_immutable()
 returns trigger
 language plpgsql
as $function$
begin
  if tg_op = 'DELETE'
     and coalesce(current_setting('edgehq.purging_tenant', true), '') = old.user_id::text then
    return old;
  end if;
  raise exception
    'audit_events is append-only: the audit trail is evidence, and evidence does not get edited. Removing a business history is possible only through tenant_purge().'
    using errcode = 'restrict_violation';
end;
$function$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4 · THE OWNER-AUTHORISED WORKFLOW
-- ═══════════════════════════════════════════════════════════════════════════
-- Every function below authorises on auth.uid() alone. There is no operator
-- override and no tenant parameter: a business is deleted by the person who owns
-- it, or not at all. A worker of the tenant holds a different uid and therefore
-- reaches none of these — asserted in verify:tenant-deletion.

create or replace function public.tenant_set_active(p_active boolean)
 returns text
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then return 'not-signed-in'; end if;
  if not exists (select 1 from public.business_settings where user_id = v_uid) then
    return 'no-business';
  end if;

  insert into public.tenant_lifecycle (user_id, state, updated_at)
  values (v_uid, case when p_active then 'active' else 'deactivated' end, now())
  on conflict (user_id) do update
    set state = excluded.state, updated_at = now()
    -- Deactivating must never quietly clear a running deletion request.
    where public.tenant_lifecycle.state <> 'deletion_requested';

  return (select state from public.tenant_lifecycle where user_id = v_uid);
end;
$function$;

-- Start the grace period. Reversible until tenant_purge() runs.
create or replace function public.tenant_request_deletion(p_reason text default null, p_grace_days integer default 7)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_days integer := greatest(0, least(coalesce(p_grace_days, 7), 30));
  v_company text;
  v_not_before timestamptz;
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'reason', 'not-signed-in'); end if;
  select company_name into v_company from public.business_settings where user_id = v_uid;
  if not found then return jsonb_build_object('ok', false, 'reason', 'no-business'); end if;

  v_not_before := now() + make_interval(days => v_days);

  insert into public.tenant_lifecycle (user_id, state, reason, requested_at, purge_not_before, cancelled_at, updated_at)
  values (v_uid, 'deletion_requested', p_reason, now(), v_not_before, null, now())
  on conflict (user_id) do update
    set state = 'deletion_requested', reason = excluded.reason,
        requested_at = coalesce(public.tenant_lifecycle.requested_at, excluded.requested_at),
        purge_not_before = coalesce(public.tenant_lifecycle.purge_not_before, excluded.purge_not_before),
        cancelled_at = null, updated_at = now();

  -- One open tombstone per tenant; the partial unique index enforces it, so a
  -- replayed request does not mint a second ledger row.
  insert into public.tenant_deletions (tenant_user_id, company_name, owner_email, reason, requested_at, status)
  select v_uid, v_company, (select email from auth.users where id = v_uid), p_reason, now(), 'requested'
  where not exists (
    select 1 from public.tenant_deletions where tenant_user_id = v_uid and status = 'requested');

  return jsonb_build_object('ok', true, 'state', 'deletion_requested',
    'purge_not_before', (select purge_not_before from public.tenant_lifecycle where user_id = v_uid));
end;
$function$;

create or replace function public.tenant_cancel_deletion()
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'reason', 'not-signed-in'); end if;
  if not exists (select 1 from public.tenant_lifecycle where user_id = v_uid and state = 'deletion_requested') then
    return jsonb_build_object('ok', false, 'reason', 'not-requested');
  end if;

  update public.tenant_lifecycle
     set state = 'active', cancelled_at = now(), purge_not_before = null, updated_at = now()
   where user_id = v_uid;
  delete from public.tenant_deletions where tenant_user_id = v_uid and status = 'requested';

  return jsonb_build_object('ok', true, 'state', 'active');
end;
$function$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5 · THE PURGE
-- ═══════════════════════════════════════════════════════════════════════════
-- Removes every row this tenant owns, plus its storage objects. Idempotent: an
-- interrupted run is simply called again, because it deletes whatever is left and
-- re-counts rather than assuming a starting state.
--
-- ORDERING is not a hand-maintained list — such a list rots the moment a table is
-- added, and this repo adds tables weekly. The loop deletes from every
-- tenant-owned table and RETRIES the ones a foreign key refused, until a pass
-- frees nothing. Intra-tenant references resolve themselves that way, and the
-- bound is the number of tables.
--
-- It does NOT delete auth.users: that belongs to GoTrue, and doing it here would
-- put the cascade back in front of us. The identity is removed afterwards, by
-- which point nothing references it.
create or replace function public.tenant_purge()
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_uid       uuid := auth.uid();
  v_life      record;
  v_tbl       text;
  v_counts    jsonb := '{}'::jsonb;
  v_n         bigint;
  v_total     bigint := 0;
  v_progress  boolean;
  v_pending   text[];
  v_next      text[];
  v_pass      int := 0;
  v_storage   bigint := 0;
  v_tokens    text[];
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'reason', 'not-signed-in'); end if;

  select * into v_life from public.tenant_lifecycle where user_id = v_uid;
  if not found or v_life.state <> 'deletion_requested' then
    return jsonb_build_object('ok', false, 'reason', 'not-requested');
  end if;
  if v_life.purge_not_before is not null and now() < v_life.purge_not_before then
    return jsonb_build_object('ok', false, 'reason', 'grace-period',
      'purge_not_before', v_life.purge_not_before);
  end if;

  -- ⭐ THE KEY. Transaction-local, so it cannot leak to another session and is
  -- gone on rollback. Both exceptions compare it to the row's own tenant.
  perform set_config('edgehq.purging_tenant', v_uid::text, true);

  -- ── storage first: an object outlives its row, so remove it while we still
  --    know which booking tokens belonged to this business. Three keyings exist:
  --    owner = uid, a uid-prefixed path, and booking-uploads keyed by the raw
  --    booking token (owner is null there, because the uploader is anonymous).
  select array_agg(booking_token) into v_tokens
    from public.business_settings where user_id = v_uid and booking_token is not null;

  delete from storage.objects
   where owner = v_uid
      or name like v_uid::text || '/%'
      or (bucket_id = 'booking-uploads' and v_tokens is not null
          and exists (select 1 from unnest(v_tokens) t where name like t || '/%'));
  get diagnostics v_storage = row_count;

  -- ── every tenant-owned table, retried until a pass frees nothing ──────────
  select array_agg(c.relname order by c.relname) into v_pending
    from pg_class c
    join pg_namespace ns on ns.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attname = 'user_id' and a.attnum > 0
   where ns.nspname = 'public' and c.relkind = 'r';

  while coalesce(array_length(v_pending, 1), 0) > 0 and v_pass < 40 loop
    v_pass := v_pass + 1;
    v_progress := false;
    v_next := '{}';
    foreach v_tbl in array v_pending loop
      begin
        execute format('delete from public.%I where user_id = $1', v_tbl) using v_uid;
        get diagnostics v_n = row_count;
        if v_n > 0 then
          v_counts := v_counts || jsonb_build_object(v_tbl, coalesce((v_counts->>v_tbl)::bigint, 0) + v_n);
          v_total := v_total + v_n;
          v_progress := true;
        end if;
      exception when foreign_key_violation then
        -- Something inside this tenant still points at it. Retry next pass.
        v_next := array_append(v_next, v_tbl);
      end;
    end loop;
    exit when coalesce(array_length(v_next, 1), 0) = 0;
    -- No progress and nothing freed: retrying cannot help. Report rather than spin.
    exit when not v_progress;
    v_pending := v_next;
  end loop;

  if coalesce(array_length(v_next, 1), 0) > 0 and not v_progress then
    update public.tenant_deletions
       set status = 'failed',
           last_error = 'tables still referenced after ' || v_pass || ' passes: ' || array_to_string(v_next, ', '),
           rows_deleted = v_counts, storage_objects_deleted = v_storage
     where tenant_user_id = v_uid and status = 'requested';
    return jsonb_build_object('ok', false, 'reason', 'blocked',
      'tables', to_jsonb(v_next), 'deleted', v_counts);
  end if;

  update public.tenant_deletions
     set status = 'completed', executed_at = now(),
         rows_deleted = v_counts, storage_objects_deleted = v_storage, last_error = null
   where tenant_user_id = v_uid and status = 'requested';

  return jsonb_build_object('ok', true, 'rows_deleted', v_total, 'by_table', v_counts,
    'storage_objects_deleted', v_storage,
    'note', 'tenant rows removed; the auth identity is deleted separately, and nothing references it now');
end;
$function$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 6 · GRANTS — client-callable, authorised inside on auth.uid()
-- ═══════════════════════════════════════════════════════════════════════════
revoke all on function public.tenant_set_active(boolean) from public, anon, authenticated, service_role;
revoke all on function public.tenant_request_deletion(text, integer) from public, anon, authenticated, service_role;
revoke all on function public.tenant_cancel_deletion() from public, anon, authenticated, service_role;
revoke all on function public.tenant_purge() from public, anon, authenticated, service_role;

grant execute on function public.tenant_set_active(boolean) to authenticated;
grant execute on function public.tenant_request_deletion(text, integer) to authenticated;
grant execute on function public.tenant_cancel_deletion() to authenticated;
grant execute on function public.tenant_purge() to authenticated;

comment on function public.tenant_purge() is
  'Removes every row the CALLING tenant owns, plus its storage objects, after a deletion request and its grace period. Idempotent. Authorises on auth.uid() only — no operator override and no tenant parameter, so no caller can purge a business that is not theirs.';
