-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260716233413
--   name    : search_conversations_phone_digits_2026_07_16
--
-- Recovered 2026-08-14 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.search_conversations(p_query text)
returns json
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_user uuid := auth.uid();
  q text := '%' || trim(coalesce(p_query, '')) || '%';
  v_digits text;
  v_phone_pat text;
  result json;
begin
  if v_user is null or length(trim(coalesce(p_query, ''))) < 2 then return '[]'::json; end if;

  if trim(coalesce(p_query, '')) ~ '[A-Za-z@]' then
    v_digits := '';
  else
    v_digits := regexp_replace(coalesce(p_query, ''), '\D', '', 'g');
  end if;
  if length(v_digits) < 3 then v_digits := ''; end if;
  v_phone_pat := '%' || v_digits || '%';

  select coalesce(json_agg(row_to_json(t) order by t.pinned_at desc nulls last, t.last_message_at desc), '[]'::json) into result
  from (
    select c.id, c.customer_id, c.last_message_at, c.last_preview, c.last_direction, c.unread,
           c.archived_at, c.pinned_at, c.muted, c.lead_status, c.last_channel, cu.name as customer_name, cu.phone as customer_phone,
           (select left(m.body, 140) from public.messages m where m.conversation_id = c.id and m.body ilike q order by m.created_at desc limit 1) as message_snippet,
           case
             when cu.name ilike q then 'name'
             when v_digits <> '' and coalesce(cu.phone_digits, '') like v_phone_pat then 'phone'
             when v_digits = '' and coalesce(cu.phone, '') ilike q then 'phone'
             when coalesce(cu.address, '') ilike q then 'address'
             when exists (select 1 from public.properties p where p.customer_id = c.customer_id and (coalesce(p.address, '') ilike q or coalesce(p.city, '') ilike q)) then 'property'
             when exists (select 1 from public.quotes qq where qq.customer_id = c.customer_id and qq.quote_number ilike q) then 'quote'
             when exists (select 1 from public.invoices iv where iv.customer_id = c.customer_id and iv.invoice_number ilike q) then 'invoice'
             when exists (select 1 from public.jobs j where j.customer_id = c.customer_id and coalesce(j.service_type, '') ilike q)
               or exists (select 1 from public.quotes qq where qq.customer_id = c.customer_id and coalesce(qq.service_type, '') ilike q) then 'service'
             else 'message'
           end as match_type
    from public.conversations c
    join public.customers cu on cu.id = c.customer_id
    where c.user_id = v_user and (
      cu.name ilike q
      or (v_digits <> '' and coalesce(cu.phone_digits, '') like v_phone_pat)
      or (v_digits = '' and coalesce(cu.phone, '') ilike q)
      or coalesce(cu.address, '') ilike q
      or exists (select 1 from public.properties p where p.customer_id = c.customer_id and (coalesce(p.address, '') ilike q or coalesce(p.city, '') ilike q))
      or exists (select 1 from public.messages m where m.conversation_id = c.id and m.body ilike q)
      or exists (select 1 from public.quotes qq where qq.customer_id = c.customer_id and (qq.quote_number ilike q or coalesce(qq.service_type, '') ilike q))
      or exists (select 1 from public.invoices iv where iv.customer_id = c.customer_id and iv.invoice_number ilike q)
      or exists (select 1 from public.jobs j where j.customer_id = c.customer_id and coalesce(j.service_type, '') ilike q)
    )
  ) t;
  return result;
end; $function$;