// Called by verify-quote-builder: actual production hook, owner helper and cache
// in an isolated deterministic lifecycle host. This is not a React renderer;
// independent browser fixtures cover the real component/navigation lifecycle.
// No SDK, auth provider or transport is loaded. Storage is an in-memory Map.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

type Check = (name: string, passed: boolean, detail?: string) => void
type Draft = { customer: string; service: string; notes: string }
type Options = { key: string; value: Draft; ownership?: 'verified-owner'; canReplaceDraft?: boolean }
type Result = { draft: Draft | null; status: string; savedAt: number | null; restore(): Draft | null; discard(): void; clear(): void }
type Effect = { deps?: readonly unknown[]; fn(): void | (() => void); cleanup?: () => void }
type Sources = { autosave: string; owner: string; cache: string }
type Cache = {
  adoptCacheOwner(id: string): void; setCacheOwner(id: string | null): void; clearOwnedCaches(): void
  getCacheOwner(): string | null; getCacheGeneration(): number
  subscribeCacheOwner(fn: () => void): () => void
}
// Windows checkouts may use CRLF; exact multiline mutations must test the same
// source on either platform without changing or writing application bytes.
const read = (file: string) => readFileSync(join(process.cwd(), file), 'utf8').replace(/\r\n/g, '\n')
const compiled = new Map<string, string>()
function compile(source: string): string {
  if (!compiled.has(source)) compiled.set(source, ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText)
  return compiled.get(source)!
}
const blank: Draft = { customer: '', service: '', notes: '' }
const authored: Draft = { customer: 'customer-A', service: 'Owner A service', notes: 'Owner A private wording' }
const passive: Draft = { customer: 'customer-B', service: '', notes: '' }
const legacyKey = 'eq:autosave:quote:new'
const ownedKey = (owner: string) => `eq:autosave:owner:${encodeURIComponent(owner)}:quote:new`
const legacy = JSON.stringify({ value: authored, savedAt: 100 })
const envelope = (owner: string, value = authored) => JSON.stringify({ owner, value, savedAt: 100 })
const own = (value = blank): Options => ({ key: 'quote:new', value, ownership: 'verified-owner', canReplaceDraft: false })

