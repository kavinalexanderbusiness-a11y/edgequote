# First authenticated quote Save slice

This successor preserves the PR127 source checkpoint at
`6b403a3601c8432124005633f89546f928d2dd1e`. It is test-only work; it does not
activate the dormant editor or authorize a migration, deployment or main merge.

The independent design review requires a temporary Next project outside the
entire checkout, one alias to the actual source modules, canonical cookie and
browser Supabase clients, real Auth users, actual owner auxiliary queries, and
unchanged baseline/Save server adapters. There must be no injected owner-ready
context, replacement SDK or fabricated successful transport.

The acknowledged first slice passed on 3039762f62441ea5f60533a2367dcff1a61f7e6c,
run34643273075: nine real Auth/browser stages and 54 focused owner lifecycle
regressions. Preserve that packet. See `platform-plan.md` for its design. The
canonical authorization prerequisite in
`authority-blocker.md` was corrected at c543cae22bc84618ec78fc655213a9d46258fab7
and independently verified in run34636256963 (72 synthetic/native checks).
That prerequisite is not real Auth/browser proof. The older native harness's
platform-prelude.sql and substitutePlatformStatements are explicitly prohibited
for this proof: they install simplified Auth/platform behavior.

The first proof is deliberately bounded: one normally committed Save, exact
101.23 price / 37.17 rate / 1.13 hours / 1234.56 area, an independent database
connection and a fresh authenticated session reading that result, and cross-owner
and denied-session refusal. The required reconciliation callback must fail closed
and remain uncalled. Loss of acknowledgement and acceptance ordering are later
stages. A passing older rollback/native or simulated-browser suite cannot satisfy
this gate.

All services run only in existing disposable cloud CI. No heavy local services,
hosted Supabase project, live customer data, real email, provider activation,
production credentials or paid provisioning are permitted. The generated Next
configuration must reject production build/server phases and require a cloud
disposable marker. Essential UI hosts are imported directly; production layouts
and configuration are excluded.

Ordinary PR/main CI must remain unchanged. Focused iteration may be selected only
by an explicit manual workflow input on the isolated candidate ref. No PR is
opened solely to trigger duplicate predecessor proofs. Source and failing
evidence are preserved; final claims require actual runner/source pins and
observed cleanup.

The explicit `quote-save-authenticated` manual CI mode now prepares a real
disposable platform with `real-platform-proof.mjs`, followed by the separately
generated app, `real-workload.mjs`, and `browser-cases.mjs`. Ordinary CI and the
completed synthetic prerequisite are not repeated by this mode. Source review
and a completed exact-runner receipt are required before any runtime PASS claim.
Output is restricted to sanitized platform/browser JSON evidence; local keys,
cookie values, Auth request bodies and private workload files are never uploaded.

`fixtures.mjs` supplies the fixture helper. `seedFixtures({sql,createUser})`
requires caller-owned real local Auth and a marked disposable SQL connection;
`readFixture(sql,fixture)` observes full synthetic tenant rows independently.
It creates owner A, owner B, and a denied account with its own quote but no
settings, so a denied-role test cannot accidentally pass solely on tenant
mismatch. Runtime evidence must come from the marked disposable CI platform;
the helper is never wired to a production route or hosted database target.

## Bounded lost-acknowledgement case

The separate manual `quote-save-lost-ack` input selects only
`lost-ack-browser-cases.mjs` on the same pinned disposable real platform. It skips
the acknowledged case and unchanged lifecycle/broad suites. Its output folder
is `outputs/authenticated-quote-save-lost-ack-20260911`, preserving the first packet.

The generated dev-only route forwards the original Request through canonical
auth and Save. A transparent store wrapper counts native adapter commit dispatch
and return; these are not wire-packet counts. The actual committed receipt is
retained only as private harness evidence. The response stream yields one byte
of that authentic response, then waits until the browser observes HTTP200 and
fresh independent SQL reads observe normal COMMIT before deliberately failing.
No fabricated error/success JSON reaches the caller. Commit and release markers
are private files published atomically outside the source tree and removed with
the disposable root. Other canonical refusal responses remain unchanged.

