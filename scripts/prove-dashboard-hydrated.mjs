// ── Interaction proof for the HYDRATED Customize sheet ───────────────────────
//   CSS_DIR=<...>/.next/static/css npx tsx --tsconfig tsconfig.harness.json scripts/dashboard-hydrated-harness.tsx
//   node scripts/prove-dashboard-hydrated.mjs [.dashboard-hydrated]
//
// Drives real headless Chrome over CDP against the hydrated fixture at
// 375 / 390 / 430 (touch emulated, asserted; taps are touch events) and 1280
// (mouse). Every input is a real key or pointer event through Chrome's input
// pipeline into the real handlers — nothing calls a React prop directly.
// Per width:
//   • hydration committed; zero recoverable hydration errors; zero console
//     errors / uncaught exceptions; every request the page makes is file://
//   • OPEN by keyboard (Tab to the trigger, Enter): a labelled aria-modal
//     dialog appears, focus lands on the panel, body scroll is locked
//   • TRAP: Tab visits exactly the dialog's enabled controls in DOM order and
//     wraps last→first; Shift+Tab wraps first→last; nothing outside is reached;
//     disabled controls (required switch, end-of-list arrows, hidden-row
//     arrows, a clean Save) are never visited
//   • STATE: Space/Enter on a switch flips aria-checked, its name, the row's
//     dim state, its arrows, Save's enabled state and Reset's presence; Enter /
//     Space on an arrow reorders the rows; a hidden card is skipped over;
//     disabled switches and arrows do nothing when tapped; Reset restores the
//     default; Ctrl+Enter and Save reach the "Not signed in" refusal with the
//     dialog still open and no request leaving the page
//   • CLOSE: Escape closes and returns focus to the trigger; Cancel closes and
//     the next open shows the untouched initial layout (a DRAFT); backdrop tap
//     closes; on phones a swipe past the threshold on the grab handle closes
//     and a short one snaps back
// Not covered (needs a signed-in session, i.e. production auth): a successful
// Save, router.refresh and the server re-render of the bands.
// Read-only dev tooling; `next build` never invokes it.

import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'

const DIR = resolve(process.argv[2] || '.dashboard-hydrated')
const SHOTS = resolve(process.env.SHOTS_DIR || join(DIR, 'shots'))
mkdirSync(SHOTS, { recursive: true })
const WIDTHS = [375, 390, 430, 1280]
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9342
let failures = 0, checks = 0
const ok = n => { checks++; console.log(`  ✓ ${n}`) }
const fail = (n, d = '') => { checks++; failures++; console.log(`  ✗ ${n}${d ? `\n      ${d}` : ''}`) }
const check = (n, c, d = '') => (c ? ok(n) : fail(n, d))
const info = n => console.log(`  ℹ ${n}`)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const now = () => new Date().toISOString()

let ws, nextId = 1
const pending = new Map()
const events = { requests: [], consoleErrors: [], exceptions: [], logErrors: [] }
const send = (method, params = {}) => new Promise((res, rej) => { const id = nextId++; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })) })
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval threw')
  return r.result.value
}
const keyEvent = async (type, key, code, vk, extra = {}) =>
  send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: vk, ...extra })
const press = async (key, code, vk, { modifiers = 0, text } = {}) => {
  await keyEvent('keyDown', key, code, vk, { modifiers, ...(text ? { text, unmodifiedText: text } : {}) })
  await keyEvent('keyUp', key, code, vk, { modifiers })
  await sleep(60)
}
const K = {
  tab: () => press('Tab', 'Tab', 9),
  shiftTab: () => press('Tab', 'Tab', 9, { modifiers: 8 }),
  enter: () => press('Enter', 'Enter', 13, { text: '\r' }),
  ctrlEnter: () => press('Enter', 'Enter', 13, { modifiers: 2 }),
  space: () => press(' ', 'Space', 32, { text: ' ' }),
  escape: () => press('Escape', 'Escape', 27),
}
let phone = false
async function tapAt(x, y) {
  if (phone) {
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  } else {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  }
  await sleep(80)
}
// Tap the CENTRE of a control found by accessible name — through the same
// pipeline a finger or a mouse uses, so a disabled control's inertness is
// Chrome's, not ours.
async function tap(finder) {
  const r = await evaluate(`(() => { const el = ${finder}; if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, w: b.width, h: b.height } })()`)
  if (!r) throw new Error(`tap: nothing matched ${finder}`)
  await tapAt(r.x, r.y)
  return r
}
async function swipeHandle(dy) {
  const r = await evaluate(`(() => { const el = document.querySelector('[role="dialog"] .touch-none'); if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 } })()`)
  if (!r) throw new Error('swipe: no grab handle')
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: r.x, y: r.y }] })
  for (let i = 1; i <= 6; i++) { await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: r.x, y: r.y + dy * i / 6 }] }); await sleep(16) }
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await sleep(300)
}
async function shot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(data, 'base64'))
}

