-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260717012601
--   name    : integrations_stabilization
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

-- Mirror of supabase/RUN-2026-07-16-integrations-stabilization.sql (committed).
-- Post-merge compatibility: invoice.paid fires on 'overpaid' too; payment.recorded
-- gated to kind='payment'; quote/job/invoice payloads carry property_id;
-- request.created carries kind. Replaces THE one capture function only.

create or replace function public.capture_integration_event()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_event text; v_entity text; v_id uuid; v_user uuid; v_payload jsonb;
begin
  if tg_table_name = 'customers' then
    v_entity := 'customer'; v_id := new.id; v_user := new.user_id;
    if tg_op = 'INSERT' then
      v_event := 'customer.created';
      v_payload := jsonb_build_object('id', new.id, 'name', new.name, 'email', new.email,
        'phone', new.phone, 'address', new.address, 'city', new.city,
        'acquisition_source', new.acquisition_source, 'created_at', new.created_at);
    end if;
  elsif tg_table_name = 'quotes' then
    v_entity := 'quote'; v_id := new.id; v_user := new.user_id;
    v_payload := jsonb_build_object('id', new.id, 'quote_number', new.quote_number,
      'customer_id', new.customer_id, 'customer_name', new.customer_name,
      'property_id', new.property_id,
      'service_type', new.service_type, 'status', new.status, 'total', new.total,
      'address', new.address, 'created_at', new.created_at);
    if tg_op = 'INSERT' then
      v_event := 'quote.created';
    elsif tg_op = 'UPDATE' and new.status is distinct from old.status then
      if new.status = 'accepted' then v_event := 'quote.accepted';
      elsif new.status = 'declined' then v_event := 'quote.declined';
      end if;
    end if;
  elsif tg_table_name = 'jobs' then
    v_entity := 'job'; v_id := new.id; v_user := new.user_id;
    v_payload := jsonb_build_object('id', new.id, 'customer_id', new.customer_id,
      'property_id', new.property_id,
      'title', new.title, 'service_type', new.service_type, 'status', new.status,
      'scheduled_date', new.scheduled_date, 'price', new.price, 'crew_id', new.crew_id,
      'created_at', new.created_at);
    if tg_op = 'INSERT' then
      v_event := 'job.created';
    elsif tg_op = 'UPDATE' and new.status = 'completed' and old.status is distinct from 'completed' then
      v_event := 'job.completed';
      v_payload := v_payload || jsonb_build_object('completed_at', new.completed_at, 'actual_minutes', new.actual_minutes);
    end if;
  elsif tg_table_name = 'invoices' then
    v_entity := 'invoice'; v_id := new.id; v_user := new.user_id;
    v_payload := jsonb_build_object('id', new.id, 'invoice_number', new.invoice_number,
      'customer_id', new.customer_id, 'customer_name', new.customer_name,
      'property_id', new.property_id,
      'status', new.status, 'amount', new.amount, 'amount_paid', new.amount_paid,
      'due_date', new.due_date, 'created_at', new.created_at);
    if tg_op = 'INSERT' then
      v_event := 'invoice.created';
    elsif tg_op = 'UPDATE'
      and new.status in ('paid', 'overpaid')
      and coalesce(old.status, '') not in ('paid', 'overpaid') then
      v_event := 'invoice.paid';
      v_payload := v_payload || jsonb_build_object('paid_at', new.paid_at);
    end if;
  elsif tg_table_name = 'payments' then
    v_entity := 'payment'; v_id := new.id; v_user := new.user_id;
    if tg_op = 'INSERT'
      and coalesce(new.status, 'paid') in ('paid', 'succeeded')
      and coalesce(new.kind, 'payment') = 'payment' then
      v_event := 'payment.recorded';
      v_payload := jsonb_build_object('id', new.id, 'customer_id', new.customer_id,
        'invoice_id', new.invoice_id, 'amount', new.amount, 'currency', new.currency,
        'method', new.method, 'kind', new.kind, 'paid_at', new.paid_at, 'created_at', new.created_at);
    end if;
  elsif tg_table_name = 'service_requests' then
    v_entity := 'request'; v_id := new.id; v_user := new.user_id;
    if tg_op = 'INSERT' then
      v_event := 'request.created';
      v_payload := jsonb_build_object('id', new.id, 'customer_id', new.customer_id,
        'kind', coalesce(new.kind, 'service'),
        'message', new.message, 'status', new.status, 'created_at', new.created_at);
    end if;
  end if;

  if v_event is null or v_user is null then return new; end if;

  if not exists (select 1 from public.webhook_endpoints e where e.user_id = v_user and e.active)
     and not exists (select 1 from public.api_keys k where k.user_id = v_user and k.revoked_at is null)
  then return new; end if;

  begin
    insert into public.integration_events (user_id, event, entity_type, entity_id, payload)
    values (v_user, v_event, v_entity, v_id, v_payload);
  exception when others then
    null;
  end;
  return new;
end; $$;

revoke execute on function public.capture_integration_event() from public, anon, authenticated;