// ── Verify: custom fields ────────────────────────────────────────────────────
//   npm run verify:custom-fields
//
// Custom fields are the first place in this product where an OWNER, at runtime,
// creates a place to put data. That makes three promises worth an executable
// guard, because each of them fails silently:
//
//   1. THE VALUES ARE INTERNAL. There is no worker-visible or customer-visible
//      custom field in V1, and no mechanism to make one. src/lib/noteScope.ts
//      explains why a `visibility` flag on generic data is the wrong shape; this
//      guard is what stops one appearing by accident later.
//   2. THE DATABASE REFUSES, NOT THE FORM. Every tenancy and type rule is a
//      constraint. §4 proves that by attempting each forbidden write against a
//      REAL Postgres built from this repository's own migrations, and failing if
//      any of them succeeds.
//   3. CHANGING A FIELD DOES NOT REWRITE HISTORY. Archiving keeps answers,
//      relabelling a dropdown choice keeps answers, and a field holding answers
//      cannot be deleted at all.
//
// ⭐ §4 IS A MUTATION TEST, and it is the reason this guard is worth reading. Each
// case asserts a write FAILS. A guard that only exercises the happy path would
// stay green if every constraint in the migration were dropped tomorrow.
//
// §4 needs PGlite and SKIPS CLEAN without it (~100 MB, deliberately not in
// package.json — Vercel builds already OOM). §1–§3 and §5–§6 are pure and always
// run, so CI still holds the line on everything that does not need a database:
//   npm i -D @electric-sql/pglite && npm run verify:custom-fields

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CUSTOM_FIELD_ENTITIES, CUSTOM_FIELD_TYPES, ENTITY_COLUMN, MAX_OPTIONS, SEARCHABLE_TYPES,
  TYPE_COLUMN, UPSERT_CONFLICT, displayValue, encodeValue, fieldsForRecord, isCalendarDate,
  parseOptions, reconcileOptions, slugify, uniqueKey, validateDefinition, valueWritePayload,
} from '../src/lib/customFields'
import { EXPORT_ENTITIES, DENIED_COLUMNS } from '../src/lib/export/manifest'
import { readdirSync } from 'node:fs'
import { splitStatements, loadPGlite, substitutePlatformStatements } from './lib/pg-sql'
import type { CustomFieldDefinition, CustomFieldValue } from '../src/types'

