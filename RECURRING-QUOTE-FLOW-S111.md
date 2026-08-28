# Recurring service quoting — what Session 111 built, and what it deliberately did not

Two things were asked for that S111 does **not** deliver, both on purpose, and both
because building them blind would have meant inventing an engine the product
already half-has. They are characterised here so the next session starts from
measurement rather than from a guess.

Everything below was measured against `origin/main` @ `fc31857f` and the live
production database (read-only probes; no operational record was modified).

---

## Part 1 — THE SERVICE TRIGGER GAP

> *Reported separately, as instructed. A commercial plan/term is not an
> operational trigger, and neither is an operational recurrence.*

### 1.1 What the brief asked for

A generic, owner-configurable statement of **how service is set in motion**:

- scheduled recurrence
- on demand
- event / condition triggered ("service begins after X cm")
- customer-requested
- fixed appointment schedule

### 1.2 The operational models that already exist

Five things on `main` answer some part of "when does work happen". None of them
answers "how is this SERVICE triggered".

| # | Model | What it actually is | Owner-configurable? |
|---|---|---|---|
| 1 | `job_recurrences` | THE calendar engine. `freq` ∈ `weekly · biweekly · monthly`, plus `interval_unit`/`interval_count` (`day·week·month`), `start_date`, `end_date`, `end_count`. `jobs.recurrence_id` ties each visit to it, and a `jobs` row **is** a visit. | Per customer/series, not per service |
| 2 | `schedule_items` | A dated appointment. `type` ∈ `estimate · callback · appointment · task · reminder`, with `scheduled_date`, `status`, `converted_quote_id`. This is the "fixed appointment schedule" primitive (estimate appointments, S79). | Per item |
| 3 | `service_requests` | THE customer-requested door. `kind` ∈ `service · appointment · reschedule · plan_change · additional_work`, plus `from_portal`, `preferred_date`, `details jsonb`, `dedup_key`, and links out to `job_id` / `recurrence_id`. | Per request |
| 4 | `service_templates.recurrence` | `one_time · recurring_ok · usually_recurring`, read by `lib/serviceRecurrence`. ⚠️ This is **eligibility**, not a trigger: it says whether this service *may* repeat, and `mayRecommendRecurring()` still demands real cadence evidence before suggesting anything. | Per service ✅ |
| 5 | Ad-hoc `jobs` | A visit with `recurrence_id IS NULL`. On-demand work exists, but only as the *absence* of a recurrence — it is never declared. | n/a |

**Contracts are NOT on `main`.** `session83/contracts` is built and pushed but
unmerged, so there is no contract-term primitive to hang a trigger from either.
(The nine `contract` hits in the baseline are `schema_contract()` and friends,
unrelated.)

### 1.3 ⭐⭐ The finding that makes this dangerous

`job_recurrences.freq` and `service_pricing_plans.term` **share three values
word for word**:

```
job_recurrences.freq          weekly · biweekly · monthly
service_pricing_plans.term    one_time · weekly · biweekly · monthly · seasonal
                                         ^^^^^^^^^^^^^^^^^^^^^^^^^^^
```

One is how often a crew attends. The other is what the customer pays per. They
are different facts with identical names, one join away from each other. That
overlap — not a missing feature — is the real hazard, and it is why S111 spends
so much of its guard budget asserting that no `PricingTerm` reaches a recurrence
builder and that `lib/recurringOffering` imports no scheduling engine.

Any trigger primitive added later inherits this hazard, because a third
vocabulary about *when work happens* would sit beside two that already collide.

### 1.4 What is genuinely missing

1. **No per-service trigger declaration.** A service cannot say "this is done on
   demand" or "this runs to a schedule". `service_templates.recurrence` is the
   nearest column and answers a different question (may it repeat).
2. **Nothing at all for condition/event-driven work.** No table, no column, no
   enum, anywhere. "Service begins after 5 cm" has no home, not even a text field
   the owner could type it into and have it appear on a quote.