function host(sources: Sources, initial: Record<string, string> = {}) {
  const storage = new Map(Object.entries(initial)), session = new Map<string, string>()
  const io: { actor: string; op: string; key: string }[] = []
  const microtasks: (() => void)[] = [], forms: Form[] = []
  const timers = new Map<number, { at: number; fn(): void }>()
  let now = 1000, timerId = 0, actor = 'hook', current: Form | null = null
  const act = <T>(who: string, fn: () => T): T => { const previous = actor; actor = who; try { return fn() } finally { actor = previous } }
  const store = (data: Map<string, string>) => ({
    get length() { return data.size }, key: (i: number) => [...data.keys()][i] ?? null,
    getItem(key: string) { io.push({ actor, op: 'read', key }); return data.get(key) ?? null },
    setItem(key: string, value: string) { io.push({ actor, op: 'write', key }); data.set(key, value) },
    removeItem(key: string) { io.push({ actor, op: 'remove', key }); data.delete(key) },
  })
  const localStorage = store(storage), sessionStorage = store(session)
  const same = (a?: readonly unknown[], b?: readonly unknown[]) => !!a && !!b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]))
  const activeForm = () => { if (!current) throw new Error('Hook outside a render'); return current }
  const hooks = {
    useState(initialValue: unknown) {
      const f = activeForm(), i = f.cursor++
      if (!(i in f.slots)) f.slots[i] = typeof initialValue === 'function' ? initialValue() : initialValue
      return [f.slots[i], (next: any) => {
        const previous = f.queued.has(i) ? f.queued.get(i) : f.slots[i]
        const value = typeof next === 'function' ? next(previous) : next
        if (!Object.is(previous, value)) { f.queued.set(i, value); f.dirty = true }
      }]
    },
    useRef(value: unknown) { const f = activeForm(), i = f.cursor++; return f.slots[i] ?? (f.slots[i] = { current: value }) },
    useCallback(fn: unknown, deps?: readonly unknown[]) {
      const f = activeForm(), i = f.cursor++, old = f.slots[i]
      if (!old || !same(old.deps, deps)) f.slots[i] = { deps, fn }
      return f.slots[i].fn
    },
    useEffect(fn: Effect['fn'], deps?: readonly unknown[]) {
      const f = activeForm(), i = f.cursor++, previous = f.effects.get(i)
      if (!previous || !same(previous.deps, deps)) f.pending.push(() => {
        previous?.cleanup?.()
        f.effects.set(i, { fn, deps, cleanup: fn() || undefined })
      })
    },
    useSyncExternalStore(subscribe: (fn: () => void) => () => void, snapshot: () => number) {
      const [, set] = hooks.useState(snapshot())
      hooks.useEffect(() => {
        const notify = () => (set as (value: number) => void)(snapshot())
        const unsubscribe = subscribe(notify); notify(); return unsubscribe
      }, [subscribe, snapshot])
      return snapshot()
    },
  }
  const loaded = new Map<string, any>()
  function load(name: keyof Sources): any {
    if (loaded.has(name)) return loaded.get(name)
    const mod = { exports: {} }; loaded.set(name, mod.exports)
    runInNewContext(compile(sources[name]), {
      module: mod, exports: mod.exports,
      require(id: string) {
        if (id === 'react') return hooks
        if (id === '@/hooks/useAutosaveOwner') return load('owner')
        if (id === '@/lib/clientCache') return load('cache')
        throw new Error(`Unexpected owned-autosave dependency: ${id}`)
      },
      window: { localStorage, sessionStorage }, localStorage, sessionStorage,
      Date: class extends Date { static now() { return now } },
      queueMicrotask: (fn: () => void) => microtasks.push(fn),
      setTimeout(fn: () => void, ms: number) { const id = ++timerId; timers.set(id, { at: now + ms, fn }); return id },
      clearTimeout: (id: number) => { timers.delete(id) },
    })
    return mod.exports
  }
  const cache = load('cache') as Cache
  const evaluateAutosave = load('autosave').useAutosave as (options: Options) => Result
  class Form {
    slots: any[] = []; queued = new Map<number, unknown>(); effects = new Map<number, Effect>()
    cursor = 0; dirty = false; pending: (() => void)[] = []; result!: Result; mounted = true
    constructor(public options: Options) {}
    publish() { for (const [i, value] of this.queued) this.slots[i] = value; this.queued.clear() }
    render(options = this.options, publishState = true): Result {
      this.options = options
      if (publishState) this.publish()
      let rounds = 0
      do {
        if (++rounds > 30) throw new Error('Owned autosave failed to settle')
        this.cursor = 0; this.pending = []; this.dirty = false; current = this
        try { this.result = evaluateAutosave(this.options) } finally { current = null }
        for (const effect of this.pending) effect()
        if (publishState) this.publish()
      } while (this.dirty && publishState)
      return this.result
    }
    cleanup() { for (const effect of this.effects.values()) effect.cleanup?.() }
    // Execute committed effect cleanup/setup, preserving refs/state, like a
    // StrictMode effect replay. Optional parent callbacks model CacheOwner.
    replay(parentCleanup = () => {}, parentSetup = () => {}) {
      parentCleanup(); this.cleanup(); parentSetup()
      for (const effect of this.effects.values()) effect.cleanup = effect.fn() || undefined
      this.render(); flush()
    }
    unmount() { this.cleanup(); this.mounted = false }
  }
  function flush() {
    let rounds = 0
    do {
      if (++rounds > 30) throw new Error('Owner notifications failed to settle')
      while (microtasks.length) microtasks.shift()!()
      for (const f of forms) if (f.mounted && f.dirty) f.render()
    } while (microtasks.length || forms.some(f => f.mounted && f.dirty))
  }
  return {
    cache, storage, io, pendingTimers: () => timers.size,
    form(options = own(), publishState = true) { const f = new Form(options); forms.push(f); f.render(options, publishState); return f },
    adopt(id: string) { act('cache', () => cache.adoptCacheOwner(id)) },
    signOut() { act('cache', () => cache.clearOwnedCaches()); act('cache', () => cache.setCacheOwner(null)) },
    invalidate() { act('cache', () => cache.clearOwnedCaches()) },
    flush,
    advance(ms = 1000, publish = true) {
      const end = now + ms
      while (true) {
        const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) break
        timers.delete(next[0]); now = next[1].at; act('hook', next[1].fn)
        if (publish) flush()
      }
      now = end; if (publish) flush()
    },
    close() { forms.forEach(f => f.unmount()); flush() },
  }
}

