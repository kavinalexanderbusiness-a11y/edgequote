-- ── Messages search finds a number the way it was dialled ────────────────────
-- Companion to RUN-2026-07-16-phone-search.sql. That added customers.phone_digits
-- (a generated, digits-only form) and pointed the command palette at it. This is
-- the same fix for the OTHER phone search: search_conversations, which the Messages
-- rail uses.
--
-- Only two things change, both mechanical:
--   • the WHERE clause and the match_type CASE now compare digits to digits when
--     the query is phone-shaped, instead of comparing two arbitrary formats
--   • everything else — the columns, the ordering, the ranking, message_snippet —
--     is byte-identical to the live definition
--
-- v_digits mirrors lib/customers.ts phoneSearchDigits(): a query containing letters
-- or '@' is a name/email search that merely happens to include digits, so it must
-- NOT become a phone lookup ("Rose 403" is not a search for 403). Below 3 digits is
-- too noisy to be a number. When v_digits is empty the phone clause falls back to
-- the original raw ilike, so non-phone queries behave exactly as before.

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

  -- Phone-shaped? (no letters, no '@', at least 3 digits) → match on digits.
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
