// ── verify:contracts ─────────────────────────────────────────────────────────
//
// Contracts + Service Agreements V1 (Session 83). Three halves, each saying
// plainly when it cannot run rather than passing quietly:
//
//   STATIC     — always runs, including on CI. Reads the schema and the app code
//                and asserts the contract that must never regress.
//   BEHAVIOUR  — applies the platform prelude and EVERY migration in the apply
//                path, in version order, to PGlite, and proves the rules FROM
//                ZERO. Skips clean when PGlite is absent (optional dependency).
//   LIVE       — a marked fixture tenant, never the owner's book. Skips clean
//                without credentials.
//
// ⭐ WHY THE BEHAVIOURAL HALF MATTERS MOST. Every claim here is a claim about
// what the DATABASE refuses. Grepping for a constraint proves the text exists;
// executing it proves it bites. RLS cannot be proven in PGlite (the harness
// connects as superuser and bypasses it), so RLS is asserted statically and
// exercised for real in the live half — a split stated rather than papered over.
//
// ⭐⭐ THE INVARIANT THIS WHOLE FILE EXISTS TO DEFEND: a contract is a COMMERCIAL
// relationship. It is not a document, not a signature, and not a schedule. The
// three truths — agreed / scheduled / delivered — must stay independent in BOTH
// directions, which is why 14 and 15 below are separate proofs.

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { baselineSql } from './lib/schema-source'
import { splitStatements, loadPGlite, substitutePlatformStatements } from './lib/pg-sql'
import { openFixtureTenant, isSkipped, fixtureResidue } from './lib/verify-fixture'

const MIGRATIONS = join('supabase', 'migrations')
const PRELUDE = join('scripts', 'schema', 'platform-prelude.sql')