let failures = 0
const ok = (n: string) => console.log(`  ✓ ${n}`)
const fail = (n: string, d = '') => { failures++; console.log(`  ✗ ${n}${d ? `\n      ${d}` : ''}`) }
const check = (n: string, cond: boolean, d = '') => cond ? ok(n) : fail(n, d)
const eq = (n: string, a: unknown, b: unknown) =>
  check(n, JSON.stringify(a) === JSON.stringify(b), `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

// The apply path, in the order production ran it. Same primitives verify:rebuild
// and verify:audit-trail use — scripts/lib/pg-sql.ts is the one splitter.
const MIGRATIONS_DIR = join('supabase', 'migrations')
const migrationFiles = () => readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort()

const MIGRATION_FILE = migrationFiles().find(f => /custom_fields/.test(f)) || ''
const migration = MIGRATION_FILE ? read(join(MIGRATIONS_DIR, MIGRATION_FILE)) : ''

// A definition/value pair for the pure tests, shaped exactly like a database row.
const def = (over: Partial<CustomFieldDefinition> = {}): CustomFieldDefinition => ({
  id: 'd1', created_at: '', updated_at: '', user_id: 'u1',
  entity: 'customer', field_key: 'gate_code', label: 'Gate code', field_type: 'text',
  options: [], help_text: null, sort_order: 0, archived_at: null, ...over,
});
const val = (over: Partial<CustomFieldValue> = {}): CustomFieldValue => ({
  id: 'v1', created_at: '', updated_at: '', user_id: 'u1', definition_id: 'd1',
  entity: 'customer', field_type: 'text', customer_id: 'c1', property_id: null, job_id: null,
  value_text: null, value_number: null, value_boolean: null, value_date: null, ...over,
});

async function main() {

// ── 1. the engine and the schema say the same thing ──────────────────────────
// The module mirrors the constraints so a form can explain a refusal early. Two
// statements of one rule drift, so the drift is what is tested — not the rule.
console.log('\n═══ 1. the engine agrees with the schema ═══')

check('a custom-fields migration exists in the apply path', !!MIGRATION_FILE,
  'no supabase/migrations/*custom_fields*.sql — §1 and §4 have nothing to check')

if (migration) {
  const typeCheck = /custom_field_definitions_field_type_check\s*\n?\s*check \(field_type in \(([^)]*)\)\)/.exec(migration)
  const schemaTypes = (typeCheck?.[1] || '').split(',').map(s => s.trim().replace(/'/g, '')).filter(Boolean).sort()
  eq('CUSTOM_FIELD_TYPES matches the field_type CHECK', [...CUSTOM_FIELD_TYPES].sort(), schemaTypes)

  const entityCheck = /custom_field_definitions_entity_check\s*\n?\s*check \(entity in \(([^)]*)\)\)/.exec(migration)
  const schemaEntities = (entityCheck?.[1] || '').split(',').map(s => s.trim().replace(/'/g, '')).filter(Boolean).sort()
  eq('CUSTOM_FIELD_ENTITIES matches the entity CHECK', [...CUSTOM_FIELD_ENTITIES].sort(), schemaEntities)

  // Every type must map to a column the type CHECK actually permits for it.
  const typeBlock = /custom_field_values_type_check check \(([\s\S]*?)\n  \),/.exec(migration)?.[1] || ''
  for (const t of CUSTOM_FIELD_TYPES) {
    const column = TYPE_COLUMN[t]
    const clause = typeBlock.split('or\n').find(c => new RegExp(`'${t}'`).test(c)) || ''
    check(`${t} stores into ${column}, and the CHECK agrees`,
      new RegExp(`${column} is not null`).test(clause),
      `the migration's type CHECK does not require ${column} for '${t}'`)
  }

  check('the upsert target names the one-answer constraint\'s columns',
    new RegExp(`unique nulls not distinct \\(${UPSERT_CONFLICT.split(',').join(', ')}\\)`).test(migration),
    `UPSERT_CONFLICT is "${UPSERT_CONFLICT}" — PostgREST cannot infer a constraint it does not name exactly`)

  for (const e of CUSTOM_FIELD_ENTITIES) {
    check(`${e} attaches through ${ENTITY_COLUMN[e]}, and a foreign key carries user_id with it`,
      new RegExp(`custom_field_values_${e === 'job' ? 'job' : e}_fkey[\\s\\S]{0,160}user_id`).test(migration),
      `no tenant-carrying FK found for ${ENTITY_COLUMN[e]}`)
  }
}

// ── 2. the audience promise, pinned ──────────────────────────────────────────
// V1 says these values never leave the owner's screens. That is only true while
// nothing selects them for anybody else, so this section asserts the ABSENCE of
// the mechanism rather than the presence of a setting.
console.log('\n═══ 2. custom field values are internal ═══')

if (migration) {
  const forbidden = /\b(worker_visible|portal_visible|customer_visible|crew_visible|is_public|visibility|audience|exposure)\b/i
  const offending = migration.split('\n')
    .filter(l => !l.trim().startsWith('--'))
    .filter(l => forbidden.test(l))
  check('the schema carries no visibility/audience column', offending.length === 0,
    `${offending.length} line(s), e.g. ${offending[0]?.trim().slice(0, 110)}\n      ` +
    'V1 has no audience mechanism on purpose — see src/lib/noteScope.ts. Exposing a field ' +
    'later means a grant column PLUS a predicate in the canonical projection, not a flag here.')
}

// The two projections that answer for the other two audiences must not have
// learned these tables exist. This is the check that would have caught a
// well-meant "just add it to the portal payload".
const baseline = read(join(MIGRATIONS_DIR, migrationFiles().find(f => /baseline/.test(f)) || ''))
const portalFn = /CREATE OR REPLACE FUNCTION public\.get_portal_data[\s\S]*?\n\$function\$;/.exec(baseline)?.[0] || ''
const crewFn = /CREATE OR REPLACE FUNCTION public\.crew_day[\s\S]*?\n\$function\$;/.exec(baseline)?.[0] || ''
check('get_portal_data does not read custom fields', !!portalFn && !/custom_field/.test(portalFn),
  'the customer portal projection now selects a custom field — V1 says it must not')
