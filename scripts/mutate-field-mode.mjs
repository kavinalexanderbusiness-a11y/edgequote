// ── Mutation-test verify:field-mode ──────────────────────────────────────────
//
// A guard that has never failed proves nothing. Each mutation below breaks ONE
// thing the guard claims to protect; the guard must go red for every one, and
// green again once the file is restored.
//
//   node scripts/mutate-field-mode.mjs
//
// ⚠️ Restores from git, so COMMIT before running it — `git checkout --` wipes
// uncommitted edits (that has cost this project real work before).
// ⚠️ CRLF: this repo checks out with CRLF, so every pattern here is matched with
// `\r?\n` or against a normalised copy. A bare `\n` matches nothing and reads as
// "the guard has a hole".

import { readFileSync, writeFileSync } from 'node:fs'
import { execSync, spawnSync } from 'node:child_process'

const MUTATIONS = [
  // ── The engine ────────────────────────────────────────────────────────────
  { file: 'src/lib/quickAdd.ts', why: 'the + stops carrying the customer',
    from: 'href: `/dashboard/quotes/new${qs({ customer: cust.id, property: cust.propertyId })}`',
    to: 'href: `/dashboard/quotes/new`' },
  { file: 'src/lib/quickAdd.ts', why: 'a cost door is offered on a visit that has not finished',
    from: "if (ctx.status === 'completed' && enabled.has('accounting'))",
    to: "if (enabled.has('accounting'))" },
  { file: 'src/lib/quickAdd.ts', why: 'work time is offered on a scheduled visit',
    from: "if (ctx.status === 'in_progress' || ctx.status === 'completed')",
    to: 'if (true)' },
  { file: 'src/lib/quickAdd.ts', why: 'an empty ?customer= is emitted instead of none',
    from: ".filter(([, v]) => v != null && v !== '')",
    to: '.filter(([, v]) => v != null)' },
  { file: 'src/lib/quickAdd.ts', why: 'a hidden module keeps its create door',
    from: "if (enabled.has('quotes')) {",
    to: 'if (true) {' },
  { file: 'src/lib/quickAdd.ts', why: 'visit-scoped doors stop coming first',
    from: 'export function quickAddActions(ctx: QuickAddContext, enabled: ReadonlySet<string>): QuickAddAction[] {',
    to: 'export function quickAddActions(ctx: QuickAddContext, enabled: ReadonlySet<string>): QuickAddAction[] {\n  if (ctx.kind === \'job\') return quickAddActions({ kind: \'none\' }, enabled)' },
  { file: 'src/lib/quickAdd.ts', why: 'an unknown ?panel= is honoured instead of ignored',
    from: "return param === 'time' || param === 'cost' ? param : null",
    to: 'return (param || null)' },

  // ── The wiring ────────────────────────────────────────────────────────────
  { file: 'src/components/layout/QuickAdd.tsx', why: 'the sheet stops reading the engine',
    from: 'const actions = quickAddActions(ctx, enabled)',
    to: 'const actions = []' },
  { file: 'src/components/layout/QuickAddProvider.tsx', why: 'a surface keeps publishing after it unmounts',
    from: 'return () => publish(null)',
    to: 'return () => {}' },
  { file: 'src/app/dashboard/customers/[id]/page.tsx', why: 'the customer profile stops publishing itself',
    from: '  usePublishQuickAddContext(useMemo(() => (customer ? {',
    to: '  void 0; const _unused = (() => (customer ? {' },

  // ── Reach ─────────────────────────────────────────────────────────────────
  { file: 'src/components/layout/BottomNav.tsx', why: 'Customers loses its tab again',
    from: "{ moduleKey: 'customers', href: '/dashboard/customers', label: 'Customers', icon: Users },",
    to: '' },
  { file: 'src/components/layout/Sidebar.tsx', why: 'the logo stops being the Home link',
    from: '<Link href="/dashboard" aria-label="Home"',
    to: '<div data-was-home' },

  // ── The field bar ─────────────────────────────────────────────────────────
  // ⚠️ This mutation used to remove only the ICON and was labelled "directions
  // leave the bar" — it did not, and the guard was rightly green. A mutation
  // that does less than its name says produces a false hole and sends you off
  // weakening a correct assertion. It now gates the whole link off, which is the
  // realistic regression shape.
  { file: 'src/components/schedule/FieldStopBar.tsx', why: 'directions leave the bar',
    from: '{hasWhere && (', to: '{false && (' },
  { file: 'src/components/schedule/FieldStopBar.tsx', why: 'the crew note is dropped',
    from: '{note && (', to: '{false && (' },
  { file: 'src/components/schedule/FieldStopBar.tsx', why: 'the details panel opens itself',
    from: 'const [open, setOpen] = useState(false)', to: 'const [open, setOpen] = useState(true)' },
  { file: 'src/components/schedule/FieldStopBar.tsx', why: 'the sheet uses vh only, hiding the composer behind browser chrome',
    from: 'max-h-[80vh] supports-[max-height:1dvh]:max-h-[80dvh]', to: 'max-h-[80vh]' },
  { file: 'src/components/schedule/FieldStopBar.tsx', why: 'a new stop inherits the last one\'s open panel',
    from: 'useEffect(() => { setOpen(false); setChat(false) }, [job.id])', to: '' },

  // ── The card ──────────────────────────────────────────────────────────────
  { file: 'src/components/schedule/DayOpsPanel.tsx', why: 'Stop for today gets folded into the menu',
    from: '<ActionBtn disabled={acting !== null} onClick={() => openStop(job)} icon={PauseCircle} label="Stop for today"',
    to: '<ActionBtn className="hidden sm:inline-flex" disabled={acting !== null} onClick={() => openStop(job)} icon={PauseCircle} label="Stop for today"' },
  { file: 'src/components/schedule/DayOpsPanel.tsx', why: 'a folded button is deleted rather than moved',
    from: "{ key: 'p-photos', className: 'sm:hidden', label: 'Photos'", to: "{ key: 'p-photos-x', className: 'sm:hidden', label: 'Photos'" },
  { file: 'src/components/schedule/DayOpsPanel.tsx', why: 'a folded twin also shows on desktop',
    from: "{ key: 'p-message', className: 'sm:hidden',", to: "{ key: 'p-message'," },
  { file: 'src/components/schedule/DayOpsPanel.tsx', why: 'unread crew messages get folded away too',
    from: "className={cn(!chatUnread[job.id] && 'hidden sm:inline-flex')}", to: 'className="hidden sm:inline-flex"' },

  // ── The customer profile ──────────────────────────────────────────────────
  { file: 'src/app/dashboard/customers/[id]/page.tsx', why: 'the dossier goes back above the actions on phones',
    from: 'className="order-2 sm:order-3 grid grid-cols-2', to: 'className="grid grid-cols-2' },
  { file: 'src/app/dashboard/customers/[id]/page.tsx', why: 'space-y comes back and the reorder breaks its margins',
    from: '<CardBody className="flex flex-col gap-4">', to: '<CardBody className="space-y-4">' },

  // ── Duration ──────────────────────────────────────────────────────────────
  { file: 'src/components/quotes/QuoteBuilder.tsx', why: 'a quote line goes back to a raw minutes box',
    from: '<DurationField\n', to: '<Input label="Duration (min)" type="number"\n' },
  { file: 'src/components/quotes/QuoteBuilder.tsx', why: 'a workday becomes 24 hours',
    from: 'workdayMinutes(settings?.daily_capacity_hours)', to: '(24 * 60)' },
]