// Page-side readers. Titles come from the row's title span minus the
// "Always shown" tag; the dialog's own FOCUSABLE rule is copied verbatim from
// hooks/useFocusTrap so "expected" is what the Modal itself will trap.
const HELPERS = `(() => {
  const FOCUSABLE = 'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])'
  const name = el => (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim().replace(/\\s+/g, ' ')
  const dialog = () => document.querySelector('[role="dialog"]')
  window.__fx = {
    dialog,
    open: () => !!dialog(),
    trigger: () => document.querySelector('button[aria-label="Customize dashboard"]'),
    byLabel: l => document.querySelector('button[aria-label="' + l + '"]'),
    byText: t => [...(dialog()?.querySelectorAll('button') ?? [])].find(b => b.textContent.trim().replace(/\\s+/g, ' ') === t) || null,
    dialogInfo: () => { const d = dialog(); if (!d) return null; const lab = d.getAttribute('aria-labelledby'); return { modal: d.getAttribute('aria-modal'), label: lab ? document.getElementById(lab)?.textContent.trim() : null, bodyOverflow: document.body.style.overflow } },
    focus: () => { const el = document.activeElement; if (!el || el === document.body) return { tag: 'body', name: '', inDialog: false, isPanel: false, isTrigger: false, ring: false }; const cs = getComputedStyle(el); const d = dialog(); return { tag: el.tagName.toLowerCase(), role: el.getAttribute('role'), name: name(el).slice(0, 60), inDialog: !!(d && d.contains(el)), isPanel: el === d, isTrigger: el === window.__fx.trigger(), hidden: !!el.closest('[aria-hidden="true"]'), ring: cs.boxShadow !== 'none' || cs.outlineStyle !== 'none' } },
    expected: () => { const d = dialog(); return d ? [...d.querySelectorAll(FOCUSABLE)].filter(el => el.offsetParent !== null).map(name) : [] },
    order: () => [...(dialog()?.querySelectorAll('ol > li') ?? [])].map(li => li.querySelector('span.block').textContent.replace(/Always shown$/, '').trim()),
    rows: () => [...(dialog()?.querySelectorAll('ol > li') ?? [])].map(li => { const sw = li.querySelector('[role="switch"]'); const [up, down] = [...li.querySelectorAll('button')].filter(b => b !== sw); return { title: li.querySelector('span.block').textContent.replace(/Always shown$/, '').trim(), checked: sw.getAttribute('aria-checked') === 'true', swDisabled: sw.disabled, swName: sw.getAttribute('aria-label'), dim: /opacity-55/.test(li.className), upDisabled: up.disabled, downDisabled: down.disabled } }),
    row: t => window.__fx.rows().find(r => r.title === t),
    save: () => { const b = window.__fx.byText('Save'); return b ? { disabled: b.disabled, busy: b.getAttribute('aria-busy') } : null },
    reset: () => !!window.__fx.byText('Reset'),
    toasts: () => [...document.querySelectorAll('[aria-live="polite"] [role="alert"], [aria-live="polite"] > div')].map(el => el.textContent.trim().replace(/\\s+/g, ' ')),
    hydration: () => ({ marked: document.documentElement.getAttribute('data-hydrated') === '1', errors: window.__hydrationErrors || ['(no __hydrationErrors — bundle did not run)'] }),
  }
  return true
})()`

