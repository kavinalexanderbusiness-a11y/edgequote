// Execute the actual setup/login components and dashboard redirect with synthetic
// auth/query boundaries. No environment, real account, provider or network access.
// This guards an interrupted signup, not a duplicate of the provisioning policy.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { transformSync } from 'esbuild'
import * as registration from '../src/lib/registration'
import * as seed from '../src/lib/onboarding/seed'
import * as trades from '../src/lib/trades'
import * as crew from '../src/lib/crewAccess'
import * as google from '../src/lib/googleAuth'
import * as recovery from '../src/lib/passwordRecovery'
import * as authState from '../src/lib/authState'

type Element = { type: unknown; props: Record<string, any> }
type Answer = { data: unknown; error: { message: string } | null }
const user = { id: 'signup-resume-fixture', email: 'resume@example.invalid', email_confirmed_at: '2026-09-05' }
const success = (data: unknown): Answer => ({ data, error: null })
const failed = { data: null, error: { message: 'private driver detail must not appear' } }
const jsx = (type: unknown, props: Record<string, any>): Element => ({ type, props })
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
const drain = async () => { for (let i = 0; i < 24; i++) await Promise.resolve() }

function fixture() {
  const f = {
    signedIn: true,
    status: (() => Promise.resolve(success('self-service'))) as () => Promise<Answer>,
    settings: null as Record<string, unknown> | null,
    writes: [] as { table: string; row: Record<string, unknown> }[],
    reads: [] as { table: string; uid: string | undefined }[],
    calls: [] as string[],
    destinations: [] as string[],
    signOutScopes: [] as string[],
    search: '',
  }
  const supabase = {
    auth: {
      getUser: async () => ({ data: { user: f.signedIn ? user : null }, error: null }),
      signOut: async ({ scope }: { scope: string }) => { f.signOutScopes.push(scope); f.signedIn = false; return { error: null } },
      signInWithPassword: async (credentials: { email: string; password: string }) => {
        assert.deepEqual({ ...credentials }, { email: user.email, password: 'synthetic-password' })
        f.signedIn = true
        return { error: null }
      },
    },
    rpc: async (name: string) => {
      f.calls.push(name)
      if (name === 'claim_beta_invite') return success('no-invite')
      if (name === 'current_app_role') return success('none')
      assert.equal(name, 'provisioning_status', 'no unexpected RPC')
      return f.status()
    },
    from(table: string) {
      assert.ok(['business_settings', 'service_templates'].includes(table), 'setup never reads another business surface')
      let uid: string | undefined
      const answer = () => {
        assert.equal(uid, user.id, 'every query is scoped to the authenticated account')
        f.reads.push({ table, uid })
        return { data: table === 'business_settings' ? f.settings : [], error: null, count: 0 }
      }
      const chain = {
        select: () => chain,
        eq: (column: string, value: string) => { assert.equal(column, 'user_id'); uid = value; return chain },
        maybeSingle: async () => answer(),
        then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve().then(answer).then(resolve, reject),
        upsert: async (row: Record<string, unknown>) => {
          assert.equal(row.user_id, user.id, 'creation remains scoped to the signed-in account')
          f.writes.push({ table, row: { ...row } })
          f.settings = { ...row }
          return { data: null, error: null }
        },
        insert: () => { throw new Error('Unexpected catalogue creation') },
        update: () => { throw new Error('Unexpected settings update') },
        delete: () => { throw new Error('Unexpected delete') },
      }
      return chain
    },
  }
  const router = { push: (path: string) => f.destinations.push(path), replace: (path: string) => f.destinations.push(path), refresh: () => {} }
  return { f, supabase, router }
}

