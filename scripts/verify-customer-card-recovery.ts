// Executes the real TSX components with deterministic hooks and a read-only
// Supabase double. Exercises reads, recovery and rendered branches; not a browser
// or an assertion about live tenant data. No application secrets are loaded.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { transformSync } from 'esbuild'

type Result = { data: unknown; error: unknown }
type Element = { type: unknown; props: Record<string, any> }
const ok = (data: unknown[] = []): Result => ({ data, error: null })
const failed: Result = { data: null, error: { message: 'simulated unavailable read' } }
const message = { id: 'm1', channel: 'email', template: 'job_complete', status: 'sent', created_at: '2026-09-05' }
const consent = { id: 'c1', channel: 'email', old_value: false, new_value: true, source: 'single', created_at: '2026-09-05' }
const referral = { id: 'r1', status: 'joined', referred_name: 'Example Person', referred_customer_id: 'linked-1', created_at: '2026-09-05' }

function mount(kind: 'CustomerComms' | 'ReferralPanel') {
  const states: any[] = []
  const effects: (() => void | (() => void))[] = []
  const cleanups: (() => void)[] = []
  let cursor = 0, initial = true
  let responses: Record<string, Result | Promise<Result>> = {}
  const reads: string[] = []
  const supabase = {
    auth: { getSession: async () => ({ data: { session: { user: { id: 'owner-fixture' } } } }) },
    from(table: string) {
      reads.push(table)
      const response = responses[table] ?? ok()
      const chain: Record<string, any> = {
        then: (resolve: (v: Result) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(response).then(resolve, reject),
      }
      for (const method of ['select', 'eq', 'order', 'limit', 'in']) chain[method] = () => chain
      for (const method of ['insert', 'update', 'delete']) chain[method] = () => { throw new Error('Unexpected business write in recovery') }
      return chain
    },
  }
  const hooks = {
    useState(value: unknown) {
      const i = cursor++
      if (!(i in states)) states[i] = value
      return [states[i], (next: unknown) => { states[i] = typeof next === 'function' ? next(states[i]) : next }]
    },
    useRef(value: unknown) {
      const i = cursor++
      if (!(i in states)) states[i] = { current: value }
      return states[i]
    },
    useMemo: (factory: () => unknown) => factory(),
    useEffect(effect: () => void) { if (initial) effects.push(effect) },
  }
  const jsx = (type: unknown, props: Record<string, any>) => ({ type, props })
  const container = ({ children, ...props }: Record<string, any>) => jsx('div', { ...props, children })
  const button = (props: Record<string, any>) => jsx('button', { ...props, disabled: props.loading || props.disabled })
  const stubModules: Record<string, unknown> = {
    react: hooks,
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
    'next/link': { default: (props: Record<string, any>) => jsx('a', props) },
    '@/lib/supabase/client': { createClient: () => supabase },
    '@/lib/confirm': { confirm: () => { throw new Error('Unexpected confirmation') } },
    '@/lib/toast': { toast: () => { throw new Error('Unexpected toast') } },
    '@/lib/consent': {},
    '@/lib/utils': { cn: (...parts: unknown[]) => parts.join(' '), formatDate: (date: string) => date, formatCurrency: (n: number) => String(n) },
    '@/lib/comms/templates': { MSG_LABELS: { job_complete: 'Job complete' } },
    '@/hooks/useRealtime': { useRealtimeRefresh: () => {} },
    '@/components/ui/Card': { Card: container, CardHeader: container, CardBody: container },
    '@/components/ui/Button': { Button: button },
    '@/components/ui/Input': { Input: container },
    '@/components/ui/EmptyState': { InlineEmpty: container },
    '@/components/ui/Skeleton': { Skeleton: () => null, SkeletonRows: () => null },
    'lucide-react': new Proxy({}, { get: () => () => null }),
  }
  const context: Record<string, any> = { module: { exports: {} }, require: (id: string) => {
    assert.ok(id in stubModules, `unexpected import: ${id}`)
    return stubModules[id]
  } }
  const raw = readFileSync(`src/components/customers/${kind}.tsx`, 'utf8')
  // Capture the actual loader without replacing its body or its rendered UI.
  const marker = kind === 'CustomerComms' ? 'async function toggle(' : 'async function addReferral('
  const loader = kind === 'CustomerComms' ? 'loadLog' : 'load'
  assert.ok(raw.includes(marker), 'loader capture anchor exists')
  const instrumented = raw.replace(marker, `globalThis.__reload = ${loader}\n  ${marker}`)
  const js = transformSync(instrumented, { loader: 'tsx', format: 'cjs', jsx: 'automatic', target: 'es2022' }).code
  runInNewContext(js, context)
  const props = kind === 'CustomerComms'
    ? { customerId: 'customer-fixture', smsOptIn: false, emailOptIn: true }
    : { customer: { id: 'customer-fixture', name: 'Example Customer' }, referrer: null, referredRevenue: 0 }
  function render() {
    cursor = 0
    return context.module.exports[kind](props) as Element
  }
  const nodes = (node: any): Element[] => {
    if (!node || typeof node !== 'object') return []
    if (Array.isArray(node)) return node.flatMap(nodes)
    if (typeof node.type === 'function') return nodes(node.type(node.props))
    return [node, ...nodes(node.props?.children)]
  }
  const text = (node: any): string => {
    if (node == null || typeof node === 'boolean') return ''
    if (typeof node !== 'object') return String(node)
    if (Array.isArray(node)) return node.map(text).join(' ')
    return text(typeof node.type === 'function' ? node.type(node.props) : node.props?.children)
  }
  return {
    reads,
    respond(next: typeof responses) { responses = next },
    async start() { render(); initial = false; for (const effect of effects) { const cleanup = effect(); if (cleanup) cleanups.push(cleanup) }; await drain() },
    async reload() { await context.__reload() },
    snapshot() { const tree = render(); return { text: text(tree), nodes: nodes(tree) } },
    async retry(label: string) {
      const target = this.snapshot().nodes.find(node => node.type === 'button' && node.props['aria-label'] === label)
      assert.ok(target, `${label} is a rendered button`)
      assert.ok(!target.props.disabled, 'retry is usable after failure')
      target.props.onClick()
      await drain()
    },
    dispose() { for (const cleanup of cleanups) cleanup() },
  }
}
const drain = async () => { for (let i = 0; i < 16; i++) await Promise.resolve() }
const deferred = () => { let resolve!: (value: Result) => void; const promise = new Promise<Result>(r => { resolve = r }); return { promise, resolve } }
let passed = 0
const check = (name: string, fn: () => void) => { fn(); passed++; console.log(`  PASS ${name}`) }

async function main() {
  const comms = mount('CustomerComms')
  comms.respond({ notification_log: failed, consent_changes: failed })
  await comms.start()
  check('first failed histories show errors rather than an empty-history claim', () => {
    const view = comms.snapshot()
    assert.match(view.text, /Could not load message history/)
    assert.match(view.text, /Could not load consent history/)
    assert.doesNotMatch(view.text, /No messages sent yet/)
    assert.equal(view.nodes.filter(n => n.props.role === 'alert').length, 2)
  })
  comms.respond({ notification_log: ok([message]), consent_changes: ok([consent]) })
  await comms.retry('Retry message history')
  check('retry restores both histories and removes errors', () => {
    assert.match(comms.snapshot().text, /Job complete/)
    assert.match(comms.snapshot().text, /single/)
    assert.doesNotMatch(comms.snapshot().text, /Could not load/)
  })
  comms.respond({ notification_log: failed, consent_changes: failed })
  await comms.reload()
  check('failed refresh retains previous messages and consent changes', () => {
    assert.match(comms.snapshot().text, /Job complete/)
    assert.match(comms.snapshot().text, /single/)
    assert.match(comms.snapshot().text, /previously loaded messages/)
    assert.match(comms.snapshot().text, /previously loaded changes/)
  })
  comms.respond({ notification_log: ok(), consent_changes: Promise.reject(new Error('offline fixture')) })
  await comms.retry('Retry consent history')
  check('a rejected consent request preserves that history while messages recover independently', () => {
    assert.match(comms.snapshot().text, /No messages sent yet/)
    assert.match(comms.snapshot().text, /Could not load consent history/)
    assert.match(comms.snapshot().text, /single/)
    assert.doesNotMatch(comms.snapshot().text, /Could not load message history/)
  })
  const oldMessages = deferred()
  comms.respond({ notification_log: oldMessages.promise, consent_changes: ok() })
  const olderComms = comms.reload()
  comms.respond({ notification_log: ok([message]), consent_changes: ok() })
  await comms.reload()
  oldMessages.resolve(failed)
  await olderComms
  check('an older failure cannot replace a successful history retry', () => {
    assert.match(comms.snapshot().text, /Job complete/)
    assert.doesNotMatch(comms.snapshot().text, /Could not load/)
  })

  const refs = mount('ReferralPanel')
  refs.respond({ referrals: failed })
  await refs.start()
  check('first referral failure is neither zero joined nor no referrals', () => {
    assert.match(refs.snapshot().text, /Count unavailable/)
    assert.match(refs.snapshot().text, /Could not load referrals/)
    assert.doesNotMatch(refs.snapshot().text, /0 joined|No referrals tracked/)
  })
  refs.respond({ referrals: ok([referral]), customers: ok([{ id: 'linked-1', name: 'Linked Customer' }]) })
  await refs.retry('Retry referrals')
  check('referral retry restores count and linked customer name', () => {
    assert.match(refs.snapshot().text, /1\s+joined/)
    assert.match(refs.snapshot().text, /Linked Customer/)
    assert.doesNotMatch(refs.snapshot().text, /Could not load/)
  })
  refs.respond({ referrals: failed })
  await refs.reload()
  check('failed referral refresh retains rows and marks the count unavailable', () => {
    assert.match(refs.snapshot().text, /Linked Customer/)
    assert.match(refs.snapshot().text, /previously loaded referrals/)
    assert.match(refs.snapshot().text, /Count unavailable/)
  })
  refs.respond({ referrals: ok([referral]), customers: failed })
  await refs.retry('Retry referrals')
  check('name lookup failure preserves known names and valid referral count', () => {
    assert.match(refs.snapshot().text, /Linked Customer/)
    assert.match(refs.snapshot().text, /1\s+joined/)
    assert.match(refs.snapshot().text, /Some customer names could not be refreshed/)
  })
  refs.respond({ referrals: Promise.reject(new Error('offline fixture')) })
  await refs.retry('Retry referrals')
  check('thrown referral read exits loading and offers an enabled retry', () => {
    assert.match(refs.snapshot().text, /Could not load referrals/)
    assert.ok(!refs.snapshot().nodes.find(n => n.props['aria-label'] === 'Retry referrals')?.props.disabled)
  })
  const oldRefs = deferred()
  refs.respond({ referrals: oldRefs.promise })
  const olderRefs = refs.reload()
  await drain()
  refs.respond({ referrals: ok() })
  await refs.reload()
  oldRefs.resolve(failed)
  await olderRefs
  check('older referral failure cannot override a recovered empty result', () => {
    assert.match(refs.snapshot().text, /No referrals tracked yet/)
    assert.match(refs.snapshot().text, /0\s+joined/)
    assert.doesNotMatch(refs.snapshot().text, /Could not load|unavailable/)
  })
  comms.dispose(); refs.dispose()
  console.log(`\ncustomer-card-recovery: ${passed} passed, 0 failed (all reads mocked; no network or business writes)`)
}
main().catch(error => { console.error(error); process.exitCode = 1 })
