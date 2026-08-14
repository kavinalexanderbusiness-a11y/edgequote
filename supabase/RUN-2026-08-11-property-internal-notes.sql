-- ── Private notes about a PLACE ──────────────────────────────────────────────
-- A field-service business needs to record "gate is on the east side", "dog in
-- the back yard", "irrigation controller beside the garage". Before this column
-- there was nowhere honest to put it.
--
-- What already existed, and why none of it was the right home:
--   * properties.notes    — CUSTOMER-FACING. get_portal_data selects it and the
--                           portal renders it under "Notes from your provider";
--                           the property page even warns "don't park a gate code
--                           here". Writing access details there mails them to
--                           the customer.
--   * customers.notes     — private (correctly absent from get_portal_data), but
--                           it describes the PERSON. A customer with three
--                           addresses would get one blob of gate codes with no
--                           way to say which gate.
--   * jobs.notes          — also portal-visible, and scoped to ONE visit. A gate
--                           does not belong to a Tuesday.
--
-- So the gap is real and it is exactly one field wide: private, and about the
-- PLACE. This deliberately does NOT introduce a new word for it — `internal_notes`
-- is already the product's name for "the owner's, never the customer's"
-- (invoices.internal_notes, RUN-2026-07-15). Reusing that name is the point:
-- "property notes / access notes / crew notes / gate notes" as four columns
-- would be four places to look and four places to forget.
--
-- PRIVACY IS STRUCTURAL, NOT A PROMISE. get_portal_data enumerates the property
-- columns it returns (address, city, province, postal_code, lawn_sqft,
-- fence_length, neighborhood, notes) rather than selecting the row, so a new
-- column is invisible to the portal BY CONSTRUCTION — this migration does not
-- touch that function, and scripts/verify-location-intelligence.ts fails the
-- build if the column ever appears in it.
--
-- Nullable, no backfill, no default: 113 existing properties are unchanged, and
-- an empty note stays NULL rather than becoming an empty string that renders as
-- a blank card. RLS is untouched — `properties` is already own-row, so this
-- column inherits exactly the tenant isolation the rest of the row has.
--
-- Idempotent: safe to run more than once.

alter table public.properties
  add column if not exists internal_notes text;

comment on column public.properties.internal_notes is
  'Private to the owner and crew: never returned by get_portal_data and never rendered in the customer portal. Home for access and site facts about the PLACE (gate side, dog, shut-off/controller location, parking). Customer-facing property notes stay in `notes`; private notes about the PERSON stay in customers.notes.';
