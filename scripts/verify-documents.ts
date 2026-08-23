// ── verify:documents ─────────────────────────────────────────────────────────
//
// Documents + Signatures V1. Three halves, and each says plainly when it cannot
// run rather than passing quietly:
//
//   STATIC     — always runs, including on CI. Reads the schema and the app code
//                and asserts the contract that must never regress.
//   BEHAVIOUR  — applies the platform prelude and EVERY migration in the apply
//                path, in version order, to PGlite and
//                proves the rules FROM ZERO: constraints, triggers, and the two
//                customer-facing projections. Skips clean when PGlite is absent
//                (it is an optional dependency — see verify:rebuild).
//   LIVE       — a marked fixture tenant, never the owner's book. Skips clean
//                without credentials.
//
// ⭐ WHY THE BEHAVIOURAL HALF MATTERS MOST. Every security claim here is a claim
// about what the DATABASE refuses. Grepping for a constraint proves the text
// exists; executing it proves it bites. RLS itself cannot be proven in PGlite
// (the harness connects as superuser, which bypasses it), so RLS is asserted
// statically and exercised for real in the live half — and that split is stated
// rather than papered over.

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { baselineSql } from './lib/schema-source'
import { openFixtureTenant, isSkipped, fixtureResidue } from './lib/verify-fixture'
const ARCHIVE = join('supabase', 'archive', 'ledger')
const MIGRATIONS = join('supabase', 'migrations')
const PRELUDE = join('scripts', 'schema', 'platform-prelude.sql')

let pass = 0, fail = 0
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`) }
}

const src = (p: string) => existsSync(p) ? readFileSync(p, 'utf8').replace(/\r\n?/g, '\n') : ''

// Wrapped in main() because tsx transforms these guards to CJS, where top-level
// await is a build error — the same shape verify:rebuild uses.
async function main() {

// ═════════════════════════════════════════════════════════════════════════════
// 1 · LIFECYCLE — exactly one home for the schema
// ═════════════════════════════════════════════════════════════════════════════
console.log('\n══ 1 · lifecycle ═══════════════════════════════════════════════════════\n')

const migrationFiles = existsSync(MIGRATIONS)
  ? readdirSync(MIGRATIONS).filter(f => /_documents_signatures_v1\.sql$/i.test(f)).sort()
  : []
const migrationSql = migrationFiles.length ? src(join(MIGRATIONS, migrationFiles[0])) : ''
const base = baselineSql()

const inMigration = /create table if not exists public\.documents\b/i.test(migrationSql)
const inBaseline = /create table if not exists public\."?documents"?\s*\(/i.test(base)

check('the documents schema exists somewhere', inMigration || inBaseline,
  'neither supabase/migrations/ nor the baseline defines public.documents')
// ⭐ THE RETIRED-CANONICAL-FILE MISTAKE, PINNED. Once production has run it and
// the baseline is regenerated, this migration moves to archive/ledger in the SAME
// commit. Two live definitions means two answers about what the database runs.
check('documents is defined in exactly ONE place', inMigration !== inBaseline,
  inMigration && inBaseline
    ? 'BOTH the migration and the baseline define public.documents — move the migration to archive/ledger now that the baseline carries it'
    : 'neither defines it')

// ⛔ ARCHIVE IS NOT THE APPLY PATH. This repo moved a whole pending/ directory
// into archive/ledger/, so git rename detection actively OFFERS to relocate this
// file there — and nothing in archive is ever executed again. An unapplied
// migration filed there is silently never applied, which is indistinguishable
// from success until the first upload fails in production.
const archivedDocs = existsSync(ARCHIVE)
  ? readdirSync(ARCHIVE).filter(f => /_documents_signatures_v1\.sql$/i.test(f))
  : []
check('the documents migration is NOT sitting unapplied in archive/ledger',
  !(archivedDocs.length > 0 && inMigration),
  'a copy is in archive/ledger while the apply path also has one — archive is never executed')

// ⭐ VERSION DISCIPLINE. A reused version is a migration that silently does not
// run: sessions 65 and 69 both minted 20260815120000 for different bodies.
if (inMigration) {
  const mine = migrationFiles[0].slice(0, 14)
  const others = [
    ...(existsSync(MIGRATIONS) ? readdirSync(MIGRATIONS) : []),
    ...(existsSync(ARCHIVE) ? readdirSync(ARCHIVE) : []),
  ].filter(f => f !== migrationFiles[0]).map(f => f.slice(0, 14)).filter(v => /^\d{14}$/.test(v))
  check('the migration version is unique across migrations AND archive/ledger',
    !others.includes(mine), `version ${mine} is already used`)
  check('the migration version sorts after every existing one',
    others.every(v => v < mine), `${mine} does not sort last — it would apply out of order`)
}

// The whole schema under test: whichever file currently owns it.
const schema = inMigration ? migrationSql : base

// ═════════════════════════════════════════════════════════════════════════════
// 2 · PRIVATE STORAGE — no public bucket, no anon door
// ═════════════════════════════════════════════════════════════════════════════
console.log('\n══ 2 · private storage ═════════════════════════════════════════════════\n')

// The whole statement, including the mime allow-list and the on-conflict tail —
// the terminating `;` is well over a thousand characters past the bucket name.
const bucketDecl = /insert into storage\.buckets[\s\S]{0,400}?'documents',[\s\S]*?;/i.exec(schema)?.[0] ?? ''
check('a `documents` bucket is declared', !!bucketDecl)
// The literal that matters: `false` in the `public` column.
check('the documents bucket is PRIVATE', /'documents',\s*'documents',\s*false/i.test(bucketDecl),
  'the bucket is public — a permit URL would be guessable forever')

const docStoragePolicies = schema.match(/create policy "documents: [^"]+" on storage\."objects"[\s\S]*?;/gi) ?? []
check('documents storage policies exist', docStoragePolicies.length >= 4,
  `found ${docStoragePolicies.length}, expected read/insert/update/delete`)
check('every documents storage policy is owner-scoped by folder',
  docStoragePolicies.every(p => /storage\.foldername\(name\)\)\[1\] = \(auth\.uid\(\)\)::text/i.test(p)),
  'a policy does not pin the first path segment to the caller — one tenant could reach another\'s object')
// ⛔ anon has no JWT, so an anon storage policy could only ever be an unscoped
// one. The portal reaches files through a server route, never through storage.
check('NO anon storage policy on the documents bucket',
  !docStoragePolicies.some(p => /\bto\s+anon\b/i.test(p)),
  'an anon storage policy would hand the whole bucket to the public portal')

// The app must never put a document in one of the PUBLIC buckets.
const libDocs = src(join('src', 'lib', 'documents.ts'))
// Comments are stripped first: this file NAMES the public buckets in prose to
// say why documents may not live in them, and a guard that cannot tell an
// explanation from a call site would be unfixable without deleting the warning.
const libDocsCode = libDocs.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
check('lib/documents targets only the documents bucket',
  /DOCUMENTS_BUCKET = 'documents'/.test(libDocs)
  && !/job-photos|booking-uploads|lead-uploads|branding/.test(libDocsCode),
  'lib/documents references a PUBLIC bucket in executable code')
check('lib/documents is the only place that builds a storage path',
  /export function documentPath/.test(libDocs) && /export function signaturePath/.test(libDocs))

// ═════════════════════════════════════════════════════════════════════════════
// 3 · ENTITY LINK — typed FKs, exactly one
// ═════════════════════════════════════════════════════════════════════════════
console.log('\n══ 3 · entity link ═════════════════════════════════════════════════════\n')

for (const col of ['customer_id', 'property_id', 'job_id', 'equipment_id']) {
  check(`documents.${col} is a real foreign key`,
    new RegExp(`documents_${col}_fkey[\\s\\S]{0,120}references public\\.`, 'i').test(schema),
    'a polymorphic (entity_type, entity_id) pair would lose referential integrity')
}
check('exactly one entity is enforced by CHECK',
  /documents_one_entity check \([\s\S]{0,300}= 1\s*\)/i.test(schema),
  'a document with zero homes cannot be found; one with two has two answers')

// ═════════════════════════════════════════════════════════════════════════════
// 4 · VISIBILITY — default safe, and no unreachable promises
// ═════════════════════════════════════════════════════════════════════════════
console.log('\n══ 4 · visibility ══════════════════════════════════════════════════════\n')

check('visibility defaults to internal',
  /"visibility"\s+text default 'internal' not null/i.test(schema),
  'a document nobody deliberately shared must be internal')
check('visibility is constrained to the three levels',
  /documents_visibility_check check \(visibility in \('internal', 'worker', 'customer'\)\)/i.test(schema))
check('worker visibility requires a job link',
  /documents_worker_needs_job check \([\s\S]{0,120}job_id is not null[\s\S]{0,20}\)/i.test(schema),
  'a crew is authorized against a visit — worker visibility without one would never appear')
check('equipment documents cannot be customer-visible',
  /documents_equipment_not_customer check \([\s\S]{0,120}equipment_id is null[\s\S]{0,20}\)/i.test(schema),
  'equipment resolves to no customer, so the share would be unreachable')

// The UI must not offer a combination the database refuses.
const panel = src(join('src', 'components', 'documents', 'DocumentsPanel.tsx'))
check('the visibility control hides combinations the schema refuses',
  /v !== 'worker' \|\| entity\.kind === 'job'/.test(panel)
  && /v !== 'customer' \|\| entity\.kind !== 'equipment'/.test(panel),
  'an option the save will reject is a promise the UI cannot keep')

// ═════════════════════════════════════════════════════════════════════════════
// 5 · THE PORTAL DOOR
// ═════════════════════════════════════════════════════════════════════════════
console.log('\n══ 5 · portal ══════════════════════════════════════════════════════════\n')

const portalFns = ['portal_get_documents', 'portal_document_file', 'portal_signature_target', 'portal_sign_document']
for (const fn of portalFns) {
  const body = new RegExp(`create or replace function public\\.${fn}\\b[\\s\\S]*?\\$function\\$;`, 'i').exec(schema)?.[0] ?? ''
  check(`${fn} exists and is SECURITY DEFINER`, /security definer/i.test(body))
  // ⭐ A token proves WHICH TENANT, not WHICH ROW.
  check(`${fn} re-scopes to the token's own customer`,
    /customer_portal_tokens/i.test(body) && /not t\.revoked|not\s+.*revoked/i.test(body),
    'the token must be joined AND unrevoked, and the row filtered by its customer_id')
}

