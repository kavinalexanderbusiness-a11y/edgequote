// ── Verify: removing a property never removes history ────────────────────────
//   npm run verify:property-remove
//
// WHY THIS SCRIPT EXISTS
// The live schema does NOT protect history from a property delete: every
// history FK is ON DELETE SET NULL (jobs, quotes, invoices, schedule_items,
// measurements, labor_observations, marketing_assets, neighbor_leads) — a
// delete strips the address identity off records the portal and reporting
// resolve BY property_id — and job_photos is ON DELETE CASCADE, so a delete
// destroys the photo rows outright. The only guard is the app rule in
// lib/customers (propertyLinks → deleteProperty): a property may go ONLY when
// nothing refers to it. tsc cannot see any of this; these contracts can.
//
// ⚠️ "0 jobs" is NOT proof a property is safe to delete — the checklist must
// cover photos, measurements, quotes, invoices, schedule items, labour records,
// marketing assets and neighbour leads too. That completeness is pinned here.

import { PROPERTY_LINK_CHECKS, describePropertyLinks, type PropertyLink } from '../src/lib/customers'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
const ok = (name: string) => console.log(`  ✓ ${name}`)
const fail = (name: string, detail?: string) => { failures++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`) }
const check = (name: string, cond: boolean, detail?: string) => (cond ? ok(name) : fail(name, detail))

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

// ── 1. The checklist is COMPLETE ─────────────────────────────────────────────
// One entry per table that references properties with history semantics, per
// the live FK audit of 2026-08-09. If a table is missing here, an owner can
// delete a property that still holds that table's records.
console.log('\nThe link checklist covers every history reference')
const REQUIRED: [string, string][] = [
  ['jobs', 'property_id'],
  ['quotes', 'property_id'],
  ['invoices', 'property_id'],            // financial — must never be orphaned
  ['schedule_items', 'property_id'],
  ['job_photos', 'property_id'],          // ON DELETE CASCADE — would be DESTROYED
  ['measurements', 'property_id'],
  ['labor_observations', 'property_id'],
  ['marketing_assets', 'property_id'],
  ['neighbor_leads', 'source_property_id'],
]
for (const [table, column] of REQUIRED) {
  check(`checks ${table}.${column}`,
    PROPERTY_LINK_CHECKS.some(c => c.table === table && c.column === column),
    'a property holding these records would be deletable')
}
check('the checklist is not jobs-only (0 jobs proves nothing)', PROPERTY_LINK_CHECKS.length >= REQUIRED.length)

// ── 2. The blocked explanation is honest and specific ────────────────────────
console.log('\nThe blocked message names what it found')
const L = (noun: string, plural: string, count: number): PropertyLink => ({ noun, plural, count })
check('photos alone block, and are named',
  describePropertyLinks([L('photo', 'photos', 2)]).includes('2 photos'))
check('a single record is singular', describePropertyLinks([L('invoice', 'invoices', 1)]).includes('1 invoice'))
check('several kinds are all named',
  (() => { const m = describePropertyLinks([L('visit', 'visits', 3), L('invoice', 'invoices', 1), L('photo', 'photos', 2)]); return m.includes('3 visits') && m.includes('1 invoice') && m.includes('2 photos') && m.includes(' and ') })())
check('zero links yields no message (nothing to explain)', describePropertyLinks([]) === '')
check('the message says WHY (history stays attached)', describePropertyLinks([L('visit', 'visits', 1)]).toLowerCase().includes('history'))

// ── 3. Structural contracts over the engine ─────────────────────────────────
console.log('\nThe engine refuses to guess')
const LIB = read('src/lib/customers.ts')
const linksFn = LIB.slice(LIB.indexOf('export async function propertyLinks'), LIB.indexOf('export function describePropertyLinks'))
check('a failed count is an ERROR, never a zero',
  /if\s*\(error\)\s*return\s*\{\s*links:\s*\[\],\s*error:/.test(linksFn),
  'treating "couldn\'t ask" as "nothing there" would greenlight deleting a property whose records we failed to see')
const delFn = LIB.slice(LIB.indexOf('export async function deleteProperty'))
check('deleteProperty re-checks the links itself (defence in depth)', /propertyLinks\(supabase,\s*p\.propertyId\)/.test(delFn))
check('the delete is scoped to the customer as well as the id',
  /\.delete\(\)\.eq\('id',\s*p\.propertyId\)\.eq\('customer_id',\s*p\.customerId\)/.test(delFn),
  'a stale or crafted id could reach another customer\'s property')
check('the delete PROVES a row was removed (.select + zero-row failure)',
  /\.select\('id'\)/.test(delFn) && /gone\.length === 0\)\s*return\s*\{\s*error:/.test(delFn),
  'zero rows back must be reported, never claimed as success')
check('a failed primary promotion is reported, never silent', /promoteError:\s*(restErr|promErr)\.message/.test(delFn))

// ── 4. Structural contracts over the page ────────────────────────────────────
console.log('\nThe UI never pretends')
const PAGE = read('src/app/dashboard/customers/[id]/page.tsx')
const handler = PAGE.slice(PAGE.indexOf('async function removeProperty'), PAGE.indexOf('async function pauseSchedule'))
check('the page removes the row from state only AFTER the awaited delete', (() => {
  const del = handler.indexOf('await deleteProperty')
  const errReturn = handler.indexOf('res.error')
  const drop = handler.indexOf('.filter(x => x.id !== p.id)')
  return del >= 0 && errReturn > del && drop > errReturn
})(), 'optimistic removal would show success over a failed write')
check('a failed link-check refuses to open the confirm', (() => {
  const err = handler.indexOf('Could not check')
  const confirm = handler.indexOf('confirmDialog')
  return err >= 0 && confirm > err
})())
check('the confirm names the property', /confirmDialog\(\{\s*title:\s*`Remove \$\{propertyLabel\(p\)\}/.test(handler))
check('the confirm is marked destructive', /destructive:\s*true/.test(handler))
check('blocked reasons render inline on the card', /blockedProp\?\.id === p\.id/.test(PAGE))

console.log(failures === 0
  ? '\n✅ property-remove: an address with records stays; an address with none may leave.\n'
  : `\n❌ property-remove: ${failures} contract${failures === 1 ? '' : 's'} broken.\n`)
process.exit(failures === 0 ? 0 : 1)
