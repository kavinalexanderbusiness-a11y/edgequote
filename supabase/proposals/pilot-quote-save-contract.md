# Single quote-editor Save — contract for dormant implementation

Status: **RE-REVIEW REQUIRED; production FIX FIRST; S106 PARK.** This is a source-bound design, not an implemented or deployed fix. It extends the frozen identity-only PR121 rather than mounting that transaction ahead of the existing multi-request Save. `contract-resolutions.md` is normative and resolves the first independent review's B1–B4; where its concrete details supersede an earlier general statement below, use the resolutions.

## Evidence and scope

Reviewed source: PR121 `46e9d62cedf4708e98e18a039559072cd46d6a28`, tree `d058920a076b2546734136e136064440ebb4201b`. Fresh fetch on 2026-09-10 returned main `57b64a47f037197677c3564a5e992f7ed3032b3c`, tree `0756f1c62a827a53b963e1c1decb89e8ab478fde`. Its two commits since `217f71b8` do not change the quote handler, builder, resolver, measurement or acceptance sources inventoried here. The new work-session migration must still be included in any successor's current-main cloud replay.

The exact existing handler is `src/app/dashboard/quotes/[id]/page.tsx:240–527`; LF file SHA256 `36421c8964fde38a015820104849e0b38d52bb3e9d9e0b250410daa38e1416be`, extracted AST SHA256 `28daabe58fbae7c032673a633a938d6b4462cdf35f75690604b685bf83de4ad9`. `actual-save-inventory.md` contains the complete ordered trace and field mapping; `helpers-review.md` records canonical helper contracts. The prior 183 native checks establish identity-only behavior. They are predecessor evidence, not full-Save or acceptance-concurrency proof.

The unit of atomicity is **every database write initiated by one press of the existing quote editor's Save**, including native transactional trigger effects. It does not mean rollback of an entire editing session:

- The earlier explicit Measure & Price **Apply** currently inserts an observational `measurements` row. That separate gesture remains separate. Deferring it would change Apply→Cancel behavior and require preserving information not present in QuoteFormValues. No such change is part of this contract.
- The later explicit lawn **Undo** is another operation. It is not rollback of the quote Save. Its current numeric restoration semantics must be described honestly; no new evidence-erasure or retention policy.
- Lookup, distance, AI assistance and scanning are not replayed by Save. Save sends no message, schedules nothing, records no payment and makes no acceptance claim.

User-visible intended behavior remains one Save. A known failure leaves the form and all Save-owned database changes uncommitted. A lost response is described as uncertain, never as proof of rollback. A successful response is shown only after the complete transaction acknowledges commit.

## 1. Permitted changes and protected state

| Object | Permitted write within Save | Required binding and preservation |
| --- | --- | --- |
| Customer | Actual canonical resolver's new-customer INSERT, or its blank phone/email/source enrichment | Verified owner; actual matching order and normalization; no replacement of recorded contact/source; old archived linkage can remain but is not a new automatic match |
| Property | Actual resolver's property INSERT | Customer/owner composite binding; no old customer's property under a different customer; first-primary rule unchanged; all required reads complete |
| Pricing config version | Canonical `ensure_pricing_config_version` may INSERT when one of four quote prices moves | Same transaction; tenant settings checked under lock; retain immutable history; no copied pricing-config engine |
| Quote | Exactly current handleUpdate parent patch: identity, service/template, money, labor/travel, deposit rule, distinct public/internal notes, measured area/snapshot/suggestion and conditional provenance | Owner + expected complete editor revision. No status, quote number, consent snapshot, selected option, add-on selection, send/expiry stamp, no-charge declaration, acceptance history or other protected-column changes |
| Options | Replace existing ordered set only if native selected_option_id is null | Settled alternatives and IDs remain byte-identical. Canonical option validation, headline and row mapping. Exact owner/quote and returned counts |
| Service lines | Replace current ordered breakdown with actual primary + extra service/material mapping | Canonical discount/rounding/quantity rules; kind and public line notes preserved; exact owner/quote/template binding and counts |
| Typed lawn measurement | Actual `saveManual` upsert payload when resolved property exists, service is lawn_recurring, area >0 and rounded mirror differs | Required property read; actual service classification and manual confidence/unit mapper; prior measurement and mirror version checks |
| Native effects | Normal audit/integration rows, measurement event and property mirror/updated_at triggered by the above | Enabled native constraints/triggers; part of rollback assertions; no new external provider activation |

