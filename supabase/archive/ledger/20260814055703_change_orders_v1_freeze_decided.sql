-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260814055703
--   name    : change_orders_v1_freeze_decided
--
-- Recovered 2026-08-14 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.change_order_guard_transition()
returns trigger language plpgsql security definer set search_path to 'public' as $function$
begin
  -- A DECIDED change order is a record of what was asked and what was answered.
  -- Nothing about it may move again -- including decided_via, which is the
  -- difference between "the customer tapped approve" and "the business says they
  -- agreed". Without this an owner-recorded approval could be silently rewritten
  -- as the customer's own, which is the one claim this whole feature exists to
  -- keep honest. An exact no-op update is allowed; anything else is refused.
  if old.status in ('approved', 'declined', 'cancelled') then
    if new is distinct from old then
      raise exception 'a % change order is a record of what was answered and cannot be edited', old.status
        using errcode = '42501';
    end if;
    return new;
  end if;

  if new.job_id is distinct from old.job_id
     or new.user_id is distinct from old.user_id
     or new.customer_id is distinct from old.customer_id then
    raise exception 'a change order cannot be moved to another job, customer or business'
      using errcode = 'check_violation';
  end if;

  if new.status is distinct from old.status then
    if not (
         (old.status = 'draft'   and new.status in ('pending', 'cancelled'))
      or (old.status = 'pending' and new.status in ('approved', 'declined', 'cancelled'))
    ) then
      raise exception 'a % change order cannot become %', old.status, new.status
        using errcode = 'check_violation';
    end if;
    if new.status = 'pending'   then new.sent_at      := coalesce(old.sent_at, now()); end if;
    if new.status = 'approved'  then new.approved_at  := now(); end if;
    if new.status = 'declined'  then new.declined_at  := now(); end if;
    if new.status = 'cancelled' then new.cancelled_at := now(); end if;
  end if;

  if old.status <> 'draft'
     and (new.amount is distinct from old.amount or new.description is distinct from old.description) then
    raise exception 'the scope and price of a change order are fixed once it is sent for approval'
      using errcode = 'check_violation';
  end if;

  new.updated_at := now();
  return new;
end $function$;