function mount(kind: 'setup' | 'login' | 'dashboard', fixtureState: ReturnType<typeof fixture>) {
  const { f, supabase, router } = fixtureState
  const slots: any[] = []
  const pending: (() => void)[] = []
  let cursor = 0
  const hooks = {
    useState(value: unknown) {
      const i = cursor++
      if (!(i in slots)) slots[i] = typeof value === 'function' ? value() : value
      return [slots[i], (next: unknown) => { slots[i] = typeof next === 'function' ? next(slots[i]) : next }]
    },
    useMemo(factory: () => unknown) {
      const i = cursor++
      if (!(i in slots)) slots[i] = factory()
      return slots[i]
    },
    useEffect(effect: () => void | (() => void), deps: unknown[]) {
      const i = cursor++
      const previous = slots[i]
      if (!previous || deps.some((dep, j) => !Object.is(dep, previous.deps[j]))) {
        previous?.cleanup?.()
        slots[i] = { deps }
        pending.push(() => { slots[i].cleanup = effect() })
      }
    },
    Suspense: ({ children }: Record<string, any>) => children,
  }
  const wrapper = ({ children }: Record<string, any>) => jsx('div', { children })
  const modules: Record<string, any> = {
    react: hooks,
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
    'next/navigation': {
      useRouter: () => router,
      useSearchParams: () => new URLSearchParams(f.search),
      redirect: (path: string) => { throw new Error(`redirect:${path}`) },
    },
    'next/link': { default: (props: Record<string, any>) => jsx('a', props) },
    '@/lib/supabase/client': { createClient: () => supabase },
    '@/lib/supabase/server': { createClient: async () => supabase },
    '@/lib/registration': registration,
    '@/lib/onboarding/seed': seed,
    '@/lib/trades': trades,
    '@/lib/crewAccess': crew,
    '@/lib/googleAuth': google,
    '@/lib/passwordRecovery': recovery,
    '@/lib/authState': authState,
    '@/lib/utils': { cn: (...parts: unknown[]) => parts.filter(Boolean).join(' ') },
    '@/components/ui/Button': { Button: (props: Record<string, any>) => jsx('button', { ...props, disabled: props.disabled || props.loading }) },
    '@/components/ui/Input': { Input: (props: Record<string, any>) => jsx('input', props) },
    '@/components/ui/Banner': { Banner: wrapper },
    '@/components/auth/GoogleButton': { GoogleButton: () => null, AuthDivider: () => null },
    'lucide-react': new Proxy({}, { get: () => () => null }),
  }
  const path = kind === 'dashboard' ? 'src/app/dashboard/layout.tsx' : `src/app/${kind}/page.tsx`
  const source = readFileSync(path, 'utf8') + (kind === 'login' ? '\nexport { LoginForm as ResumeLoginForm }' : '')
  const module = { exports: {} as Record<string, any> }
  runInNewContext(transformSync(source, { loader: 'tsx', format: 'cjs', jsx: 'automatic', target: 'es2022' }).code, {
    module,
    URLSearchParams,
    window: { location: { search: f.search, hash: '', pathname: kind === 'login' ? '/login' : '/setup' }, localStorage: { getItem: () => null } },
    require(id: string) {
      if (id in modules) return modules[id]
      // A row-less dashboard must redirect before any tenant component runs.
      if (kind === 'dashboard' && id.startsWith('@/components/')) return new Proxy({}, { get: () => () => { throw new Error('Unexpected dashboard render') } })
      throw new Error(`Unexpected import: ${id}`)
    },
  })
  const component = module.exports[kind === 'login' ? 'ResumeLoginForm' : 'default']
  const render = () => {
    cursor = 0
    const tree = component({ children: null })
    while (pending.length) pending.shift()!()
    return tree
  }
  return {
    render,
    async settle() { render(); await drain(); render(); await drain() },
    snapshot() { const tree = render(); return { text: text(tree), nodes: nodes(tree) } },
    button(label: string) {
      const button = this.snapshot().nodes.find(node => node.type === 'button' && text(node).trim() === label)
      assert.ok(button, `rendered button: ${label}`)
      assert.ok(!button.props.disabled, `enabled button: ${label}`)
      return button
    },
    async click(label: string) { await this.button(label).props.onClick(); await this.settle() },
    dispose() { for (const slot of slots) slot?.cleanup?.() },
  }
}

let passed = 0
const check = (name: string, fn: () => void) => { fn(); passed++; console.log(`  PASS ${name}`) }
const noCreationControls = (page: ReturnType<typeof mount>) => {
  const view = page.snapshot()
  assert.ok(!view.nodes.some(n => n.type === 'input' || (n.type === 'button' && /Create|Skip|Set up my business/.test(text(n)))), 'unknown account has no business creation controls')
}