function exercise(sources: Sources): [string, boolean][] {
  const out: [string, boolean][] = [], expect = (name: string, passed: boolean) => out.push([name, passed])
  const saved = (h: ReturnType<typeof host>, key: string) => {
    const raw = h.storage.get(key)
    return raw ? JSON.parse(raw) : { value: {} }
  }
  const A = 'owner-A', B = 'owner-B', aKey = ownedKey(A), bKey = ownedKey(B), aBytes = envelope(A)
  {
    const h = host(sources, { [legacyKey]: legacy, [aKey]: aBytes }); h.adopt(A)
    const f = h.form(); f.render(own(passive)); h.advance()
    expect('owned passive fills preserve original bytes and offer only owner A', h.storage.get(aKey) === aBytes && f.result.draft?.notes === authored.notes)
    expect('owned hook never reads, writes or removes the legacy draft', h.storage.get(legacyKey) === legacy && !h.io.some(x => x.actor === 'hook' && x.key === legacyKey))
    const recovered = f.result.restore(); f.render(own(recovered!)); h.advance()
    expect('owned Restore releases recovery and retains the complete value', f.result.draft === null && saved(h, aKey).value.notes === authored.notes)
    const next = { ...passive, service: 'Owner A new wording' }; f.render({ ...own(next), canReplaceDraft: true }); h.advance()
    const written = saved(h, aKey)
    expect('owned writes use captured owner stamp and exact form values', written.owner === A && JSON.stringify(written.value) === JSON.stringify(next) && typeof written.savedAt === 'number')
    h.close()
  }
  for (const bad of [legacy, envelope(B)]) {
    const h = host(sources, { [legacyKey]: legacy, [aKey]: bad }); h.adopt(A)
    const f = h.form(); f.render(own(passive)); h.advance()
    expect(`${bad === legacy ? 'unstamped' : 'wrong-owner'} owned envelope stays inert through passive initialization`, f.result.draft === null && f.result.restore() === null && h.storage.get(aKey) === bad)
    f.render({ ...own({ ...passive, notes: 'A deliberately replaced its slot' }), canReplaceDraft: true }); h.advance()
    expect('a deliberate edit may replace only the current owned slot', saved(h, aKey).owner === A && h.storage.get(legacyKey) === legacy)
    h.close()
  }
  {
    const h = host(sources, { [legacyKey]: legacy, [aKey]: aBytes })
    const f = h.form(); f.render({ ...own(passive), canReplaceDraft: true }); h.advance()
    f.result.clear(); f.result.discard()
    expect('unknown owner neither offers, restores nor touches drafts', f.result.draft === null && f.result.restore() === null && h.storage.get(aKey) === aBytes && h.io.length === 0)
    h.adopt(A); h.flush(); f.render({ ...own(authored), canReplaceDraft: true }); h.advance()
    expect('initially unknown instance never acquires later owner authority', f.result.draft === null && h.storage.get(aKey) === aBytes)
    const fresh = h.form(); expect('fresh verified mount can recover its own draft', fresh.result.draft?.notes === authored.notes)
    h.close()
  }
  {
    const h = host(sources, { [legacyKey]: legacy, [aKey]: aBytes }); h.adopt(A)
    const f = h.form(), stale = f.result
    // Sign-out invalidates before auth finishes, while owner ID is still A.
    h.invalidate()
    expect('generation invalidation immediately refuses stale Restore', stale.restore() === null)
    stale.discard(); stale.clear()
    expect('stale Discard and delayed-save clear leave original bytes intact', h.storage.get(aKey) === aBytes)
    h.flush()
    expect('generation-only notification hides stale recovery UI', f.result.draft === null && f.result.savedAt === null && f.result.status === 'idle')
    h.signOut(); h.adopt(B); h.flush()
    f.render({ ...own({ ...authored, service: 'Old A form still editable' }), canReplaceDraft: true }); h.advance()
    expect('existing A form never writes its values to B or its old A slot', !h.storage.has(bKey) && h.storage.get(aKey) === aBytes)
    const b = h.form(); b.render({ ...own({ ...passive, notes: 'Owner B own notes' }), canReplaceDraft: true }); h.advance()
    expect('new B form saves only B data', saved(h, bKey).owner === B && h.storage.get(aKey) === aBytes)
    stale.clear(); stale.discard(); expect('old A cleanup cannot delete current B draft', h.storage.has(bKey))
    h.signOut(); h.adopt(A); h.flush()
    expect('returning to A does not revive old A handlers or recovery UI', stale.restore() === null && f.result.draft === null)
    stale.clear(); stale.discard()
    expect('A can recover after a genuine remount and B retains its own slot', h.form().result.draft?.notes === authored.notes && h.storage.has(bKey) && h.storage.get(aKey) === aBytes)
    h.close()
  }
  {
    const h = host(sources, { [legacyKey]: legacy }); h.adopt(A)
    const f = h.form(); f.render({ ...own(authored), canReplaceDraft: true })
    h.invalidate()
    // Deliberately do not publish the queued owner notification before the
    // timer fires: callback-time lease validation is independently required.
    h.advance(1000, false)
    expect('stale write timer refuses storage before UI publication', !h.storage.has(aKey) && h.storage.get(legacyKey) === legacy)
    h.flush(); h.close()
  }
  for (const action of ['clear', 'discard'] as const) {
    const h = host(sources); h.adopt(A)
    const f = h.form(); f.render({ ...own(authored), canReplaceDraft: true }); f.result[action](); h.flush(); h.advance(4000)
    expect(`owned ${action} cancels its pending write`, !h.storage.has(aKey) && f.result.status === 'idle')
    h.close()
    const other = host(sources, { [legacyKey]: legacy, [aKey]: aBytes, [bKey]: envelope(B, passive) }); other.adopt(B)
    const b = other.form(); b.result[action](); other.flush()
    expect(`B ${action} removes only its own slot and preserves A and legacy bytes`, !other.storage.has(bKey) && other.storage.get(aKey) === aBytes && other.storage.get(legacyKey) === legacy)
    b.render({ ...own(passive), canReplaceDraft: true }); other.advance()
    const waiting = other.pendingTimers() === 1
    b.result[action](); other.flush()
    expect(`owned ${action} cancels an already scheduled saved-status timer`, waiting && other.pendingTimers() === 0 && b.result.status === 'idle')
    other.close()
  }
  for (const parentReplay of [false, true]) {
    const h = host(sources, { [aKey]: aBytes }); h.adopt(A)
    const f = h.form(), old = f.result
    f.replay(parentReplay ? () => h.cache.setCacheOwner(null) : undefined, parentReplay ? () => h.adopt(A) : undefined)
    expect(`StrictMode ${parentReplay ? 'with CacheOwner' : 'child-only'} setup gets healthy new binding`, f.result.draft?.notes === authored.notes)
    expect('StrictMode old setup token cannot Restore or clear the replayed draft', old.restore() === null && (old.clear(), h.storage.get(aKey) === aBytes))
    f.result.restore(); f.render({ ...own({ ...authored, notes: 'After replay' }), canReplaceDraft: true }); h.advance()
    expect('StrictMode replay permits subsequent deliberate autosave', saved(h, aKey).value.notes === 'After replay')
    h.close()
  }
  {
    const h = host(sources, { [aKey]: aBytes }); h.adopt(A)
    const f = h.form(), old = f.result; f.unmount()
    expect('unmounted setup cannot Restore or clear even with unchanged owner generation', old.restore() === null && (old.clear(), h.storage.get(aKey) === aBytes))
    h.close()
  }
  for (const key of ['customer:new', 'quote:saved-fixture']) {
    const target = `eq:autosave:${key}`, h = host(sources, { [target]: legacy })
    const f = h.form({ key, value: blank }); expect(`${key} default recovery remains available without a verified owner`, f.result.draft?.notes === authored.notes)
    f.render({ key, value: passive }); h.advance()
    const stored = saved(h, target)
    expect(`${key} default writes preserve the old unowned payload contract`, !('owner' in stored) && stored.value.customer === passive.customer)
    h.close()
  }
  {
    const id = 'synthetic/owner:with-space ', h = host(sources); h.adopt(id)
    const f = h.form(); f.render({ ...own(authored), canReplaceDraft: true }); h.advance()
    expect('owner key encodes the exact verified identity without normalization', h.storage.has(ownedKey(id)) && saved(h, ownedKey(id)).owner === id)
    h.close()
  }
  return out
}