const getDocs = /create or replace function public\.portal_get_documents\b[\s\S]*?\$function\$;/i.exec(schema)?.[0] ?? ''
check('portal_get_documents never projects a storage path',
  !/storage_path/i.test(getDocs),
  'a list view has no reason to hold a path — the file comes through portal_document_file')
check('portal_get_documents never projects the signature image',
  !/signature_path/i.test(getDocs),
  'the drawn mark must never leave the private bucket through a list')
check('portal_get_documents shows only customer-visible, non-archived documents',
  /d\.visibility = 'customer'/i.test(getDocs) && /d\.archived_at is null/i.test(getDocs))
check('portal_get_documents resolves the customer through the ONE resolver',
  /public\.document_customer_id\(/i.test(getDocs),
  'a second copy of "whose document is this?" is a second chance to get it wrong')

// ⛔ The canonical portal RPC must be untouched.
check('get_portal_data is NOT redefined by this change',
  !/create or replace function public\.get_portal_data/i.test(migrationSql),
  're-issuing an older get_portal_data has silently rolled the portal back before')

const fileRoute = src(join('src', 'app', 'api', 'portal', 'documents', 'file', 'route.ts'))
check('the portal file route takes a document id, never a path',
  /p_document_id/.test(fileRoute) && !/searchParams\.get\('path'\)/.test(fileRoute),
  'a client-supplied path is how a foreign storage object gets read')
check('the portal file route signs the path the DATABASE returned',
  /portal_document_file/.test(fileRoute) && /createSignedUrl\(file\.storage_path/.test(fileRoute))
check('the portal file route distinguishes a failed read from "not found"',
  /502/.test(fileRoute), 'saying 404 when the database never answered invents an absence')

// ═════════════════════════════════════════════════════════════════════════════
// 6 · THE WORKER DOOR
// ═════════════════════════════════════════════════════════════════════════════
console.log('\n══ 6 · worker ══════════════════════════════════════════════════════════\n')

for (const fn of ['crew_job_documents', 'crew_document_file', 'crew_document_counts']) {
  const body = new RegExp(`create or replace function public\\.${fn}\\b[\\s\\S]*?\\$function\\$;`, 'i').exec(schema)?.[0] ?? ''
  check(`${fn} proves employer AND assignment via the CANONICAL predicate`,
    /crew_employer\(\)/.test(body) && /crew_technician_id\(\)/.test(body)
    && /j\.user_id = v_employer/.test(body)
    && /crew_assignment_covers\(j\.crew_id, j\.technician_id, v_crew, v_tech\)/.test(body),
    'assignment is crew OR person — a hand-rolled j.crew_id = v_crew silently refuses individually-assigned workers')
  // ⚠️ Guarding on v_crew would refuse a worker who legitimately has no crew.
  check(`${fn} guards on the technician, not the crew`,
    /if v_employer is null or v_tech is null then/.test(body),
    'a crewless technician must still reach their own visit\'s paperwork')
  check(`${fn} returns only worker-visibility documents`,
    /d\.visibility = 'worker'/.test(body),
    "a customer's copy is not crew-audience material")
  check(`${fn} excludes archived documents`, /d\.archived_at is null/.test(body))
}

// ⛔ Crew Mode's founding rule: zero table access.
check('NO crew RLS policy on any documents table',
  !/create policy "[^"]*"\s+on public\.document[a-z_]*[\s\S]{0,200}\bto\s+crew\b/i.test(schema)
  && !/crew_employer\(\)/.test(schema.match(/create policy[\s\S]*?on public\.documents[\s\S]*?;/i)?.[0] ?? ''),
  'a crew session reaches documents through RPCs only')
check('there is no crew UPLOAD or crew SIGNING door',
  !/crew_upload_document|crew_sign_document|crew_add_document/i.test(schema),
  'field capture is Session 69 Forms\' territory — a second signature path would race it')

const crewDocs = src(join('src', 'components', 'crew', 'CrewStopDocuments.tsx'))
check('the crew surface is job-scoped, not a business-wide browser',
  /crew_job_documents/.test(crewDocs) && !/list all|all documents/i.test(crewDocs))

// ═════════════════════════════════════════════════════════════════════════════
// 7 · SIGNATURE
// ═════════════════════════════════════════════════════════════════════════════
console.log('\n══ 7 · signature ═══════════════════════════════════════════════════════\n')

for (const col of ['signer_name', 'signed_at', 'version_id', 'statement', 'source', 'customer_id']) {
  check(`document_signatures captures ${col}`,
    new RegExp(`"${col}"\\s+(text|uuid|timestamp)`, 'i').test(
      /create table if not exists public\.document_signatures \([\s\S]*?\n\);/i.exec(schema)?.[0] ?? ''),
    'the signature record must be self-contained')
}
check('a signature is bound to a source surface',
  /document_signatures_source_check check \(source in \('portal', 'dashboard'\)\)/i.test(schema))
check('the acknowledgement statement is required and bounded',
  /document_signatures_statement_check check \(char_length\(statement\) between 10 and 1000\)/i.test(schema),
  'a signature without a stated meaning is a scribble')

// ⭐ REPLAY, refused by the database rather than by app-layer politeness.
check('one request can be satisfied exactly once',
  /document_signatures_one_per_request unique \(request_id\)/i.test(schema),
  'without this, a resent sign call mints a second acknowledgement')
check('one open signature request at a time, enforced ACROSS tables',
  /and not exists \(select 1 from public\.document_signatures s where s\.request_id = r\.id\)/i.test(schema),
  '"open" must exclude FULFILLED requests, not just cancelled ones')
// ⭐ The bug this pins: a partial unique index on (document_id) where
// cancelled_at is null cannot see document_signatures, so a SIGNED request keeps
// occupying the slot forever — sign v1, upload v2, and asking for a signature on
// v2 is refused permanently. That breaks the exact flow versioning exists for.
check('the naive partial unique index is NOT used for "one open request"',
  !/create unique index[^;]*document_signature_requests[^;]*where cancelled_at is null/i.test(schema),
  'a partial index cannot tell pending from fulfilled — it would permanently block re-signing')
check('a signature is append-only for every role',
  /document_signatures_no_mutate/i.test(schema)
  && /before update or delete on public\.document_signatures/i.test(schema),
  'nothing in the product has a legitimate reason to rewrite an acknowledgement')

const signFn = /create or replace function public\.portal_sign_document\b[\s\S]*?\$function\$;/i.exec(schema)?.[0] ?? ''
// ⭐ FORGED SIGNER: identity comes from the token, never the payload.
check('the signer identity is resolved from the token, not the payload',
  /select t\.user_id, t\.customer_id into v_tenant, v_customer/i.test(signFn),
  'a client must not be able to nominate whose signature this is')
check('the sign path re-proves the document, visibility and customer from scratch',
  /d\.visibility = 'customer'/.test(signFn) && /d\.archived_at is null/.test(signFn)
  && /document_customer_id\(/.test(signFn),
  'nothing learned in phase one may be trusted in phase two')
check('a signature path outside the tenant folder is refused',
  /not like \(v_tenant::text \|\| '\/%'\)/.test(signFn),
  'a crafted path could otherwise record another tenant\'s object as this mark')
check('a replayed sign call answers already_signed',
  /exception when unique_violation/i.test(signFn) && /already_signed/.test(signFn))

// ⛔ The mark never goes anywhere generic.
check('the signature image is stored by path, never inline',
  /"signature_path" text/i.test(schema) && !/signature_data|signature_base64|signature_png/i.test(schema))

// ── the audit seam: Session 68's engine, not a second one ───────────────────
check('document events go through the canonical audit_log()',
  /perform public\.audit_log\(/i.test(schema),
  'documents must call Session 68\'s interface, not describe its own history')
check('this file defines NO audit table or audit_log of its own',
  !/create table[^;]*audit_events/i.test(schema)
  && !/create or replace function public\.audit_log\b/i.test(schema),
  'a second audit engine is exactly what one-engine-per-responsibility forbids')
// ⭐ Lazy plpgsql compilation means a missing audit_log only explodes on the
// FIRST UPLOAD, in production. The precondition turns that into an apply-time
// refusal.
check('the apply-order dependency on the audit trail is enforced, not merely noted',
  /to_regprocedure\('public\.audit_log\(uuid,text,text,uuid,text,uuid,jsonb,jsonb,jsonb\)'\) is null/i.test(schema)
  && /raise exception[\s\S]{0,200}audit-trail-v1\.sql/i.test(schema),
  'plpgsql compiles lazily — a comment would not stop a wrong-order apply')

// ⛔ Nothing sensitive may reach the general-purpose event log.
// ⚠️ Line comments are stripped FIRST. These calls deliberately say in prose that
// storage_path is absent, and a guard that cannot tell an explanation from a
// payload would be unfixable without deleting the very warning that keeps the
// rule intact — the same trap lib/documents' public-bucket note already sprang.
const stripSqlComments = (s: string) => s.split('\n').map(l => l.replace(/--.*$/, '')).join('\n')
const auditCalls = (schema.match(/perform public\.audit_log\([\s\S]*?\);/gi) ?? []).map(stripSqlComments)
check('every audit call is present and inspectable', auditCalls.length >= 5,
  `found ${auditCalls.length} audit_log calls`)
check('no audit call carries the signature image or any storage path',
  !auditCalls.some(c => /signature_path|storage_path|base64|signature_data/i.test(c)),
  'the drawn mark is biometric-adjacent and stays behind the private-bucket door')
check('no audit call duplicates signature truth',
  !auditCalls.some(c => /new\.signer_name|new\.statement/i.test(c)),
  'document_signatures is authoritative — audit DESCRIBES the mutation')
for (const action of ['document_uploaded', 'document_shared', 'document_signed',
                      'document_archived', 'document_version_replaced']) {
  check(`audit records ${action}`, new RegExp(`'${action}'`).test(schema))
}

// ═════════════════════════════════════════════════════════════════════════════
// 8 · VERSION / FREEZE
// ═════════════════════════════════════════════════════════════════════════════
console.log('\n══ 8 · version + freeze ════════════════════════════════════════════════\n')

check('a version row is immutable',
  /document_versions_immutable/i.test(schema)
  && /before update or delete on public\.document_versions/i.test(schema))
check('a signed version cannot be deleted',
  /has been signed and cannot be deleted/i.test(schema))
check('the signature FK to its version RESTRICTs',
  /document_signatures_version_id_fkey[\s\S]{0,140}on delete restrict/i.test(schema),
  'CASCADE here would destroy the evidence the signature rests on')
check('a signed document cannot be re-attached to another record',
  /cannot be re-attached to a different record/i.test(schema),
  'the signature names a customer; re-parenting would make it describe another record')
check('version numbers are assigned by the database',
  /document_versions_assign_no/i.test(schema),
  'two racing uploads must not compute the same number in app code')
check('there is no UPDATE policy on document_versions',
  !/create policy "document_versions: update/i.test(schema),
  'immutability means the owner has no update door to reach')
check('a stale signature request stops applying when a new version lands',
  /order by dv\.version_no desc limit 1\s*\)\s*\)?;?/i.test(signFn) || /r\.version_id = \(/.test(signFn),
  'nobody may be recorded as agreeing to a file they never saw')

// ═════════════════════════════════════════════════════════════════════════════
// 9 · TENANT BOUNDARY + GRANTS
// ═════════════════════════════════════════════════════════════════════════════
console.log('\n══ 9 · tenant boundary ═════════════════════════════════════════════════\n')

const DOC_TABLES = ['documents', 'document_versions', 'document_signature_requests', 'document_signatures']
for (const t of DOC_TABLES) {
  check(`${t} has RLS enabled`,
    new RegExp(`alter table public\\.${t} enable row level security`, 'i').test(schema))
  // ⚠️⚠️ `revoke from anon` is NOT the same as removing the PUBLIC grant, and
  // Supabase grants new tables full DML to anon at CREATE TIME.
  check(`${t} strips every role before granting`,
    new RegExp(`revoke all on table public\\.${t} from public, anon, authenticated, service_role;`, 'i').test(schema))
  // ⭐ anon must get NOTHING: the portal is anonymous and reaches documents only
  // through the definer RPCs.
  check(`${t} grants NOTHING to anon`,
    !new RegExp(`grant [^;]*on table public\\.${t} to [^;]*\\banon\\b`, 'i').test(schema),
    'anon with a table grant is every internal permit one PostgREST call away')
}
check('owner RLS policies scope by auth.uid() = user_id',
  (schema.match(/create policy "documents[^"]*"[\s\S]*?auth\.uid\(\) = user_id/gi) ?? []).length >= 4)
check('document_signatures has no client write policy',
  !/create policy "document_signatures: (insert|update|delete)/i.test(schema),
  'signatures are written only by the definer RPCs that prove the signer')

// ═════════════════════════════════════════════════════════════════════════════
// 10 · ARCHIVE
// ═════════════════════════════════════════════════════════════════════════════
console.log('\n══ 10 · archive ════════════════════════════════════════════════════════\n')

check('archiving is a timestamp, not a delete', /"archived_at"\s+timestamp with time zone/i.test(schema))
check('archived documents leave the portal', /d\.archived_at is null/i.test(getDocs))
check('an archived document cannot be sent for signature',
  /is archived and cannot be sent for signature/i.test(schema))
check('the owner is told archiving is not deletion',
  /archiving is not deletion/i.test(panel),
  'a signed record must remain retrievable, and the owner must know that')

// ═════════════════════════════════════════════════════════════════════════════
// 11 · MOBILE
// ═════════════════════════════════════════════════════════════════════════════
console.log('\n══ 11 · mobile ═════════════════════════════════════════════════════════\n')

const pad = src(join('src', 'components', 'documents', 'SignaturePad.tsx'))
// ⭐ THE bug that breaks signature pads on phones: without touch-action:none the
// browser claims the gesture for scrolling and the finger drags the page.
check('the signature pad disables browser touch gestures',
  /touchAction: 'none'/.test(pad) && /touch-none/.test(pad),
  'without this a finger scrolls the page instead of drawing')
check('the signature pad uses pointer events (finger, stylus and mouse in one path)',
  /onPointerDown/.test(pad) && /onPointerMove/.test(pad) && /onPointerUp/.test(pad)
  && !/onTouchStart|onMouseDown/.test(pad))
check('the stroke stays captured when the finger leaves the pad',
  /setPointerCapture/.test(pad))
check('the pad allocates a device-pixel-ratio backing store',
  /devicePixelRatio/.test(pad) && /ctx\.scale\(dpr, dpr\)/.test(pad),
  'a CSS-pixel canvas renders a soft, blocky mark on a 3x phone')
check('the pad reports emptiness rather than guessing',
  /onChange\(hasInk\.current \? canvas\.toDataURL\('image\/png'\) : null\)/.test(pad),
  'a blank acknowledgement must be refusable')

const portalTab = src(join('src', 'app', 'portal', '[token]', 'components', 'DocumentsTab.tsx'))
check('portal document actions stack before 400px',
  /min-\[400px\]:flex-row/.test(portalTab),
  'two 44px targets side by side do not fit at 375px')
check('the crew document row uses real tap targets',
  /tap-target/.test(crewDocs))

// ═════════════════════════════════════════════════════════════════════════════
// 12 · BEHAVIOUR — proven from zero
// ═════════════════════════════════════════════════════════════════════════════
console.log('\n══ 12 · behaviour, from zero ═══════════════════════════════════════════\n')

await behaviour()

async function behaviour() {
  let PGlite: any, contribs: any = {}
  try {
    // Specifier in a variable ON PURPOSE — PGlite is an optional dependency and a
    // literal would make tsc/next build demand its types. Same reasoning as
    // verify:rebuild, which documents it at length.
    const PGLITE = '@electric-sql/pglite'
    ;({ PGlite } = await import(PGLITE))
    const load = async (p: string, k: string) => { try { return (await import(p))[k] } catch { return undefined } }
    contribs = {
      pgcrypto: await load('@electric-sql/pglite/contrib/pgcrypto', 'pgcrypto'),
      uuid_ossp: await load('@electric-sql/pglite/contrib/uuid_ossp', 'uuid_ossp'),
      pg_trgm: await load('@electric-sql/pglite/contrib/pg_trgm', 'pg_trgm'),
    }
  } catch {
    console.log('  ⏭  SKIPPED — PGlite is not installed.')
    console.log('     The behavioural half is what proves the refusals actually bite.')
    console.log('     npm i -D @electric-sql/pglite && npm run verify:documents\n')
    return
  }

  const db = await PGlite.create({
    extensions: Object.fromEntries(Object.entries(contribs).filter(([, v]) => v)),
  })

  const exec = async (sql: string) => { await db.exec(sql) }

  /** Runs SQL that MUST fail. Returns the error message, or '' if it wrongly succeeded. */
  const refuses = async (sql: string): Promise<string> => {
    try { await db.exec(sql); return '' } catch (e: any) { return String(e?.message ?? 'error') }
  }

  /**
   * ⭐ REFUSED FOR THE RIGHT REASON. `refuses()` alone passes on ANY error — so a
   * typo'd column name, a missing fixture or a syntax slip would render as "the
   * constraint bit", and the guard would be green while proving nothing. Every
   * refusal below therefore also names the rule that must have done the refusing.
   */
  const refusedBy = async (name: string, sql: string, expected: RegExp, detail?: string) => {
    const msg = await refuses(sql)
    if (!msg) { check(name, false, detail ?? 'the statement SUCCEEDED — the rule did not bite'); return }
    check(name, expected.test(msg),
      `refused, but for the wrong reason — expected ${expected}, got: ${msg.slice(0, 180)}`)
  }

  // ── apply: prelude → baseline → the pending change ────────────────────────
  const split = (sql: string): string[] => {
    const out: string[] = []
    let buf = '', i = 0
    while (i < sql.length) {
      const c = sql[i]
      if (c === '-' && sql[i + 1] === '-') {
        const nl = sql.indexOf('\n', i); const end = nl === -1 ? sql.length : nl
        buf += sql.slice(i, end); i = end; continue
      }
      if (c === "'") {
        let j = i + 1
        while (j < sql.length) {
          if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; continue }
          if (sql[j] === "'") break
          j++
        }
        buf += sql.slice(i, j + 1); i = j + 1; continue
      }
      if (c === '$') {
        const m = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(i))
        if (m) {
          const tag = m[0]; const close = sql.indexOf(tag, i + tag.length)
          const end = close === -1 ? sql.length : close + tag.length
          buf += sql.slice(i, end); i = end; continue
        }
      }
      if (c === ';') { out.push(buf.trim()); buf = ''; i++; continue }
      buf += c; i++
    }
    if (buf.trim()) out.push(buf.trim())
    return out.filter(s => s && !/^(--[^\n]*\n?)*$/.test(s))
  }

  // ── declared platform substitutions ──────────────────────────────────────
  // A statement is dropped ONLY when the object is provided by the Supabase
  // platform rather than by this repository, and it owns no application object.
  // The same two verify:rebuild declares — and named out loud, never a silent
  // filter, because a quiet skip is how a rebuild test starts lying.
  const SUBSTITUTIONS: { pattern: RegExp; what: string }[] = [
    { pattern: /^create extension if not exists "?pg_net"?[^;]*;$/gim, what: 'create extension pg_net' },
    { pattern: /^create extension if not exists "?pg_stat_statements"?[^;]*;$/gim, what: 'create extension pg_stat_statements' },
  ]

  const applyFile = async (label: string, sql: string): Promise<boolean> => {
    let prepared = sql
    for (const s of SUBSTITUTIONS) {
      s.pattern.lastIndex = 0
      if (s.pattern.test(prepared)) {
        s.pattern.lastIndex = 0
        prepared = prepared.replace(s.pattern, '')
        console.log(`  ⇄ platform substitution — ${s.what} (provided by the platform, not this repo)`)
      }
      s.pattern.lastIndex = 0
    }
    const statements = split(prepared)
    let n = 0
    // Progress, because applying the baseline is ~10 minutes of WASM Postgres and
    // a log line that only appears on COMPLETION is indistinguishable from a hang.
    // (It cost this session two false "it's stuck" diagnoses before the real
    // cause — nine orphaned runs competing for the CPU — turned up.)
    const t0 = Date.now()
    const step = Math.max(250, Math.floor(statements.length / 8))
    try {
      for (const s of statements) {
        await db.exec(s + ';')
        n++
        if (n % step === 0) {
          console.log(`     … ${label}: ${n}/${statements.length} (${((Date.now() - t0) / 1000).toFixed(0)}s)`)
        }
      }
      console.log(`  ✓ applied ${label} (${statements.length} statements, ${((Date.now() - t0) / 1000).toFixed(0)}s)`)
      return true
    } catch (e: any) {
      fail++
      console.error(`  ✗ FAILED applying ${label} at statement ${n + 1}/${statements.length}`)
      console.error(`      ${String(e?.message).slice(0, 260)}`)
      console.error(`      ${(statements[n] ?? '').replace(/\s+/g, ' ').slice(0, 200)}`)
      return false
    }
  }

  if (!existsSync(PRELUDE)) { console.log('  ⏭  SKIPPED — no platform prelude to bootstrap PGlite.'); return }
  if (!await applyFile('platform prelude', src(PRELUDE))) return
  for (const f of readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()) {
    if (!await applyFile(f, src(join(MIGRATIONS, f)))) return
  }
  // ⭐ THE REAL APPLY ORDER, PROVEN. The loop above applies EVERY migration in
  // version order, which now includes the documents migration itself — so this
  // rebuild exercises exactly the sequence production runs. Session 68's
  // audit_log arrives with the baseline; section 0 of the documents migration
  // refuses to apply without it, so a wrong order fails HERE rather than on
  // somebody's first upload in production.

  // ── fixtures ───────────────────────────────────────────────────────────────
  // Two tenants, because half of what follows is a claim about the boundary
  // between them.
  const A = '00000000-0000-0000-0000-0000000000aa'   // tenant A (the owner under test)
  const B = '00000000-0000-0000-0000-0000000000bb'   // tenant B (the neighbour)
  try {
    await exec(`insert into auth.users (id, email) values
      ('${A}', 'a@example.test'), ('${B}', 'b@example.test')`)
    await exec(`
      insert into public.customers (id, user_id, name) values
        ('11111111-1111-1111-1111-111111111111', '${A}', 'Customer One'),
        ('22222222-2222-2222-2222-222222222222', '${A}', 'Customer Two'),
        ('33333333-3333-3333-3333-333333333333', '${B}', 'Neighbour Customer');
      insert into public.properties (id, user_id, customer_id, address) values
        ('aaaaaaaa-0000-0000-0000-000000000001', '${A}', '11111111-1111-1111-1111-111111111111', '1 Test Way');
      insert into public.jobs (id, user_id, customer_id, title, scheduled_date, crew_id) values
        ('bbbbbbbb-0000-0000-0000-000000000001', '${A}', '11111111-1111-1111-1111-111111111111', 'Visit', current_date, 'cccccccc-0000-0000-0000-000000000001');
      insert into public.equipment (id, user_id, name) values
        ('dddddddd-0000-0000-0000-000000000001', '${A}', 'Mower');
      insert into public.customer_portal_tokens (user_id, customer_id, token) values
        ('${A}', '11111111-1111-1111-1111-111111111111', 'tok-one'),
        ('${A}', '22222222-2222-2222-2222-222222222222', 'tok-two'),
        ('${B}', '33333333-3333-3333-3333-333333333333', 'tok-neighbour');
    `)
  } catch (e: any) {
    console.error(`  ✗ could not build fixtures: ${String(e?.message).slice(0, 200)}`)
    fail++
    return
  }
  console.log('  ✓ fixtures: two tenants, three customers, one visit')

  // ── entity link ────────────────────────────────────────────────────────────
  await refusedBy('BEHAVIOUR · a document with no entity is refused',
    `insert into public.documents (user_id, name) values ('${A}', 'Orphan')`,
    /documents_one_entity/i)
  await refusedBy('BEHAVIOUR · a document with two entities is refused',
    `insert into public.documents (user_id, name, customer_id, job_id)
      values ('${A}', 'Two homes', '11111111-1111-1111-1111-111111111111', 'bbbbbbbb-0000-0000-0000-000000000001')`,
    /documents_one_entity/i)

  // ── visibility ─────────────────────────────────────────────────────────────
  await refusedBy('BEHAVIOUR · worker visibility on a customer document is refused',
    `insert into public.documents (user_id, name, customer_id, visibility)
      values ('${A}', 'No visit', '11111111-1111-1111-1111-111111111111', 'worker')`,
    /documents_worker_needs_job/i)
  await refusedBy('BEHAVIOUR · customer visibility on an equipment document is refused',
    `insert into public.documents (user_id, name, equipment_id, visibility)
      values ('${A}', 'Mower manual', 'dddddddd-0000-0000-0000-000000000001', 'customer')`,
    /documents_equipment_not_customer/i)

  await exec(`insert into public.documents (id, user_id, name, customer_id, visibility)
    values ('eeee0000-0000-0000-0000-000000000001', '${A}', 'Authorization', '11111111-1111-1111-1111-111111111111', 'customer')`)
  const defaultVis = (await db.query(`insert into public.documents (user_id, name, customer_id)
    values ('${A}', 'Unshared', '11111111-1111-1111-1111-111111111111') returning visibility`)).rows[0] as any
  check('BEHAVIOUR · a new document defaults to internal', defaultVis?.visibility === 'internal')

  // ── versions ───────────────────────────────────────────────────────────────
  await exec(`insert into public.document_versions (id, document_id, storage_path, file_name)
    values ('ffff0000-0000-0000-0000-000000000001', 'eeee0000-0000-0000-0000-000000000001', '${A}/eeee/v1.pdf', 'auth.pdf')`)
  const v1 = (await db.query(`select version_no, user_id from public.document_versions
    where id = 'ffff0000-0000-0000-0000-000000000001'`)).rows[0] as any
  check('BEHAVIOUR · the database assigned version_no = 1', Number(v1?.version_no) === 1)
  check('BEHAVIOUR · the version inherited the document\'s tenant', v1?.user_id === A)

  await refusedBy('BEHAVIOUR · a version\'s content pointer cannot be swapped',
    `update public.document_versions set storage_path = '${A}/eeee/evil.pdf'
      where id = 'ffff0000-0000-0000-0000-000000000001'`,
    /immutable/i)

  // ── signature request ──────────────────────────────────────────────────────
  await refusedBy('BEHAVIOUR · a signature cannot be requested from the wrong customer',
    `insert into public.document_signature_requests
      (document_id, version_id, customer_id, statement, purpose)
      values ('eeee0000-0000-0000-0000-000000000001', 'ffff0000-0000-0000-0000-000000000001',
              '22222222-2222-2222-2222-222222222222', 'I authorize the described work.', 'work_authorization')`,
    /does not belong to customer/i,
    'customer Two must not be asked to sign customer One\'s document')

  await exec(`insert into public.document_signature_requests
    (id, document_id, version_id, customer_id, statement, purpose)
    values ('99990000-0000-0000-0000-000000000001', 'eeee0000-0000-0000-0000-000000000001',
            'ffff0000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
            'I authorize the described work.', 'work_authorization')`)

  // ── the portal projection ──────────────────────────────────────────────────
  const seenByOne = (await db.query(`select public.portal_get_documents('tok-one') as j`)).rows[0] as any
  const listOne = JSON.parse(JSON.stringify(seenByOne.j)) as any[]
  check('BEHAVIOUR · the customer sees their shared document',
    listOne.length === 1 && listOne[0].name === 'Authorization')
  check('BEHAVIOUR · the internal document is NOT in the portal projection',
    !listOne.some(d => d.name === 'Unshared'))
  check('BEHAVIOUR · the portal reports the awaiting-signature state',
    listOne[0]?.signature_state === 'awaiting_signature')
  // The path must not appear under ANY key, so the whole payload is searched
  // rather than a named field — a rename would otherwise slip past this.
  const listOneJson = JSON.stringify(listOne)
  check('BEHAVIOUR · the portal projection carries no storage path',
    !listOneJson.includes('storage_path') && !listOneJson.includes(`${A}/eeee`),
    'a list view has no reason to hold a path')
  check('BEHAVIOUR · the portal projection carries no signature image path',
    !listOneJson.includes('signature_path'))

  const seenByTwo = ((await db.query(`select public.portal_get_documents('tok-two') as j`)).rows[0] as any).j
  check('BEHAVIOUR · another customer of the SAME tenant sees nothing',
    Array.isArray(seenByTwo) && seenByTwo.length === 0,
    'a token proves which tenant — the projection must prove which row')

  const seenByNeighbour = ((await db.query(`select public.portal_get_documents('tok-neighbour') as j`)).rows[0] as any).j
  check('BEHAVIOUR · another TENANT sees nothing',
    Array.isArray(seenByNeighbour) && seenByNeighbour.length === 0)

  // ── foreign document id ────────────────────────────────────────────────────
  const foreignFile = ((await db.query(
    `select public.portal_document_file('tok-two', 'eeee0000-0000-0000-0000-000000000001') as j`)).rows[0] as any).j
  check('BEHAVIOUR · a foreign document id returns nothing to the portal', foreignFile == null,
    'the id is a filter input, never an instruction')

  const revokedTarget = ((await db.query(
    `select public.portal_signature_target('tok-neighbour', 'eeee0000-0000-0000-0000-000000000001') as j`)).rows[0] as any).j
  check('BEHAVIOUR · a foreign token cannot reach a signature target', revokedTarget == null)

  // ── signing, and replay ────────────────────────────────────────────────────
  const signed = ((await db.query(
    `select public.portal_sign_document('tok-one', 'eeee0000-0000-0000-0000-000000000001',
       '99990000-0000-0000-0000-000000000001', 'Alex Homeowner', '${A}/eeee/signatures/x.png') as j`)).rows[0] as any).j
  check('BEHAVIOUR · the customer can sign', signed?.ok === true)

  const replay = ((await db.query(
    `select public.portal_sign_document('tok-one', 'eeee0000-0000-0000-0000-000000000001',
       '99990000-0000-0000-0000-000000000001', 'Alex Homeowner', null) as j`)).rows[0] as any).j
  check('BEHAVIOUR · a replayed signature is refused as already_signed',
    replay?.ok === false && replay?.reason === 'already_signed')

  const forged = ((await db.query(
    `select public.portal_sign_document('tok-two', 'eeee0000-0000-0000-0000-000000000001',
       '99990000-0000-0000-0000-000000000001', 'Mallory', null) as j`)).rows[0] as any).j
  check('BEHAVIOUR · a different customer cannot sign this request',
    forged?.ok === false && forged?.reason === 'not_authorized')

  const badPath = ((await db.query(
    `select public.portal_sign_document('tok-one', 'eeee0000-0000-0000-0000-000000000001',
       '99990000-0000-0000-0000-000000000001', 'Alex', '${B}/stolen.png') as j`)).rows[0] as any).j
  check('BEHAVIOUR · a signature path in another tenant\'s folder is refused',
    badPath?.ok === false)

  // ── what signing froze ─────────────────────────────────────────────────────
  await refusedBy('BEHAVIOUR · a signature cannot be edited',
    `update public.document_signatures set signer_name = 'Someone Else'
      where request_id = '99990000-0000-0000-0000-000000000001'`,
    /append-only/i)
  await refusedBy('BEHAVIOUR · a signature cannot be deleted',
    `delete from public.document_signatures
      where request_id = '99990000-0000-0000-0000-000000000001'`,
    /append-only/i)
  await refusedBy('BEHAVIOUR · the signed version cannot be deleted',
    `delete from public.document_versions
      where id = 'ffff0000-0000-0000-0000-000000000001'`,
    /has been signed and cannot be deleted/i)
  await refusedBy('BEHAVIOUR · a signed document cannot be re-attached to another record',
    `update public.documents
      set customer_id = '22222222-2222-2222-2222-222222222222'
      where id = 'eeee0000-0000-0000-0000-000000000001'`,
    /cannot be re-attached/i)

  // A NEW version is still allowed — that is the whole point of versioning.
  const v2 = await refuses(`insert into public.document_versions (document_id, storage_path, file_name)
    values ('eeee0000-0000-0000-0000-000000000001', '${A}/eeee/v2.pdf', 'auth-v2.pdf')`)
  check('BEHAVIOUR · a replacement is allowed AS A NEW VERSION', v2 === '',
    'freezing content must not block correcting the document')

  // ⭐ …and the old request no longer applies to the new current version.
  const staleTarget = ((await db.query(
    `select public.portal_signature_target('tok-one', 'eeee0000-0000-0000-0000-000000000001') as j`)).rows[0] as any).j
  check('BEHAVIOUR · a superseded request stops being signable', staleTarget == null,
    'nobody may be recorded as agreeing to a file they never saw')

  // ── audit, through Session 68's engine ─────────────────────────────────────
  const events = (await db.query(`select action, entity_type, entity_id, after
    from public.audit_events where entity_type = 'document' order by seq`)).rows as any[]
  const actions = events.map(e => e.action)
  check('BEHAVIOUR · the upload was audited', actions.includes('document_uploaded'))
  check('BEHAVIOUR · the signature was audited', actions.includes('document_signed'))
  check('BEHAVIOUR · audit events are written by the CANONICAL engine',
    events.length > 0 && events.every(e => e.entity_type === 'document'),
    'these rows are in audit_events — no second audit table exists')

  // ⛔ The whole point of the payload rules: prove the mark never got in.
  const auditJson = JSON.stringify(events)
  check('BEHAVIOUR · no signature image or storage path reached the audit trail',
    !auditJson.includes('signatures/') && !auditJson.includes('.png')
    && !auditJson.includes('signature_path') && !auditJson.includes(`${A}/eeee`),
    'a private path or a drawn mark in a general-purpose event log is a leak')
  check('BEHAVIOUR · audit did not duplicate signature truth',
    !auditJson.includes('Alex Homeowner') && !auditJson.includes('I authorize the described work'),
    'document_signatures is authoritative — audit only describes the mutation')

  // ── asking again ───────────────────────────────────────────────────────────
  // ⭐ THE REGRESSION THIS EXISTS FOR. The whole point of versioning is that a
  // signed document can be revised and re-signed. A "one open request" rule
  // written as a partial unique index cannot see that the first request was
  // FULFILLED, so it blocks this forever. Proven, not assumed.
  const v2row = (await db.query(`select id from public.document_versions
    where document_id = 'eeee0000-0000-0000-0000-000000000001' order by version_no desc limit 1`)).rows[0] as any
  const reRequest = await refuses(`insert into public.document_signature_requests
    (document_id, version_id, customer_id, statement, purpose)
    values ('eeee0000-0000-0000-0000-000000000001', '${v2row.id}',
            '11111111-1111-1111-1111-111111111111',
            'I authorize the revised work described in version 2.', 'work_authorization')`)
  check('BEHAVIOUR · a signed document can be re-signed after a revision', reRequest === '',
    `a fulfilled request must not block asking again — got: ${reRequest.slice(0, 140)}`)

  // …but two PENDING requests at once are still refused.
  await refusedBy('BEHAVIOUR · a second OPEN request is still refused',
    `insert into public.document_signature_requests
      (document_id, version_id, customer_id, statement, purpose)
      values ('eeee0000-0000-0000-0000-000000000001', '${v2row.id}',
              '11111111-1111-1111-1111-111111111111',
              'A second simultaneous ask that must be refused.', 'customer_acknowledgement')`,
    /already waiting on a signature/i,
    'two pending asks would let one act of consent satisfy both')

  // ── archive ────────────────────────────────────────────────────────────────
  await exec(`update public.documents set archived_at = now()
    where id = 'eeee0000-0000-0000-0000-000000000001'`)
  const afterArchive = ((await db.query(`select public.portal_get_documents('tok-one') as j`)).rows[0] as any).j
  check('BEHAVIOUR · an archived document leaves the portal',
    Array.isArray(afterArchive) && afterArchive.length === 0)
  const stillThere = (await db.query(`select count(*)::int as n from public.document_signatures
    where document_id = 'eeee0000-0000-0000-0000-000000000001'`)).rows[0] as any
  check('BEHAVIOUR · archiving keeps the signed record', Number(stillThere?.n) === 1,
    'archiving is not deletion — a signed record must stay retrievable')

  await db.close?.()
}

// ═════════════════════════════════════════════════════════════════════════════
// 13 · LIVE — a marked fixture tenant, never the owner's book
// ═════════════════════════════════════════════════════════════════════════════
console.log('\n══ 13 · live ═══════════════════════════════════════════════════════════\n')

const t = await openFixtureTenant('verify:documents')
if (isSkipped(t)) {
  console.log(`  ⏭  live half SKIPPED — ${t.skipped}`)
} else {
  try {
    // Does the schema exist in the environment we are pointed at? Until the
    // pending migration is applied to production this is expected to be absent,
    // and saying so is the honest answer — not a pass.
    const { error: probe } = await t.db.from('documents').select('id').limit(1)
    if (probe && /does not exist/i.test(probe.message)) {
      console.log('  ⏭  live half SKIPPED — the documents schema is not applied to this database yet.')
      console.log('     Apply supabase/pending/ first, then this half proves RLS for real.')
    } else {
      check('live · the fixture tenant can read its own documents', !probe, probe?.message)

      const customer = await t.fixtureCustomer()
      const { data: doc, error: insErr } = await t.db.from('documents').insert({
        user_id: t.uid, name: t.tag('DOC'), customer_id: customer.id, visibility: 'internal',
      }).select('id, visibility').single()
      check('live · a document can be created', !insErr && !!doc, insErr?.message)
      check('live · it defaults to internal', (doc as any)?.visibility === 'internal')

      if (doc) {
        // ⭐ THE TENANT BOUNDARY, asked of the real database through real RLS:
        // an anonymous caller must not reach the table at all.
        const { data: anonRows } = await t.anon.from('documents').select('id').limit(1)
        check('live · anon cannot read documents through PostgREST',
          !anonRows || anonRows.length === 0,
          'anon reached the documents table — the grant or the policy is wrong')

        await t.db.from('documents').delete().eq('id', (doc as any).id)
      }
    }
  } finally {
    await t.close()
    const residue = await fixtureResidue(t)
    const left = Object.entries(residue).filter(([, n]) => n > 0)
    check('live · the run left nothing behind', left.length === 0, JSON.stringify(residue))
  }
}

// ═════════════════════════════════════════════════════════════════════════════
console.log(`\n${fail === 0 ? '✅' : '❌'} verify:documents — ${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
}

void main()
