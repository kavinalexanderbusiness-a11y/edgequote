// Actual route/components with synthetic auth, database and fetch only.
// No credentials, provider calls, business writes, browser or server required.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { transformSync } from 'esbuild'
import * as setup from '../src/lib/onboarding/setupHealth'

let passed = 0
async function check(name: string, test: () => void | Promise<void>) {
  await test()
  passed++
  console.log(`PASS ${name}`)
}
function sourceModule(file: string, modules: Record<string, any>, globals: Record<string, any> = {}) {
  const context = { module: { exports: {} }, require(id: string) {
    assert.ok(id in modules, `Unexpected dependency: ${id}`)
    return modules[id]
  }, ...globals }
  runInNewContext(transformSync(readFileSync(file, 'utf8'), { loader: file.endsWith('tsx') ? 'tsx' : 'ts', format: 'cjs', jsx: 'automatic' }).code, context)
  return context.module.exports as Record<string, any>
}

function routeFixture() {
  const grant = { online_payments: true, inbound_sms: true, outbound_sms: true, outbound_email: true }
  const state = { user: { id: 'owner-fixture' } as { id: string } | null, authError: null as unknown, business: { user_id: 'owner-fixture' } as unknown, readError: null as unknown, grant: grant as unknown, grantError: null as unknown, configured: true, webhook: true, throwRead: false }
  const reads: unknown[][] = []
  const sb = { auth: { getUser: async () => ({ data: { user: state.user }, error: state.authError }) }, from(table: string) {
    const query: unknown[] = [table]
    reads.push(query)
    return { select(fields: string) { query.push(fields); return this }, eq(key: string, value: string) { query.push(key, value); return this }, async maybeSingle() {
      if (state.throwRead) throw new Error('private database details')
      if (table === 'business_settings') return { data: state.business, error: state.readError }
      assert.equal(table, 'platform_capabilities')
      return { data: state.grant, error: state.grantError }
    } }
  } }
  const capabilities = sourceModule('src/lib/capabilities.ts', {})
  const route = sourceModule('src/app/api/integrations/status/route.ts', {
    'next/server': { NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } },
    '@/lib/supabase/server': { createClient: async () => sb },
    '@/lib/capabilities': capabilities,
    '@/lib/comms/send': { commsEnabled: () => ({ email: state.configured, sms: state.configured, push: false }) },
    '@/lib/stripe/config': { stripeEnabled: () => state.configured, webhookConfigured: () => state.webhook },
  })
  return { state, reads, get: () => route.GET() as Promise<Response> }
}

