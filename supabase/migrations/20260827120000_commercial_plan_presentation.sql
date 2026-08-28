-- ── Commercial plan presentation and term — Session 111 ──────────────────────
-- Four nullable columns on service_pricing_plans. No new table, no new engine.
--
-- WHAT S107 BUILT AND WHAT IT COULD NOT SAY.
-- service_pricing_plans already expresses "this service is sold five ways, and
-- here is the rule that turns a measurement into money for each". That is the
-- commercial offering, and it is not rebuilt here.
--
-- What a plan row cannot express is anything a CUSTOMER reads. It has a term key
-- and a rate, so the only sentence available to put under "$240 / month" on a
-- quote was the provenance string lib/measurePricing builds for the OWNER —
-- "$0.05/sq ft x 1,392 sq ft". That is the internal rationale for the number,
-- and it was being written into quote_options.description, which is a
-- customer-facing field on the quote, the portal and the PDF.
--
-- ⛔ NO DEFAULT SENTENCES. These columns are NULL until the owner types
-- something, and a NULL renders as nothing at all. The product does not ship
-- "Pay only when service occurs" as a default, because that is a promise about
-- how a business operates and only that business can make it. Same discipline as
-- the rate itself: EdgeHQ ships no default price, and it ships no default claim.

-- ── 1. What the customer reads about this plan ───────────────────────────────
alter table public."service_pricing_plans"
  add column if not exists "customer_note" text;

-- Empty string is not a note. Mirrors quote_addons_name_check / the rest of the
-- codebase: a column that means "the owner said nothing" says it with NULL, so
-- no reader has to test for two flavours of absence.
do $$ begin
  alter table public."service_pricing_plans"
    add constraint "service_pricing_plans_customer_note_check"
    check ("customer_note" is null or btrim("customer_note") <> '');
exception when duplicate_object then null; end $$;

comment on column public."service_pricing_plans"."customer_note" is
  'The owner''s own one-line description of this plan, shown to the customer beside its price (becomes quote_options.description). NULL = the owner has not written one, and nothing is shown. ⛔ No default text: a claim about how service is delivered is the business''s to make, never the product''s.';

-- ── 2. The period this plan's price covers ───────────────────────────────────
-- ⭐⭐ THIS IS NOT A SECOND DEFINITION OF A SEASON, AND THE DISTINCTION IS THE
-- WHOLE REASON THESE COLUMNS EXIST.
--
-- S107's migration said, correctly, that seasons already exist and that adding
-- a second definition would create two answers to "when does winter end". That
-- is still true, and business_settings.service_seasons is still the only answer
-- to that question. lib/seasons is untouched by this migration.
--
-- A SEASON and a PLAN TERM are different facts:
--
--   business_settings.service_seasons   WHEN THE BUSINESS OPERATES
--     Recurring month/day anchors (Nov 1 -> Mar 31), resolved for a service by
--     keyword hints on its NAME. Recurs every year by construction: it cannot
--     name a particular winter, because it is not about one.
--
--   service_pricing_plans.term_*        WHAT THIS $900 BUYS
--     Concrete dates on one commercial offer. "$900 seasonal" is meaningless to
--     a customer, and unenforceable to the business, unless it says which season
--     — and next year's price will differ, so it cannot be a recurring anchor.
--
-- A quote that says "$900 / season" and cannot say which dates is the gap. The
-- season engine could not close it, because a recurring anchor is the wrong
-- shape for a price, and because it reads service names — which is exactly what
-- this product's pricing path must never do.
--
-- ⛔ NOT RESTRICTED TO term = 'seasonal'. A twelve-month monthly agreement has a
-- term too. Restricting these columns to one term key would be product logic
-- deciding which commercial arrangements a business is allowed to have; the
-- owner decides, and every term may carry a term or leave it NULL.
alter table public."service_pricing_plans"
  add column if not exists "term_label" text;
alter table public."service_pricing_plans"
  add column if not exists "term_start" date;
alter table public."service_pricing_plans"
  add column if not exists "term_end" date;

do $$ begin
  alter table public."service_pricing_plans"
    add constraint "service_pricing_plans_term_label_check"
    check ("term_label" is null or btrim("term_label") <> '');
exception when duplicate_object then null; end $$;

-- The only rule the database can honestly enforce about these dates: a term
-- cannot end before it starts. Everything else — how long a season is, whether
-- one is required at all — is the owner's configuration, not the product's
-- opinion. ⛔ Deliberately NOT "seasonal plans must have dates": an owner who
-- sells a season by a named term ("2026/27 Winter") without committing to
-- calendar dates is describing a real arrangement, and refusing to store it
-- would push them into inventing dates they did not mean.
do $$ begin
  alter table public."service_pricing_plans"
    add constraint "service_pricing_plans_term_range_check"
    check ("term_start" is null or "term_end" is null or "term_end" >= "term_start");
exception when duplicate_object then null; end $$;

comment on column public."service_pricing_plans"."term_label" is
  'Owner-named term this plan''s price covers, e.g. "2026/27 Winter Season". NULL = unnamed. ⛔ Not a season definition — business_settings.service_seasons remains the only answer to when the business operates; this names the period ONE price buys.';
comment on column public."service_pricing_plans"."term_start" is
  'First day this plan''s price covers. Concrete date, not a recurring anchor: next year is a different term at a different price. NULL = the owner has not dated it.';
comment on column public."service_pricing_plans"."term_end" is
  'Last day this plan''s price covers. NULL = the owner has not dated it. ⛔ Neither this nor term_start schedules anything: a term is a commercial period, and visits are still created only by job_recurrences and the dispatch surfaces.';
