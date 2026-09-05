-- ═══════════════════════════════════════════════════════════════════════════
-- ARCHIVED MIGRATION — HISTORY ONLY. DO NOT RE-RUN.
--
--   version : 20260811074600
--   name    : global_search_records
--
-- Recovered 2026-08-14 from supabase_migrations.schema_migrations — the SQL
-- production actually executed, not a repo file believed to match it.
--
-- Its effects are already folded into supabase/migrations/*_baseline.sql. This
-- copy exists so "why is this column here?" is answerable, and for nothing else.
-- Re-running one replaces a live object with an older body — silently, no error.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.search_records(
  p_query text,
  p_limit int default 8
)
returns json
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_user uuid := auth.uid();
  v_raw  text := trim(coalesce(p_query, ''));
  v_lim  int  := least(greatest(coalesce(p_limit, 8), 1), 25);
  v_esc  text;
  v_like text;
  v_pre  text;
  v_digits text;
  v_phone_like text;
  v_email text;
  v_ident text;
  v_bare  text;
  result json;
begin
  if v_user is null then return '[]'::json; end if;
  if length(v_raw) < 2 then return '[]'::json; end if;

  v_esc  := replace(replace(replace(v_raw, '\', '\\'), '%', '\%'), '_', '\_');
  v_like := '%' || v_esc || '%';
  v_pre  := v_esc || '%';

  if v_raw ~ '[A-Za-z@]' then v_digits := ''; else v_digits := regexp_replace(v_raw, '\D', '', 'g'); end if;
  if length(v_digits) < 3 then v_digits := ''; end if;
  v_phone_like := '%' || v_digits || '%';

  v_email := case when v_raw ~ '@' then lower(v_raw) else null end;
  v_ident := lower(regexp_replace(v_raw, '[^A-Za-z0-9]', '', 'g'));
  v_bare  := coalesce(nullif(ltrim(regexp_replace(v_raw, '\D', '', 'g'), '0'), ''),
                      case when v_raw ~ '\d' then '0' else null end);

  with hits as (
    select
      'customer'::text as kind,
      c.id             as id,
      c.created_at     as created_at,
      coalesce(nullif(c.name, ''), 'Unnamed customer') as label,
      nullif(concat_ws(' · ', nullif(c.address, ''), nullif(c.city, ''), nullif(c.phone, '')), '') as sub,
      case
        when v_email is not null and lower(coalesce(c.email, '')) = v_email then 10
        when v_digits <> '' and coalesce(c.phone_digits, '') = v_digits then 10
        when v_digits <> '' and length(v_digits) >= 10
             and right(coalesce(c.phone_digits, ''), 10) = right(v_digits, 10) then 10
        when c.name    ilike v_pre  then 20
        when c.address ilike v_pre  then 20
        when c.name    ilike v_like then 30
        when c.address ilike v_like then 30
        else 40
      end              as rank,
      c.id             as customer_id,
      '{}'::jsonb      as extra
    from public.customers c
    where c.user_id = v_user
      and c.archived_at is null
      and (
        c.name    ilike v_like
        or c.email   ilike v_like
        or c.address ilike v_like
        or c.city    ilike v_like
        or (v_digits <> '' and coalesce(c.phone_digits, '') like v_phone_like)
        or (v_digits =  '' and coalesce(c.phone, '') ilike v_like)
      )

    union all
    select
      'property', p.id, p.created_at,
      coalesce(nullif(p.address, ''), 'Property'),
      nullif(concat_ws(' · ', nullif(p.neighborhood, ''), nullif(p.city, '')), ''),
      case
        when p.address ilike v_pre  then 20
        when p.address ilike v_like then 30
        else 40
      end,
      p.customer_id,
      '{}'::jsonb
    from public.properties p
    where p.user_id = v_user
      and (p.address ilike v_like or p.city ilike v_like
           or p.neighborhood ilike v_like or p.postal_code ilike v_like)

    union all
    select
      'quote', q.id, q.created_at,
      coalesce(nullif(q.quote_number, ''), 'Quote'),
      nullif(concat_ws(' · ', nullif(q.customer_name, ''), nullif(q.service_type, '')), ''),
      case
        when v_ident <> '' and lower(regexp_replace(coalesce(q.quote_number, ''), '[^A-Za-z0-9]', '', 'g')) = v_ident then 0
        when v_bare is not null
             and nullif(ltrim(regexp_replace(coalesce(q.quote_number, ''), '\D', '', 'g'), '0'), '') = v_bare then 0
        when q.customer_name ilike v_pre  then 20
        when q.address       ilike v_pre  then 20
        when q.customer_name ilike v_like then 30
        when q.address       ilike v_like then 30
        else 40
      end,
      q.customer_id,
      jsonb_build_object('ref', q.quote_number, 'status', q.status, 'total', q.total)
    from public.quotes q
    where q.user_id = v_user
      and (
        q.quote_number  ilike v_like
        or q.customer_name ilike v_like
        or q.service_type  ilike v_like
        or q.address       ilike v_like
        or (v_bare is not null
            and nullif(ltrim(regexp_replace(coalesce(q.quote_number, ''), '\D', '', 'g'), '0'), '') = v_bare)
      )

    union all
    select
      'invoice', i.id, i.created_at,
      coalesce(nullif(i.invoice_number, ''), 'Invoice'),
      nullif(concat_ws(' · ', nullif(i.customer_name, ''), nullif(i.service_type, '')), ''),
      case
        when v_ident <> '' and lower(regexp_replace(coalesce(i.invoice_number, ''), '[^A-Za-z0-9]', '', 'g')) = v_ident then 0
        when v_bare is not null
             and nullif(ltrim(regexp_replace(coalesce(i.invoice_number, ''), '\D', '', 'g'), '0'), '') = v_bare then 0
        when i.customer_name ilike v_pre  then 20
        when i.address       ilike v_pre  then 20
        when i.customer_name ilike v_like then 30
        when i.address       ilike v_like then 30
        else 40
      end,
      i.customer_id,
      jsonb_build_object(
        'ref', i.invoice_number, 'status', i.status,
        'amount', i.amount, 'amount_paid', i.amount_paid,
        'discount_type', i.discount_type, 'discount_value', i.discount_value,
        'due_date', i.due_date, 'viewed_at', i.viewed_at)
    from public.invoices i
    where i.user_id = v_user
      and (
        i.invoice_number ilike v_like
        or i.customer_name ilike v_like
        or i.service_type  ilike v_like
        or i.address       ilike v_like
        or (v_bare is not null
            and nullif(ltrim(regexp_replace(coalesce(i.invoice_number, ''), '\D', '', 'g'), '0'), '') = v_bare)
      )

    union all
    select
      'job', j.id, j.created_at,
      coalesce(nullif(j.title, ''), nullif(j.service_type, ''), 'Visit'),
      nullif(concat_ws(' · ', to_char(j.scheduled_date, 'Mon FMDD'), nullif(j.service_type, '')), ''),
      case
        when j.title ilike v_pre  then 20
        when j.title ilike v_like then 30
        else 40
      end,
      j.customer_id,
      jsonb_build_object('status', j.status, 'scheduled_date', j.scheduled_date)
    from public.jobs j
    where j.user_id = v_user
      and (j.title ilike v_like or j.service_type ilike v_like)
  ),
  ranked as (
    select h.*,
           case h.kind when 'customer' then 0 when 'property' then 1
                       when 'invoice'  then 2 when 'quote'    then 3 else 4 end as kind_order
    from hits h
    order by rank,
             case h.kind when 'customer' then 0 when 'property' then 1
                         when 'invoice'  then 2 when 'quote'    then 3 else 4 end,
             h.created_at desc, h.id
    limit v_lim
  )
  select coalesce(
           json_agg(row_to_json(r) order by r.rank, r.kind_order, r.created_at desc, r.id),
           '[]'::json)
  into result
  from ranked r;

  return result;
end;
$function$;

revoke all on function public.search_records(text, int) from public;
revoke all on function public.search_records(text, int) from anon;
grant execute on function public.search_records(text, int) to authenticated;

create index if not exists customers_address_trgm  on public.customers  using gin (address gin_trgm_ops);
create index if not exists customers_email_trgm    on public.customers  using gin (email gin_trgm_ops);
create index if not exists properties_address_trgm on public.properties using gin (address gin_trgm_ops);
create index if not exists invoices_cname_trgm     on public.invoices   using gin (customer_name gin_trgm_ops);
create index if not exists quotes_cname_trgm       on public.quotes     using gin (customer_name gin_trgm_ops);