The actual editor must retain the exact unknown pending submission and newer
typing, avoid a success/close callback, block repeat Save, and preserve recovery
across reload and genuine same-owner reauthentication. Explicit saved-version
reads and independent fresh Auth/PostgREST establish current stored facts only.
They never confirm that a particular pending request saved those values.

This case supplies no attributable reconciliation endpoint, operation journal,
new schema or production route. A stronger recovery feature requires separately
reviewed transactional operation persistence and finalization contracts. Local
pending prevention is not a global exactly-once guarantee across tabs/devices.

## Versioned acceptance and owner authority prerequisite

The explicit `quote-acceptance-versioned` manual mode preserves both completed
Save packets and runs only the new acceptance cases. It first applies the reviewed
dormant versioned acceptance proposal after the existing Save prerequisites in a
new disposable database. This is not permission to apply production DDL.

This lane corrects owner-on-behalf authority in the dormant HTTP adapter and SQL
proposal: fresh verified identity must pass the canonical owner-bound role gate,
and native authority rechecks eligibility after the shared settings lock. Portal
authority remains token/customer-bound. A later denied reconciliation remains
unknown; it cannot establish that an earlier write failed.

The focused 24-case synthetic HTTP suite is separate from six real owner-authority
stages. In the latter, the generated server holds one synthetic owner B acceptance
after actual HTTP authorization, then an independent SQL connection commits
removal of only B's settings before release to the unchanged native call. The
native refusal and fresh HTTP/direct-native denials must leave the captured
business rows unchanged after that explicit revocation. This is a deterministic
sequential boundary test, not a concurrent database lock proof. Original and
post-prerequisite row snapshots remain separately labeled.

Nine subsequent browser stages use real owner A Save UI and token-authorized
acceptance HTTP requests: preview V1, normal Save V2, stale V1 refusal with zero
writes, explicit preview V2, then one accepted native COMMIT and fresh Auth/readback.
The proof compiles the actual canonical wire parsers and terms classifier in memory
with consumed source/dependency hashes. Native SQL supplies fingerprints, amount
and acceptance-current facts. It observes 23 selected business table families plus
shared units, including the documented acceptance audit and notification effects.
No acceptance UI, concurrency, durable recovery or global exactly-once claim is made.

Evidence goes to `outputs/authenticated-quote-acceptance-real-20260911`; the new
synthetic server report, platform report and browser report stay separate.

## Observed acceptance lock ordering

The manual `quote-acceptance-lock-order` input runs six new synthetic fixtures
on the same pinned disposable stack. It preserves all completed predecessor
packets and skips their suites. Product modules and native SQL are unchanged.
Evidence goes to `outputs/quote-acceptance-lock-order-20260911`.

Four schedules exercise both orders of actual Save UI and portal or owner
acceptance HTTP requests. A quote-only transaction gate holds the first native
request while an independent observer proves its transaction-ID wait and the
second request's conflict on the exact canonical owner advisory lock. Backend
identity, granted/ungranted lock tags, pending requests and unchanged rows are
required before release. One eight-second barrier budget applies; absent proof
fails the schedule without a sequential fallback or timeout relaxation.

The remaining schedules order owner acceptance against settings deletion. R1
uses actual HTTP acceptance behind an uncommitted deletion. R2 deliberately uses
a native acceptance call in an outer service transaction: its return is provisional
until COMMIT, and an independent committed snapshot precedes deletion COMMIT.
R2 is not HTTP or acceptance-UI acknowledgement evidence. Its nonempty required
terms fixture makes current acceptance false after settings removal; the committed
ledger must remain intact. Later owner actions refuse and reconciliation stays
unknown.

The harness admits no further schedules after failure. It records rows before
and after cleanup, propagates incomplete drain/closure as failure, and observes
external IO and unchanged native definitions again. Cancellation or gate release
does not establish rollback; released pending work may commit. Only a completed,
reviewed exact-run artifact can support a runtime PASS claim.
