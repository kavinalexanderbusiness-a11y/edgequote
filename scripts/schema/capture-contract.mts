// ── Contract capture — `npm run schema:contract` ─────────────────────────────
//
// Re-reads production's catalogue into supabase/contract/*.json, which is what the
// baseline is generated from and what verify:schema compares against.
//
// This being ONE COMMAND is the whole point. The process it replaces was a hand-run
// sequence of catalogue queries, and the measurable result of that friction was 30
// migrations sitting in production with no file in this repository. A resync that
// is tedious is a resync that does not happen.
//
// ── ACCESS ───────────────────────────────────────────────────────────────────
// Calls public.schema_contract(), which is granted to service_role ONLY — it
// returns every RLS predicate and SECURITY DEFINER body. Needs, in .env.local:
//     SUPABASE_SERVICE_ROLE_KEY=...
// Without it the script stops and says so; it does not fall back to a weaker key
// and silently capture less.
//
// ── ALTERNATIVE INPUT ────────────────────────────────────────────────────────
//     npm run schema:contract -- --from-file <path.json>
// Takes the same payload captured another way (SQL editor, MCP, psql):
//     select public.schema_contract();
// Useful when the service-role key is not on the machine doing the resync.
//
// Read-only against production. Writes only into supabase/contract/.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

for (const line of existsSync('.env.local') ? readFileSync('.env.local', 'utf8').split(/\r?\n/) : []) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2')
}

const OUT = join('supabase', 'contract')
const argv = process.argv.slice(2)
const fromFileIdx = argv.indexOf('--from-file')

async function fetchContract(): Promise<any> {
  if (fromFileIdx !== -1) {
    const path = argv[fromFileIdx + 1]
    if (!path) throw new Error('--from-file needs a path')
    console.log(`  reading contract from ${path}`)
    return JSON.parse(readFileSync(path, 'utf8'))
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.error('\n✗ Cannot capture: SUPABASE_SERVICE_ROLE_KEY (and NEXT_PUBLIC_SUPABASE_URL) must be set.')
    console.error('\n  schema_contract() returns every RLS predicate and SECURITY DEFINER body, so it is')
    console.error('  granted to service_role only — the anon key and an owner login cannot read it,')
    console.error('  and that is deliberate.')
    console.error('\n  Either add the key to .env.local, or capture the payload elsewhere and pass it in:')
    console.error('      select public.schema_contract();     -- SQL editor, as the service role')
    console.error('      npm run schema:contract -- --from-file contract.json\n')
    process.exit(1)
  }

  const call = async (fn: string) => {
    const res = await fetch(`${url}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: '{}',
    })
    if (!res.ok) throw new Error(`${fn} failed: ${res.status} ${await res.text()}`)
    return res.json()
  }
  console.log('  calling public.schema_contract() as service_role…')
  const contract = await call('schema_contract')
  contract.fingerprint = await call('schema_fingerprint')
  return contract
}

console.log('\n══ capture production schema contract ═══════════════════════════════════\n')

const c = await fetchContract()

// A capture that silently lost a section would produce a baseline missing those
// objects, and the rebuild test would still pass — because it compares against the
// same truncated capture. Refuse anything that does not look whole.
const REQUIRED = ['tables', 'constraints', 'indexes', 'policies', 'triggers', 'functions',
  'extension_objects', 'comments', 'misc', 'misc2', 'ledger']
const missing = REQUIRED.filter(k => c[k] == null)
if (missing.length) {
  console.error(`✗ capture is incomplete — missing: ${missing.join(', ')}`)
  console.error('  Refusing to overwrite supabase/contract/ with a partial snapshot.\n')
  process.exit(1)
}
if (!Array.isArray(c.tables) || c.tables.length < 50) {
  console.error(`✗ capture returned ${Array.isArray(c.tables) ? c.tables.length : 'no'} tables — implausible for this schema.`)
  console.error('  Refusing to overwrite supabase/contract/.\n')
  process.exit(1)
}

mkdirSync(OUT, { recursive: true })
const write = (name: string, value: unknown) => {
  writeFileSync(join(OUT, name), JSON.stringify(value, null, 1) + '\n')
  const n = Array.isArray(value) ? `${value.length} rows` : 'object'
  console.log(`  ✓ ${name.padEnd(24)} ${n}`)
}

write('tables.json', c.tables)
write('constraints.json', c.constraints)
write('indexes.json', c.indexes)
write('policies.json', c.policies)
write('triggers.json', c.triggers)
write('functions.json', c.functions)
write('extension-objects.json', c.extension_objects)
write('comments.json', c.comments)
write('misc.json', c.misc)
write('misc2.json', c.misc2)
write('ledger.json', c.ledger)

// fingerprint.json must describe the SAME instant as the rest of the capture, or
// verify:schema reports drift that is really just a race. Production moved five
// times during the session that built this, twice within twenty seconds — so the
// fingerprint is written here, from the same capture, never fetched separately.
if (c.fingerprint) {
  writeFileSync(join(OUT, 'fingerprint.json'), JSON.stringify({
    _comment: 'Production\'s schema shape at capture time, from public.schema_fingerprint(). `npm run verify:schema` compares live production against this. Regenerate with `npm run schema:contract` — never hand-edit a hash to make the guard pass, because the hash is the only thing standing between a silent production change and a rebuild that quietly omits it.',
    captured_at: c.misc.captured_at,
    captured_from: `production, ${String(c.misc.pg_version).split(',')[0]}`,
    baseline: 'supabase/migrations/*_baseline.sql',
    overall: c.fingerprint.overall,
    latest_migration: c.fingerprint.latest_migration,
    sections: c.fingerprint.sections,
  }, null, 2) + '\n')
  console.log(`  ✓ ${'fingerprint.json'.padEnd(24)} ${Object.keys(c.fingerprint.sections ?? {}).length} sections`)
} else {
  console.log('  ⚠ fingerprint.json NOT written — the capture carried no fingerprint.')
  console.log('    verify:schema will keep comparing against the previous one.')
}

console.log(`\n  captured_at      ${c.misc.captured_at}`)
console.log(`  latest_migration ${c.misc.latest_migration}`)
console.log(`  ${c.tables.length} tables · ${c.functions.length} functions · ${c.policies.length} policies · ${c.ledger.length} ledger entries`)
console.log('\nNext:')
console.log('  npm run schema:baseline    # regenerate the baseline from this capture')
console.log('  npm run verify:rebuild     # prove it still builds an empty database')
console.log('  npm run verify:schema      # confirm production and the repo now agree\n')
console.log('⚠ Any migration in the ledger that has no file under supabase/archive/ledger/ reached')
console.log('  production without going through the repo. Recover its SQL and archive it:')
console.log("    select version, name, array_to_string(statements, E'\\n') from supabase_migrations.schema_migrations;\n")
