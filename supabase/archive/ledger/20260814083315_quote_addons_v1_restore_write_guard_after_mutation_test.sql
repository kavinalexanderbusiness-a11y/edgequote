-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260814083315
--   name    : quote_addons_v1_restore_write_guard_after_mutation_test
--
-- Recovered 2026-08-15 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

-- Restores public.quote_addons_write_guard to its real body after the
-- deliberate mutation test above. Byte-identical to quote_addons_v1_schema.
create or replace function public.quote_addons_write_guard() returns trigger
language plpgsql set search_path to 'public' as $fn$
declare v_quote uuid; v_status text; v_count int;
begin
  v_quote := coalesce(new.quote_id, old.quote_id);
  select q.status into v_status from public.quotes q where q.id = v_quote;

  -- The parent quote is already gone: this row is going with it via ON DELETE
  -- CASCADE. Refusing here would make an APPROVED quote impossible to delete.
  if v_status is null then return coalesce(new, old); end if;

  -- ⭐⭐ THE FREEZE. 'draft'/'sent' = not yet decided. Any other status means a
  -- real person approved an exact set of extras at an exact price, and that set
  -- IS the record. Additional scope after approval is a CHANGE ORDER.
  if v_status not in ('draft', 'sent') then
    raise exception 'This quote has been decided — its optional extras are part of the record now. Additional work goes on a change order.'
      using errcode = 'check_violation';
  end if;

  if tg_op = 'DELETE' then return old; end if;

  -- The selection invariant is the DATABASE's to keep, so app code only ever has
  -- to say `is_selected` and cannot leave a half-recorded choice behind.
  if new.is_selected then
    if new.selected_via is null then new.selected_via := 'default'; end if;
    if new.selected_at  is null then new.selected_at  := now();     end if;
  else
    new.selected_via := null;
    new.selected_at  := null;
  end if;
  new.updated_at := now();

  select count(*) into v_count from public.quote_addons where quote_id = v_quote and id <> new.id;
  if v_count + 1 > 6 then
    raise exception 'A quote may offer at most 6 optional extras (this one would have %)', v_count + 1
      using errcode = 'check_violation';
  end if;
  return new;
end $fn$;