export function verifyAutosaveOwnership(check: Check): void {
  const sources: Sources = { autosave: read('src/hooks/useAutosave.ts'), owner: read('src/hooks/useAutosaveOwner.ts'), cache: read('src/lib/clientCache.ts') }
  for (const [name, passed] of exercise(sources)) check(name, passed)
  const mutations: [string, keyof Sources, string, string][] = [
    ['owner stamp validation', 'autosave', "if (guarded && parsed?.owner !== binding!.lease.owner)", 'if (false)'],
    ['mismatch passive protection', 'autosave', 'pendingDraft.current = true\n          return', 'return'],
    ['owner namespace', 'owner', '`eq:autosave:owner:${encodeURIComponent(lease.owner)}:${key}`', '`eq:autosave:${key}`'],
    ['lease fence', 'owner', 'isCurrentLease(binding.lease)', 'true'],
    ['setup token cleanup', 'owner', 'if (next) next.active = false', 'if (next) void next'],
    ['write-time lease check', 'autosave', 'timer.current = setTimeout(() => {\n      if (guarded && !isActiveAutosaveOwner(binding, key)) return', 'timer.current = setTimeout(() => {'],
    ['Restore fence', 'autosave', 'const restore = useCallback((): T | null => {\n    if (guarded && !isActiveAutosaveOwner(binding, key)) return null', 'const restore = useCallback((): T | null => {'],
    ['clear fence', 'autosave', 'const clear = useCallback(() => {\n    if (guarded && !isActiveAutosaveOwner(binding, key)) return', 'const clear = useCallback(() => {'],
    ['clear pending timer', 'autosave', 'if (guarded) {\n      if (timer.current) clearTimeout(timer.current)', 'if (guarded) {'],
    ['clear saved-status timer', 'autosave', 'if (timer.current) clearTimeout(timer.current)\n      if (statusTimer.current) clearTimeout(statusTimer.current)', 'if (timer.current) clearTimeout(timer.current)'],
    ['generation-only notification', 'cache', 'export function clearOwnedCaches(): void {\n  gen++\n  notifyCacheOwner()', 'export function clearOwnedCaches(): void {\n  gen++'],
    ['write owner stamp', 'autosave', '? { owner: binding!.lease.owner, value, savedAt: now }', "? { owner: 'wrong-owner', value, savedAt: now }"],
  ]
  for (const [name, file, before, after] of mutations) {
    const changed = sources[file].replace(before, after)
    let failed: string[] = []
    if (changed !== sources[file]) {
      try { failed = exercise({ ...sources, [file]: changed }).filter(([, passed]) => !passed).map(([label]) => label) }
      catch (error) { throw new Error(`Mutation ${name} crashed the harness instead of reaching a behavioral assertion: ${String(error)}`) }
    }
    check(`ownership mutation caught: ${name}`, changed !== sources[file] && failed.length > 0, changed === sources[file] ? 'mutation anchor missing' : failed.slice(0, 2).join('; '))
  }
  const qb = ts.createSourceFile('QuoteBuilder.tsx', read('src/components/quotes/QuoteBuilder.tsx'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let expression: ts.Expression | undefined
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(qb) === 'useAutosave') {
      const options = node.arguments[0]
      if (options && ts.isObjectLiteralExpression(options)) {
        const member = options.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(qb) === 'ownership')
        if (member && ts.isPropertyAssignment(member)) expression = member.initializer
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(qb)
  check('default QuoteBuilder expression opts in only new quotes', !!expression &&
    runInNewContext(expression.getText(qb), { isEdit: false, pilotSave: undefined }) === 'verified-owner' &&
    runInNewContext(expression.getText(qb), { isEdit: true, pilotSave: undefined }) === undefined)
  const customer = read('src/components/customers/CustomerForm.tsx')
  check('CustomerForm creation opts in while edits retain the default contract',
    customerOptions(customer, { isEdit: false }, {}).ownership === 'verified-owner' &&
    customerOptions(customer, {}, {}).ownership === 'verified-owner' &&
    customerOptions(customer, { isEdit: true }, {}).ownership === undefined)
}

// Consumer integration: evaluate the actual call-site props and entire form
// options expression, then pass those options to the same production-hook host.
// This complements (does not repeat) the owner/generation matrix above.
function customerOptionsAst(source: string) {
  const ast = ts.createSourceFile('CustomerForm.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const options: ts.ObjectLiteralExpression[] = []
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useAutosave' &&
        node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0])) options.push(node.arguments[0])
    ts.forEachChild(node, visit)
  }
  visit(ast)
  if (options.length !== 1) throw new Error('Expected the one CustomerForm autosave options object')
  return { ast, options: options[0] }
}