Quote add-ons, acceptance rows, invoices, payments, jobs, portal tokens, archives and existing pilot workflow/attempt/event state are preserved. The existing retained-workflow rule applies to **every retained state**, before any preparatory write. It must not be narrowed to sent attempts or approvals.

Atomic lawn sync intentionally improves one failure outcome: today it can fail after the editor closes; here its failure rolls back the entire Save and preserves the draft. That is a concrete behavior change required for the all-Save-writes promise.

## 2. Complete editor baseline and request

New code remains in dormant library/proposal/proof files; no mounted route or migration replay entry. Proposed module names are `src/lib/quotes/pilotQuoteSave.ts`, `src/lib/quotes/pilotQuoteSaveCaller.ts`, `supabase/proposals/pilot-quote-save.sql`. Implementing an eventual adapter does not authorize mounting it.

The server must provide a complete editor baseline before destructive replacement is available. Existing page loads that turn a failed options/services read into `[]` cannot supply this baseline. The source-bound initializer preserves all current field mapping and additionally carries the existing `quote.measurement_snapshot`; omission in the mounted initializer currently turns an untouched snapshot into null. Fixing that omission is intentional evidence preservation, not a new measurement engine.

The baseline binds:

1. Owner/quote identity, full stored quote revision, selected option and current status.
2. Complete ordered services, options and add-ons including IDs and owner/quote bindings. Order uses saved sort_order plus ID; do not synthesize a different display order.
3. Latest acceptance identity/sequence plus native material/terms fingerprints and authoritative current-acceptance result. Missing acceptance is distinct from a failed read.
4. Resolver customer/property snapshot with PR121's exact projections, complete flags, canonical ordering and caps.
5. Applicable service-template rows, including the classification used for lawn sync; template IDs in all submitted rows must belong to the same owner.
6. Tenant pricing-setting inputs used by canonical ensure: pricing_base_charge, pricing_mow_rate, pricing_recommended_mult, pricing_premium_mult, pricing_travel_rate, crew_cost_per_hour, fee_recovery_percent, payment_fee_strategy; relevant template/recommendation inputs loaded into this editor; tenant terms fingerprint for acceptance standing. No credentials or unrelated settings in browser payloads or evidence logs.
7. Resolved existing property's lawn mirror and typed lawn measurement revision, including the explicit absent-row case. A newly planned property has an explicit absent measurement baseline.

The outer snapshot is assembled in one database statement or under the same read locks; do not label unrelated REST responses an atomic snapshot. Native row JSON and complete child-set revisions are server-produced and opaque to browser code. Equality tokens are concurrency checks, not authentication. Include the quote tuple version in the revision so a committed identical-content update does not authorize reusing the prior baseline. Compare complete authoritative state again under write locks; a client cannot declare a snapshot complete.

Read caps fail closed rather than truncating. Preserve PR121's 10,000 resolver-row and 200,000-byte request bounds unless the independent review establishes a concrete required adjustment; oversize returns an explicit error before any write. No silent trimming of commercial content to fit a request.

Browser request, exact top-level keys:

```ts
type SaveIntent = {
  version: 1;
  quoteId: string;
  expectedEditorRevision: string;
  clientOperationId: string;
  editorGeneration: string;
  values: QuoteFormValues;
};
```

