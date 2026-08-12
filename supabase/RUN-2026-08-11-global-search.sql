-- ── search_records — THE global record locator ───────────────────────────────
--
-- One query answers "where does this thing live?" across the five record types an
-- owner actually looks up by hand: customers, properties, quotes, invoices and
-- visits. Before this, the command palette fanned out NINE separate PostgREST
-- selects per keystroke, each with its own tenant predicate, each with a failure
-- that was silently swallowed into `|| []`, and no ranking at all — typing an
-- invoice number returned that invoice below every customer whose notes happened
-- to contain the digits.
--
-- WHY A SINGLE DEFINER FUNCTION, mirroring public.search_conversations:
--
--   1. TENANCY IS ONE PREDICATE PER SOURCE, WRITTEN HERE, NOT IN REACT.
--      `v_user := auth.uid()` is read server-side and is never accepted as an
--      argument, so no caller can ask for another business's rows by passing a
--      different id. Every branch below carries `user_id = v_user`. A null session
--      returns an empty set — it fails CLOSED, before touching a table.
--      SECURITY DEFINER means RLS is not consulted: these predicates ARE the
--      boundary, which is exactly why they live in one reviewable function
--      instead of being re-typed at nine call sites.
--
--   2. ONE ROUND TRIP, ONE ERROR. Nine parallel selects had nine ways to fail
--      half-way and no way to say so; the palette rendered "No matches" for a
--      dropped connection. One call has one outcome the client can be honest
--      about.
--
--   3. RANKING NEEDS ALL CANDIDATES AT ONCE. Ordering can only be deterministic
--      if every source is sorted by the same key in the same pass.
--
-- WHAT IS DELIBERATELY NOT SEARCHED: customer notes, message bodies, payment
-- notes, photo captions and AI-vision summaries. Those are free text of unbounded
-- size — scanning them makes every keystroke proportional to the longest note in
-- the book — and a record surfacing because of what was written ABOUT it privately
-- is a surprise, not a lookup. This function locates RECORDS by their identity.
--
-- MONEY IS PASSED THROUGH, NEVER COMPUTED. Invoices return the raw canonical
-- columns (amount / amount_paid / discount / status / due_date) inside `extra`, so
-- the client can call lib/payments/ledger — THE balance engine the list, portal,
-- PDF and Stripe charge already share. A balance re-derived in SQL would be a
-- second money path that can disagree with the first. quotes.total is a GENERATED
-- column, so it is already the one number and is returned as-is.
--
-- SHAPE: every branch returns the same eight columns, and everything type-specific
-- rides in the `extra` jsonb. An earlier draft carried sixteen positional columns
-- and required each branch to pad with ten bare NULLs in exactly the right order —
-- a silent wrong-VALUE bug the moment a column is inserted in the middle.

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
  v_esc  text;        -- v_raw with LIKE metacharacters neutralised
  v_like text;        -- %escaped%  → "contains"
  v_pre  text;        -- escaped%   → "starts with"
  v_digits text;      -- phone digits, or '' when this is not a phone query
  v_phone_like text;
  v_email text;       -- lowercased query when it looks like an email
  v_ident text;       -- query reduced to [a-z0-9], for identifier matching
  v_bare  text;       -- query digits with leading zeros dropped ("882" = INV-0882)
  result json;
