-- ═══════════════════════════════════════════════════════════════════════════
-- Service publication v1 — ACTIVE IS NOT PUBLISHED
-- Session 113 · production hygiene
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ⭐⭐ THE DEFECT. There was one switch, `service_templates.is_active`, and both
-- customer-facing projections gated on it and nothing else:
--
--   public_services(p_token)   → /api/public/services → the marketing website.
--                                ANONYMOUS, CORS *, edge-cached for five minutes.
--   get_portal_data(p_token)   → the portal's "Request a service" tab.
--
-- So "active" silently meant "published to the public internet". A placeholder
-- switched on while pricing was being worked out, a $1 row left behind by a
-- test, an internal-only call-out line — every one of them was on the website
-- the moment it existed. The production audit found exactly that.
--
-- ⛔ This is NOT fixable by naming discipline or by a cleanup pass. The system
-- never asked whether a service was meant to be public, so there was no answer
-- to be wrong about. This migration adds the question.
--
-- ── THE MODEL: three states out of two columns ─────────────────────────────
--   INACTIVE   is_active = false                     not available at all
--   INTERNAL   is_active = true,  published_at NULL  owner-usable, not public
--   PUBLISHED  is_active = true,  published_at set   explicitly customer-visible
--
-- No new enum, so there is no second switch to drift out of step with
-- `is_active`, and no way to express a contradiction. The timestamp is not
-- decoration: "when did this price become public?" is the first question anyone
-- auditing a customer-visible figure will ask.
--
-- ⚠️⚠️⚠️ READ THIS BEFORE APPLYING — IT CHANGES WHAT CUSTOMERS SEE, IMMEDIATELY.
--
-- `published_at` defaults to NULL and THIS MIGRATION DELIBERATELY DOES NOT
-- BACKFILL. The moment it applies, **the public service catalogue and the
-- portal's service list are EMPTY** until the owner publishes. Bookings and
-- quotes are unaffected; only the browse-able catalogue goes quiet.
--
-- That is the intended safety property, not an oversight. Backfilling every
-- currently-active service as published would re-publish the exact fixture and
-- $1 rows this exists to remove, on the exact day it was meant to remove them.
-- Publication has to be an act.
--
-- ⭐ IF CONTINUITY IS PREFERRED OVER SAFETY, the owner may run the OPTIONAL
-- statement at the bottom of this file — it is commented out, it is not part of
-- the migration, and it publishes only rows that pass the catalogue-quality
-- rules (no fixture prefix, no trivial price, named). Running it is a decision;
-- it is not the default and it is not automatic.
--
-- ⛔ NON-DESTRUCTIVE. One nullable column added; two functions replaced by
-- adding one predicate each. No column is dropped, no row is deleted, no
-- existing value is rewritten.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ── 1. The column ──────────────────────────────────────────────────────────
-- Nullable with no default: NULL IS the "internal" state, so an absent value is
-- meaningful rather than missing. `if not exists` so a re-run is a no-op.
alter table public.service_templates
  add column if not exists published_at timestamptz;

comment on column public.service_templates.published_at is
  'When this service was explicitly made customer-visible. NULL = INTERNAL: the owner may quote with it, but public_services() and get_portal_data() will not return it. Set = PUBLISHED. is_active is the master switch and wins over this: a switched-off service is never public regardless. ⛔ Never backfilled — publication is an act, not a migration.';

-- Partial index: every customer-facing read asks the same narrow question, and
-- the public one is anonymous and edge-cached, so it is the hottest path here.
create index if not exists service_templates_published_idx
  on public.service_templates (user_id, sort_order, name)
  where is_active and published_at is not null;

