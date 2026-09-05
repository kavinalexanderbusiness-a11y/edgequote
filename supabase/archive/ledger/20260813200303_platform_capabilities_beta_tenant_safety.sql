-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260813200303
--   name    : platform_capabilities_beta_tenant_safety
--
-- Recovered 2026-08-14 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

-- Session 43: platform capability grants for shared deployment infrastructure.
-- Full commented version lives in supabase/RUN-2026-08-13-platform-capabilities.sql

create table if not exists public.platform_capabilities (
  user_id uuid primary key references auth.users(id) on delete cascade,
  online_payments boolean not null default false,
  inbound_sms boolean not null default false,
  outbound_sms boolean not null default false,
  outbound_email boolean not null default false,
  note text,
  updated_at timestamptz not null default now()
);

comment on table public.platform_capabilities is
  'Platform-managed grants for SHARED deployment infrastructure (Stripe account, Twilio number, Resend identity). Missing row = no grants. App code reads only; rows are written by the platform operator in SQL.';

alter table public.platform_capabilities enable row level security;

drop policy if exists "capabilities: read own" on public.platform_capabilities;
create policy "capabilities: read own" on public.platform_capabilities
  for select to authenticated using (user_id = auth.uid());

revoke all on table public.platform_capabilities from anon, authenticated;
grant select on table public.platform_capabilities to authenticated;

insert into public.platform_capabilities
  (user_id, online_payments, inbound_sms, outbound_sms, outbound_email, note)
values
  ('a12a0549-7210-4b6c-829e-3ed9feb380b3', true, true, true, true,
   'Founding tenant (Edge Property Services) — owns the deployment''s Stripe account, Twilio number and Resend sending identity.')
on conflict (user_id) do nothing;

create or replace function public.find_inbound_sms_customer(p_phone text)
returns json
language plpgsql
security definer
set search_path to 'public'
as $function$
declare d text; result json;
begin
  d := right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 10);
  if length(d) < 10 then return null; end if;
  select to_json(c) into result from (
    select cu.id, cu.user_id, cu.sms_opt_in, cu.name
    from public.customers cu
    join public.platform_capabilities pc
      on pc.user_id = cu.user_id and pc.inbound_sms
    where cu.phone is not null
      and right(regexp_replace(cu.phone, '\D', '', 'g'), 10) = d
    order by cu.created_at desc limit 1
  ) c;
  return result;
end; $function$;

revoke execute on function public.find_inbound_sms_customer(text) from public, anon, authenticated;
grant execute on function public.find_inbound_sms_customer(text) to service_role;