3. **On-demand is inferred, never declared** — the absence of a `recurrence_id`.
4. **No seam from a quote to any of it.** A quote records what was *sold*; nothing
   carries "and here is how it will be set in motion" through to operations.

### 1.5 Why S111 introduced no schema for it

Three shapes are defensible and they are not equivalent:

- **(a) A per-service enum** (`scheduled · on_demand · event · customer_request ·
  appointment`) — cheap, but it is a fourth vocabulary about when work happens,
  and enums are the hardest thing to widen later.
- **(b) A per-service free-text policy** shown on the quote — honest, owner-
  authored, zero product logic, but purely presentational: nothing can act on it.
- **(c) A first-class trigger row** that dispatch actually consults — the only one
  that changes behaviour, and the only one that risks becoming a second
  scheduling engine beside `job_recurrences`.

The brief's own example decides nothing between them: *"Service begins after X cm"*
is **(b)** if it is a sentence on a quote, and **(c)** if anything is expected to
happen when it snows. Those are different products.

**Recommended next step:** answer one question before any column — *does a
trigger CHANGE what the system does, or only what the customer is told?* If the
latter, (b) is a nullable text column on `service_templates` and a line in the
offerings panel, and it is a small session. If the former, it belongs with
`job_recurrences` and dispatch, and it is a large one that should land after
`session83/contracts`, because a contract term is the natural owner of "what we
committed to do, and when".

⛔ Whichever is chosen: **do not name its values `weekly`/`monthly`.**

---

## Part 2 — THE QUOTE ADD-ONS SEAM

> S111 characterises this and leaves the seam. It builds none of it.

### 2.1 ⚠️ A correction to the record

`quote-addons-v1-schema-live-code-lost` states that Session 106 landed **both**
halves of S57 quote add-ons, citing `git grep -il addon origin/main -- src` → 17
files. **That grep is misleading and the conclusion is wrong.** Those 17 files are
`JobAddons.tsx`, `AddonTemplate`, `addonsTotal`, `lib/trades/*` — the **job**
add-on feature, a different concept at a different time.

Measured on `origin/main` @ `fc31857f`:

```
git grep -n "quote_addons" -- src     →  0 matches
src/lib/quoteAddons.ts                →  does not exist
src/components/quotes/QuoteAddons*    →  does not exist
```

**The database half is live. The application half has never landed.**

### 2.2 The canonical DB seam that already exists

All present in `supabase/migrations/20260826120001_baseline.sql` and in production:

| Object | What it guarantees |
|---|---|
| `quote_addons` | The extras themselves: `name`, `description`, `price`, `sort_order`, `is_selected`, `selected_via` ∈ `default·portal·owner`, `selected_at`. Composite FK `(user_id, quote_id) → quotes(user_id, id)`. |
| `quotes.addons_total` | Σ of **selected** extras. Written **only** by trigger `quote_addons_sync_total` — app code never writes it. |
| `quotes.total` | Re-expressed generated column: `initial_price + coalesce(travel_fee,0) + coalesce(addons_total,0)`. This is why invoicing, job costing, deposits and pipeline needed no change. |
| `quote_addons_write_guard` | BEFORE trigger enforcing the **post-approval freeze**, the selection invariant, and the cap of 6. Structural, not a UI rule. |
| `quote_apply_choice(quote, option, addon_ids[], via)` | The one core that applies a customer's choice. Granted to **no role**; reached only through `portal_accept_quote` and `owner_select_quote_option`. |
| RLS | Insert/update/delete predicated on `status in ('draft','sent')`. No `anon` grant. |

`verify:recurring-quote-flow` §11 pins all of the above so the next session cannot
quietly weaken it.

### 2.3 ⭐ Add-ons are PRE-acceptance. Change orders are POST.

