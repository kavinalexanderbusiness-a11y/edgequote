-- ── Pricing v2 · Phase 0 · Sensor: the CUSTOMER-side half of the accept record ──
-- Companion to RUN-2026-07-16c (which added quotes.accepted_price / selected_cadence).
-- Master plan: https://claude.ai/code/artifact/6082f1d8-33b9-4541-af8a-ef0041aacb66
--
-- `portal_accept_quote` set status='accepted' and recorded nothing else. So the most
-- trustworthy acceptance in the product — the customer clicking it themselves —
-- taught the learner nothing, and `repPriceAndCadence` went on guessing weekly-first.
--
-- TWO DELIBERATE CHOICES:
--
-- 1. `accepted_price` is snapshotted from the quote's OWN `total`, inside the same
--    UPDATE. It is NOT a parameter. A portal caller holds only a token; it must never
--    be able to tell the server what it agreed to pay. `coalesce(accepted_price,
--    total)` also makes this idempotent — a double-click cannot rewrite the snapshot.
--
-- 2. `selected_cadence` stays NULL. The portal's button means "yes to this quote",
--    not "yes to weekly". Writing a cadence here would be exactly the invented
--    distinction these columns exist to eliminate. When the portal grows a real
--    cadence choice, THAT is when this records one.
--
-- The signature is UNCHANGED (p_token, p_quote_id) — no client edit, no redeploy
-- coupling. Everything else about the function is byte-identical to the prior
-- definition: same token check, same `status = 'sent'` guard, same `found` return.

create or replace function public.portal_accept_quote(p_token text, p_quote_id uuid)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_customer uuid;
begin
  select customer_id into v_customer from public.customer_portal_tokens where token = p_token and not revoked;
  if v_customer is null then return false; end if;
  update public.quotes
     set status = 'accepted',
         accepted_price = coalesce(accepted_price, total)
   where id = p_quote_id and customer_id = v_customer and status = 'sent';
  return found;
end; $function$;
