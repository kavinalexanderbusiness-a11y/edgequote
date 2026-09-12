// Reference generation only. This module has no URL/credential API and creates
// a fresh in-memory PGlite database; it never learns a digest from a target.
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadPGlite, splitStatements, substitutePlatformStatements } from '../lib/pg-sql'

const CORE = 'supabase/proposals/pilot-email-core.sql'
const COMMON = 'supabase/proposals/pilot-quote-shared-profile.sql'
const PRESENT = 'supabase/proposals/pilot-quote-email-present.sql'
const ABSENT = 'supabase/proposals/pilot-quote-email-absent.sql'
const CORE_SHA256 = '434048ade9a3625a280707f12877f694281e72efbaa78b29ae141503876540fb'
type Row = Record<string, unknown>
interface ReferenceDatabase {
  exec(sql: string): Promise<unknown>
  query<T = Row>(sql: string): Promise<{ rows: T[] }>
  close(): Promise<void>
}
interface Catalogue {
  sha256: string
  catalogue: Row
}
export interface ProfileReference {
  kind: 'fresh-in-memory-source-reference'
  pass: boolean
  databaseVersion: string
  sourcePins: { file: string; lfSha256: string }[]
  substitutions: { file: string; detail: string }[]
  profiles: Partial<Record<'absent' | 'original' | 'present', Catalogue>>
  checks: { name: string; pass: boolean }[]
  allDatabasesClosed: boolean
  pinnedInstallersChecked: boolean
  limitation: string
}
const lf = (value: string) => value.replace(/\r\n/g, '\n')
const hash = (value: string) => createHash('sha256').update(value).digest('hex')

