-- ── Service bundles: a reusable starting scope ───────────────────────────────
--   Run once. Purely additive: two new tables + two unique constraints on
--   existing ones (both trivially already true, since `id` is a primary key).
--
-- WHY A NEW TABLE AND NOT A SECOND CATALOGUE
-- `service_templates` (27 live rows; the Settings page titled "Service
-- Templates") is already THE catalogue: one row = ONE service, carrying the
-- rate, unit costs and canned description that service is normally sold at.
-- What it cannot express is "Spring Cleanup" — the four services an owner
-- quotes together every March. That is the entire gap, so this is a GROUPING
-- OVER the catalogue and never a copy of it: an item points at a catalogue row
-- and, by default, has no price of its own.
--
-- VOCABULARY — this repo has been bitten badly by one word meaning three things
-- (three different objects were all called a "follow-up"). Three distinct nouns:
--   Service — a catalogue row (`service_templates`). Owns the default rate.
--   Bundle  — a named, reusable SET of service lines that SEEDS a quote. THIS.
--   Option  — Budget/Recommended/Premium (`quote_options`, shipped separately):
--             ALTERNATIVE whole-job prices the customer picks between. An
--             option REPLACES the quote total; a bundle seeds the lines that
--             ADD UP to it. The database already refuses a quote holding both
--             (`quote_options_shape_guard`), which is why applying a bundle to
--             an options quote is impossible rather than merely discouraged.
-- ⛔ Do NOT rename these to "template" — that noun is taken by the catalogue.
--
-- COPY, NOT LIVE LINK — enforced by ABSENCE
-- Applying a bundle INSERTs ordinary `quote_services` rows (and fills the
-- primary service's flat fields on `quotes`). There is deliberately NO
-- `bundle_id` on `quotes` or `quote_services`: with no reference anywhere,
-- editing or deleting a bundle CANNOT reach a quote that was built from it.
-- A structural guarantee, not a rule someone has to remember. The only link a
-- seeded line keeps is `quote_services.service_template_id` — to the CATALOGUE
-- service, exactly as a hand-typed line does.
--
-- PRICE SEMANTICS — a bundle is a STARTING POINT, never a promise
--   unit_price NULL → follow the catalogue's `default_rate` AT APPLY TIME.
--                     The default and the canonical path: re-price a service in
--                     the catalogue and every future quote built from a bundle
--                     follows, with no bundle to go and re-edit.
--   unit_price SET  → the owner typed a per-bundle figure for this line. Still
--                     only a seed for `quote_services.unit_price`, which the
--                     builder has always let an owner type by hand. Nothing
--                     recomputes it and nothing reads it once the line is on
--                     the quote.
-- No pricing engine is involved either way. This table stores numbers an owner
-- typed; it never derives one. (Pricing is frozen outside the Pricing V2
-- roadmap — a bundle deliberately adds no rule, rate curve or multiplier.)

begin;

-- ── Same-owner anchors ───────────────────────────────────────────────────────
-- So a child row can name its parent AND its tenant in ONE foreign key, making
-- "this item belongs to a bundle owned by the same business" a database fact
-- rather than a convention the application has to keep. Same shape the
-- quote-options work used for (selected_option_id, id). Both are already true —
-- `id` is a primary key in each table — so neither takes any row out.
alter table public.service_templates
  add constraint service_templates_id_user_uk unique (id, user_id);

-- ── The bundle ───────────────────────────────────────────────────────────────
create table public.service_bundles (
  id          uuid primary key default uuid_generate_v4(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  -- What the owner picks from a list: "Spring Cleanup", "Move-out clean".
  name        text not null,
  -- Optional reminder of what this covers. The owner's words, for the owner —
  -- never shown to a customer, because a bundle is not a document.
  description text,
  sort_order  integer not null default 0,
  constraint service_bundles_name_not_blank check (btrim(name) <> ''),
  -- A second "Spring Cleanup" is always a mistake, and two identically-named
  -- rows in a picker is the worst possible outcome for a feature whose whole
  -- job is "pick the right one fast". Case- and space-insensitive so
  -- "spring cleanup " cannot slip past it.
  constraint service_bundles_id_user_uk unique (id, user_id)
);

create unique index service_bundles_user_name_uk
  on public.service_bundles (user_id, lower(btrim(name)));
create index service_bundles_user_sort_idx
  on public.service_bundles (user_id, sort_order, created_at);

create trigger service_bundles_updated_at
  before update on public.service_bundles
  for each row execute function handle_updated_at();

-- ── The lines it seeds ───────────────────────────────────────────────────────
-- Deliberately the same shape as `quote_services`, because that is exactly what
-- each one becomes. Same column names, same `kind`, same unit vocabulary — so
-- applying a bundle is a field-for-field copy with no translation layer to
-- drift out of step.
create table public.service_bundle_items (
  id         uuid primary key default uuid_generate_v4(),
  created_at timestamptz not null default now(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  bundle_id  uuid not null,
  -- The catalogue service this line IS, when it is one. Null = one-off work
  -- named by hand, exactly as the quote builder already allows.
  service_template_id uuid,
  -- The line's display name. Copied to `quote_services.service_type`, which
  -- carries the same historical name for the same thing.
  name       text not null,
  quantity   numeric not null default 1,
  -- Any `service_units` code. Null falls back to 'each' at apply time.
  unit       text,
  -- NULL = follow the catalogue rate at apply time. See PRICE SEMANTICS above.
  unit_price numeric,
  est_minutes integer,
  notes      text,
  kind       text not null default 'service',
  sort_order integer not null default 0,
  constraint service_bundle_items_name_not_blank check (btrim(name) <> ''),
  constraint service_bundle_items_quantity_positive check (quantity > 0),
  constraint service_bundle_items_price_not_negative
    check (unit_price is null or unit_price >= 0),
  constraint service_bundle_items_minutes_not_negative
    check (est_minutes is null or est_minutes >= 0),
  -- Mirrors quote_services_kind_check. A material line on a bundle becomes a
  -- material line on the quote; omit the kind and every material silently
  -- becomes a service.
  constraint service_bundle_items_kind_check check (kind in ('service', 'material')),
  -- The parent AND the tenant in one key: an item can only ever hang off a
  -- bundle belonging to the same business. Without the user_id half, a caller
  -- could file its own row inside someone else's bundle.
  constraint service_bundle_items_bundle_same_owner
    foreign key (bundle_id, user_id)
    references public.service_bundles (id, user_id) on delete cascade,
  -- Same rule for the catalogue link, so a bundle can never quietly reference
  -- another business's service. Column-scoped SET NULL (PG 15+) because
  -- user_id is NOT NULL and must survive the catalogue row being deleted —
  -- the line then behaves exactly like hand-typed work, which is what it is.
  constraint service_bundle_items_template_same_owner
    foreign key (service_template_id, user_id)
    references public.service_templates (id, user_id)
    on delete set null (service_template_id)
);

create index service_bundle_items_bundle_idx
  on public.service_bundle_items (bundle_id, sort_order, created_at);

-- ── Tenancy ──────────────────────────────────────────────────────────────────
-- One business cannot read, use or damage another's bundles. Same policy shape
-- as every other owner-scoped table here (`auth.uid() = user_id`), with an
-- explicit WITH CHECK on UPDATE so a row cannot be handed to another user_id.
alter table public.service_bundles       enable row level security;
alter table public.service_bundle_items  enable row level security;

create policy "bundles: select own" on public.service_bundles
  for select using (auth.uid() = user_id);
create policy "bundles: insert own" on public.service_bundles
  for insert with check (auth.uid() = user_id);
create policy "bundles: update own" on public.service_bundles
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "bundles: delete own" on public.service_bundles
  for delete using (auth.uid() = user_id);

create policy "bundle items: select own" on public.service_bundle_items
  for select using (auth.uid() = user_id);
create policy "bundle items: insert own" on public.service_bundle_items
  for insert with check (auth.uid() = user_id);
create policy "bundle items: update own" on public.service_bundle_items
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "bundle items: delete own" on public.service_bundle_items
  for delete using (auth.uid() = user_id);

-- No DEFINER function, no RPC, no grant to anon: these tables are reached only
-- by an authenticated owner through PostgREST, under the policies above. The
-- audit that found every tenant hole on an RLS-OFF surface is the reason this
-- feature deliberately adds neither.

commit;

-- ── Verify (run after; every line must report true) ──────────────────────────
-- select
--   (select relrowsecurity from pg_class where oid='public.service_bundles'::regclass)      as bundles_rls_on,
--   (select relrowsecurity from pg_class where oid='public.service_bundle_items'::regclass) as items_rls_on,
--   (select count(*) from pg_policy where polrelid='public.service_bundles'::regclass)      = 4 as bundles_4_policies,
--   (select count(*) from pg_policy where polrelid='public.service_bundle_items'::regclass) = 4 as items_4_policies,
--   not has_table_privilege('anon','public.service_bundles','select')                       as anon_cannot_select,
--   not has_table_privilege('anon','public.service_bundle_items','select')                  as anon_items_cannot_select;