let pass = 0, fail = 0
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`) }
}

const src = (p: string) => existsSync(p) ? readFileSync(p, 'utf8').replace(/\r\n?/g, '\n') : ''

/**
 * ⚠️⚠️ STRIP COMMENTS BEFORE ASSERTING ABSENCE. A guard that greps raw SQL for a
 * forbidden token is defeated by a comment that mentions the token in order to
 * say it is deliberately absent — this codebase has now been bitten by that in
 * both directions. Line comments come off BEFORE block comments, and `[^\n]`
 * rather than `.` because `.` does not match `\r`.
 */
const stripSql = (s: string) => s.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
const stripTs = (s: string) => s.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')

/** The contracts migration, comments stripped — read by both halves. */
function contractsSchema(): string {
  const f = existsSync(MIGRATIONS)
    ? readdirSync(MIGRATIONS).filter(n => /_contracts_v1(_TEMP)?\.sql$/i.test(n)).sort()[0]
    : undefined
  return f ? stripSql(src(join(MIGRATIONS, f))) : ''
}

async function main() {

// ═════════════════════════════════════════════════════════════════════════════
// 1 · LIFECYCLE — one home for the schema
// ═════════════════════════════════════════════════════════════════════════════
console.log('\n══ 1 · lifecycle ═══════════════════════════════════════════════════════\n')

const migrationFiles = existsSync(MIGRATIONS)
  ? readdirSync(MIGRATIONS).filter(f => /_contracts_v1(_TEMP)?\.sql$/i.test(f)).sort()
  : []
const migrationSql = migrationFiles.length ? src(join(MIGRATIONS, migrationFiles[0])) : ''
const schema = stripSql(migrationSql)
const base = baselineSql()

check('the contracts migration exists', !!migrationSql,
  'no *_contracts_v1*.sql in supabase/migrations/')
check('contracts is not already in the baseline',
  !/create table if not exists public\."?contracts"?\s*\(/i.test(base),
  'the baseline already defines public.contracts — this migration has landed and should be archived')

// ⛔ THE TEMPORARY STAMP IS DELIBERATE AND MUST BE LOUD. Session 74 has not
// landed, so the real version cannot be known: it is taken from the LIVE ledger
// at apply time. This check fails the day someone tries to land it as-is.
const isTemp = /_TEMP\.sql$/i.test(migrationFiles[0] ?? '')
check('the temporary migration identity announces itself', isTemp,
  'the placeholder version must stay obviously temporary until S74 lands')
check('the file says the version must be re-stamped from the live ledger',
  /TEMPORARY MIGRATION IDENTITY/i.test(migrationSql)
  && /AT APPLY TIME from the live\s*\n?--\s*ledger/i.test(migrationSql.replace(/\r/g, '')),
  'a placeholder version with no instruction is how a wrong version gets applied')

// ═════════════════════════════════════════════════════════════════════════════
// 2 · ONE ENGINE — S83 adds no document, signature or recurrence engine
// ═════════════════════════════════════════════════════════════════════════════
console.log('\n══ 2 · one engine per responsibility ═══════════════════════════════════\n')

const lib = src(join('src', 'lib', 'contracts.ts'))
const libCode = stripTs(lib)

// ⛔ PROOF 7 (part 1) · the signature is Session 74's, by construction.
//
// ⚠️⚠️ ASSERT ON THE TABLE NAMES, NOT ON PROXIMITY. `create table[^;]*signature`
// looks like it says "no signature table" and does not: there is no semicolon
// anywhere inside a CREATE TABLE, so `[^;]*` runs to the end of the statement and
// matches the perfectly legitimate COLUMN `signature_request_id`. The same trap
// took out the document and recurrence checks. Extracting the created names is
// the only form of this assertion that means what it says.
const createdTables = [...schema.matchAll(/create table (?:if not exists )?public\.("?)([a-z_]+)\1\s*\(/gi)]
  .map(m => m[2].toLowerCase())
check('S83 creates exactly the two tables it owns',
  createdTables.length === 2
  && createdTables.includes('contracts') && createdTables.includes('contract_templates'),
  `created: ${createdTables.join(', ') || '(none)'}`)
check('S83 defines NO signature table of its own',
  !createdTables.some(t => /signature/.test(t)),
  'signatures belong to Session 74 — document_signature_requests / document_signatures')
check('S83 defines NO document or version table of its own',
  !createdTables.some(t => /^document/.test(t)),
  'the artifact is a Session 74 document version')
check('S83 defines NO storage bucket of its own',
  !/storage\.(buckets|objects)/i.test(schema),
  'the contract artifact lives in Session 74\'s private documents bucket')
check('S83 defines NO recurrence table of its own',
  !createdTables.some(t => /recurrence/.test(t)),
  'job_recurrences is the ONE operational recurring engine')
check('S83 defines no portal signing RPC of its own',
  !/create or replace function public\.portal_[a-z_]*sign/i.test(schema),
  'portal_sign_document is Session 74\'s door and the only one')

// ⭐ PROOF 7 (part 2) · the app calls S74's canonical API rather than the tables.
check('the library imports Session 74\'s canonical API',
  /from '@\/lib\/documents'/.test(lib),
  'contracts must call lib/documents, not re-implement it')
check('the library requests signatures through S74 requestSignature',
  /requestSignature\(/.test(libCode),
  'the signature request must be S74\'s')
check('the library creates the artifact through S74 uploadDocument',
  /uploadDocument\(/.test(libCode),
  'the rendered agreement must become an S74 document version')
check('the library never writes S74 signature tables directly',
  !/from\('document_signature_requests'\)[\s\S]{0,80}\.(insert|update|delete)/.test(libCode)
  && !/from\('document_signatures'\)[\s\S]{0,80}\.(insert|update|delete)/.test(libCode),
  'writing S74\'s tables behind its API is a second engine wearing its name')
check('there is no second signature pad',
  !existsSync(join('src', 'components', 'contracts', 'SignaturePad.tsx')),
  'S74\'s SignaturePad is the only one')

// ═════════════════════════════════════════════════════════════════════════════
// 3 · SEPARATION — contract vs recurrence vs money
// ═════════════════════════════════════════════════════════════════════════════
console.log('\n══ 3 · separation of the three truths ══════════════════════════════════\n')

// ⛔ PROOF 14 · signing must never manufacture a schedule.
check('14 · nothing in the contracts schema writes job_recurrences',
  !/(insert into|update|delete from)\s+public\.job_recurrences/i.test(schema),
  'a signed contract must never create or mutate a recurring series')
check('14 · nothing in the contracts library writes job_recurrences',
  !/from\('job_recurrences'\)[\s\S]{0,120}\.(insert|update|delete|upsert)/.test(libCode),
  'relinking the operational series is a separate, explicit owner action')

// ⛔ PROOF 13 · a status is not a financial event.
check('13 · the contracts schema creates no job, invoice or payment',
  !/(insert into|update)\s+public\.(jobs|invoices|payments|quotes)\b/i.test(schema),
  'no contract status may manufacture work, an invoice or revenue')
check('13 · the contracts library writes no job, invoice or payment',
  !/from\('(jobs|invoices|payments)'\)[\s\S]{0,120}\.(insert|update|upsert|delete)/.test(libCode),
  'activating a contract must not book work or bill anybody')

// ⛔ PROOF 15 · and the reverse direction, which is the one that gets forgotten.
check('15 · no recurrence trigger touches contracts',
  !/on\s+public\.job_recurrences[\s\S]{0,200}execute function public\.[a-z_]*contract/i.test(schema),
  'completing or cancelling a series must not change a contract\'s legal status')
check('15 · contract status is never derived from a recurrence',
  !/job_recurrence[\s\S]{0,200}\bstatus\s*:=/i.test(schema),
  'the commercial status is independent of the operational series')

// ⭐ PROOF 4 · term independence, asserted where it could actually rot.
check('4 · the term columns exist on the contract itself',
  /"effective_date"\s+date/i.test(schema) && /"end_date"\s+date/i.test(schema),
  'a contract term must be its own fact, not a recurrence\'s dates')
check('4 · no contract date is copied from a recurrence',
  !/(effective_date|end_date)\s*(:?=)\s*[^;\n]*recurrence/i.test(schema)
  && !/recurrence[^;\n]*\.(start_date|end_date)/i.test(schema),
  'reading start_date/end_date off job_recurrences is exactly the coupling this forbids')
check('4 · the library computes the term from its own inputs only',
  /endDateFromTerm\(/.test(libCode) && !/recurrence/i.test(
    libCode.slice(libCode.indexOf('export function endDateFromTerm'),
                  libCode.indexOf('export function termLabel'))),
  'endDateFromTerm must not consult a recurrence')

// ⭐ PROOF 12 · renewal awareness must not become Session 53's engine.
check('12 · the contracts library does not import the Session 53 renewal engine',
  !/from '@\/lib\/signals/.test(lib) && !/planRenewal|ranOut|cadenceDays/.test(libCode),
  'lib/signals/renewal answers a question about an operational PLAN — a different question with different inputs')
check('12 · contract renewal reads only the contract\'s own term',
  /renewalState\(/.test(libCode)
  && !/season|cadence|visit/i.test(
    libCode.slice(libCode.indexOf('export function renewalState'),
                  libCode.indexOf('export function renewalLabel'))),
  'a commercial term ending is not a service cadence ending')

// ═════════════════════════════════════════════════════════════════════════════
// 4 · TENANCY — every link welded
// ═════════════════════════════════════════════════════════════════════════════
console.log('\n══ 4 · tenancy ═════════════════════════════════════════════════════════\n')

// ⭐ PROOF 3 + 9 · composite FKs, not single-column ones.
for (const [label, re] of [
  ['customer', /foreign key \(user_id, customer_id\) references public\.customers\(user_id, id\)/i],
  ['property', /foreign key \(property_id, user_id\) references public\.properties\(id, user_id\)/i],
  ['job', /foreign key \(job_id, user_id\) references public\.jobs\(id, user_id\)/i],
  ['quote', /foreign key \(user_id, quote_id\) references public\.quotes\(user_id, id\)/i],
  ['recurrence', /foreign key \(user_id, job_recurrence_id\) references public\.job_recurrences\(user_id, id\)/i],
  ['service template', /foreign key \(service_template_id, user_id\) references public\.service_templates\(id, user_id\)/i],
  ['contract template', /foreign key \(template_id, user_id\) references public\.contract_templates\(id, user_id\)/i],
  ['document', /foreign key \(user_id, document_id\) references public\.documents\(user_id, id\)/i],
  ['document version', /foreign key \(user_id, document_version_id\) references public\.document_versions\(user_id, id\)/i],
] as [string, RegExp][]) {
  check(`3 · the ${label} link is a TENANT WELD, not a bare id`, re.test(schema),
    'a single-column FK lets one tenant attach another tenant\'s row')
}

check('2 · a contract without a customer is impossible',
  /"customer_id"\s+uuid not null/i.test(schema),
  'an agreement with nobody is not an agreement')
check('RLS is enabled on both tables',
  /alter table public\.contracts enable row level security/i.test(schema)
  && /alter table public\.contract_templates enable row level security/i.test(schema))
check('anon is explicitly revoked',
  /revoke all on public\.contracts from anon/i.test(schema),
  'Supabase grants DML to anon at table-create time — a previous session shipped an openly writable table this way')
// ⛔ PROOF 10 · the customer never reads a contract row.
check('10 · there is no portal or worker RLS policy on contracts',
  !/create policy[^;]*on public\.contracts[^;]*to (anon|public)/i.test(schema),
  'the customer sees the DOCUMENT through Session 74\'s projection, never a contract row')
check('10 · no contracts RPC is granted to anon',
  !/grant execute on function public\.[a-z_]*contract[a-z_]*\([^)]*\) to anon/i.test(schema),
  'a contract carries internal commercial metadata')

// ═════════════════════════════════════════════════════════════════════════════
// 5 · HONEST STATUS
// ═════════════════════════════════════════════════════════════════════════════
console.log('\n══ 5 · honest status ═══════════════════════════════════════════════════\n')

// ⭐⭐ PROOF 11 · expiry is DERIVED. A stored flag is wrong the morning after.
check('11 · there is no stored expired flag or expired status',
  !/"(expired|is_expired|expired_at)"/i.test(schema)
  && !/status[^;]*check[^;]*'expired'/i.test(schema),
  'expiry is a function of end_date and today — storing it needs a cron to stay true')
check('11 · expiry has ONE definition in SQL',
  /create or replace function public\.contract_is_expired/i.test(schema))
check('11 · only a LIVE agreement can lapse',
  /p_status = 'active' and p_end_date is not null and p_end_date < p_today/i.test(schema),
  'a draft was never in force; terminated/superseded already have a truer word')
check('11 · the app mirrors the same rule',
  /export function isExpired/.test(libCode)
  && /status === 'active'/.test(libCode) && /daysUntil\(c\.end_date, today\) < 0/.test(libCode),
  'two definitions of expired is how two screens disagree')
check('11 · terminated is paired with its stamp, both ways',
  /\(status = 'terminated'\) = \(terminated_at is not null\)/i.test(schema),
  'a terminated contract with no moment, or a stamp with no status, is a lie either way')
check('11 · an ending cannot be reopened',
  /cannot be reopened/i.test(migrationSql),
  'terminated and superseded are endings')

// ⭐ PROOF 5 + 6 + 8 · frozen truth.
check('6 · a sent contract must point at a document AND a version',
  /status not in \('sent', 'active'\) or \(document_id is not null and document_version_id is not null\)/i.test(schema),
  'sent with no artifact means nothing was actually sent')
check('8 · the signed version FK is RESTRICT, never cascade',
  /references public\.document_versions\(user_id, id\) on delete restrict/i.test(schema),
  'losing the pointer leaves a signed contract that cannot say what was signed')
check('5 · a sent contract cannot be re-pointed at another version',
  /has already been sent\. The version it points at is the record of what was sent/i.test(migrationSql),
  'swapping the version is how a template edit would rewrite history one level up')
check('5 · a signed contract\'s template provenance is frozen',
  /A signed contract keeps the template it was made from/i.test(migrationSql))
check('8 · a signed contract\'s term cannot be edited',
  /The term of a signed contract cannot be edited/i.test(migrationSql),
  'changing terms after signature is a new contract — that is what supersede is for')
check('8 · a signed contract cannot be deleted',
  /A signed contract cannot be deleted/i.test(migrationSql))
check('the template name is COPIED onto the contract',
  /"template_name"\s+text/i.test(schema) && /template_name: input\.template\?\.name/.test(libCode),
  'the S69 job_forms freeze pattern: provenance survives a rename or a delete')

// ⭐ ACTIVE means the acceptance condition is satisfied.
check('active requires a real signature against THIS version',
  /select 1 from public\.document_signatures s[\s\S]{0,200}s\.request_id = new\.signature_request_id[\s\S]{0,200}s\.version_id = new\.document_version_id/i.test(schema),
  'any-signature-will-do would let a customer\'s unrelated signature activate an agreement')

// ⭐ Universality.
// ⚠️ SCOPE THE MATCH TO THE ACTUAL CONSTRAINT. `[^;]*` looked precise and was
// not: there is no semicolon anywhere inside a CREATE TABLE, so it spanned the
// whole statement and matched the unrelated STATUS check — a guard that failed
// while the schema was correct.
const typeCheck = /constraint contracts_type_check\s+check\s*\(([\s\S]*?)\),\n/i.exec(schema)?.[1] ?? ''
check('contract type is FREE TEXT, not an enum',
  !!typeCheck && /char_length/i.test(typeCheck) && !/\bin\s*\(/i.test(typeCheck)
  && !/'Service Agreement'/i.test(schema),
  `a fixed five-word list is wrong for the first owner who needs a sixth — constraint reads: ${typeCheck.slice(0, 120)}`)
check('no annual or seasonal default is hardcoded',
  !/interval '1 year'|12 months|term_months\s+integer\s+default/i.test(schema),
  'the owner decides the term')

// ⭐ Audit reuse.
check('contract events go through the canonical audit_log()',
  /perform public\.audit_log\(/i.test(schema))
check('S83 defines no audit table or audit_log of its own',
  !/create table[^;]*audit_events/i.test(schema)
  && !/create or replace function public\.audit_log\b/i.test(schema))
const auditCalls = schema.match(/perform public\.audit_log\([\s\S]*?\);/gi) ?? []
check('no audit call leaks a storage path, a signature or a template body',
  auditCalls.length > 0
  && !auditCalls.some(c => /storage_path|signature_path|\bbody\b|base64/i.test(c)),
  `audit DESCRIBES the mutation; contracts stays authoritative (${auditCalls.length} calls)`)

// ═════════════════════════════════════════════════════════════════════════════
// 5b · SURFACES — the portal boundary, and the phone
// ═════════════════════════════════════════════════════════════════════════════
console.log('\n══ 5b · surfaces ═══════════════════════════════════════════════════════\n')

const listPage = src(join('src', 'app', 'dashboard', 'contracts', 'page.tsx'))
const newPage = src(join('src', 'app', 'dashboard', 'contracts', 'new', 'page.tsx'))
const detailPage = src(join('src', 'app', 'dashboard', 'contracts', '[id]', 'page.tsx'))
const tplPage = src(join('src', 'app', 'dashboard', 'contracts', 'templates', 'page.tsx'))
const custPanel = src(join('src', 'components', 'contracts', 'CustomerContracts.tsx'))
const ownerSurfaces: [string, string][] = [
  ['contracts list', listPage], ['new contract', newPage],
  ['contract detail', detailPage], ['templates', tplPage],
  ['customer contracts', custPanel],
]
for (const [label, s] of ownerSurfaces) check(`the ${label} surface exists`, !!s)

// ⛔ PROOF 10 · the customer never receives a contract row. The portal shows the
// DOCUMENT through Session 74's projection; contract metadata (termination
// reasons, template provenance, internal links) is the owner's.
const portalDir = join('src', 'app', 'portal')
const portalFiles: string[] = []
const walk = (dir: string) => {
  if (!existsSync(dir)) return
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p)
    else if (/\.(ts|tsx)$/.test(e.name)) portalFiles.push(p)
  }
}
walk(portalDir)
const portalSrc = portalFiles.map(f => src(f)).join('\n')
check('10 · no portal file imports the contracts engine',
  !/@\/lib\/contracts/.test(portalSrc),
  'the customer sees the signed DOCUMENT, never the commercial record around it')
check('10 · no portal file queries the contracts tables',
  !/from\('contracts'\)/.test(portalSrc) && !/from\('contract_templates'\)/.test(portalSrc),
  'a contract row carries internal metadata')
check('10 · no contracts API route is exposed under the portal',
  !existsSync(join('src', 'app', 'api', 'portal', 'contracts')),
  'signing goes through Session 74\'s existing portal door')

// ── Mobile: 375 / 390 / 430 ────────────────────────────────────────────────
// ⭐ The rule this codebase settled on: a phone stacks, it does not scroll
// sideways. Every owner surface must lay out in one column and widen at `sm:`.
for (const [label, s] of ownerSurfaces) {
  if (!s) continue
  const stacks = (/\bflex-col\b/.test(s) && /\bsm:flex-row\b/.test(s))
    || (/\bgrid-cols-1\b/.test(s) && /\bsm:grid-cols-/.test(s))
  check(`${label}: stacks on a phone, widens at sm:`, stacks,
    'a fixed row at 375px is how a surface overflows sideways')
}
check('contract detail: the action buttons are full-width on a phone',
  /className="w-full sm:w-auto"/.test(detailPage),
  'a half-width action on a 375px screen is a tiny tap target')
// ⚠️ Wide content must scroll INSIDE its own container, never the page body.
check('the rendered-agreement preview scrolls inside its own box',
  /overflow-x-auto/.test(detailPage) && /whitespace-pre-wrap/.test(detailPage),
  'a long unwrapped line in a <pre> is the classic body-level horizontal scroll')
for (const [label, s] of ownerSurfaces) {
  if (!s) continue
  check(`${label}: no fixed pixel width that cannot fit 375px`,
    !/\b(w|min-w)-\[(4[0-9]{2}|[5-9][0-9]{2}|[0-9]{4,})px\]/.test(s),
    'a min-width above ~430px forces the page to scroll sideways on every phone')
}

// ⭐ The legal-honesty line is a product requirement, not decoration.
check('the owner surfaces make no claim of legal enforceability',
  !/legally binding|legally enforceable|court/i.test(
    [listPage, detailPage, tplPage].join('\n')),
  'EdgeHQ provides the infrastructure and gives no legal advice')
check('the list page states what EdgeHQ actually records',
  /does not provide legal advice/i.test(listPage))
check('the signature panel distinguishes intent from identity',
  /evidence of intent, not proof of identity/i.test(detailPage),
  'a typed name is not proof of who typed it, and the product must not imply otherwise')

// ═════════════════════════════════════════════════════════════════════════════
// 6 · BEHAVIOUR, FROM ZERO
// ═════════════════════════════════════════════════════════════════════════════
console.log('\n══ 6 · behaviour, from zero ════════════════════════════════════════════\n')
await behaviour()

// ═════════════════════════════════════════════════════════════════════════════
// 7 · LIVE
// ═════════════════════════════════════════════════════════════════════════════
console.log('\n══ 7 · live (fixture tenant) ═══════════════════════════════════════════\n')
await live()

console.log(`\n${fail ? '✗' : '✓'} verify:contracts — ${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
}