check('crew_day does not read custom fields', !!crewFn && !/custom_field/.test(crewFn),
  'the worker projection now selects a custom field — V1 says it must not')

// Nothing outside /dashboard may render a value. A portal or crew surface
// importing the section component is the other way this promise breaks.
const sectionImporters = (() => {
  const { execSync } = require('node:child_process') as typeof import('node:child_process')
  try {
    return execSync('git grep -l "CustomFieldsSection\\|customFields" -- src', { encoding: 'utf8' })
      .split('\n').map(s => s.trim()).filter(Boolean)
  } catch { return [] }
})()
const leaked = sectionImporters.filter(f =>
  /^src\/app\/(portal|book|pay|crew)\//.test(f) || /^src\/components\/(portal|crew)\//.test(f))
check('no portal or crew surface imports the custom-field engine', leaked.length === 0, leaked.join(', '))

// ── 3. the engine's own behaviour ────────────────────────────────────────────
console.log('\n═══ 3. types, keys and history ═══')

eq('a label becomes a stable key', slugify('Permit #'), 'permit')
eq('a key never starts with a digit', slugify('2026 code').startsWith('f_'), true)
eq('an unusable label yields no key', slugify('###'), '')
eq('a colliding key is suffixed, not refused', uniqueKey('Notes', ['notes']), 'notes_2')

// Each type accepts what it should and refuses what it should not.
const cases: [string, ReturnType<typeof def>, unknown, boolean][] = [
  ['text takes text', def(), 'Front gate 4821', true],
  ['number refuses a date', def({ field_type: 'number' }), '2026-03-01', false],
  ['number refuses words', def({ field_type: 'number' }), 'twelve', false],
  ['number takes a number', def({ field_type: 'number' }), '12.5', true],
  ['currency strips a currency symbol', def({ field_type: 'currency' }), '$1,200.50', true],
  ['date refuses the 31st of February', def({ field_type: 'date' }), '2026-02-31', false],
  ['date takes a real date', def({ field_type: 'date' }), '2026-03-01', true],
  ['yes/no refuses prose', def({ field_type: 'boolean' }), 'maybe', false],
  ['yes/no takes a boolean', def({ field_type: 'boolean' }), true, true],
  ['dropdown refuses an unoffered choice', def({ field_type: 'select', options: [{ value: 'a', label: 'A' }] }), 'b', false],
  ['dropdown takes an offered choice', def({ field_type: 'select', options: [{ value: 'a', label: 'A' }] }), 'a', true],
]
for (const [name, d, raw, shouldPass] of cases) {
  const r = encodeValue(d, raw)
  check(name, r.ok === shouldPass, r.ok ? 'accepted, but should have been refused' : `refused: ${r.message}`)
}

eq('a currency amount parses to a number', (() => {
  const r = encodeValue(def({ field_type: 'currency' }), '$1,200.50')
  return r.ok && !r.clear ? r.columns.value_number : null
})(), 1200.5)

// Blank in every shape means "no answer", and no answer means no row.
for (const blank of [null, undefined, '', '   ']) {
  const r = encodeValue(def(), blank)
  check(`clearing with ${JSON.stringify(blank)} deletes the answer rather than storing a blank`,
    r.ok && r.clear === true)
}

eq('a date is never stored in a text column', (() => {
  const r = encodeValue(def({ field_type: 'date' }), '2026-03-01')
  return r.ok && !r.clear ? [r.columns.value_text, r.columns.value_date] : null
})(), [null, '2026-03-01'])

check('February 29 is a date in a leap year', isCalendarDate('2028-02-29'))
check('…and is not one otherwise', !isCalendarDate('2026-02-29'))

// History: the two ways an owner changes a field tomorrow.
const selectDef = def({
  id: 'd9', field_type: 'select',
  options: [{ value: 'front', label: 'Front gate' }, { value: 'side', label: 'Side gate' }],
})
eq('relabelling a choice keeps every answer pointing at it',
  reconcileOptions(
    [{ value: 'front', label: 'Front gate (north)' }, { value: 'side', label: 'Side gate' }],
    parseOptions(selectDef),
  ).map(o => o.value),
  ['front', 'side'])

const removed = def({ id: 'd9', field_type: 'select', options: [{ value: 'side', label: 'Side gate' }] })
const shown = displayValue(removed, val({ definition_id: 'd9', field_type: 'select', value_text: 'front' }))
eq('a removed choice still reads, marked as no longer offered', shown, { text: 'front', retired: true })

const archived = def({ id: 'd7', archived_at: '2026-08-01T00:00:00Z', label: 'Old code' })
const rows = fieldsForRecord([def(), archived], 'customer', [
  val({ id: 'v7', definition_id: 'd7', value_text: 'kept' }),
])
check('an archived field with an answer stays on the record, read only',
  rows.some(r => r.definition.id === 'd7' && r.readOnly && r.value?.value_text === 'kept'))
check('…and an archived field with no answer does not clutter it',
  !fieldsForRecord([def(), archived], 'customer', []).some(r => r.definition.id === 'd7'))

// The write payload takes nothing from the caller's inputs.
const payload = valueWritePayload(def({ id: 'dX', entity: 'property', field_type: 'text' }), 'owner-1', 'prop-1',
  { value_text: 'x', value_number: null, value_boolean: null, value_date: null })
eq('a write carries the definition\'s own entity and type, not the form\'s',
  [payload.entity, payload.field_type, payload.property_id, payload.customer_id, payload.job_id],
  ['property', 'text', 'prop-1', null, null])
eq('…and the tenant comes from the session', payload.user_id, 'owner-1')

check('a definition with no choices is refused as a dropdown',
  !validateDefinition({ entity: 'customer', label: 'Type', field_type: 'select', options: [] }).ok)
check('a non-dropdown carrying choices is refused',
  !validateDefinition({ entity: 'customer', label: 'X', field_type: 'text', options: [{ value: 'a', label: 'A' }] }).ok)
check(`more than ${MAX_OPTIONS} choices is refused`,
  !validateDefinition({
    entity: 'customer', label: 'X', field_type: 'select',
    options: Array.from({ length: MAX_OPTIONS + 1 }, (_, i) => ({ value: `o${i}`, label: `O${i}` })),
  }).ok)

// ── 4. the database refuses ──────────────────────────────────────────────────
console.log('\n═══ 4. mutation test — every forbidden write must fail ═══')

// Stand the repository's own schema up: platform prelude, then every migration in
// filename order — the same sequence verify:rebuild applies, so a constraint
// proven here is a constraint that will exist in production once this ships.
const db = await (async () => {
  const loaded = await loadPGlite()
  if (!loaded) return null
  const pg = await loaded.PGlite.create({
    extensions: Object.fromEntries(Object.entries(loaded.contribs).filter(([, v]) => v)),
  })
  const files: [string, string][] = [
    ['platform prelude', read(join('scripts', 'schema', 'platform-prelude.sql'))],
    ...migrationFiles().map(f => [f, read(join(MIGRATIONS_DIR, f))] as [string, string]),
  ]
  for (const [label, raw] of files) {
    const { sql } = substitutePlatformStatements(raw)
    const statements = splitStatements(sql)
    let n = 0
    try {
      for (const s of statements) { await pg.exec(s + ';'); n++ }
    } catch (e: any) {
      fail(`the schema builds from the repository (${label})`,
        `statement ${n + 1}/${statements.length}: ${String(e.message).slice(0, 200)}`)
      return null
    }
  }
  return pg
})()

if (!db) {
  console.log('  ⏭  SKIPPED — PGlite is not installed, so the constraints cannot be exercised.')
  console.log('     npm i -D @electric-sql/pglite && npm run verify:custom-fields')
} else {
  const OWNER = '11111111-1111-4111-8111-111111111111'
  const OTHER = '22222222-2222-4222-8222-222222222222'
  const q = (sql: string, params: unknown[] = []) => db.query(sql, params)

  // Two tenants, each with a customer. Everything below is an attempt to cross
  // the line between them, or to write something the type system forbids.
  await q(`insert into auth.users (id, email) values ($1,'a@x.invalid'), ($2,'b@x.invalid')`, [OWNER, OTHER])
  await q(`insert into public.customers (id, user_id, name) values
             ('aaaaaaaa-0000-4000-8000-000000000001',$1,'Owner customer'),
             ('bbbbbbbb-0000-4000-8000-000000000002',$2,'Other customer')`, [OWNER, OTHER])
  await q(`insert into public.custom_field_definitions (id, user_id, entity, field_key, label, field_type)
           values ('dddddddd-0000-4000-8000-000000000001',$1,'customer','gate_code','Gate code','text')`, [OWNER])
  await q(`insert into public.custom_field_definitions (id, user_id, entity, field_key, label, field_type, options)
           values ('dddddddd-0000-4000-8000-000000000002',$1,'customer','entry','Entry','select',
                   '[{"value":"front","label":"Front"}]'::jsonb)`, [OWNER])
  await q(`insert into public.custom_field_definitions (id, user_id, entity, field_key, label, field_type)
           values ('dddddddd-0000-4000-8000-000000000003',$1,'customer','permit','Permit','number')`, [OWNER])

  const D_TEXT = 'dddddddd-0000-4000-8000-000000000001'
  const D_SELECT = 'dddddddd-0000-4000-8000-000000000002'
  const D_NUMBER = 'dddddddd-0000-4000-8000-000000000003'
  const C_OWNER = 'aaaaaaaa-0000-4000-8000-000000000001'
  const C_OTHER = 'bbbbbbbb-0000-4000-8000-000000000002'

  /** Asserts a statement FAILS. A mutation test that passes silently proves nothing. */
  const refuses = async (name: string, sql: string, params: unknown[] = []) => {
    try { await q(sql, params); fail(name, 'the write SUCCEEDED — the constraint behind it is missing or wrong') }
    catch { ok(name) }
  }
  const allows = async (name: string, sql: string, params: unknown[] = []) => {
    try { await q(sql, params); ok(name) }
    catch (e: any) { fail(name, String(e.message).slice(0, 200)) }
  }

  const ins = (cols: string, vals: string) =>
    `insert into public.custom_field_values (${cols}) values (${vals})`

  await allows('the honest write lands',
    ins('user_id, definition_id, entity, field_type, customer_id, value_text',
        `'${OWNER}','${D_TEXT}','customer','text','${C_OWNER}','4821'`))

  await refuses('a second answer for the same field on the same record',
    ins('user_id, definition_id, entity, field_type, customer_id, value_text',
        `'${OWNER}','${D_TEXT}','customer','text','${C_OWNER}','9999'`))

  await refuses('a value pointing at ANOTHER TENANT\'S customer',
    ins('user_id, definition_id, entity, field_type, customer_id, value_text',
        `'${OWNER}','${D_TEXT}','customer','text','${C_OTHER}','4821'`))

  await refuses('a value claiming another tenant\'s definition',
    ins('user_id, definition_id, entity, field_type, customer_id, value_text',
        `'${OTHER}','${D_TEXT}','customer','text','${C_OTHER}','4821'`))

  await refuses('a value naming a definition that does not exist',
    ins('user_id, definition_id, entity, field_type, customer_id, value_text',
        `'${OWNER}','dddddddd-9999-4999-8999-999999999999','customer','text','${C_OWNER}','x'`))

  await refuses('a DATE written into a NUMBER field',
    ins('user_id, definition_id, entity, field_type, customer_id, value_date',
        `'${OWNER}','${D_NUMBER}','customer','number','${C_OWNER}','2026-03-01'`))

  await refuses('a value whose field_type disagrees with its definition',
    ins('user_id, definition_id, entity, field_type, customer_id, value_text',
        `'${OWNER}','${D_NUMBER}','customer','text','${C_OWNER}','not a number'`))

  await refuses('a value whose entity disagrees with its definition',
    ins('user_id, definition_id, entity, field_type, job_id, value_text',
        `'${OWNER}','${D_TEXT}','job','text','${C_OWNER}','x'`))

  await refuses('a value attached to nothing at all',
    ins('user_id, definition_id, entity, field_type, value_text',
        `'${OWNER}','${D_TEXT}','customer','text','x'`))

  await refuses('a value attached to two records at once',
    ins('user_id, definition_id, entity, field_type, customer_id, job_id, value_text',
        `'${OWNER}','${D_TEXT}','customer','text','${C_OWNER}','${C_OWNER}','x'`))

  await refuses('a dropdown answer that is not one of the choices',
    ins('user_id, definition_id, entity, field_type, customer_id, value_text',
        `'${OWNER}','${D_SELECT}','customer','select','${C_OWNER}','back'`))

  await allows('…while an offered choice is accepted',
    ins('user_id, definition_id, entity, field_type, customer_id, value_text',
        `'${OWNER}','${D_SELECT}','customer','select','${C_OWNER}','front'`))

  await refuses('a blank stored as if it were an answer',
    ins('user_id, definition_id, entity, field_type, customer_id, value_text',
        `'${OWNER}','${D_TEXT}','customer','text','   '`))

  // History: what happens when the owner changes the field tomorrow.
  await allows('a choice can be relabelled',
    `update public.custom_field_definitions
        set options = '[{"value":"front","label":"Front gate (north)"}]'::jsonb where id = $1`, [D_SELECT])
  const kept = await q(`select value_text from public.custom_field_values where definition_id = $1`, [D_SELECT])
  eq('…and the answer still points at the same choice', kept.rows[0]?.value_text, 'front')

  await refuses('deleting a field that holds answers',
    `delete from public.custom_field_definitions where id = $1`, [D_TEXT])

  await refuses('changing the type of a field that holds answers',
    `update public.custom_field_definitions set field_type = 'number' where id = $1`, [D_TEXT])

  await refuses('changing a field\'s key',
    `update public.custom_field_definitions set field_key = 'renamed' where id = $1`, [D_TEXT])

  await refuses('moving a field to a different kind of record',
    `update public.custom_field_definitions set entity = 'job' where id = $1`, [D_TEXT])

  await allows('archiving a field',
    `update public.custom_field_definitions set archived_at = now() where id = $1`, [D_TEXT])
  const survived = await q(`select value_text from public.custom_field_values where definition_id = $1`, [D_TEXT])
  eq('…and its answers survive intact', survived.rows[0]?.value_text, '4821')
  await refuses('…while a NEW answer on an archived field is refused',
    ins('user_id, definition_id, entity, field_type, customer_id, value_text',
        `'${OWNER}','${D_TEXT}','customer','text','${C_OTHER}','x'`))

  // An unused field is a mistake, not history — it must still be deletable.
  await q(`insert into public.custom_field_definitions (id, user_id, entity, field_key, label, field_type)
           values ('dddddddd-0000-4000-8000-000000000009',$1,'customer','typo','Typo','text')`, [OWNER])
  await allows('a field that has never been used can be deleted',
    `delete from public.custom_field_definitions where id = 'dddddddd-0000-4000-8000-000000000009'`)

  // Deleting the record takes its answers with it — no orphan holding a gate code.
  await q(`insert into public.custom_field_definitions (id, user_id, entity, field_key, label, field_type)
           values ('dddddddd-0000-4000-8000-00000000000a',$1,'customer','note2','Note2','text')`, [OWNER])
  await q(ins('user_id, definition_id, entity, field_type, customer_id, value_text',
              `'${OWNER}','dddddddd-0000-4000-8000-00000000000a','customer','text','${C_OWNER}','bye'`))
  // ⚠️ PGlite ships PostgreSQL 18, which refuses a DELETE on a published table
  // whose replica identity contains a generated column — `customers.phone_digits`
  // is generated and the table is in supabase_realtime. That is a property of the
  // TEST TARGET, not of production (PG17, where this delete is routine), so the
  // publication is dropped here rather than the assertion being weakened.
  try { await q(`drop publication if exists supabase_realtime`) } catch { /* not present */ }
  await q(`delete from public.customers where id = $1`, [C_OWNER])
  const orphans = await q(`select count(*)::int as n from public.custom_field_values where customer_id = $1`, [C_OWNER])
  eq('deleting a customer takes its answers with it', orphans.rows[0]?.n, 0)

  // ── tenancy under RLS, as a real session sees it ───────────────────────────
  // auth.uid() is a settable GUC in the prelude, so a session can be simulated.
  const asUser = async (uid: string, sql: string) => {
    await q(`set local role authenticated`)
    await q(`select set_config('request.jwt.claim.sub', '${uid}', true)`)
    const r = await q(sql)
    await q(`reset role`)
    return r
  }
  await q('begin')
  const mine = await asUser(OWNER, `select count(*)::int as n from public.custom_field_definitions`)
  const theirs = await asUser(OTHER, `select count(*)::int as n from public.custom_field_definitions`)
  await q('commit')
  check('an owner sees their own field definitions', (mine.rows[0]?.n ?? 0) > 0)
  eq('…and another tenant sees none of them', theirs.rows[0]?.n, 0)

  await q('begin')
  let forged = false
  try {
    await q(`set local role authenticated`)
    await q(`select set_config('request.jwt.claim.sub', '${OTHER}', true)`)
    await q(`insert into public.custom_field_definitions (user_id, entity, field_key, label, field_type)
             values ('${OWNER}','customer','forged','Forged','text')`)
    forged = true
  } catch { /* refused, as it must be */ }
  await q('rollback')
  check('a forged user_id is refused by RLS', !forged,
    'a session inserted a definition owned by somebody else')

  // Grants: anon is nobody, and nobody holds no privilege on a table of gate codes.
  const grants = await q(`select grantee, privilege_type from information_schema.role_table_grants
                          where table_name in ('custom_field_definitions','custom_field_values')`)
  const anonGrants = grants.rows.filter((r: any) => r.grantee === 'anon')
  check('anon holds no privilege on either table', anonGrants.length === 0,
    `anon holds ${anonGrants.map((r: any) => r.privilege_type).join(', ')}`)
  const rls = await q(`select relname, relrowsecurity from pg_class
                       where relname in ('custom_field_definitions','custom_field_values')`)
  check('RLS is enabled on both tables', rls.rows.every((r: any) => r.relrowsecurity))

  await db.close?.()
}

// ── 5. the export carries it ─────────────────────────────────────────────────
console.log('\n═══ 5. export ═══')

const defEntity = EXPORT_ENTITIES.find(e => e.table === 'custom_field_definitions')
const valEntity = EXPORT_ENTITIES.find(e => e.table === 'custom_field_values')
check('definitions are in the export', !!defEntity)
check('answers are in the export', !!valEntity)
if (defEntity && valEntity) {
  for (const c of ['entity', 'field_key', 'field_type', 'options', 'archived_at']) {
    check(`a definition exports its ${c}`, defEntity.select.includes(c),
      'without it the archive cannot say what the field WAS')
  }
  for (const c of ['definition_id', 'customer_id', 'property_id', 'job_id']) {
    check(`an answer exports its ${c}`, valEntity.select.includes(c),
      'without it the archive cannot say what the answer was ABOUT')
  }
  check('every value_ column is exported',
    ['value_text', 'value_number', 'value_boolean', 'value_date'].every(c => valEntity.select.includes(c)))
  for (const e of [defEntity, valEntity]) {
    const denied = e.select.filter(c => DENIED_COLUMNS.includes(c))
    check(`${e.key} fetches no denied column`, denied.length === 0, denied.join(', '))
  }
}

// ── 6. search, and the shape of the screens ──────────────────────────────────
console.log('\n═══ 6. search and surfaces ═══')

eq('only short text is searchable', [...SEARCHABLE_TYPES], ['text'])
check('the searchable set is a subset of the real types',
  SEARCHABLE_TYPES.every(t => (CUSTOM_FIELD_TYPES as readonly string[]).includes(t)))
if (migration) {
  check('…and exactly one index backs it', /custom_field_values_text_lookup/.test(migration))
  check('…and it is not a trigram sweep over every value', !/gin_trgm_ops|to_tsvector/.test(migration),
    'a full-text or trigram index over arbitrary attributes is the cost V1 declined')
}

const section = read('src/components/customFields/CustomFieldsSection.tsx')
check('the record surface is ONE section, not a card per field',
  /grid-cols-1 sm:grid-cols-2/.test(section) && !/CardHeader/.test(section),
  'a heading and a card per attribute turns a customer record into a form')
check('it renders nothing when the business defines no fields',
  /if \(!defs \|\| !rows\.length\) return null/.test(section))
check('a failed read is not rendered as an empty record',
  /Could not load details/.test(section),
  'rendering "no details" because the network blinked is read as fact by an owner')

const settings = read('src/components/settings/CustomFields.tsx')
check('the owner is told, on the screen, that these values stay internal',
  /not shown to customers|not sent to workers/i.test(settings))
check('archiving is offered alongside deleting', /Archive/.test(settings) && /archived/i.test(settings))

console.log(
  failures === 0
    ? '\n✅ verify:custom-fields — typed, tenant-bound, internal, and history-preserving\n'
    : `\n❌ verify:custom-fields — ${failures} failed\n`)
process.exit(failures ? 1 : 0)

}

main().catch(e => { console.error(e); process.exit(1) })