export async function buildProfileReference(sourceRoot = process.cwd(), validateInstallers = true): Promise<ProfileReference> {
  const loaded = await loadPGlite()
  if (!loaded) throw new Error('The existing optional PGlite dependency is required for reference generation; no installation attempted')
  const report: ProfileReference = {
    kind: 'fresh-in-memory-source-reference', pass: false, databaseVersion: '', sourcePins: [], substitutions: [], profiles: {}, checks: [],
    allDatabasesClosed: false, pinnedInstallersChecked: false,
    limitation: 'Sequential PGlite reference only, with explicit platform-prelude Auth/network stubs. No native PG17 lock/concurrency, real Auth, deployment or production claim.',
  }
  const read = (file: string): string => {
    const content = lf(readFileSync(resolve(sourceRoot, file), 'utf8'))
    if (!report.sourcePins.some(pin => pin.file === file)) report.sourcePins.push({ file, lfSha256: hash(content) })
    return content
  }
  const core = read(CORE)
  if (hash(core) !== CORE_SHA256) throw new Error('Original email proposal differs from reviewed immutable source')
  const common = read(COMMON), present = read(PRESENT), absent = read(ABSENT)
  const db: ReferenceDatabase = await loaded.PGlite.create({ extensions: loaded.contribs })
  const apply = async (source: string, label: string) => {
    const substituted = substitutePlatformStatements(source)
    for (const detail of substituted.hits) report.substitutions.push({ file: label, detail })
    for (const [index, statement] of splitStatements(substituted.sql).entries()) {
      try { await db.exec(statement) } catch (error) {
        throw new Error(`${label} statement ${index + 1}: ${error instanceof Error ? error.message : 'SQL failed'}`)
      }
    }
  }
  const capture = async (): Promise<Catalogue> => {
    const { rows } = await db.query<Catalogue>(`select c as catalogue, encode(sha256(convert_to(c::text,'UTF8')),'hex') as sha256 from (select public._pilot_quote_email_catalogue() c) s`)
    if (rows.length !== 1 || !/^[a-f0-9]{64}$/.test(rows[0].sha256)) throw new Error('Reference catalogue returned an invalid digest')
    return rows[0]
  }
  const check = (name: string, passed: boolean) => {
    report.checks.push({ name, pass: passed })
    if (!passed) throw new Error(name)
  }
  try {
    report.databaseVersion = String((await db.query<{ version: string }>('select version()')).rows[0].version)
    await apply(read('scripts/schema/platform-prelude.sql'), 'scripts/schema/platform-prelude.sql')
    const migrations = readdirSync(resolve(sourceRoot, 'supabase/migrations')).filter(name => name.endsWith('.sql')).sort()
    for (const name of migrations) await apply(read(`supabase/migrations/${name}`), `supabase/migrations/${name}`)
    await apply(common, COMMON)
    report.profiles.absent = await capture()
    check('Absent catalogue contains precisely the empty footprint', Object.entries(report.profiles.absent.catalogue).every(([key, value]) => key === 'version' ? value === 1 : Array.isArray(value) && value.length === 0))
    // Installers can be checked after literals have been pinned. The reference
    // generation never rewrites those source literals or substitutes a target.
    if (validateInstallers) {
      await db.exec('begin')
      try {
        await apply(absent.replace(/^begin;$/m, '').replace(/^commit;$/m, ''), ABSENT)
        check('Pinned absent installer validates the fresh reference', (await db.query<{ profile: string }>('select public._pilot_quote_email_profile() profile')).rows[0].profile === 'absent')
        check('Verified absent retained state is empty', JSON.stringify((await db.query<{ retained: Row }>("select public._pilot_quote_email_retained('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002') retained")).rows[0].retained) === JSON.stringify({ attempts: [], workflows: [] }))
      } finally { await db.exec('rollback') }
    }
    await apply(core, CORE)
    report.profiles.original = await capture()
    check('Original catalogue has all four email relations', Array.isArray(report.profiles.original.catalogue.relations) && report.profiles.original.catalogue.relations.length === 4)
    const weld = /-- BEGIN OWNER LOCK WELD[^\n]*\n([\s\S]*?)-- END OWNER LOCK WELD/.exec(present)?.[1]
    if (!weld) throw new Error('Present installer has no uniquely delimited owner-lock weld')
    await db.exec('begin')
    try {
      await apply(weld, `${PRESENT}:exact-owner-lock-weld`)
      report.profiles.present = await capture()
      const before = report.profiles.original.catalogue, after = report.profiles.present.catalogue
      for (const key of Object.keys(before).filter(key => key !== 'functions')) check(`Wrapper weld preserves ${key}`, JSON.stringify(before[key]) === JSON.stringify(after[key]))
      const otherFunctions = (value: unknown) => (value as Row[]).filter(row => row.name !== '_pilot_email_owner_lock')
      check('Wrapper weld preserves every other email function', JSON.stringify(otherFunctions(before.functions)) === JSON.stringify(otherFunctions(after.functions)))
    } finally { await db.exec('rollback') }
    if (validateInstallers) {
      await apply(present, PRESENT)
      check('Pinned present installer validates the fresh reference', (await db.query<{ profile: string }>('select public._pilot_quote_email_profile() profile')).rows[0].profile === 'present')
      report.pinnedInstallersChecked = true
    }
    report.pass = true
  } finally {
    await db.close()
    report.allDatabasesClosed = true
  }
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(process.cwd(), 'scripts/pilot-email/profile-reference.ts')) {
  buildProfileReference(process.cwd(), !process.argv.includes('--generate-only')).then(report => {
    if (process.argv[2]) writeFileSync(resolve(process.argv[2]), JSON.stringify(report, null, 2) + '\n')
    process.stdout.write(JSON.stringify({ pass: report.pass, databaseVersion: report.databaseVersion, digests: Object.fromEntries(Object.entries(report.profiles).map(([name, value]) => [name, value?.sha256])), checks: report.checks, allDatabasesClosed: report.allDatabasesClosed, pinnedInstallersChecked: report.pinnedInstallersChecked }) + '\n')
  }).catch(error => { process.stderr.write((error instanceof Error ? error.message : 'Reference generation failed') + '\n'); process.exitCode = 1 })
}