begin
  -- Fail closed: no session, no rows. Never "everything".
  if v_user is null then return '[]'::json; end if;

  -- Minimum query. Two characters is the same floor search_conversations uses.
  -- One character against a book of thousands is a scan whose result is useless
  -- anyway — every customer matches "a".
  if length(v_raw) < 2 then return '[]'::json; end if;

  -- A query is DATA, not pattern syntax. Without this a stray '%' matches every
  -- row in the business and '_' silently matches any single character.
  v_esc  := replace(replace(replace(v_raw, '\', '\\'), '%', '\%'), '_', '\_');
  v_like := '%' || v_esc || '%';
  v_pre  := v_esc || '%';

  -- Phone rule, the same one lib/customers.phoneSearchDigits and
  -- search_conversations apply: a letter or '@' means this is a name/email query
  -- that happens to contain digits ("Rose 403"), and fewer than three digits would
  -- drag in every 403 number in the book.
  if v_raw ~ '[A-Za-z@]' then v_digits := ''; else v_digits := regexp_replace(v_raw, '\D', '', 'g'); end if;
  if length(v_digits) < 3 then v_digits := ''; end if;
  v_phone_like := '%' || v_digits || '%';

  v_email := case when v_raw ~ '@' then lower(v_raw) else null end;
  v_ident := lower(regexp_replace(v_raw, '[^A-Za-z0-9]', '', 'g'));
  v_bare  := coalesce(nullif(ltrim(regexp_replace(v_raw, '\D', '', 'g'), '0'), ''),
                      case when v_raw ~ '\d' then '0' else null end);

  -- ── RANK ────────────────────────────────────────────────────────────────────
  -- Deterministic integers, lowest wins. No scoring model, no fuzziness: the same
  -- query must return the same order every time, and whatever ranks first must be
  -- explainable in one sentence.
  --    0  exact identifier   — you typed INV-0882 (or 882) and that invoice exists
  --   10  exact phone/email  — you typed the whole number or the whole address
  --   20  prefix             — a name or street that STARTS with what you typed
  --   30  partial            — the identity field CONTAINS what you typed
  --   40  secondary          — matched on service/city/denormalised name instead
  -- Ties break on record type, then newest first, then id — so the order is total
  -- and stable across identical queries.
  with hits as (
    -- ── Customers. Leads included: a lead is a customer with a stage, not its own
    -- table. Archived customers stay out — the rule the customer list already uses.
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
    -- ── Properties (service locations). An address must find the place AND the
    -- customer who owns it — the customer branch above already matches on its own
    -- address, so the two arrive together without either duplicating the other's
    -- identity in a second index.
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
    -- ── Quotes. total is GENERATED — the one number, returned untouched.
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
    -- ── Invoices. Raw money columns only; deriving the balance is the client's
    -- canonical engine's job (see the header).
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
    -- ── Visits. A `jobs` row IS a visit (the job/visit/stop vocabulary): the label
    -- is the work, the subtitle is the day it lands on.
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

-- Signed-in users only. `anon` is never granted: an unauthenticated caller would
-- reach auth.uid() = null and get '[]' anyway, but not granting it at all means
-- the door is shut rather than merely unhelpful. Revoking from PUBLIC is the part
-- that actually matters — a revoke from `anon` alone leaves the PUBLIC grant that
-- every role inherits.
revoke all on function public.search_records(text, int) from public;
revoke all on function public.search_records(text, int) from anon;
grant execute on function public.search_records(text, int) to authenticated;

-- ── No new indexes. Measured, not assumed. ──────────────────────────────────
-- The obvious move is a GIN trigram index per searched column. EXPLAIN on the
-- shapes this function actually issues says otherwise: the planner scans
-- <table>_user_id_idx and filters the ilike inside that one business's rows, which
-- is the correct plan for a multi-tenant book — the tenant predicate is the
-- selective one, and a single business has thousands of records, not millions.
-- A trigram index is chosen only for a SINGLE-column ilike (invoices_inum_trgm and
-- quotes_qnum_trgm already exist and are still used for a bare identifier lookup);
-- across a multi-column OR it never is. Five more GIN indexes would have cost write
-- amplification on every customer, property, quote and invoice write to buy nothing.
--
-- All five source tables already carry the index that matters:
--   customers_user_id_idx · properties_user_id_idx · quotes_user_id_idx ·
--   invoices_user_id_idx  · jobs_user_id_idx
-- If a single tenant ever reaches a size where the per-tenant filter stops being
-- instant, THAT is the evidence that justifies a trigram index — and it should be
-- added then, for the column the slow query names.