-- ── 2. The PUBLIC website catalogue ────────────────────────────────────────
-- ⭐ ONE predicate added: `and published_at is not null`. Everything else in
-- this function is byte-for-byte what was there — the business projection, the
-- column list, the ordering, the booking_enabled gate on the token. A rewrite
-- here would be a chance to lose something that already works.
CREATE OR REPLACE FUNCTION public.public_services(p_token text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_user uuid; result json;
begin
  select user_id into v_user from public.business_settings where booking_token = p_token and booking_enabled = true;
  if v_user is null then return null; end if;
  select json_build_object(
    'business', (select to_json(b) from (
      select company_name, owner_name, logo_url, phone, email_primary, website, base_address, coalesce(gst_percent,0) as gst_percent
      from public.business_settings where user_id = v_user) b),
    -- ⛔⛔ `and published_at is not null` IS THE PRIVACY/QUALITY BOUNDARY, not a
    -- filter preference. This function is reachable ANONYMOUSLY with only a
    -- booking token and its answer is cached at the edge for five minutes.
    -- Without this clause every active service — including anything a test left
    -- behind — is served to the open internet. Deleting it re-opens exactly the
    -- exposure this migration was written for.
    'services', (select coalesce(json_agg(json_build_object(
        'id', id, 'name', name, 'category', category, 'description', default_description,
        'default_rate', default_rate, 'pricing_display_type', pricing_display_type) order by sort_order, name), '[]'::json)
      from public.service_templates
      where user_id = v_user and is_active = true and published_at is not null)
  ) into result;
  return result;
end; $function$;

comment on function public.public_services(text) is
  'The public website catalogue. ANONYMOUS + edge-cached. Returns PUBLISHED services only (is_active AND published_at is not null) — see the boundary note in the body. ⛔ Never widen this to is_active alone.';

-- ── 3. The PORTAL catalogue ────────────────────────────────────────────────
-- ⚠️ get_portal_data is ~9 kB and carries a dozen projections that have each
-- been fixed for a specific incident (the draft-privacy predicate, the internal
-- access note that must never appear, change_orders, quote add-ons). Retyping it
-- is how one of those gets lost. So it is transformed IN PLACE at a single
-- guarded anchor: read the live body, replace the one services predicate, and
-- refuse loudly if the anchor is not found exactly once.
do $do$
declare
  v_src text;
  v_anchor text := 'from public.service_templates
      where user_id = v_user and is_active';
  v_new text := 'from public.service_templates
      where user_id = v_user and is_active and published_at is not null';
  v_hits int;
begin
  select pg_get_functiondef(p.oid) into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'get_portal_data'
   limit 1;

  if v_src is null then
    raise exception 'get_portal_data not found — refusing to guess at its body';
  end if;

  -- Already applied? Idempotent, so a re-run is a no-op rather than a failure.
  if position(v_new in v_src) > 0 then
    raise notice 'get_portal_data already filters on published_at — nothing to do';
    return;
  end if;

  v_hits := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
  if v_hits <> 1 then
    raise exception
      'get_portal_data: expected exactly 1 services anchor, found % — refusing to transform a body I do not recognise', v_hits;
  end if;

  execute replace(v_src, v_anchor, v_new);
end
$do$;

-- ── 4. Prove it, in the same transaction that did it ───────────────────────
-- ⭐ A migration that claims a boundary should demonstrate it, not assert it.
-- If either function can still be read without the predicate, this rolls back.
do $do$
declare v_pub text; v_portal text;
begin
  select pg_get_functiondef(p.oid) into v_pub from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname='public' and p.proname='public_services' limit 1;
  select pg_get_functiondef(p.oid) into v_portal from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname='public' and p.proname='get_portal_data' limit 1;

  if position('published_at is not null' in v_pub) = 0 then
    raise exception 'public_services did not take the publication predicate';
  end if;
  if position('published_at is not null' in v_portal) = 0 then
    raise exception 'get_portal_data did not take the publication predicate';
  end if;
  -- The two incident-fixed clauses that share this function must still be there.
  if position('status <> ''draft''' in v_portal) = 0 then
    raise exception 'get_portal_data LOST its draft-privacy predicate during the transform';
  end if;
  if position('change_orders' in v_portal) = 0 then
    raise exception 'get_portal_data LOST its change_orders projection during the transform';
  end if;
  if position('addons' in v_portal) = 0 then
    raise exception 'get_portal_data LOST its quote add-ons projection during the transform';
  end if;
end
$do$;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- ⭐ OPTIONAL — NOT PART OF THIS MIGRATION. Run by hand ONLY if the owner
-- decides continuity matters more than a clean start.
--
-- It publishes the services that pass the catalogue-quality rules and leaves
-- everything questionable INTERNAL for the owner to look at: no fixture prefix,
-- a real name, and a price above $1. Review the SELECT before running the
-- UPDATE — it is the same list the hygiene report produces.
--
--   select id, name, default_rate from public.service_templates
--    where user_id = '<OWNER_UUID>'
--      and is_active
--      and published_at is null
--      and coalesce(default_rate, 0) > 1
--      and btrim(coalesce(name, '')) <> ''
--      and lower(btrim(name)) not like 'zz-%'
--      and lower(btrim(name)) not like 'verify-%'
--      and lower(btrim(name)) not like '\_\_fixture%'
--      and lower(btrim(name)) <> 'automated guard fixture — safe to delete'
--    order by sort_order, name;
--
--   -- then, with the SAME predicate:
--   update public.service_templates set published_at = now()
--    where user_id = '<OWNER_UUID>' and is_active and published_at is null
--      and coalesce(default_rate, 0) > 1
--      and btrim(coalesce(name, '')) <> ''
--      and lower(btrim(name)) not like 'zz-%'
--      and lower(btrim(name)) not like 'verify-%'
--      and lower(btrim(name)) not like '\_\_fixture%'
--      and lower(btrim(name)) <> 'automated guard fixture — safe to delete';
-- ═══════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════
-- ADDENDUM — the universal-product half of the same defect
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ⭐⭐ `book_service` labelled an un-named booking request with a hardcoded
-- TRADE: `coalesce(v_service, 'Lawn Mowing')`. This is one function serving
-- every tenant, so a window cleaner's customer who did not pick a service got a
-- quote whose `service_type` read "Lawn Mowing" — on the customer's own portal,
-- on the PDF, and in the owner's pipeline.
--
-- ⛔ The fix is NOT another hardcoded word. Trade vocabulary must come from
-- CONFIGURATION — here, the owner's own catalogue — and only fall back to a
-- neutral noun when the business has published nothing to borrow a name from.
-- ⛔ It must never be inferred from a keyword in the service name.
--
-- Two statements only, both inside book_service, both replaced in place at a
-- guarded anchor for the same reason get_portal_data was: this function creates
-- customers, properties, jobs, quotes and service_requests, and retyping it is
-- how one of those loses a clause.
begin;

do $do$
declare
  v_src text;
  v_anchor text := 'coalesce(v_service,''Lawn Mowing'')';
  v_new text := 'coalesce(v_service, v_fallback_service)';
  v_decl_anchor text := 'v_rate numeric; v_job uuid; v_quote uuid; v_num int; v_qnum text := null; v_mode text;';
  v_decl_new text := 'v_rate numeric; v_job uuid; v_quote uuid; v_num int; v_qnum text := null; v_mode text;'
                  || E'\n  v_fallback_service text;';
  -- Resolve the label from the owner's OWN published catalogue, in their own
  -- order. 'Service' is the last resort: neutral, true, and trade-free.
  v_resolve text := E'\n  select name into v_fallback_service from public.service_templates'
                 || E'\n   where user_id = v_user and is_active and published_at is not null'
                 || E'\n   order by sort_order, name limit 1;'
                 || E'\n  v_fallback_service := coalesce(v_fallback_service, ''Service'');\n';
  v_resolve_anchor text := 'v_notes   := nullif(trim(coalesce(p_payload->>''notes'', p_payload->>''message'','''')), '''');';
begin
  select pg_get_functiondef(p.oid) into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'book_service' limit 1;
  if v_src is null then raise exception 'book_service not found — refusing to guess at its body'; end if;

  if position(v_new in v_src) > 0 then
    raise notice 'book_service already resolves its fallback from the catalogue — nothing to do';
    return;
  end if;

  if (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor) <> 1 then
    raise exception 'book_service: expected exactly 1 hardcoded trade fallback — refusing to transform a body I do not recognise';
  end if;
  if (length(v_src) - length(replace(v_src, v_decl_anchor, ''))) / length(v_decl_anchor) <> 1 then
    raise exception 'book_service: declaration anchor not found exactly once';
  end if;
  if (length(v_src) - length(replace(v_src, v_resolve_anchor, ''))) / length(v_resolve_anchor) <> 1 then
    raise exception 'book_service: resolve anchor not found exactly once';
  end if;

  v_src := replace(v_src, v_decl_anchor, v_decl_new);
  v_src := replace(v_src, v_resolve_anchor, v_resolve_anchor || v_resolve);
  v_src := replace(v_src, v_anchor, v_new);
  execute v_src;
end
$do$;

do $do$
declare v_src text;
begin
  select pg_get_functiondef(p.oid) into v_src from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname='public' and p.proname='book_service' limit 1;
  if position('Lawn Mowing' in v_src) > 0 then
    raise exception 'book_service still carries the hardcoded trade fallback';
  end if;
  if position('v_fallback_service' in v_src) = 0 then
    raise exception 'book_service did not take the configuration-resolved fallback';
  end if;
  -- The clauses that share this function must survive the transform.
  if position('rate_limited' in v_src) = 0 then
    raise exception 'book_service LOST its rate limiter during the transform';
  end if;
  if position('template_rate' in v_src) = 0 then
    raise exception 'book_service LOST its ADR-002 price provenance during the transform';
  end if;
end
$do$;

commit;

-- ⚠️ KNOWN, NOT FIXED HERE — reported instead, because fixing it changes an
-- existing numbering series on live data and that is the owner's call:
-- book_service mints quote numbers as 'EPS-<year>-NNNN'. "EPS" is one tenant's
-- initials, hardcoded into a function every tenant runs, so a second business's
-- quotes are numbered with the first business's brand. It is customer-visible
-- (the number is on the PDF and in the portal). Changing it must migrate or
-- preserve the existing series; see the session report.
