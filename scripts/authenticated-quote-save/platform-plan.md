# Reviewed disposable platform plan — not executed

Source checkpoint: PR127 `6b403a3601c8432124005633f89546f928d2dd1e`.
Fresh main: `b507fbfd41a8dbef5b6bd88d8a951df5750e0547`.
Independent design review: auth_save_design_review, 2026-09-11.

The proposed environment is suitable for real Auth/PostgREST/PostgreSQL evidence.
No stack, generated Next app or cloud workflow has been started. The canonical
authority defect in `authority-blocker.md` is the current stop gate.

## Pinned platform

Official Supabase CLI [v2.117.0](https://github.com/supabase/cli/releases/tag/v2.117.0),
Linux amd64 archive SHA256
`69c05f85b9e47ee706d30f1a6ca8a526b4e337bfd12c7ef1ef522d24e7280d24`.
Before startup record version and root/start/status/stop help. Verify the downloaded
archive digest rather than trusting a mutable download URL. Do not use a hosted
project, linked-project files, repository secrets or production environment files.

Embedded default images at that release:

| Service | Image |
| --- | --- |
| PostgreSQL | supabase/postgres:17.6.1.167 |
| Gateway | library/kong:2.8.1 |
| Auth | supabase/gotrue:v2.196.0 |
| PostgREST | postgrest/postgrest:v16.2 |
| Storage | supabase/storage-api:v1.72.1 |

Record actual pulled image digests; reject version overrides/slim-image switches.
This CLI release still uses its pinned Kong integration. Do not substitute the
current self-hosted Docker compose, whose gateway changed separately.

## Generated configuration

Place a fresh project outside the entire source checkout with no migrations,
seed files, `.env`, linked project or inherited provider settings:

```toml
project_id = "edgequote-auth-save-disposable"
[api]
enabled = true
port = 8000
schemas = ["public"]
extra_search_path = ["public", "extensions"]
max_rows = 1000
[db]
port = 54322
shadow_port = 54320
major_version = 17
[db.migrations]
enabled = false
schema_paths = []
[db.seed]
enabled = false
sql_paths = []
[db.pooler]
enabled = false
[auth]
enabled = true
site_url = "http://127.0.0.1:3000"
additional_redirect_urls = []
enable_signup = false
enable_anonymous_sign_ins = false
[auth.email]
enable_signup = true
enable_confirmations = false
[auth.email.smtp]
enabled = false
[local_smtp]
enabled = false
[storage]
enabled = true
[storage.image_transformation]
enabled = false
[storage.s3_protocol]
enabled = false
[storage.analytics]
enabled = false
[storage.vector]
enabled = false
[realtime]
enabled = false
[studio]
enabled = false
[analytics]
enabled = false
[edge_runtime]
enabled = false
```

Create actual synthetic users through the local Auth admin `createUser` operation
with `email_confirm:true`. Do not invite, send email, or insert Auth users in SQL.

## Containment and bootstrap

1. Acquire locked app dependencies, CLI and images on the disposable cloud host.
2. Create a Docker network with `--internal`. Pass that existing network through
   the CLI's `--network-id`; the pinned implementation preserves it. Start with
   `--exclude realtime,imgproxy,mailpit,postgres-meta,studio,edge-runtime,logflare,vector,supavisor`.
   Unknown exclusions only warn, so validate exact expected containers and do not
   use the obsolete `inbucket` name. Never ignore a health check.
3. Verify all five running containers belong only to the intended internal
   network. Record their image digests and network identity. Auth and Storage
   must remain enabled so their real schema migration jobs run.
4. Enter the verified gateway container's network namespace for app, browser,
   fixture and SQL processes while retaining the runner filesystem. Their fixed
   Supabase URL is `http://127.0.0.1:8000`; the temporary Next app and trusted
   origin are `http://127.0.0.1:3000`. SQL uses only the inspected DB container
   address on port5432. Restrict all targets before opening connections.
5. Verify no external route using a bounded failed public-IP probe. Require no
   scheduled jobs/provider connections; use an explicit process environment
   allowlist with `SUPABASE_TELEMETRY_DISABLED=1`, `DO_NOT_TRACK=1` and
   `NEXT_TELEMETRY_DISABLED=1`. Do not log local token/password material or include
   it in evidence artifacts.
6. Verify real Auth functions/roles/tables and Storage tables/path helpers, and
   mark the disposable database before application SQL. Apply unchanged checked-in
   migrations in filename order, then pilot-email-core, pilot-quote-identity,
   pilot-quote-save proposals. Preserve native constraints, triggers, RLS and
   transaction semantics. A real-platform incompatibility fails with its exact
   statement; no prelude/substitution or skipped-constraint fallback is allowed.
7. Generate the separately reviewed temporary Next mount outside the entire
   source checkout. Its own config rejects production build/server phases and
   requires the disposable cloud marker; one alias resolves actual source
   components. Use canonical cookie/browser clients, verified CacheOwner, actual
   OwnerEditor and untouched baseline/Save Response adapters. The service-role
   store is server-only. Production layouts/routes/config are never imported.
8. Run the bounded browser test, independent fresh-session/connection readback
   and denied-authority cases after the canonical blocker is repaired. Record
   the actual candidate/runner/source and schema hashes. Close app/browser/SQL
   sessions and verify stack/network/profile cleanup even after failure.

Use only an explicit manual mode of existing cloud CI while iterating, preserving
ordinary PR/main checks. Do not open a PR just to retrigger predecessor suites.

Reviewed primary sources:

- [Network lifecycle](https://github.com/supabase/cli/blob/v2.117.0/apps/cli/src/command-internal/db-bootstrap/container-lifecycle.ts)
- [Real platform schema setup](https://github.com/supabase/cli/blob/v2.117.0/apps/cli/src/command-internal/db-bootstrap/db-setup.ts)
- [Service exclusions](https://github.com/supabase/cli/blob/v2.117.0/apps/cli/src/commands/start/start.exclude.ts)
- [Pinned image manifest](https://github.com/supabase/cli/blob/v2.117.0/apps/cli-go/pkg/config/templates/Dockerfile)
- [Gateway ports](https://github.com/supabase/cli/blob/v2.117.0/apps/cli/src/commands/start/services/kong.service.ts)
- [Telemetry controls](https://github.com/supabase/cli/blob/v2.117.0/apps/cli/src/telemetry/legacy-telemetry-state.layer.ts)
