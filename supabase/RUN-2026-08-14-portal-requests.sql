-- ══════════════════════════════════════════════════════════════════════════
-- CUSTOMER PORTAL REQUESTS V1
--
-- A customer can ask their provider for more work, a different date, or another
-- quote — with photos and a short note — from the portal.
--
-- ⭐ THE LAW THIS ENCODES: A REQUEST IS AN ASK, NOT AN OUTCOME.
--   A request row is never a job, never a schedule change, never an approved
--   price. Nothing in this file writes to jobs, job_recurrences, quotes,
--   invoices or payments — a request can only ever produce a row in
--   service_requests. The owner turns an ask into work through the SAME
--   deliberate creation doors they already use, and those doors carry no money
--   from the ask.
--
-- WHAT CHANGES
--   1. service_requests grows four columns: from_portal, photos, dedup_key,
--      resolved_at. No new table — service_requests IS the request primitive
--      (it already threads to conversations, notifications and the timeline).
--   2. ONE request engine. portal_submit_request validates everything and is now
--      the only body that inserts; portal_request_service becomes a thin wrapper
--      over it, so the free-text door cannot drift from the structured one.
--   3. Media is stored as a STORAGE PATH, never a URL (see below).
--   4. Duplicate submissions are refused BY THE DATABASE (partial unique index),
--      not by a client that may have already lost the response.
--
-- ⭐ WHY PATHS AND NOT URLS
--   A URL column would let a tampered client store any absolute address —
--   another tenant's job-photos object, or an external tracker the owner's
--   browser would then fetch. Storing a path means the BUCKET IS NAMED IN CODE
--   at render time, so a stored value can never point outside booking-uploads,
--   and the path shape below contains no customer-supplied text at all (two
--   UUIDs and an extension): nothing to traverse with, nothing to inject.
--   The portal TOKEN is deliberately absent from the path — booking-uploads is a
--   public bucket, and a token in an object URL is a token in a public URL.
--
-- ⛔ NOT TOUCHED: get_portal_data (unchanged, same 13 keys), every other portal_*
--   RPC body, jobs/quotes/invoices/payments, RLS on service_requests (the owner's
--   existing "update own" policy is what lets them resolve a request; there is
--   still NO insert policy, so only these SECURITY DEFINER doors can create one).
-- ══════════════════════════════════════════════════════════════════════════

-- ── 1) Columns ───────────────────────────────────────────────────────────────
-- from_portal answers ONE question — "did a customer create this in their own
-- portal?" — and nothing else. It is a boolean rather than a source enum because
-- service_requests has five producers (portal asks, website leads, online
-- bookings, marketplace leads, the portal contact-details note) and only the
-- first is a request the owner must act on. A wrong enum value is one UPDATE
-- away from putting a stale lead in front of the owner as a customer request;
-- a boolean set by exactly two functions cannot drift.
alter table public.service_requests add column if not exists from_portal boolean not null default false;
alter table public.service_requests add column if not exists photos text[] not null default '{}'::text[];
alter table public.service_requests add column if not exists dedup_key text;
alter table public.service_requests add column if not exists resolved_at timestamp with time zone;

comment on column public.service_requests.from_portal is
  'True only for rows created by portal_submit_request (incl. its portal_request_service wrapper) — a customer acting in their own portal. Website leads, online bookings and system notes stay false.';
comment on column public.service_requests.photos is
  'booking-uploads STORAGE PATHS (never URLs) the customer attached. The bucket is named in application code at render time; see portal_request_photos_ok for the enforced shape.';
comment on column public.service_requests.dedup_key is
  'Set by portal_submit_request. With service_requests_open_dedup_idx it makes a repeated submission of the same ask a no-op while the first is still open.';

-- ── 2) Backfill: claim only what can be PROVEN ───────────────────────────────
-- Production holds 29 rows from five producers, 27 of them still 'new'. Most are
-- website leads that live their own lifecycle (website_leads.status +
-- conversations.lead_status) and are already answered by LeadCard — surfacing
-- them as customer requests would put twenty stale rows in front of the owner
-- on day one, which is exactly the false-signal failure this codebase keeps
-- paying for.
--
-- So the backfill is POSITIVE-MATCH ONLY: a row is claimed for the portal when
-- its shape can only have come from the portal —
--   • the preset catalogue's own format ("Service request: <name> quote"), or
--   • a kind that no other producer can write (portal_submit_request is the only
--     writer of appointment / reschedule / plan_change).
-- Free-text portal asks from before today are NOT claimed: there is no signature
-- that distinguishes them from an intake note, and inventing one would be a
-- guess rendered as a fact.
update public.service_requests
   set from_portal = true
 where from_portal = false
   and (kind in ('appointment', 'reschedule', 'plan_change')
        or message like 'Service request: % quote');