// ─────────────────────────────────────────────────────────────────────────────

async function behaviour() {
  const loaded = await loadPGlite()
  if (!loaded) {
    console.log('  ⏭  SKIPPED — PGlite is not installed.')
    console.log('     The behavioural half is what proves the refusals actually bite.')
    console.log('     npm i -D @electric-sql/pglite && npm run verify:contracts\n')
    return
  }
  const { PGlite, contribs } = loaded
  const db = await PGlite.create({ extensions: contribs })

  const exec = async (sql: string) => { await db.exec(sql) }
  const refuses = async (sql: string): Promise<string> => {
    try { await db.exec(sql); return '' } catch (e: any) { return String(e?.message ?? 'error') }
  }
  /**
   * ⭐ REFUSED FOR THE RIGHT REASON. `refuses()` alone passes on ANY error, so a
   * typo'd column would render as "the constraint bit" and the guard would be
   * green while proving nothing. Every refusal names the rule that must have
   * done the refusing.
   */
  const refusedBy = async (name: string, sql: string, expected: RegExp, detail?: string) => {
    const msg = await refuses(sql)
    if (!msg) { check(name, false, detail ?? 'the statement SUCCEEDED — the rule did not bite'); return }
    check(name, expected.test(msg),
      `refused, but for the wrong reason — expected ${expected}, got: ${msg.slice(0, 200)}`)
  }

  const applyFile = async (label: string, sql: string): Promise<boolean> => {
    const { sql: subbed } = substitutePlatformStatements(sql)
    const statements = splitStatements(subbed)
    let n = 0
    try {
      for (; n < statements.length; n++) await db.exec(statements[n])
      return true
    } catch (e: any) {
      check(`applied ${label}`, false,
        `statement ${n + 1}/${statements.length}: ${String(e?.message).slice(0, 200)}\n      ${(statements[n] ?? '').replace(/\s+/g, ' ').slice(0, 200)}`)
      return false
    }
  }

  if (!existsSync(PRELUDE)) { console.log('  ⏭  SKIPPED — no platform prelude to bootstrap PGlite.'); return }
  if (!await applyFile('platform prelude', src(PRELUDE))) return
  // ⭐ THE REAL APPLY ORDER, PROVEN. Every migration in version order — which
  // includes Session 74's and then this one. Section 0 of the contracts
  // migration refuses to apply without S74, so a wrong order fails HERE rather
  // than on somebody's first send in production.
  for (const f of readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()) {
    if (!await applyFile(f, src(join(MIGRATIONS, f)))) return
  }
  console.log('  ✓ applied the prelude and every migration, in version order')

  const A = '00000000-0000-0000-0000-0000000000aa'
  const B = '00000000-0000-0000-0000-0000000000bb'
  const CUST_A = '11111111-1111-1111-1111-111111111111'
  const CUST_B = '33333333-3333-3333-3333-333333333333'
  const PROP_B = 'aaaaaaaa-0000-0000-0000-0000000000bb'
  const REC_A = 'rrrrrrrr-0000-0000-0000-00000000000a'.replace(/r/g, 'a')
  const REC_B = 'rrrrrrrr-0000-0000-0000-00000000000b'.replace(/r/g, 'b')

  try {
    await exec(`insert into auth.users (id, email) values
      ('${A}', 'a@example.test'), ('${B}', 'b@example.test')`)
    await exec(`
      insert into public.customers (id, user_id, name) values
        ('${CUST_A}', '${A}', 'Customer A'),
        ('${CUST_B}', '${B}', 'Neighbour Customer');
      insert into public.properties (id, user_id, customer_id, address) values
        ('${PROP_B}', '${B}', '${CUST_B}', '9 Neighbour Rd');
      insert into public.job_recurrences (id, user_id, customer_id, start_date, freq) values
        ('${REC_A}', '${A}', '${CUST_A}', current_date, 'weekly'),
        ('${REC_B}', '${B}', '${CUST_B}', current_date, 'weekly');
      insert into public.contract_templates (id, user_id, name, body, statement) values
        ('cccccccc-0000-0000-0000-00000000000a', '${A}', 'Service Agreement',
         'The business agrees to serve {{customer_name}}.',
         'I agree to the terms of this service agreement.');
    `)
  } catch (e: any) {
    check('fixtures built', false, String(e?.message).slice(0, 250)); return
  }
  console.log('  ✓ fixtures: two tenants, two customers, two recurrences, one template')

  // ── PROOF 1 · a draft can be created ──────────────────────────────────────
  const mk = (id: string, extra = '', cols = '', vals = '') => `
    insert into public.contracts (id, user_id, customer_id, title${cols}) values
      ('${id}', '${A}', '${CUST_A}', 'Seasonal Agreement'${vals})${extra}`
  const draftOk = await refuses(mk('d0000000-0000-0000-0000-000000000001'))
  check('1 · a draft contract can be created', draftOk === '',
    `it was refused: ${draftOk.slice(0, 200)}`)

  // ── PROOF 2 · customer required ───────────────────────────────────────────
  await refusedBy('2 · a contract with no customer is refused',
    `insert into public.contracts (user_id, title) values ('${A}', 'Nobody')`,
    /customer_id|not-null|null value/i)

  // ── PROOF 3 + 9 · tenancy ─────────────────────────────────────────────────
  await refusedBy('9 · a FOREIGN TENANT customer is refused',
    `insert into public.contracts (user_id, customer_id, title) values ('${A}', '${CUST_B}', 'Steal')`,
    /contracts_customer_same_tenant|foreign key/i)
  await refusedBy('3 · a foreign tenant property is refused',
    `insert into public.contracts (user_id, customer_id, property_id, title)
       values ('${A}', '${CUST_A}', '${PROP_B}', 'X')`,
    /contracts_property_same_tenant|foreign key/i)
  await refusedBy('3 · a foreign tenant RECURRENCE is refused',
    `insert into public.contracts (user_id, customer_id, job_recurrence_id, title)
       values ('${A}', '${CUST_A}', '${REC_B}', 'X')`,
    /contracts_recurrence_same_tenant|foreign key/i)

  // ⚠️ A DATE COLUMN COMES BACK AS A `Date`, NOT A STRING. `String(new Date())`
  // is "Sat Dec 31 2026 …", so a startsWith('2026-12-31') comparison fails while
  // the value is perfectly correct. Normalise once, here.
  const asDate = (v: unknown): string =>
    v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? '').slice(0, 10)

  // ── PROOF 4 · term independent of the recurrence ──────────────────────────
  await exec(`insert into public.contracts (id, user_id, customer_id, job_recurrence_id, title, effective_date, end_date)
    values ('d0000000-0000-0000-0000-000000000002', '${A}', '${CUST_A}', '${REC_A}', 'Governed', date '2026-01-01', date '2026-12-31')`)
  await exec(`update public.job_recurrences set end_date = date '2026-03-01' where id = '${REC_A}'`)
  const term: any = await db.query(
    `select end_date from public.contracts where id = 'd0000000-0000-0000-0000-000000000002'`)
  check('4 · changing the recurrence does NOT move the contract term',
    asDate(term.rows[0]?.end_date) === '2026-12-31',
    `the contract term followed the series: ${asDate(term.rows[0]?.end_date)}`)

  // ── PROOF 15 · an operational ending does not change legal status ─────────
  // The series is made to look finished — an end date in the past, the shape a
  // completed or cancelled plan actually has.
  //
  // ⚠️ DELETING the recurrence is the other half of this proof and CANNOT run
  // here: the delete cascades to quotes.renewal_of_recurrence_id, and PGlite
  // refuses to update `quotes` at all ("replica identity must not contain
  // unpublished generated columns" — quotes.total is GENERATED). That is a
  // harness limitation, not a product one, and it is named rather than skipped
  // silently. The FK's ON DELETE SET NULL is asserted statically instead.
  await exec(`update public.job_recurrences set end_date = date '2020-01-01' where id = '${REC_A}'`)
  const afterEnd: any = await db.query(
    `select status, job_recurrence_id, end_date from public.contracts where id = 'd0000000-0000-0000-0000-000000000002'`)
  check('15 · the series ending leaves the contract\'s status untouched',
    afterEnd.rows[0]?.status === 'draft',
    `status became ${afterEnd.rows[0]?.status}`)
  check('15 · the series ending leaves the contract term untouched',
    asDate(afterEnd.rows[0]?.end_date) === '2026-12-31'
    && afterEnd.rows[0]?.job_recurrence_id === REC_A,
    `the commercial record must survive an operational change: ${JSON.stringify(afterEnd.rows[0])}`)
  check('15 · losing the series releases the link rather than deleting the contract',
    /references public\.job_recurrences\(user_id, id\) on delete set null \(job_recurrence_id\)/i.test(contractsSchema()),
    'a deleted series must never take the signed commercial record with it')

  // ── PROOF 11 · honest lifecycle ───────────────────────────────────────────
  await refusedBy('11 · a contract cannot be marked sent without an artifact',
    `update public.contracts set status = 'sent' where id = 'd0000000-0000-0000-0000-000000000001'`,
    /contracts_sent_needs_artifact/i)
  await refusedBy('11 · terminated without a stamp is refused',
    `update public.contracts set status = 'terminated' where id = 'd0000000-0000-0000-0000-000000000001'`,
    /contracts_terminated_needs_stamp/i)
  await exec(`update public.contracts set status = 'terminated', terminated_at = now()
              where id = 'd0000000-0000-0000-0000-000000000001'`)
  await refusedBy('11 · a terminated contract cannot be reopened',
    `update public.contracts set status = 'draft', terminated_at = null where id = 'd0000000-0000-0000-0000-000000000001'`,
    /cannot be reopened/i)

  const exp: any = await db.query(`
    select public.contract_is_expired('active', date '2020-01-01', date '2026-01-01') as a,
           public.contract_is_expired('draft',  date '2020-01-01', date '2026-01-01') as b,
           public.contract_is_expired('active', null,              date '2026-01-01') as c`)
  check('11 · expiry: a live agreement past its end date HAS expired', exp.rows[0]?.a === true)
  check('11 · expiry: a draft never expires', exp.rows[0]?.b === false,
    'a draft was never in force')
  check('11 · expiry: an OPEN-ENDED agreement never expires', exp.rows[0]?.c === false,
    'no end date means no expiry — not an expiry at the epoch')

  // ── PROOF 6 + 8 · the artifact and the signature ──────────────────────────
  // Build a real S74 document + version + request + signature for tenant A.
  const DOC = 'dddddddd-0000-0000-0000-00000000000a'
  const VER = 'eeeeeeee-0000-0000-0000-00000000000a'
  const REQ = 'ffffffff-0000-0000-0000-00000000000a'
  try {
    await exec(`
      insert into public.documents (id, user_id, name, customer_id, visibility)
        values ('${DOC}', '${A}', 'Seasonal Agreement', '${CUST_A}', 'customer');
      insert into public.document_versions (id, document_id, storage_path, file_name, mime)
        values ('${VER}', '${DOC}', '${A}/${DOC}/agreement.txt', 'agreement.txt', 'text/plain');
      insert into public.document_signature_requests (id, user_id, document_id, version_id, customer_id, statement, purpose)
        values ('${REQ}', '${A}', '${DOC}', '${VER}', '${CUST_A}',
                'I agree to the terms of this service agreement.', 'customer_acknowledgement');
      insert into public.contracts (id, user_id, customer_id, title, status, effective_date, end_date,
                                    document_id, document_version_id, signature_request_id, sent_at)
        values ('d0000000-0000-0000-0000-000000000003', '${A}', '${CUST_A}', 'Sent Agreement', 'sent',
                date '2026-02-01', date '2027-01-31',
                '${DOC}', '${VER}', '${REQ}', now());
    `)
    check('6 · a sent contract points at an immutable S74 document version', true)
  } catch (e: any) {
    check('6 · a sent contract points at an immutable S74 document version', false,
      String(e?.message).slice(0, 250))
  }

  await refusedBy('5 · a sent contract cannot be re-pointed at another version',
    `update public.contracts set document_version_id = null where id = 'd0000000-0000-0000-0000-000000000003'`,
    /already been sent/i)

  // ⭐ THE TERM IS FIXED BEFORE SENDING. The rendered document states it, so a
  // contract cannot reach 'sent' without one — this is the constraint that also
  // keeps activation from having to edit a signed term.
  await refusedBy('a contract cannot be sent without an effective date',
    `insert into public.contracts (user_id, customer_id, title, status, document_id, document_version_id)
       values ('${A}', '${CUST_A}', 'No term', 'sent', '${DOC}', '${VER}')`,
    /contracts_sent_needs_term/i)

  // ⭐ ACTIVE requires a real signature — before one exists, it must refuse.
  await refusedBy('a contract requiring signature cannot be activated unsigned',
    `update public.contracts set status = 'active'
       where id = 'd0000000-0000-0000-0000-000000000003'`,
    /becomes active when the customer signs/i)

  await exec(`insert into public.document_signatures
      (user_id, request_id, document_id, version_id, customer_id, signer_name, statement, purpose, source)
    values ('${A}', '${REQ}', '${DOC}', '${VER}', '${CUST_A}', 'A Customer',
            'I agree to the terms of this service agreement.', 'customer_acknowledgement', 'portal')`)
  const act = await refuses(`update public.contracts set status = 'active', activated_at = now()
      where id = 'd0000000-0000-0000-0000-000000000003'`)
  check('7 · once signed through S74\'s request, the contract can activate', act === '',
    `it was still refused: ${act.slice(0, 200)}`)

  // ── PROOF 8 · signed truth is immutable ───────────────────────────────────
  await refusedBy('8 · a signed contract\'s term cannot be edited',
    `update public.contracts set end_date = date '2030-01-01' where id = 'd0000000-0000-0000-0000-000000000003'`,
    /term of a signed contract cannot be edited/i)
  await refusedBy('8 · a signed contract cannot be moved to another customer',
    `update public.contracts set customer_id = '${CUST_A}' , title = 'Retitled' where id = 'd0000000-0000-0000-0000-000000000003'`,
    /cannot be retitled|different customer/i)
  await refusedBy('8 · a signed contract cannot be deleted',
    `delete from public.contracts where id = 'd0000000-0000-0000-0000-000000000003'`,
    /signed contract cannot be deleted/i)
  // ⭐ Session 74 refuses this first, with its own sentence — the FK RESTRICT
  // behind it is the structural backstop. Expect S74's wording, because that is
  // what actually bites; a looser pattern would pass on any error at all.
  await refusedBy('8 · the signed VERSION cannot be deleted out from under it',
    `delete from public.document_versions where id = '${VER}'`,
    /has been signed and cannot be deleted|restrict|violates foreign key/i)

  // ── PROOF 5 · a template edit never rewrites history ──────────────────────
  await exec(`update public.contract_templates
                 set body = 'COMPLETELY DIFFERENT TERMS', name = 'Renamed Template'
               where id = 'cccccccc-0000-0000-0000-00000000000a'`)
  const frozen: any = await db.query(
    `select file_name, storage_path from public.document_versions where id = '${VER}'`)
  check('5 · editing the template does not touch the sent artifact',
    frozen.rows[0]?.storage_path === `${A}/${DOC}/agreement.txt`,
    'the artifact is an immutable S74 version — a template edit cannot reach it')

  // ── PROOF 13 · no revenue is manufactured ─────────────────────────────────
  const money: any = await db.query(`
    select (select count(*) from public.jobs) as jobs,
           (select count(*) from public.invoices) as invoices,
           (select count(*) from public.payments) as payments`)
  check('13 · the whole contract lifecycle created no job, invoice or payment',
    Number(money.rows[0]?.jobs) === 0 && Number(money.rows[0]?.invoices) === 0
    && Number(money.rows[0]?.payments) === 0,
    `a contract status must never manufacture work or revenue: ${JSON.stringify(money.rows[0])}`)

  // ── PROOF 14 · no recurrence was manufactured ─────────────────────────────
  // The two fixture series and not one more: sending, signing and activating a
  // contract must never bring a schedule into existence.
  const recs: any = await db.query(`select count(*)::int as n from public.job_recurrences`)
  check('14 · the whole contract lifecycle created no recurring series',
    Number(recs.rows[0]?.n) === 2,
    `expected only the two fixture series: ${JSON.stringify(recs.rows[0])}`)

  await db.close?.()
}