const run = () => spawnSync('node', ['node_modules/tsx/dist/cli.mjs', 'scripts/verify-field-mode.ts'],
  { encoding: 'utf8', shell: false })

console.log('── baseline ──')
const base = run()
if (base.status !== 0) {
  console.error('⛔ the guard is RED before any mutation — fix that first')
  console.error((base.stdout || '').split('\n').filter(l => l.includes('✗')).join('\n'))
  process.exit(2)
}
console.log(`  ✓ green: ${(base.stdout.match(/✓/g) || []).length} checks\n`)

let caught = 0, missed = 0
for (const m of MUTATIONS) {
  const original = readFileSync(m.file, 'utf8')
  // CRLF-tolerant: match the pattern against the file as written on disk by
  // normalising BOTH sides, then splice using the normalised copy.
  const norm = original.replace(/\r\n/g, '\n')
  const from = m.from.replace(/\r\n/g, '\n')
  if (!norm.includes(from)) {
    console.log(`  ⚠ SKIPPED (pattern not found): ${m.why}`)
    missed++
    continue
  }
  writeFileSync(m.file, norm.replace(from, m.to))
  const res = run()
  writeFileSync(m.file, original)
  if (res.status === 0) { console.log(`  ✗ MISSED  — ${m.why}`); missed++ }
  else { console.log(`  ✓ caught  — ${m.why}`); caught++ }
}

// Every file is byte-restored above, but prove it rather than assert it.
const dirty = execSync('git status --porcelain -- src scripts', { encoding: 'utf8' })
  .split('\n').filter(l => l.trim() && !l.includes('mutate-field-mode'))
console.log(`\n${missed === 0 ? '✓' : '✗'} ${caught} caught, ${missed} missed`)
console.log(dirty.length === 0 ? '✓ working tree restored' : `⛔ NOT restored:\n${dirty.join('\n')}`)
process.exit(missed === 0 && dirty.length === 0 ? 0 : 1)