async function main() {
  const interrupted = fixture()
  interrupted.f.search = '?intent=register'
  const fresh = mount('setup', interrupted)
  await fresh.settle()
  check('confirmed registration reaches setup without creating a business', () => {
    assert.match(fresh.snapshot().text, /Set up your business/)
    assert.equal(interrupted.f.writes.length, 0)
  })
  fresh.dispose()
  await interrupted.supabase.auth.signOut({ scope: 'local' })
  interrupted.f.search = ''
  const login = mount('login', interrupted)
  await login.settle()
  for (const [type, value] of [['email', user.email], ['password', 'synthetic-password']]) {
    const input = login.snapshot().nodes.find(n => n.type === 'input' && n.props.type === type)
    assert.ok(input, `${type} input`)
    input.props.onChange({ target: { value } })
  }
  const form = login.snapshot().nodes.find(n => n.type === 'form')
  assert.ok(form)
  await form.props.onSubmit({ preventDefault() {} })
  check('ordinary password sign-in routes to dashboard with no registration intent or business write', () => {
    assert.deepEqual(interrupted.f.destinations, ['/dashboard'])
    assert.equal(interrupted.f.writes.length, 0)
  })
  login.dispose()
  await assert.rejects(mount('dashboard', interrupted).render(), /redirect:\/setup$/)
  check('row-less dashboard redirects to plain setup using only the authenticated tenant', () => {
    assert.equal(interrupted.f.writes.length, 0)
    assert.ok(interrupted.f.reads.every(read => read.uid === user.id))
  })
  const resumed = mount('setup', interrupted)
  await resumed.settle()
  check('returning signup is shown explicit create-business consent and neutral account details', () => {
    assert.match(resumed.snapshot().text, /No business yet/)
    assert.match(resumed.snapshot().text, /resume@example.invalid/)
    assert.doesNotMatch(resumed.snapshot().text, /Edge Property Services|Skip for now|Set up your business/)
    assert.equal(interrupted.f.writes.length, 0)
  })
  await resumed.click('Sign out')
  check('declining creation signs out locally and still creates nothing', () => {
    assert.equal(interrupted.f.signedIn, false)
    assert.equal(interrupted.f.signOutScopes.at(-1), 'local')
    assert.equal(interrupted.f.destinations.at(-1), '/login')
    assert.equal(interrupted.f.writes.length, 0)
  })
  resumed.dispose()

  for (const failure of ['resolved error', 'thrown error', 'malformed answer'] as const) {
    const f = fixture()
    f.f.status = async () => {
      if (failure === 'thrown error') throw new Error(failed.error.message)
      return failure === 'resolved error' ? failed : success({ unexpected: 'self-service' })
    }
    const page = mount('setup', f)
    await page.settle()
    check(`${failure}: unknown provisioning offers retry without creation controls, seed reads or private errors`, () => {
      noCreationControls(page)
      page.button('Try again')
      assert.doesNotMatch(page.snapshot().text, /private driver detail/)
      assert.equal(f.f.reads.length, 0)
      assert.equal(f.f.writes.length, 0)
    })
    let resolve!: (answer: Answer) => void
    f.f.status = () => new Promise<Answer>(r => { resolve = r })
    await page.click('Try again')
    check(`${failure}: retry waits without exposing creation or a repeated retry`, () => {
      noCreationControls(page)
      assert.equal(f.f.calls.filter(call => call === 'provisioning_status').length, 2, 'retry actually re-checks provisioning')
      assert.ok(!page.snapshot().nodes.some(n => n.type === 'button' && text(n).trim() === 'Try again'))
      assert.equal(f.f.writes.length, 0)
    })
    resolve(success('self-service'))
    await page.settle()
    check(`${failure}: recovered ordinary sign-in still requires explicit consent`, () => {
      assert.match(page.snapshot().text, /No business yet/)
      assert.doesNotMatch(page.snapshot().text, /Set up your business|Skip for now/)
      assert.equal(f.f.writes.length, 0)
    })
    await page.click('Create a business')
    check(`${failure}: consent reveals setup but creates no row itself`, () => {
      assert.match(page.snapshot().text, /Set up your business/)
      assert.equal(f.f.writes.length, 0)
    })
    await page.click('Create my business without a starter catalogue')
    check(`${failure}: explicit neutral creation writes only the current account and navigates`, () => {
      assert.deepEqual(f.f.writes, [{ table: 'business_settings', row: { user_id: user.id, business_type: 'general' } }])
      assert.equal(f.f.destinations.at(-1), '/dashboard')
    })
    page.dispose()
  }

  const registered = fixture()
  registered.f.search = '?intent=register'
  registered.f.status = async () => failed
  const registeredPage = mount('setup', registered)
  await registeredPage.settle()
  check('registration intent cannot bypass an unavailable account check', () => {
    noCreationControls(registeredPage)
    registeredPage.button('Try again')
    assert.equal(registered.f.writes.length, 0)
  })
  registered.f.status = async () => success('self-service')
  await registeredPage.click('Try again')
  check('valid registration intent still resumes directly to setup after a successful retry', () => {
    assert.match(registeredPage.snapshot().text, /Set up your business/)
    assert.doesNotMatch(registeredPage.snapshot().text, /No business yet/)
    assert.equal(registered.f.writes.length, 0)
  })
  registeredPage.dispose()

  for (const status of ['invited', 'already-owner', 'crew-account', 'email-unverified', 'closed']) {
    const f = fixture()
    f.f.status = async () => success(status)
    const page = mount('setup', f)
    await page.settle()
    check(`${status}: existing successful gate remains intact without automatic writes`, () => {
      if (status === 'invited' || status === 'already-owner') assert.match(page.snapshot().text, /Set up your business/)
      else noCreationControls(page)
      assert.equal(f.f.writes.length, 0)
    })
    page.dispose()
  }
  console.log(`\n${passed} signup resume checks passed; synthetic I/O only.`)
}
main().catch(error => { console.error(error); process.exitCode = 1 })