function customerOptions(source: string, props: Record<string, unknown>, value: Record<string, unknown>): Options {
  const { ast, options } = customerOptionsAst(source)
  return runInNewContext(`(${options.getText(ast)})`, {
    autosaveKey: undefined, isEdit: undefined, baselineUpdatedAt: undefined, ...props, formValues: value,
  }) as Options
}

function customerCallerProps(source: string, context: Record<string, unknown>): Record<string, unknown> {
  const ast = ts.createSourceFile('customer-page.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const forms: ts.JsxSelfClosingElement[] = []
  const visit = (node: ts.Node) => {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === 'CustomerForm') forms.push(node)
    ts.forEachChild(node, visit)
  }
  visit(ast)
  if (forms.length !== 1) throw new Error('Expected one actual CustomerForm call in each supported page')
  const props: Record<string, unknown> = {}
  for (const member of forms[0].attributes.properties) {
    if (ts.isJsxSpreadAttribute(member)) throw new Error('Review customer props spread before assuming its ownership flags')
    const key = member.name.getText(ast)
    if (!['isEdit', 'autosaveKey', 'baselineUpdatedAt'].includes(key)) continue
    if (!member.initializer) props[key] = true
    else if (ts.isJsxExpression(member.initializer) && member.initializer.expression) {
      props[key] = runInNewContext(member.initializer.expression.getText(ast), context)
    } else if (ts.isStringLiteral(member.initializer)) props[key] = member.initializer.text
    else throw new Error(`Unsupported CustomerForm ${key} expression`)
  }
  return props
}

