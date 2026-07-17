-- ── business_type default: lawn_landscaping → general ────────────────────────
-- The 'lawn_landscaping' default existed for the ADD COLUMN backfill (every row
-- that existed on 2026-07-15 WAS the founding lawn business, and those rows keep
-- their physically-stored value — a default change never rewrites them). As an
-- ONGOING default it was a latent mis-brand: any business_settings row created
-- by a side path (booking-token upsert, a settings save racing the first-run
-- gate) was silently born a lawn company. /setup writes business_type explicitly
-- on both "apply" and "skip", so the default should only ever be hit by accident
-- — and an accident must land on the neutral pack (the registry's fail-safe),
-- never on a trade.
--
-- Non-destructive: changes the column DEFAULT only; no row is touched.

alter table public.business_settings
  alter column business_type set default 'general';