const DEFAULT_ORDER = ['Money', 'Needs you', 'Today & next days', 'This month', 'Weekly review', 'Recent updates']
// The default layout's trap list, derived by hand from lib/dashboard/layout:
// needsYou required (switch disabled); Money first (up disabled); Weekly
// review last visible (down disabled); Recent updates hidden (arrows disabled,
// switch says Show); Save disabled while the draft is clean; Reset absent.
const DEFAULT_TRAP = ['Close',
  'Hide Money', 'Move Money down',
  'Move Needs you up', 'Move Needs you down',
  'Hide Today & next days', 'Move Today & next days up', 'Move Today & next days down',
  'Hide This month', 'Move This month up', 'Move This month down',
  'Hide Weekly review', 'Move Weekly review up',
  'Show Recent updates',
  'Cancel']
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const profile = join(process.env.TEMP || '.', 'eq-cdp-profile-s97-hydrated')
if (!existsSync(join(DIR, 'index.html')) || !existsSync(join(DIR, 'bundle.js'))) { console.error(`no fixture in ${DIR} — run the harness first`); process.exit(2) }
console.log(`start ${now()}  fixture ${DIR}`)
try { const m = JSON.parse(readFileSync(join(DIR, 'manifest.json'), 'utf8')); console.log(`manifest: head ${m.head}  html ${m.html.sha256.slice(0, 16)}  bundle ${m.bundle.sha256.slice(0, 16)}  css ${m.css.map(c => c.sha256.slice(0, 16)).join(',')}`) } catch { console.log('manifest: missing') }
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run', '--no-default-browser-check',
  `--user-data-dir=${profile}`, '--hide-scrollbars', '--allow-file-access-from-files', 'about:blank'], { stdio: 'ignore' })
process.on('exit', () => { try { chrome.kill() } catch {} })

