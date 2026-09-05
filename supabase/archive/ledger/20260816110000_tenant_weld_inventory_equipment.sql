-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260816110000
--   name    : tenant_weld_inventory_equipment
--
-- Applied to production 2026-08-16 via the management API (another session;
-- archived by Session 68 convergence) and recorded in
-- supabase_migrations.schema_migrations. The SQL below is the text production executed.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

-- ââ Two more B2-class welds: parts and equipment ââââââââââââââââââââââââââââ
--
-- Found by classifying all 106 single-column tenantâtenant foreign keys by
-- EXPLOITABILITY rather than by shape. Shape alone proves nothing â 102 of the
-- 106 have an attacker-writable child row. What makes a relation dangerous is a
-- SECURITY DEFINER path that traverses it WITHOUT constraining user_id. Eleven
-- did; these two reproduce the paymentsâinvoices defect exactly.
--
-- PROVEN ON PRODUCTION 2026-08-16, inside a rolled-back transaction, with two
-- real tenants:
--   part_movements(A) -> parts(B)          ACCEPTED â B's qty_on_hand 100 â -75
--   equipment_service(A) -> equipment(B)   ACCEPTED â B's last_service_at â 2099-01-01
--
-- The stock case is worse than corruption. recompute_part_stock REPLACES the
-- parent's value with the sum of its movements, so tenant A does not nudge
-- tenant B's count â A's number becomes B's count outright.
--
-- Preflight: 0 mismatched rows on both relations, and both child tables are
-- empty, so these constraints validate instantly against existing data.

-- ââ parts âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
alter table public.parts
  add constraint parts_user_id_id_key unique (user_id, id);

alter table public.part_movements
  drop constraint if exists part_movements_part_id_fkey;

alter table public.part_movements
  add constraint part_movements_part_tenant_fkey
  foreign key (user_id, part_id)
  references public.parts (user_id, id)
  on delete cascade;

-- ââ equipment âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
alter table public.equipment
  add constraint equipment_user_id_id_key unique (user_id, id);

alter table public.equipment_service
  drop constraint if exists equipment_service_equipment_id_fkey;

alter table public.equipment_service
  add constraint equipment_service_equipment_tenant_fkey
  foreign key (user_id, equipment_id)
  references public.equipment (user_id, id)
  on delete cascade;

-- ââ Defence in depth: the recomputes refuse to cross a tenant âââââââââââââââ
-- The constraints above already make a foreign-tenant child row unINSERTable.
-- These make the aggregate itself refuse, so a row arriving by some other route
-- (a service_role path, a restore, a future migration) still cannot move another
-- business's totals. Bodies are production's current definitions with the tenant
-- predicate added â read with pg_get_functiondef, not from a repo copy.

create or replace function public.recompute_part_stock()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_part uuid; v_owner uuid;
begin
  v_part := coalesce(new.part_id, old.part_id);
  -- The part's OWN tenant, never the writer's: a row that should not exist must
  -- not get a vote in whose total it changes.
  select user_id into v_owner from public.parts where id = v_part;
  if v_owner is null then return null; end if;
  update public.parts p
     set qty_on_hand = coalesce((select sum(qty) from public.part_movements
                                  where part_id = v_part and user_id = v_owner), 0),
         updated_at  = now()
   where p.id = v_part and p.user_id = v_owner;
  return null;
end $function$;

create or replace function public.recompute_equipment_service()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_eq uuid; v_owner uuid;
begin
  v_eq := coalesce(new.equipment_id, old.equipment_id);
  select user_id into v_owner from public.equipment where id = v_eq;
  if v_owner is null then return null; end if;
  update public.equipment e
     set last_service_at = s.service_date, last_service_hours = s.hours, updated_at = now()
    from (select service_date, hours from public.equipment_service
           where equipment_id = v_eq and user_id = v_owner
           order by service_date desc, created_at desc limit 1) s
   where e.id = v_eq and e.user_id = v_owner;
  if not exists (select 1 from public.equipment_service
                  where equipment_id = v_eq and user_id = v_owner) then
    update public.equipment set last_service_at = null, last_service_hours = null, updated_at = now()
     where id = v_eq and user_id = v_owner;
  end if;
  return null;
end $function$;