-- ── 3) Vocabulary: three states, no fourth word for an existing one ──────────
-- 'handled' already exists in production data and in portal_add_contact, so it
-- stays THE word for "acted on". 'dismissed' is the genuinely different outcome
-- (closed without acting). Adding 'resolved' would be a second word for the
-- first state, which is how this codebase gets two vocabularies for one fact.
alter table public.service_requests drop constraint if exists service_requests_status_check;
alter table public.service_requests add constraint service_requests_status_check
  check (status in ('new', 'handled', 'dismissed'));

-- additional_work = "please also do X" — an ask for MORE work, which is neither a
-- new appointment nor a move of an existing one.
alter table public.service_requests drop constraint if exists service_requests_kind_check;
alter table public.service_requests add constraint service_requests_kind_check
  check (kind in ('service', 'appointment', 'reschedule', 'plan_change', 'additional_work'));

-- A closed request records WHEN. It deliberately does not record a resolution
-- note: what the owner did is evidenced by the artefact they created (a quote, a
-- moved visit, a line on the job), and a second free-text record of the same
-- fact is a second source of truth.
--
-- One-directional on purpose: an OPEN request can never carry a resolution time
-- (the half that would be a lie). The converse is NOT asserted, because two rows
-- closed before this column existed — and every future row written by
-- portal_add_contact, which inserts 'handled' outright — legitimately have no
-- timestamp, and stamping one would be inventing a moment that was never
-- recorded.
alter table public.service_requests drop constraint if exists service_requests_resolved_at_check;
alter table public.service_requests add constraint service_requests_resolved_at_check
  check (resolved_at is null or status <> 'new');

-- ── 4) Media shape, enforced by the database ─────────────────────────────────
-- A CHECK cannot contain a subquery, so the per-element test lives in an
-- IMMUTABLE validator. Every element must be
--   portal/<uuid>/<uuid>.<image ext>
-- which contains no caller-supplied text whatsoever, and at most 6 of them.
create or replace function public.portal_request_photos_ok(p text[])
 returns boolean
 language sql
 immutable
 parallel safe
as $function$
  select coalesce(array_length(p, 1), 0) <= 6
     and coalesce(array_length(p, 1), 0) = (
           select count(*) from unnest(p) as u
            where u ~ ('^portal/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
                    || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
                    || '\.(jpg|jpeg|png|webp|heic|heif)$')
         )
$function$;

comment on function public.portal_request_photos_ok(text[]) is
  'Validator for service_requests.photos: at most 6 elements, each a booking-uploads path of the shape portal/<uuid>/<uuid>.<ext>. Used by a CHECK constraint, so it holds no matter which door writes.';

revoke all on function public.portal_request_photos_ok(text[]) from public, anon, authenticated, service_role;
-- Owner UPDATEs (resolve/dismiss) re-evaluate the CHECK as `authenticated`, so
-- that role needs EXECUTE. The portal doors run SECURITY DEFINER as the owner of
-- the function and never touch anon's privileges.
grant execute on function public.portal_request_photos_ok(text[]) to authenticated;
grant execute on function public.portal_request_photos_ok(text[]) to service_role;

alter table public.service_requests drop constraint if exists service_requests_photos_check;
alter table public.service_requests add constraint service_requests_photos_check
  check (public.portal_request_photos_ok(photos));

-- ── 5) Duplicate submission protection, in the database ──────────────────────
-- The client already guards double-taps, but the case that actually happens is
-- the one a client cannot guard: the insert succeeds, the response is lost on a
-- phone's flaky connection, and the customer submits again. A second row would
-- also mean a second inbound message in the owner's thread and a second
-- notification for one ask.
--
-- Scoped to OPEN rows so the same ask after the first was handled is a genuine
-- new request, and to non-null dedup_key so the 29 legacy rows (which have none)
-- are exempt and the index can be created without rewriting history.
create unique index if not exists service_requests_open_dedup_idx
  on public.service_requests (customer_id, dedup_key)
  where dedup_key is not null and status = 'new';

-- The owner's "what is still open from my customers?" read.
create index if not exists service_requests_open_portal_idx
  on public.service_requests (user_id, created_at desc)
  where from_portal and status = 'new';