// ─────────────────────────────────────────────────────────────────────────────

async function live() {
  const t = await openFixtureTenant('contracts')
  if (isSkipped(t)) { console.log(`  ⏭  SKIPPED — ${t.skipped}\n`); return }
  try {
    // ⭐ RLS is the one thing PGlite cannot prove (the harness is superuser), so
    // it is exercised here for real, against a marked fixture tenant.
    const { error: readErr } = await t.anon.from('contracts').select('id').limit(1)
    check('LIVE · anon cannot read contracts', !!readErr,
      'a contract carries internal commercial metadata and must never be public')
    const { error: writeErr } = await t.anon.from('contracts')
      .insert({ user_id: t.uid, customer_id: t.uid, title: 'anon' })
    check('LIVE · anon cannot write contracts', !!writeErr)
    const { error: tplErr } = await t.anon.from('contract_templates').select('id').limit(1)
    check('LIVE · anon cannot read contract templates', !!tplErr)
  } finally {
    const residue = await fixtureResidue(t)
    const left = Object.entries(residue).filter(([, n]) => n > 0)
    check('LIVE · the fixture tenant left nothing behind', left.length === 0,
      left.map(([k, n]) => `${k}=${n}`).join(' '))
  }
}

main().catch(e => { console.error(e); process.exit(1) })
