# FIX FIRST: owner authority is absent from the dormant Save server boundary

Reviewed source: PR127 `6b403a3601c8432124005633f89546f928d2dd1e`.
Independently confirmed by native_proof_plan and auth_save_design_review on
2026-09-11. This is a source-reachable inference, not a runtime reproduction.
No production caller was activated, no live account inspected and no SQL run.

## Reproducer to execute after the canonical correction is designed

Start with a real synthetic Auth account that owns a settings row and one quote,
but has no pilot email connections. Remove only its synthetic settings row while
retaining the Auth account/customer/property/quote. Its valid Auth session now
receives `none` from actual `current_app_role()` (or `crew` after a legitimate
synthetic crew association). Request a **fresh** baseline, then submit a
notes-only Save preserving the prices. An old pre-removal baseline is insufficient:
its stale revision can refuse for a different reason and hide the authority gap.

The intended owner-only editor refuses that account. The canonical server/native
path currently does not impose the same owner requirement.

## Exact source chain

| Boundary | Finding |
| --- | --- |
| baseline.sql:4371, current_app_role | Auth UUID plus business_settings means owner; without settings the answer is crew or none. |
| pilotQuoteAuxiliaryLoader.ts:188 | Actual owner wrapper requires current_app_role owner. |
| pilotQuoteSave.ts:158 and pilotQuoteSaveBaselineServer.ts:85 | Both HTTP adapters verify getUser only, then supply its UUID to service-role RPCs. |
| pilot-quote-save.sql:90 | Snapshot checks quote ownership and optional auth.uid equality; there is no current owner predicate. |
| pilotQuoteSavePlan.ts:91 | Missing pricing_inputs is expressly valid; unchanged prices can select preserve. |
| pilot-quote-save.sql:40 | Shared lock SELECTs settings FOR UPDATE but does not require a row. |
| pilot-quote-save.sql:139 | Missing settings refuses ensure_current only. |
| pilot-quote-save.sql:275 | Commit rechecks the fresh snapshot/targets but never current owner eligibility. |

Missing settings also produces a valid empty terms fingerprint. Quote/customer/
service ownership foreign keys retain Auth identity rather than require settings.
The pilot-email-core connection foreign key prevents deleting settings only when
that tenant has a connection; it does not protect the connection-free case.
Reviewed quote triggers do not add the missing owner predicate.

## Required correction design

Use the same authenticated client for fresh getUser and a successful
`current_app_role() === 'owner'` in both canonical HTTP adapters. Distinguish a
denied role from an unavailable role read. Keep tenant identity server-derived.

Add equivalent native authority to snapshot/target reads and, critically, inside
Save after `_pilot_quote_save_lock` and before the first write. For the current
canonical role definition, owner eligibility is an existing settings row for
`p_owner`. Calling current_app_role through a separate service client would inspect
that client's absent user identity and would be the wrong check.

Preserve the existing lock order. A positively checked, locked settings row
prevents deletion/reassignment before Save commits; the missing-row case must
refuse. A pre-lock HTTP role read alone does not protect the native write race.
Review the related identity Save path for the same assumption during the correction
design; do not quietly broaden or activate dormant callers.

The owner-to-crew transition must also refuse once the settings row is gone.
While that row exists, canonical current_app_role deliberately gives owner
precedence; preserve that existing meaning.

## Required new proof

- Actual authenticated fresh post-removal baseline/Save for roles none and crew.
- Denied direct authenticated execution of the service-only native RPCs.
- Settings deletion racing with Save in both lock orders, with independent
  committed readback and unchanged rows for the refused operation.
- A normal owner Save still commits and preserves full price/rate/hour/area
  precision, followed by a fresh authenticated browser read.
- No temporary test-handler guard that hides a missing canonical check.

Do not mark PR127's earlier evidence false: those component/SDK/native tests have
explicit simulation/rollback scope and never established this authenticated gate.
They remain frozen. The first authenticated mount is stopped at this concrete
blocker under the coordinator's bounded assignment. Overall activation remains
FIX FIRST; S106 and Stripe remain PARK.