-- ── 6) ONE request engine ────────────────────────────────────────────────────
-- The 7-argument signature is DROPPED, not left beside the new one: two
-- overloads that differ only by a defaulted trailing parameter make a 7-argument
-- named call ambiguous, and PostgREST would start failing with "function is not
-- unique" rather than picking one.
drop function if exists public.portal_submit_request(text, text, text, date, uuid, uuid, jsonb);

CREATE OR REPLACE FUNCTION public.portal_submit_request(
  p_token text,
  p_message text,
  p_kind text DEFAULT 'service'::text,
  p_preferred_date date DEFAULT NULL::date,
  p_job_id uuid DEFAULT NULL::uuid,
  p_recurrence_id uuid DEFAULT NULL::uuid,
  p_details jsonb DEFAULT NULL::jsonb,
  p_photos text[] DEFAULT NULL::text[])
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_customer uuid; v_user uuid; v_msg text; v_photos text[]; v_key text;
begin
  -- The token proves WHICH CUSTOMER. Everything below is re-resolved against it.
  select customer_id, user_id into v_customer, v_user
    from public.customer_portal_tokens where token = p_token and not revoked;
  if v_customer is null then return false; end if;

  v_msg := left(btrim(coalesce(p_message, '')), 2000);
  if v_msg = '' then return false; end if;
  if p_kind not in ('service','appointment','reschedule','plan_change','additional_work') then return false; end if;

  -- A caller-supplied id proves nothing on its own: a job or plan named here must
  -- belong to THIS token's customer AND this business, or the request is refused.
  if p_job_id is not null and not exists (
    select 1 from public.jobs where id = p_job_id and customer_id = v_customer and user_id = v_user
  ) then return false; end if;
  if p_recurrence_id is not null and not exists (
    select 1 from public.job_recurrences where id = p_recurrence_id and customer_id = v_customer and user_id = v_user
  ) then return false; end if;

  -- Media is REFUSED, never silently dropped. A legitimate client can only ever
  -- produce paths it just uploaded, so a malformed one means the call was
  -- tampered with — and quietly discarding a photo the customer attached would
  -- be the portal lying about what it sent.
  v_photos := coalesce(p_photos, '{}'::text[]);
  if not public.portal_request_photos_ok(v_photos) then return false; end if;

  if (select count(*) from public.service_requests
       where customer_id = v_customer and created_at > now() - interval '1 hour') >= 20
  then return false; end if;

  -- Same ask, same day preference, same visit ⇒ same key. Paired with the partial
  -- unique index, a resubmission while the first is still open is a no-op that
  -- still reports success: the request IS on file, which is what the customer
  -- asked to be true.
  v_key := md5(p_kind || '|' || lower(v_msg) || '|'
            || coalesce(p_preferred_date::text, '') || '|' || coalesce(p_job_id::text, ''));

  insert into public.service_requests
    (user_id, customer_id, message, kind, preferred_date, job_id, recurrence_id, details, photos, from_portal, dedup_key)
  values
    (v_user, v_customer, v_msg, p_kind, p_preferred_date, p_job_id, p_recurrence_id, p_details, v_photos, true, v_key)
  on conflict do nothing;

  return true;
end; $function$;

-- The free-text / preset door is now a WRAPPER, not a second implementation. It
-- had no rate limit and no dedup of its own; routing it through the engine gives
-- it both, and means a future rule can never be added to one door and forgotten
-- on the other. Every existing caller (the service cards, the contact-method
-- card, "Something else?") keeps its 2-argument signature.
CREATE OR REPLACE FUNCTION public.portal_request_service(p_token text, p_message text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  return public.portal_submit_request(p_token, p_message, 'service');
end; $function$;

-- ── 7) Grants ────────────────────────────────────────────────────────────────
-- The DROP above took the old signature's grants with it. The portal is a
-- public, no-login surface, so anon must be able to execute the door — the
-- function's own body is what scopes it to one customer.
revoke all on function public.portal_submit_request(text, text, text, date, uuid, uuid, jsonb, text[])
  from public, anon, authenticated, service_role;
grant execute on function public.portal_submit_request(text, text, text, date, uuid, uuid, jsonb, text[]) to anon;
grant execute on function public.portal_submit_request(text, text, text, date, uuid, uuid, jsonb, text[]) to authenticated;
grant execute on function public.portal_submit_request(text, text, text, date, uuid, uuid, jsonb, text[]) to service_role;
