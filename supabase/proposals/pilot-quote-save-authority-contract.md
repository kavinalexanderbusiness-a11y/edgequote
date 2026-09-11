# Dormant quote Save: canonical owner authority prerequisite

This correction remains source-only. It does not activate an editor, route,
migration, deployment, provider or production write. Sole S106 landing control
and Stripe onboarding remain parked. PR127 and PR129 stay frozen.

## Reproduced predecessor behavior

Source `2fb708514f87ef0360feaccb7877043e278b31b3`, tree
`b5c40c55ed2d8b2317a14612f3ccfee4391ec0c5`, preserves the original canonical
adapters/proposal from PR127. Cloud run34635290534/job103381579026 reproduced all
five bounded native/server scenarios on actual disposable PostgreSQL17 with
explicit synthetic Auth/platform context. Valid-owner Save worked; fresh baseline
and preserve-price Save wrongly worked after settings removal for both none and
crew. Independent transactions demonstrated both settings-deletion/Save lock
orders. Cleanup and native-definition preservation passed.

This is a synthetic native/server reproduction, not a production incident or
proof of real Auth, PostgREST, cookies, browser integration or the full Save flow.
The first three cases roll back fixture transactions; the race cases commit in
the marked disposable database and use a separate observer connection.

## Authority contract

Both canonical HTTP adapters require verified getUser followed by an exact bound
owner-role response. createPilotQuoteSaveAuth receives the same request's ordinary
authenticated SDK client, separate from the privileged Save store. It calls
pilot_quote_save_owner_role with the previously verified expected owner UUID.

That authenticated-only STABLE SECURITY INVOKER RPC compares auth.uid with the
expected UUID and delegates policy to current_app_role in one SQL statement.
A match returns exactly {owner_id,role}; a missing/mismatched identity returns
exactly {code:forbidden}. This binds a role to the correct request identity even
if a mutable client changes A→B→A. No cached-session fallback or token extraction
is needed. RPC errors/malformed output/timeouts remain unavailable; confirmed
none/crew/forbidden is denied. No role defaults to owner.

Native privileged RPCs cannot use their service client's auth.uid as owner policy.
The private _pilot_qs_is_owner predicate checks business_settings for p_owner,
matching canonical current_app_role's owner precedence. Snapshot/target RPCs
check it before returning private data. Save checks it after the unchanged shared
lock and before any write. A pre-lock role check is deliberately insufficient.

The predicate is STABLE, not immutable. The existing VOLATILE READ COMMITTED
Save evaluates it in a fresh post-lock statement. If deletion wins, it refuses;
if Save locks the settings row first, deletion waits until Save commits. Existing
lock order, quote revision guards, pricing rules and owner-over-crew meaning stay
unchanged. The new private helper has no direct public/anon/authenticated/service
execution grant. The bound role RPC grants EXECUTE only to authenticated.

Exact native {code:forbidden} is a proven pre-write refusal, including when it is
received from the dispatched native Save RPC. SQL/SDK errors, response loss and
malformed refusal objects after dispatch remain unknown. The caller's draft and
recovery behavior is unchanged; no retry or fabricated success is introduced.

Dormant acceptance retains its existing identity-only capability as a separate
type. Its behavior is not silently changed by the Save interface extension.
Related identity-only Save helpers are not activated or newly granted here;
their external activation remains subject to the larger closed-door landing plan.

## Schema-first order

In a fresh reviewed disposable application schema, apply the unchanged migrations,
then pilot-email-core.sql, pilot-quote-identity.sql and this corrected
pilot-quote-save.sql before using the updated canonical HTTP owner adapter.
The corrected proposal defines the bound role RPC and native predicate together.
No migration has been created for an already-running production database. Any
later S106 plan must translate/review that transition and activate all appropriate
callers together; applying this proposal or deploying code is not authorized here.

Missing schema/role RPC fails closed through the SDK error path. A test-only
route must not add its own owner shortcut to conceal a missing canonical check.

## Bounded validation

Use the explicit quote-save-authority manual mode of existing CI. Normal PR/main
and normal manual CI remain unchanged. The synthetic bootstrap adds authenticated
USAGE on the stub auth namespace because the old prelude lacks the real platform's
namespace permission; it does not add RPC execution privileges or claim real Auth.

Required correction proof: both HTTP adapters refuse none/crew and malformed,
changed or unavailable role evidence before store access; native reads/writes
refuse missing owner settings; bound-role ACLs and identity mismatch refuse;
canonical owner precedence remains; both deletion/Save lock orders are observed
with independent row readback; normal owner Save still works. Existing bounded
Save/baseline regressions cover uncertain acknowledgements and no automatic retry.

Only after this prerequisite has reviewed passing evidence should the separately
planned real-Auth browser environment begin. Numeric form-step fixes, the full
authenticated browser Save, lost-acknowledgement transport and acceptance ordering
remain later work.