`clientOperationId` and editorGeneration correlate responses and drafts; they are not durable receipts or authority. The owner comes only from verified auth, never the body. Same-origin POST, JSON/size validation and no-store response follow PR121. No service credentials or SQL plan reaches the client. The server fetches the fresh complete snapshot, requires the supplied baseline revision to match, validates the submitted fields, then builds its own plan. Required fields, enums, finite numbers and nested row/snapshot structure are checked at the boundary; unknown write-bearing fields cannot become SQL assignments. Preserve accepted browser blank-number sentinels via the current Number/positive/rounding rules. Native constraints remain the final authority; never claim a TypeScript interface validates JSON.

Changing settings/templates or current selection after editor initialization refuses a stale Save; it does not silently reprice the entered form. A missing pricing-settings row must not block an unchanged-price edit solely to produce unused provenance, but a changed-price edit requires canonical ensure to succeed. Never claim that a carried recommendation was freshly recomputed at Save.

## 3. Canonical planning, without a second engine

Build identity with the real `buildPilotQuoteIdentityPlan` and resolver facade from PR121. A separate live call to `pilot_quote_identity_save` before the full Save is prohibited.

Compute commercial mapping once, using existing `applyOvergrowth`, `sumServiceLines`/discount engine, `optionSetProblem`, `optionsConflictWithLines`, `optionRowsFor`, `headlineOptionPrice`, `depositRuleFromForm` and `servicePricingKind`. The full field recipe is the inventory section4. Preserve selected-option behavior and the form's explicit has_options switch. Do not infer alternatives from a nonempty hidden array or sum their prices. Preserve unpriced/zero first-visit quotes after the existing explicit Save anyway action. A content Save never submits values.status.

Prefer extracting a pure shared payload planner from the actual handler without changing its mounted behavior, then exercising that exact planner in the dormant successor. If mounted source must remain byte-identical, keep the new planner dormant and prove parity by invoking the real handler AST with strict recording dependencies over a matrix of fixtures. Runtime AST evaluation, copied matching logic and copied money helpers are prohibited. A parity test must compare every parent/child output field, not just totals.

Price-moved detection remains the exact four-field numeric comparison with the captured quote. If moved, the SQL transaction invokes the existing canonical ensure function and substitutes its verified owner-bound version ID into the same provenance patch. If unmoved, all four stored provenance columns remain untouched. No provenance RPC runs during planning.

Derive the conditional lawn payload by running actual `saveManual` on a recording facade (no DML), or extracting its pure payload mapper into a shared seam without changing mounted semantics. Unit, confidence, empty shapes and measured_at remain actual manual provenance. Do not relabel the roof-ratio estimate as an imagery scan. Record prior numeric value only for the later Undo gesture, not as a fabricated prior geometry snapshot.

Server plan contains exactly: schema version; full expected editor revision and required authoritative baselines; PR121 identity plan; exact parent patch; options mode (`preserve` or `replace`) and ordered option rows; ordered service replacement rows; provenance mode (`preserve` or `ensure_current`); optional canonical manual measurement payload; correlation IDs. The SQL allowlist contains the complete field sets from the inventory. It does not accept arbitrary table names, operations, filters, SQL, owner IDs or protected-column patches.

## 4. One transaction and locking

Use one service-only, owner-bound VOLATILE RPC for all Save writes. No network I/O while locks are held. Fixed search_path and revoked PUBLIC/anon/authenticated execution follow the frozen pilot pattern; the application server authenticates and authorizes before supplying owner. A mismatching non-null auth.uid must also be refused. No new table or retention ledger is introduced by this design.

Supported isolation stays READ COMMITTED, matching PR121. Unsupported isolation refuses before mutation. Proposed order:

1. Validate plan shape/owner/IDs; acquire existing pilot owner advisory transaction lock **before** any row lock.
2. Lock old and target customer rows in UUID order, then relevant old/target properties in UUID order, then quote FOR UPDATE, as PR121 does. Missing expected rows are a refusal. Planned inserts are checked for ID collision before mutation.
3. Lock current quote option, service and add-on rows in a fixed table order and UUID order; lock applicable templates, pricing-settings row when required, current acceptance rows and relevant typed measurement row. Acquire these consistently in the companion acceptance path. Quote-parent locking must be proved to fence native child inserts under the actual FKs; child updates/deletes need their own locks and post-wait comparisons.
4. Re-read **all** expected state after waits, with ownership predicates. Compare quote tuple/content revision, full child sets, acceptance, terms/settings/template inputs, resolver candidates and property/measurement state. No read error/absence is treated as an empty authorized set. Repeat the retained-customer-binding refusal before DML.
5. Within this outer transaction call PR121 identity save with the original identity baseline. Reentrant locks are allowed. Any non-success response aborts before later writes; if the outer transaction has performed any DML, raise rather than returning a refusal object. Do not change frozen PR121 source. Preserve and verify actual native side effects rather than assuming an audit row for every UPDATE: this baseline's quote audit UPDATE trigger names status/initial_price/travel_fee, so the identity-only UPDATE does not itself necessarily create a quote audit event.
6. For changed prices call canonical ensure under the locked settings baseline, verify returned owner/version, then apply the exact full quote patch. Require one owner-bound row. No second auth lookup can change ownership midway.
7. If unsettled, delete old options and insert the planned set; replace service rows. Require exact expected deletion IDs and insertion cardinality/owner/quote/field matches. Existing deferred final-shape constraint permits service↔options conversion within the transaction; do not disable it or manufacture consent to delete settled choices.
8. If planned, perform the canonical typed lawn upsert; native event and mirror effects remain enabled. Missing/malformed returned row or unexpected mirror/history outcome raises. Native history can intentionally append zero events when the compared value/source/shapes did not change; the assertion follows that condition rather than demanding an unconditional event.
9. Re-read authoritative final quote/options/services and expected measurement. Verify protected quote fields, add-ons, acceptance and retained workflow state are unchanged; all receipt IDs/field mappings match. Any late mismatch raises. Return a bounded receipt; deferred constraints may still reject commit, so receipt construction alone is not a successful HTTP acknowledgement.

No catch may turn a late SQL exception into a successful or ordinary-refusal return after retaining earlier writes. Native constraint/trigger failure, deadlock, timeout or lost owner binding rolls back the whole database transaction. No JS compensation deletes customer/property/evidence rows after failure.

This order is not a global deadlock-free claim. Existing measurement writers take measurement→property, while property deletion/cascade and identity preparation can take property first. Existing native acceptance takes add-ons→quote. Native adversarial tests must demonstrate safe abort/rollback and bounded UI behavior where paths have incompatible order. Do not introduce table-wide locks or claim the owner advisory serializes native writers that do not use it. Unrelated native customer creation still prevents a global duplicate-customer guarantee; retain PR121's precisely scoped matching claim.

## 5. Acceptance companion is a required integration dependency

Current source exposes a wider boundary than the Save handler. PortalClient:333–484 refreshes before confirmation, then submits only quote/option/terms-ack IDs; the dialog can stay open while Save commits. Its load path can return cached data after refresh failure. RecordAcceptanceDialog:95–105 has neither a fresh-read gate nor expected document version. Native portal/owner functions read eligibility and quote_apply_choice reads price/option before the final quote UPDATE acquires a row lock. These are source findings, not yet reproduced concurrent failures.

Therefore **do not call full Save acceptance-safe or mount it with the existing acceptance doors unchanged**. The proposed companion is narrowly version-bound acceptance, with no new approval kind, status engine or calculation policy:

- A read-only authorized preview returns the document displayed for confirmation plus a server-produced concurrency token. Bind canonical material and terms fingerprints **and** customer/owner/quote identity, token eligibility, status/expiry, option/add-on choices and all displayed commercial fields omitted by the existing material fingerprint. Customer identity must not be inferred from address or the material fingerprint alone. Preserve the native fingerprint as acceptance-standing authority; the preview token is an additional concurrency fence, not a replacement standing engine.
- Portal preview failure is fail-closed for accepting; cached data may remain readable. Owner confirmation likewise uses the newly returned document. No fallback from a missing preview to current server prices at commit.
- Acceptance submits that expected token and the choice/reason/note/terms acknowledgement the person actually made. Under the same owner/quote/child/settings locks, re-resolve token or verified owner, customer binding, status/expiry, current document/terms and choices; compare expected token before any choice/ledger write. If changed, return `quote_changed`, refresh and require explicit confirmation of the new version. Do not carry an old terms acknowledgement into changed terms.
- After that comparison invoke canonical choice and record-acceptance logic in the same transaction; no copied price/terms/ledger engine. Read current rows only after locks. Any refusal after a choice write must raise so both choice and ledger roll back. Quote/customer/options/add-ons/settings must remain stable until record completes.
- Preserve portal versus owner-on-behalf distinction, explicit required reason, real terms acknowledgement, allowed statuses and append-only history. Do not treat payment or a typed status as acceptance. Do not infer customer consent from a quote edit.
- Acceptance-first makes a stale editor baseline refuse. Save-first makes stale acceptance refuse. A newly opened Revise quote can still edit under current native rules and produce needs_reapproval; accepted quotes are not categorically made read-only.

Compatibility matters: replacing only the displayed buttons while old callable RPC aliases remain a versionless bypass is insufficient. Inventory every alias and caller before the companion contract is approved. A future coordinated rollout must either require the expected version on each authorized acceptance door or explicitly retire a legacy door; it cannot invent an expected version server-side for an old request. Old open clients may need to refresh. That compatibility decision and the exact schema signature plan require independent review before implementation; no production grants/DDL or RPC replacement is authorized here.

## 6. Acknowledgement, draft and UI contract

Results are a discriminated union:

- `committed`: matching operation/editor/quote/owner correlation, exact before/after revision and complete authoritative quote/options/services receipt, with the optional lawn result. An unchanged-content Save is still a committed transaction if it updates/replaces rows; do not invent an unchanged receipt to bypass checks.
- `refused`: a validated pre-write rejection or definite database rollback (`stale_editor`, `retained_customer_binding`, `invalid_values`, `not_found`, native constraint/deadlock/timeout). Preserve draft and form; a stale baseline calls for reload/review, not automatic resubmission.
- `unknown`: transport failure or missing/malformed acknowledgement after dispatch. Preserve draft and operation context. No legacy fallback, no automatic write retry, no optimistic clear, and no claim that nothing saved.

Only one write dispatch is allowed per in-memory operation; controls stay fenced while pending. Cancellation, logout/account change, quote navigation or reopening an editor advances its generation. A late response cannot close that newer editor, replace its rows, clear its draft, or update the new owner's state. The stored draft is flushed before dispatch using its existing owner/quote scope; a commit can clear only the unchanged generation/form snapshot it actually saved. Edits made during a pending request remain recoverable rather than being silently cleared.

No durable idempotency receipt table is proposed. Correlation UUIDs must not be advertised as exactly-once delivery. Reconciliation is read-only and owner-bound: fetch current complete state and compare to the pending intent; distinguish matching saved values, a changed/conflicting document and still-uncertain status. Matching values alone do not prove which request committed. An unchanged read while an old request could still be executing is not proof of rollback. Never convert that observation into an automatic write retry.

After uncertainty the owner can review current saved values with the draft retained. A later explicit Save is a new reviewed intent using the displayed baseline; stale original-baseline replay is rejected under locks, including identical-content updates via tuple revision. Do not automatically remap an unresolved old intent onto a fresh revision or recreate its customer/property. Native tests must cover request reordering and acknowledgement loss, not only a mocked fetch rejection.