type Element = { type: any; props: Record<string, any> }
function mount(kind: 'setup' | 'connections', options: { snapshot?: setup.SetupSnapshot; dismissed?: string } = {}) {
  const slots: any[] = [], effects: (() => void)[] = [], timers = new Map<number, () => void>()
  let cursor = 0, timerId = 0, tree: any
  let snapshot = options.snapshot, readFailure = false, fetchBody: unknown = { email: true, sms: false, payments: false }, fetchFails = false, httpOk = true, hang = false
  let activity = { hasCustomers: false, hasQuotes: false }
  let requests = 0
  const jsx = (type: any, props: Record<string, any>) => ({ type, props })
  const hooks = {
    useState(value: unknown) { const i = cursor++; if (!(i in slots)) slots[i] = value; return [slots[i], (next: any) => { slots[i] = typeof next === 'function' ? next(slots[i]) : next }] },
    useMemo(factory: () => unknown) { const i = cursor++; if (!(i in slots)) slots[i] = factory(); return slots[i] },
    useEffect(effect: () => void | (() => void), deps: unknown[]) {
      const i = cursor++, previous = slots[i]
      if (!previous || deps.some((value, index) => !Object.is(value, previous.deps[index]))) {
        slots[i] = { deps }
        effects.push(() => { previous?.cleanup?.(); slots[i].cleanup = effect() })
      }
    },
  }
  const div = (props: Record<string, any>) => jsx('div', props)
  const modules = {
    react: hooks, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
    'next/link': (props: Record<string, any>) => jsx('a', props),
    'lucide-react': new Proxy({}, { get: () => () => null }),
    '@/components/ui/Button': { Button: (props: Record<string, any>) => jsx('button', props), ButtonLink: (props: Record<string, any>) => jsx('a', props) },
    '@/components/ui/Card': { Card: div, CardHeader: div, CardBody: div },
    '@/lib/supabase/client': { createClient: () => ({ auth: { getSession: async () => ({ data: { session: { user: { id: 'owner-fixture' } } }, error: null }) } }) },
    '@/lib/onboarding/setupHealth': { ...setup, loadSetupSnapshot: async () => { if (readFailure) throw new Error('private read failure'); return snapshot } },
  }
  const mod = sourceModule(kind === 'setup' ? 'src/components/dashboard/SetupProgress.tsx' : 'src/components/integrations/ConnectionStatus.tsx', modules, {
    AbortController, window: { localStorage: { getItem: () => options.dismissed ?? null, setItem: () => {} } },
    setTimeout: (callback: () => void) => { const id = ++timerId; timers.set(id, callback); return id }, clearTimeout: (id: number) => timers.delete(id),
    fetch: async (_url: string, init: RequestInit) => {
      assert.equal(_url, '/api/integrations/status')
      assert.equal(init.cache, 'no-store')
      assert.equal(init.method, undefined, 'read-only GET')
      requests++
      if (hang) return new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('timeout'))))
      if (fetchFails) throw new Error('private network failure')
      return { ok: httpOk, json: async () => fetchBody }
    },
  })
  function expand(node: any): any {
    if (node == null || typeof node === 'boolean') return null
    if (Array.isArray(node)) return node.map(expand)
    if (typeof node !== 'object') return node
    if (typeof node.type === 'function') return expand(node.type(node.props))
    return { ...node, props: { ...node.props, children: expand(node.props.children) } }
  }
  function render() { cursor = 0; tree = expand(kind === 'setup' ? mod.SetupProgress({ activity }) : mod.ConnectionStatus()); effects.splice(0).forEach(effect => effect()) }
  function nodes(node: any = tree): Element[] {
    if (Array.isArray(node)) return node.flatMap(n => nodes(n))
    return node && typeof node === 'object' ? [node, ...nodes(node.props.children)] : []
  }
  function text(node: any = tree): string {
    if (Array.isArray(node)) return node.map(n => text(n)).join(' ').replace(/\s+/g, ' ').trim()
    return node && typeof node === 'object' ? text(node.props.children) : node == null ? '' : String(node)
  }
  return {
    async settle() { for (let i = 0; i < 12; i++) { render(); await Promise.resolve() } render() },
    text, nodes, requests: () => requests,
    configure(next: { snapshot?: setup.SetupSnapshot; readFailure?: boolean; fetchBody?: unknown; fetchFails?: boolean; httpOk?: boolean; hang?: boolean; activity?: typeof activity }) {
      if (next.snapshot) snapshot = next.snapshot
      if ('readFailure' in next) readFailure = !!next.readFailure
      if ('fetchBody' in next) fetchBody = next.fetchBody
      if ('fetchFails' in next) fetchFails = !!next.fetchFails
      if ('httpOk' in next) httpOk = !!next.httpOk
      if ('hang' in next) hang = !!next.hang
      if (next.activity) activity = next.activity
    },
    click(label: string) { const button = nodes().find(n => n.type === 'button' && (text(n) === label || n.props['aria-label'] === label)); assert.ok(button, `Missing button ${label}`); assert.ok(!button.props.disabled); button.props.onClick() },
    timeout() { [...timers.values()].forEach(callback => callback()) },
  }
}

const full: setup.SetupSnapshot = { companyName: 'Sample Business', phone: '555-0100', emailPrimary: 'sample@example.test', baseAddress: '123 Example Street', baseLat: null, baseLng: null, logoUrl: 'example-logo', termsText: 'Example terms', etransferEmail: 'sample@example.test', bookingEnabled: true, reviewUrl: 'example-review', activeTemplateCount: 1, unpricedActiveTemplateCount: 0 }