| | Quote add-ons | Change orders |
|---|---|---|
| When | Before the customer accepts | After work is agreed |
| Who chooses | The customer, on the quote/portal | Owner proposes, customer approves |
| Effect | Changes what is being *offered* | Changes what was already *agreed* |
| Storage | `quote_addons` → `quotes.addons_total` → `quotes.total` | change-order tables, `job_price_changes` |

Welding them is the failure mode. The DB already refuses it — the write guard
freezes `quote_addons` once the quote leaves `draft`/`sent`, so a post-acceptance
extra **cannot** be expressed as an add-on. §11 of the guard asserts the freeze
exists and that no S111 code mentions change orders.

### 2.4 Where the recurring quote flow will consume add-ons

The insertion point is deliberate and already shaped:

1. **`lib/recurringOffering` is untouched by add-ons.** An offering is a
   *mutually exclusive alternative*; an add-on is *additive*. They compose but
   never merge — exactly as `quote_options` and `quote_addons` are separate
   tables feeding one `quotes.total`.
2. **`ServiceOfferings` is the surface to extend.** Its layout already reads
   *offerings → separation sentence → actions*; an add-on block sits **below the
   actions**, because add-ons modify whichever offering is chosen and must not be
   read as a fourth alternative.
3. **`quote_apply_choice` already takes `p_addon_ids uuid[]`.** The option-choice
   path S111 seeds flows through `owner_select_quote_option` / `portal_accept_quote`,
   both of which already delegate to it. **No RPC work is needed.**
4. **A per-service add-on catalogue does not exist.** There is no
   `service_addon_templates`. `AddonTemplate` (`{key,label,recurringByDefault}`)
   is a *trades* constant for job add-ons and must not be reused —
   it carries no price and no tenancy.

### 2.5 The missing application artifacts, precisely

- `src/lib/quoteAddons.ts` — pure rules: cap of 6, the selection invariant, the
  draft/sent freeze predicate, `addonsTotal`. Mirrors `lib/quoteOptions`.
- `src/components/quotes/QuoteAddonsEditor.tsx` — the owner's editor.
- Quote builder wiring — persist rows; ⛔ never write `addons_total`.
- Portal — `PortalQuote.addons`, customer selection, through `quote_apply_choice`.
- `QuotePDF` / `portalPdf` — add-ons on the document.
- `src/app/dashboard/quotes/[id]/page.tsx` — owner-side selection.
- `scripts/verify-quote-addons.ts` — **absent, and the 133-check guard S57
  described has never existed in any branch.**

`origin/recovery/session57-quote-addons-wip` (`2d33918`) holds ~1,260 lines
across 14 files from the destroyed S57 work. ⚠️ It is 1 ahead / far behind main,
predates Quote Options V1, Measure & Price V2 and `quote_apply_choice`'s current
signature, and **must be read as a reference, not cherry-picked.**

---

## Part 3 — Pricing precedence (the answer S111 settled)

Four sources could produce a number for a service, all at once. `lib/recurringOffering`
now states the order once, and `verify:recurring-quote-flow` §9 asserts it:

```
1  configured_plans         service_pricing_plans — the ways the owner sells it
2  measured_template_rate   service_templates.default_rate × a measurement
3  labour                   hours × crew × rate
4  starting_price           service_templates.default_rate ("starting from")
5  unknown                  ← an answer, not a failure
```

⭐ **1 and 2 are the same arithmetic** — a `per_unit` plan and the `area_rate` arm
both end in `unitRatePrice()`. Plans win because they are the *more specific
configuration*, not because they compute better: `default_rate` is one number for
a service that may be sold five ways, so it cannot express a monthly price.

⭐ **The demotion:** where plans exist, Starting Price becomes a display hint —
relabelled in the Price Book, **never hidden, never migrated**, and pricing quotes
again the moment the plans are removed.

⛔ **UNKNOWN stays UNKNOWN.** A plan with no rate has `price === null`, and null is
never rendered as `$0`.
