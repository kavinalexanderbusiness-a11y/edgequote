-- ── Tenant welds: portal tokens, the payment ledger, and booking uploads ─────
--
-- Three cross-tenant defects, each the same shape: a child row carries user_id,
-- the parent row carries user_id, and NOTHING makes them agree. RLS validates
-- only that the child's user_id is the caller's, so the caller supplies whatever
-- parent id they like.
--
-- Verified against production before writing (2026-08-16):
--   payments      -> invoices  mismatched rows : 0
--   payments      -> customers mismatched rows : 0
--   portal tokens -> customers mismatched rows : 0
-- so every constraint below validates against existing data without repair.
--
-- The pattern being applied already exists in this schema: payments_quote_tenant_fkey
-- welds (user_id, quote_id) -> quotes(user_id, id). The quote leg was welded and
-- the invoice leg was not. This makes them consistent.
--
-- ⚠️ SCOPE: production carries 111 single-column tenant->tenant foreign keys of
-- this shape. This migration welds the THREE with a demonstrated exploit path.
-- The remaining 108 are a known, recorded class — not silently fixed here.

-- ═══════════════════════════════════════════════════════════════════════════
-- B1 — a portal token must belong to a customer of the SAME business
-- ═══════════════════════════════════════════════════════════════════════════
-- Before: "portal_tokens: insert own" checks only (auth.uid() = user_id), and the
-- FK accepts ANY customers.id. So a signed-in tenant could mint a working portal
-- token for another tenant's customer, then read their PII through get_portal_data
-- and act on it through portal_remove_card / portal_accept_quote /
-- portal_respond_change_order.
--
-- The composite FK makes that row impossible to INSERT, which is what makes every
-- downstream `where customer_id = v_customer` lookup tenant-correct: the token can
-- no longer pair one tenant's user_id with another tenant's customer.
alter table public.customer_portal_tokens
  drop constraint if exists customer_portal_tokens_customer_id_fkey;

alter table public.customer_portal_tokens
  add constraint customer_portal_tokens_customer_same_owner
  foreign key (user_id, customer_id)
  references public.customers (user_id, id)
  on delete cascade;

-- ═══════════════════════════════════════════════════════════════════════════
-- B2 — a payment must belong to an invoice of the SAME business
-- ═══════════════════════════════════════════════════════════════════════════
-- invoices has no composite unique key yet, so there is nothing for a composite FK
-- to reference. id is already the primary key, so (user_id, id) is unique by
-- construction and this validates instantly.
alter table public.invoices
  add constraint invoices_user_id_id_key unique (user_id, id);

-- ON DELETE SET NULL (invoice_id) nulls ONLY the invoice pointer, never user_id —
-- the money-preserving behaviour the previous constraint had, and the same form
-- payments_quote_tenant_fkey already uses.
alter table public.payments
  drop constraint if exists payments_invoice_id_fkey;

alter table public.payments
  add constraint payments_invoice_tenant_fkey
  foreign key (user_id, invoice_id)
  references public.invoices (user_id, id)
  on delete set null (invoice_id);

alter table public.payments
  drop constraint if exists payments_customer_id_fkey;

alter table public.payments
  add constraint payments_customer_tenant_fkey
  foreign key (user_id, customer_id)
  references public.customers (user_id, id)
  on delete set null (customer_id);

-- Defence in depth for the trigger that turns payment rows into invoice STATUS.
-- The FK above already makes a foreign-tenant payment row unINSERTable; this makes
-- the sum itself refuse to cross a tenant even if a row ever got there another way
-- (a future service_role path, a restore, a migration). Body is otherwise byte-for-
-- byte the live definition — read from production, not from a repo copy, because
-- replaying an older get_portal_data/recompute has silently regressed this database
-- before (docs/MIGRATIONS.md).
create or replace function public.recompute_invoice_paid_for(p_invoice_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_inv record;
  v_paid numeric;
  v_total numeric;
  v_gst numeric;
begin
  if p_invoice_id is null then return; end if;

  select i.*, bs.gst_percent into v_inv
  from public.invoices i
  left join public.business_settings bs on bs.user_id = i.user_id
  where i.id = p_invoice_id;
  if not found then return; end if;

  -- ⭐ p.user_id = v_inv.user_id — a payment row belonging to another business can
  -- never contribute to this invoice's paid total.
  select coalesce(sum(p.amount), 0) into v_paid
  from public.payments p
  where p.invoice_id = p_invoice_id
    and p.user_id = v_inv.user_id
    and p.kind = 'payment' and p.status = 'paid';

  v_gst := coalesce(v_inv.gst_percent, 0);
  v_total := round(v_inv.amount * (1 + v_gst / 100), 2);

  update public.invoices set
    amount_paid = v_paid,
    paid_at = case when v_paid + 0.01 >= v_total and v_total > 0 then coalesce(paid_at, now()) else null end,
    status = case
      when status = 'cancelled' then status                    -- terminal: never auto-revived
      when status = 'draft' then status
      when v_paid <= 0 then (case when status in ('paid','partial','overpaid') then 'unpaid' else status end)
      when v_paid + 0.01 < v_total then 'partial'
      when v_paid <= v_total + 0.01 then 'paid'
      else 'overpaid'
    end
  where id = p_invoice_id;
end; $function$;

-- ═══════════════════════════════════════════════════════════════════════════
-- B3 — booking uploads must not be a directory of every tenant's booking token
-- ═══════════════════════════════════════════════════════════════════════════
-- Object paths in this bucket begin with the RAW booking token
-- (`<booking_token>/<uuid>-<name>`), so a bucket-wide SELECT for `authenticated`
-- is not merely photo disclosure — LISTING it hands any signed-in tenant every
-- other tenant's booking token, which is the credential the public /book funnel
-- authenticates with.
--
-- Dropping the policy removes LIST/read through the storage API. It deliberately
-- does NOT change `public = true`: booking photos are stored in the database as
-- public URLs (lead_meta.photos), so flipping the bucket private would 404 every
-- photo already attached to a real booking. Privatising it is a separate change
-- that has to migrate stored URLs to paths and add a signed-URL read path first;
-- it is recorded, not silently skipped.
drop policy if exists "booking-uploads: read own" on storage.objects;

-- Bound what an anonymous uploader can put here. Previously: any MIME, any size,
-- unlimited. crew-media already carries exactly this shape.
update storage.buckets
   set file_size_limit   = 15728640,   -- 15 MB: a generous phone photo, a bounded abuse budget
       allowed_mime_types = array['image/jpeg','image/jpg','image/png','image/webp','image/heic','image/heif']
 where id = 'booking-uploads';