async function main() {
  let target = null
  for (let i = 0; i < 60 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(t => t.type === 'page') } catch {}
    if (!target) await sleep(250)
  }
  if (!target) throw new Error('Chrome never opened its debugging port')
  const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json().catch(() => ({}))
  console.log(`chrome ${version.Browser || '?'}`)
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP socket failed')) })
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); return }
    if (m.method === 'Network.requestWillBeSent') events.requests.push(m.params.request.url)
    if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) events.consoleErrors.push(`${m.params.type}: ${m.params.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 200)}`)
    if (m.method === 'Runtime.exceptionThrown') events.exceptions.push((m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || '').slice(0, 200))
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') events.logErrors.push(`${m.params.entry.source}: ${m.params.entry.text}`.slice(0, 200))
  }
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable'); await send('Log.enable')
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  const url = 'file:///' + join(DIR, 'index.html').replace(/\\/g, '/')

  for (const width of WIDTHS) {
    phone = width < 1000
    const tag = `hydrated-${width}`
    console.log(`\n─ ${width} (${phone ? 'touch' : 'mouse'}) ─`)
    const before = { req: events.requests.length, con: events.consoleErrors.length, exc: events.exceptions.length, log: events.logErrors.length }
    await send('Emulation.setTouchEmulationEnabled', phone ? { enabled: true, maxTouchPoints: 5 } : { enabled: false })
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'pointer', value: phone ? 'coarse' : 'fine' }, { name: 'hover', value: phone ? 'none' : 'hover' }, { name: 'prefers-reduced-motion', value: 'reduce' }] })
    await send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 2, mobile: phone })
    await send('Page.navigate', { url })
    let hydrated = false
    for (let i = 0; i < 80 && !hydrated; i++) { try { hydrated = await evaluate('document.documentElement.getAttribute("data-hydrated") === "1"') } catch {} if (!hydrated) await sleep(125) }
    await evaluate(HELPERS)
    const hy = await evaluate('window.__fx.hydration()')
    check('React committed the hydrated tree (data-hydrated set by an effect)', hy.marked)
    check('zero recoverable hydration errors', hy.errors.length === 0, hy.errors.join(' · '))
    if (phone) check('the viewport is a phone (pointer: coarse matches)', await evaluate("matchMedia('(pointer: coarse)').matches") === true)
    check('no dialog before anything is pressed', !(await evaluate('window.__fx.open()')))
    const overflowBefore = await evaluate('document.body.style.overflow')

    // ── OPEN by keyboard ────────────────────────────────────────────────────
    let f = null
    for (let i = 0; i < 4; i++) { await K.tab(); f = await evaluate('window.__fx.focus()'); if (f.isTrigger) break }
    check('Tab reaches the Customize trigger', f?.isTrigger, `focus is on: ${f?.tag} "${f?.name}"`)
    await K.enter()
    await evaluate('document.getAnimations().forEach(a => { try { a.finish() } catch {} }); true')
    let d = await evaluate('window.__fx.dialogInfo()')
    check('Enter on the trigger opens the sheet as a labelled aria-modal dialog', d && d.modal === 'true' && d.label === 'Customize dashboard', JSON.stringify(d))
    f = await evaluate('window.__fx.focus()')
    check('opening moves focus onto the dialog panel (tabIndex -1), nothing behind it', f.isPanel, `focus is on: ${f.tag} "${f.name}" inDialog=${f.inDialog}`)
    check('body scroll is locked while open', d && d.bodyOverflow === 'hidden', `overflow="${d?.bodyOverflow}"`)
    await shot(`${tag}-1-open`)
    const expected = await evaluate('window.__fx.expected()')
    check(`the dialog exposes exactly the default layout's ${DEFAULT_TRAP.length} enabled controls`, same(expected, DEFAULT_TRAP), `got: ${expected.join(' | ')}`)

    // ── TRAP: Tab walk ──────────────────────────────────────────────────────
    const walk = []
    for (let i = 0; i < expected.length; i++) { await K.tab(); walk.push(await evaluate('window.__fx.focus()')) }
    check('Tab visits every enabled control in DOM order, no more, no fewer', same(walk.map(w => w.name), expected), `walk: ${walk.map(w => w.name).join(' | ')}`)
    check('every stop is inside the dialog', walk.every(w => w.inDialog))
    check('every stop shows a focus ring', walk.every(w => w.ring), walk.filter(w => !w.ring).map(w => w.name).join(' · '))
    check('no stop is inside an aria-hidden subtree', walk.every(w => !w.hidden))
    await K.tab(); f = await evaluate('window.__fx.focus()')
    check('Tab from the last control wraps to the first (Close)', f.name === 'Close' && f.inDialog, `landed on "${f.name}"`)
    await K.shiftTab(); f = await evaluate('window.__fx.focus()')
    check('Shift+Tab from the first control wraps to the last (Cancel)', f.name === 'Cancel' && f.inDialog, `landed on "${f.name}"`)
    const disabledNames = ['Hide Needs you', 'Move Money up', 'Move Weekly review down', 'Move Recent updates up', 'Move Recent updates down', 'Save']
    check('disabled controls were never visited (required switch, end arrows, hidden-row arrows, clean Save)', !walk.some(w => disabledNames.includes(w.name)))

    // ── STATE by keyboard ───────────────────────────────────────────────────
    await evaluate('window.__fx.byLabel("Hide Money").focus(); true'); await K.space()
    let r = await evaluate('window.__fx.row("Money")'); let s = await evaluate('window.__fx.save()')
    check('Space on "Hide Money" flips the switch: aria-checked false, name "Show Money", row dimmed, its arrows disabled', r && !r.checked && r.swName === 'Show Money' && r.dim && r.upDisabled && r.downDisabled, JSON.stringify(r))
    check('…and the draft is dirty: Save enabled, Reset offered', s && !s.disabled && await evaluate('window.__fx.reset()'), JSON.stringify(s))
    await evaluate('window.__fx.byLabel("Show Money").focus(); true'); await K.enter()
    r = await evaluate('window.__fx.row("Money")'); s = await evaluate('window.__fx.save()')
    check('Enter on "Show Money" flips it back: checked, "Hide Money", not dimmed, down-arrow enabled again', r && r.checked && r.swName === 'Hide Money' && !r.dim && !r.downDisabled, JSON.stringify(r))
    check('…and the draft is clean again: Save disabled, Reset gone', s && s.disabled && !(await evaluate('window.__fx.reset()')), JSON.stringify(s))
    await evaluate('window.__fx.byLabel("Move Money down").focus(); true'); await K.enter()
    let order = await evaluate('window.__fx.order()')
    check('Enter on "Move Money down" reorders: Needs you, Money, …', same(order.slice(0, 2), ['Needs you', 'Money']), order.join(' | '))
    let rows = await evaluate('window.__fx.rows()')
    check('arrow states recompute: Money-up enabled, Needs you-up now disabled', rows[1].title === 'Money' && !rows[1].upDisabled && rows[0].upDisabled)
    await evaluate('window.__fx.byLabel("Move Today & next days up").focus(); true'); await K.space()
    order = await evaluate('window.__fx.order()')
    check('Space on "Move Today & next days up" lands it above Money', same(order.slice(0, 3), ['Needs you', 'Today & next days', 'Money']), order.join(' | '))

    // ── STATE by pointer ────────────────────────────────────────────────────
    await tap('window.__fx.byLabel("Hide This month")')
    r = await evaluate('window.__fx.row("This month")')
    check(`${phone ? 'tap' : 'click'} on "Hide This month" hides it`, r && !r.checked && r.dim, JSON.stringify(r))
    await tap('window.__fx.byLabel("Move Weekly review up")')
    order = await evaluate('window.__fx.order()')
    check('moving Weekly review up skips the hidden This month and lands above Money', same(order, ['Needs you', 'Today & next days', 'Weekly review', 'Money', 'This month', 'Recent updates']), order.join(' | '))
    await tap('window.__fx.byLabel("Show Recent updates")')
    r = await evaluate('window.__fx.row("Recent updates")')
    check('showing Recent updates enables its up arrow (last visible: down stays disabled)', r && r.checked && !r.upDisabled && r.downDisabled, JSON.stringify(r))
    await shot(`${tag}-2-edited`)
    const snapshot = await evaluate('JSON.stringify(window.__fx.rows())')
    const g = await tap('window.__fx.byLabel("Hide Needs you")')
    check(`${phone ? 'tapping' : 'clicking'} the disabled required switch (${Math.round(g.w)}×${Math.round(g.h)}) changes nothing`, await evaluate('JSON.stringify(window.__fx.rows())') === snapshot)
    await tap('window.__fx.byLabel("Move Needs you up")')
    check('tapping a disabled end arrow changes nothing', await evaluate('JSON.stringify(window.__fx.rows())') === snapshot)
    await tap('window.__fx.byLabel("Move This month up")')
    check('tapping a hidden row\'s (disabled) arrow changes nothing', await evaluate('JSON.stringify(window.__fx.rows())') === snapshot)
    await tap('window.__fx.byText("Reset")')
    order = await evaluate('window.__fx.order()'); rows = await evaluate('window.__fx.rows()'); s = await evaluate('window.__fx.save()')
    check('Reset restores the default order and visibility; Reset disappears; Save disabled', same(order, DEFAULT_ORDER) && rows.filter(x => !x.checked).map(x => x.title).join() === 'Recent updates' && !(await evaluate('window.__fx.reset()')) && s.disabled, order.join(' | '))

    // ── SAVE without a session: the refusal, not a write ────────────────────
    await tap('window.__fx.byLabel("Hide Money")')
    const reqBeforeSave = events.requests.length
    await K.ctrlEnter(); await sleep(400)
    let toasts = await evaluate('window.__fx.toasts()')
    check('Ctrl+Enter attempts Save and the component refuses: "Not signed in" toast, dialog still open', toasts.some(t => /Not signed in/.test(t)) && await evaluate('window.__fx.open()'), toasts.join(' · '))
    await tap('window.__fx.byText("Save")'); await sleep(400)
    toasts = await evaluate('window.__fx.toasts()'); s = await evaluate('window.__fx.save()')
    check(`${phone ? 'tapping' : 'clicking'} Save: same refusal, still open, Save not stuck busy`, toasts.filter(t => /Not signed in/.test(t)).length >= 1 && await evaluate('window.__fx.open()') && s.busy !== 'true', JSON.stringify({ toasts, s }))
    check('no request left the page for either Save attempt', events.requests.length === reqBeforeSave, events.requests.slice(reqBeforeSave).join(' · '))
    await shot(`${tag}-3-toast`)

    // ── CLOSE: Escape restores focus to the trigger ─────────────────────────
    await K.escape()
    f = await evaluate('window.__fx.focus()')
    check('Escape closes the sheet', !(await evaluate('window.__fx.open()')))
    check('…and focus returns to the Customize trigger', f.isTrigger, `focus is on: ${f.tag} "${f.name}"`)
    check('…and body scroll is unlocked', (await evaluate('document.body.style.overflow')) === overflowBefore)

    // ── CLOSE: Cancel discards the draft ────────────────────────────────────
    await tap('window.__fx.trigger()')
    await evaluate('document.getAnimations().forEach(a => { try { a.finish() } catch {} }); true')
    r = await evaluate('window.__fx.row("Money")'); s = await evaluate('window.__fx.save()'); order = await evaluate('window.__fx.order()')
    check(`${phone ? 'tap' : 'click'} on the trigger reopens with the INITIAL layout, not the edited draft`, await evaluate('window.__fx.open()') && r && r.checked && s.disabled && same(order, DEFAULT_ORDER), JSON.stringify({ r, s, order }))
    f = await evaluate('window.__fx.focus()')
    info(`after a pointer open, focus is on: ${f.isPanel ? 'the dialog panel' : `${f.tag} "${f.name}"`}`)
    await tap('window.__fx.byLabel("Hide Money")')
    await tap('window.__fx.byText("Cancel")')
    f = await evaluate('window.__fx.focus()')
    check('Cancel closes', !(await evaluate('window.__fx.open()')))
    info(`after Cancel, focus is on: ${f.isTrigger ? 'the Customize trigger' : `${f.tag} "${f.name}"`}`)
    await tap('window.__fx.trigger()')
    r = await evaluate('window.__fx.row("Money")')
    check('reopening after Cancel shows Money still shown — the draft was discarded', r && r.checked, JSON.stringify(r))

    // ── CLOSE: backdrop ─────────────────────────────────────────────────────
    const panel = await evaluate('(() => { const b = window.__fx.dialog().getBoundingClientRect(); return { top: b.top, left: b.left } })()')
    const bx = 6, by = phone ? Math.max(6, panel.top - 40) : 6
    await tapAt(bx, by)
    check(`${phone ? 'tapping' : 'clicking'} the backdrop (${bx},${Math.round(by)}) outside the panel closes`, !(await evaluate('window.__fx.open()')), `panel top=${Math.round(panel.top)} left=${Math.round(panel.left)}`)

    // ── phones: the grab handle ─────────────────────────────────────────────
    if (phone) {
      await tap('window.__fx.trigger()')
      await swipeHandle(40)
      check('a short drag (40px) on the grab handle snaps back, sheet stays open', await evaluate('window.__fx.open()'))
      await swipeHandle(140)
      check('a drag past the threshold (140px) on the grab handle dismisses the sheet', !(await evaluate('window.__fx.open()')))
    }
    await shot(`${tag}-4-closed`)

    // ── hygiene for this width ──────────────────────────────────────────────
    const reqs = events.requests.slice(before.req)
    const foreign = reqs.filter(u => !u.startsWith('file://'))
    check(`every request the page made is file:// (${reqs.length} total)`, foreign.length === 0, foreign.join(' · '))
    const con = events.consoleErrors.slice(before.con), exc = events.exceptions.slice(before.exc), log = events.logErrors.slice(before.log)
    check('zero console errors/warnings', con.length === 0, con.join(' · '))
    check('zero uncaught exceptions', exc.length === 0, exc.join(' · '))
    check('zero browser log errors (failed loads, CSP)', log.length === 0, log.join(' · '))
  }
}

main()
  .catch(e => { fail('prover crashed', String(e?.stack || e)) })
  .finally(async () => {
    try { ws?.close() } catch {}
    chrome.kill()
    await sleep(300)
    console.log(`\nend ${now()}  ${checks} checks, ${failures} failed`)
    process.exit(failures ? 1 : 0)
  })