export function verifyCustomerAutosaveIntegration(check: Check): void {
  const sources: Sources = { autosave: read('src/hooks/useAutosave.ts'), owner: read('src/hooks/useAutosaveOwner.ts'), cache: read('src/lib/clientCache.ts') }
  const source = read('src/components/customers/CustomerForm.tsx')
  const page = read('src/app/dashboard/customers/page.tsx')
  const detail = read('src/app/dashboard/customers/[id]/page.tsx')
  const createProps = customerCallerProps(page, { editing: null })
  const editRecord = { id: 'existing-customer', updated_at: '1970-01-01T00:00:00.001Z' }
  const editProps = [
    ['Customers-page edit', customerCallerProps(page, { editing: editRecord })],
    ['customer-profile edit', customerCallerProps(detail, { customer: editRecord })],
  ] as const
  const initial = { name: '', email: '', phone: '', notes: '', tags: [], sms_opt_in: false, email_opt_in: false }
  const aValue = { ...initial, name: 'A synthetic contact', email: 'a@example.test', notes: 'A private intake wording' }
  const bValue = { ...initial, name: 'B synthetic contact', phone: '4035550102', notes: 'B own intake wording' }
  const legacyValue = { ...initial, name: 'Unattributed old contact', notes: 'Do not assign this legacy wording' }
  const plain = (value: object) => JSON.stringify({ value, savedAt: 100 })
  const stamped = (owner: string, value: object) => JSON.stringify({ owner, value, savedAt: 100 })
  const oldKey = 'eq:autosave:customer:new', aKey = 'eq:autosave:owner:owner-A:customer:new', bKey = 'eq:autosave:owner:owner-B:customer:new'
  const exerciseConsumer = (formSource: string): [string, boolean][] => {
    const outcomes: [string, boolean][] = [], expect = (label: string, passed: boolean) => outcomes.push([label, passed])
    const options = (props: Record<string, unknown>, value: Record<string, unknown>) => customerOptions(formSource, props, value)
    {
      const h = host(sources, { [oldKey]: plain(legacyValue), [aKey]: stamped('owner-A', aValue), [bKey]: stamped('owner-B', bValue) }); h.adopt('owner-A')
      const a = h.form(options(createProps, initial))
      expect('actual Add customer props restore only the current owner contact', JSON.stringify(a.result.restore()) === JSON.stringify(aValue))
      expect('create consumer never accesses or changes the legacy customer slot', !h.io.some(x => x.actor === 'hook' && x.key === oldKey) && h.storage.get(oldKey) === plain(legacyValue))
      h.signOut(); h.adopt('owner-B'); h.flush()
      const b = h.form(options(createProps, initial))
      expect('same actual create consumer recovers B own contact after account change', JSON.stringify(b.result.restore()) === JSON.stringify(bValue))
      h.close()
    }
    {
      const h = host(sources, { [oldKey]: plain(legacyValue) })
      const f = h.form(options(createProps, initial))
      expect('actual create consumer is dormant without verified ownership', f.result.draft === null && f.result.restore() === null && h.io.length === 0)
      h.close()
    }
    {
      const h = host(sources, { [oldKey]: plain(legacyValue) }); h.adopt('owner-A')
      const f = h.form(options(createProps, initial)); f.render(options(createProps, aValue)); h.advance()
      const raw = h.storage.get(aKey), written = raw ? JSON.parse(raw) : null
      expect('actual create key and options persist exact contact values with owner stamp', written?.owner === 'owner-A' && JSON.stringify(written.value) === JSON.stringify(aValue) && h.storage.get(oldKey) === plain(legacyValue))
      h.close()
    }
    {
      const h = host(sources, { [aKey]: stamped('owner-A', aValue) }); h.adopt('owner-A')
      expect('omitted isEdit still has the established create meaning', JSON.stringify(h.form(options({}, initial)).result.restore()) === JSON.stringify(aValue))
      h.close()
    }
    for (const [label, props] of editProps) {
      const key = 'eq:autosave:customer:existing-customer', h = host(sources, { [key]: plain(aValue) }); h.adopt('owner-A')
      const f = h.form(options(props, initial))
      expect(`${label} retains original unowned recovery through its actual props`, JSON.stringify(f.result.restore()) === JSON.stringify(aValue))
      f.render(options(props, bValue)); h.advance()
      const raw = h.storage.get(key), written = raw ? JSON.parse(raw) : null
      expect(`${label} retains its existing key and unstamped write contract`, written && !('owner' in written) && JSON.stringify(written.value) === JSON.stringify(bValue))
      h.close()
    }
    return outcomes
  }
  for (const [label, passed] of exerciseConsumer(source)) check(label, passed)
  const { ast, options } = customerOptionsAst(source)
  const ownership = options.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(ast) === 'ownership')
  if (!ownership || !ts.isPropertyAssignment(ownership)) throw new Error('Customer ownership mutation target missing')
  for (const [label, replacement] of [
    ['removing create ownership', '...{}'],
    ['inverting create/edit ownership', "ownership: isEdit ? 'verified-owner' : undefined"],
    ['broadening ownership to edits', "ownership: 'verified-owner'"],
  ]) {
    const mutant = source.slice(0, ownership.getStart(ast)) + replacement + source.slice(ownership.getEnd())
    // Every observation below comes from the real hook's recovery/storage
    // output, not from a substring or a direct comparison of the option itself.
    const failed = exerciseConsumer(mutant).filter(([, passed]) => !passed)
    check(`customer consumer mutation caught: ${label}`, failed.length > 0, failed.map(([name]) => name).slice(0, 2).join('; '))
  }
}