async function main() {
  await check('route requires a signed-in owner before reading configuration', async () => {
    for (const mode of ['signed-out', 'crew', 'failed-owner-read'] as const) {
      const f = routeFixture()
      if (mode === 'signed-out') f.state.user = null
      if (mode === 'crew') f.state.business = null
      if (mode === 'failed-owner-read') f.state.readError = { message: 'private error' }
      const response = await f.get()
      assert.equal(response.status, mode === 'signed-out' ? 401 : mode === 'crew' ? 403 : 503)
      assert.ok(!JSON.stringify(await response.json()).includes('private'))
      assert.ok(f.reads.every(read => read[0] !== 'platform_capabilities'))
    }
  })
  await check('route scopes both reads to the authenticated owner and returns only booleans, uncached', async () => {
    const f = routeFixture(), response = await f.get()
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store')
    assert.deepEqual(await response.json(), { email: true, sms: true, payments: true })
    assert.equal(f.reads.length, 2)
    for (const read of f.reads) assert.deepEqual(read.slice(-2), ['user_id', 'owner-fixture'])
  })
  await check('missing configuration, missing grants and coalesced grant failure remain unavailable', async () => {
    for (const mode of ['configuration', 'grant', 'grant-read'] as const) {
      const f = routeFixture()
      if (mode === 'configuration') f.state.configured = false
      if (mode === 'grant') f.state.grant = null
      if (mode === 'grant-read') f.state.grantError = { message: 'private error' }
      assert.deepEqual(await (await f.get()).json(), { email: false, sms: false, payments: false })
    }
  })
  await check('payment availability also requires webhook configuration', async () => {
    const f = routeFixture(); f.state.webhook = false
    assert.deepEqual(await (await f.get()).json(), { email: true, sms: true, payments: false })
  })
  await check('thrown route read returns generic retryable failure, never raw details', async () => {
    const f = routeFixture(); f.state.throwRead = true
    const response = await f.get()
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), { error: 'Could not check connections.' })
  })
  await check('connection card describes availability without a false provider disconnect or test claim', async () => {
    const f = mount('connections'); await f.settle()
    assert.match(f.text(), /Available/)
    assert.match(f.text(), /Unavailable for this business/)
    assert.match(f.text(), /doesn’t test message delivery/)
    assert.doesNotMatch(f.text(), /Connect Stripe|Disconnected|verified delivery/i)
    assert.ok(f.nodes().some(n => n.type === 'a' && n.props.href === '/dashboard/help'))
  })
  await check('failed refresh removes stale availability and retry recovers', async () => {
    const f = mount('connections'); await f.settle()
    f.configure({ fetchFails: true }); f.click('Refresh status'); await f.settle()
    assert.match(f.text(), /Couldn’t check/); assert.doesNotMatch(f.text(), /Available|private network/)
    f.configure({ fetchFails: false }); f.click('Retry'); await f.settle()
    assert.match(f.text(), /Available/); assert.equal(f.requests(), 3)
  })
  await check('malformed or refused HTTP response remains unknown, not false availability', async () => {
    for (const refused of [false, true]) {
      const f = mount('connections'); f.configure(refused ? { httpOk: false } : { fetchBody: { email: 'yes', sms: true } }); await f.settle()
      assert.match(f.text(), /Couldn’t check/); assert.doesNotMatch(f.text(), /Unavailable for this business|Available/)
    }
  })
  await check('hung status request times out to an enabled retry', async () => {
    const f = mount('connections'); f.configure({ hang: true }); await f.settle()
    f.timeout(); await f.settle(); assert.match(f.text(), /Couldn’t check/)
    f.configure({ hang: false }); f.click('Retry'); await f.settle(); assert.match(f.text(), /Available/)
  })
  await check('new business keeps four actionable milestones plus all nine optional settings', async () => {
    const f = mount('setup', { snapshot: full }); await f.settle()
    assert.match(f.text(), /2 of 4 steps complete/)
    assert.equal(f.nodes().filter(n => n.type === 'li').length, 4)
    assert.equal(f.nodes().filter(n => n.type === 'details').length, 1)
    assert.ok(f.nodes().some(n => n.type === 'a' && n.props.href === '/dashboard/customers/import'))
    const details = f.nodes().find(n => n.type === 'details')!
    assert.equal(f.nodes(details).filter(n => n.type === 'a').length, 9)
  })
  await check('both resolved and thrown setup read failures expose retry without guessed completion', async () => {
    for (const thrown of [false, true]) {
      const f = mount('setup', { snapshot: { ...full, readError: 'unavailable' } })
      f.configure({ readFailure: thrown }); await f.settle()
      assert.match(f.text(), /Couldn’t check your setup/); assert.doesNotMatch(f.text(), /steps complete|private/)
      f.configure({ readFailure: false, snapshot: full }); f.click('Retry'); await f.settle()
      assert.match(f.text(), /2 of 4 steps complete/)
    }
  })
  await check('a previous optional dismissal cannot hide incomplete milestones; completion can hide it', async () => {
    const f = mount('setup', { snapshot: { ...full, logoUrl: null }, dismissed: 'logo' }); await f.settle()
    assert.match(f.text(), /Get your business ready/)
    f.configure({ activity: { hasCustomers: true, hasQuotes: true } }); await f.settle()
    assert.equal(f.text(), '')
  })
  console.log(`\n${passed} passed; 0 failed — synthetic reads only.`)
}
main().catch(error => { console.error(error); process.exitCode = 1 })