The existing QuoteBuilder `onSubmit !== false` clearing contract is unsafe for a deferred/newer-generation receipt. The dormant integrated caller must return true only for a verified committed response still belonging to this form generation, and false for refused/unknown/stale UI replies. Its future mount must also fence the builder's own autosave clear against edits made during the await; a caller-only guard cannot protect a newer draft from the builder's unconditional clear. Test the actual submit/clear path.

After commit refresh native acceptance standing. `quote_acceptance_state` requires authenticated owner context and returns no row for a service-only context with null auth.uid; do not impersonate an owner by fabricating JWT claims to make it return data. Use the existing authenticated read, or a separately reviewed owner-bound canonical read seam. During a failed/pending read hide actionable acceptance claims rather than reusing stale acceptance state. A read-refresh failure after a proved commit does not convert the whole committed Save into a rollback claim.

Later lawn Undo remains explicitly separate. If a future integrated callback is supplied, it must at least verify owner/property and refuse overwriting a newer measurement based on the committed measurement revision. It restores the prior numeric lawn value through canonical saveManual, not a full earlier geometry/evidence record. This bounded concurrency repair does not authorize deleting measurement events.

## 7. Proof and release gates

1. Independent contract review first, including acceptance compatibility, complete revision, actual caller/draft boundary and unknown outcome. A review must return explicit PASS/FIX FIRST with remaining wider decisions; unresolved prerequisites are not silently deferred into code.
2. New isolated successor only; frozen PR116/120/121 heads/trees unchanged. Integrate fresh main changes without rewriting frozen parents. No large local worktree, installs or heavy checks under current disk limit. Reuse existing dependencies for focused source checks; full/native checks use existing GitHub cloud.
3. Preserve all predecessor 183 native cases and source pins. Add actual-handler payload parity for plain/unpriced/zero, extra services/material discounts, options, settled options, unchanged/changed prices, notes/snapshot preservation, deposits and conditional lawn cases. Missing auth/required reads, invalid ownership/foreign template, malformed receipts and no-op replay are negative cases.
4. Inject native failure at customer preparation, property preparation, ensure version, parent, each option/service delete/insert, measurement upsert, mirror/history, deferred final shape and receipt validation. A separate observer compares pre/post customer/property/quote/config/child/measurement/event/audit and retained pilot state after rollback. Seed nonempty protected evidence; an empty-table preservation comparison is insufficient.
5. Native PG17 concurrency with real separate sessions and observed barriers: two Saves; child update/insert/delete; settings/template and property/measurement drift; archive/retained approval; deletion; native acceptance and companion acceptance in both orders; changed document/terms while confirmation open; lost response/reordered request. Record wait direction, transaction IDs, final observer state and closed sessions. A deadlock test passes only with definite rollback plus safe caller result, never silent retry.
6. Actual dormant integrated caller test exercises complete-baseline initialization, QuoteBuilder submit/clear, newer edit/cancel/logout/navigation races, unknown response and read-only reconciliation. Do not claim mounted browser integration merely because a library test passes.
7. Exact candidate SHA/tree and actual cloud runner tree/parents bind native artifact, source pins and full typecheck/verify/lint/build results. Re-measure origin/main before review/landing claims. Report skips/warnings accurately. Production metadata verification is read-only; latest new work-session migration invalidates the old production fingerprint receipt.
8. No merge approval here. Future production integration requires approved S106 landing plan, acceptance compatibility and schema review, authenticated end-to-end verification and preserved zero unintended business-row mutations. Keep provider, scanner licensing, billing and pilot activation holds unchanged.

## Reference basis

The application findings above come from the pinned repository sources and saved inventories. For transaction mechanics, PostgREST documents a transaction per request and rollback on database error; PostgreSQL documents row-lock conflicts and deadlock aborts. These support the mechanism, not proof that the proposed application locks are sufficient: [PostgREST transactions](https://docs.postgrest.org/en/v12/references/transactions.html), [PostgreSQL17 locking](https://www.postgresql.org/docs/17/explicit-locking.html). Function execution privileges must remain explicit: [Supabase database functions](https://supabase.com/docs/guides/database/functions).
