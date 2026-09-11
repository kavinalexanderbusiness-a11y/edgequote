# First authenticated quote Save slice

This successor preserves the PR127 source checkpoint at
`6b403a3601c8432124005633f89546f928d2dd1e`. It is test-only work; it does not
activate the dormant editor or authorize a migration, deployment or main merge.

The independent design review requires a temporary Next project outside the
entire checkout, one alias to the actual source modules, canonical cookie and
browser Supabase clients, real Auth users, actual owner auxiliary queries, and
unchanged baseline/Save server adapters. There must be no injected owner-ready
context, replacement SDK or fabricated successful transport.

The platform design has independent review approval; runtime preflight remains
unexecuted. See `platform-plan.md`. The canonical authorization prerequisite in
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
