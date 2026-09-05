// ── Verify: Save is reachable on a phone ─────────────────────────────────────
//   npm run verify:mobile-save
//
// WHY THIS SCRIPT EXISTS
// The owner reported that EdgeQuote "sometimes won't let me save a quote" on a
// phone. It was literal, and it was measured on the deployed build at a true
// 390px viewport with a real touch tap:
//
//   save button   t:786  b:834   (inside the fixed save bar, top 775, z-30)
//   open listbox  t:638  b:926   (the service picker, z-overlay = 50)
//   elementFromPoint(312, 810) → SPAN "General Landscaping"
//   a real touch tap there      → submits attempted = 0
//                               → service_type silently CHANGED
//
// Identical at 375 and 430. Two independent causes, both of them "the primary
// action is not where the finger lands":
//
//   1. Four comboboxes rendered a downward list with a fixed height and no idea
//      where the bottom of the screen was, at a z-index ABOVE the save bar.
//   2. `position: fixed; bottom: 0` pins to the LAYOUT viewport, which the
//      software keyboard does not shrink — measured with the visual viewport at
//      508px, Save stayed at y 786–834, i.e. 326px behind the keyboard.
//
// The rules that fix them are asserted here: the pure placement function is
// RUN (§1–2, including the cases that made the first fix wrong), and the
// wiring that must carry it is pinned in source (§3–5).
//
// ⚠️ This guard writes nothing and reads no live data. Everything below is
// either arithmetic or a source assertion.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DROPDOWN_GAP, DROPDOWN_MAX_HEIGHT, DROPDOWN_MIN_HEIGHT, placeDropdown,
} from '../src/lib/dropdownPlacement'

let failures = 0
const ok = (n: string) => console.log(`  ✓ ${n}`)
const fail = (n: string, d = '') => { failures++; console.log(`  ✗ ${n}${d ? `\n      ${d}` : ''}`) }
const check = (n: string, cond: boolean, d = '') => cond ? ok(n) : fail(n, d)

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
// A guard that greps its own subject matter reports the CURE as the DISEASE:
// every file below EXPLAINS the bug in prose, and "z-30" / "max-h-72" appear in
// those explanations. Strip comments before asserting on code.
const stripComments = (s: string) =>
  s.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
    // NOTE the [^\n]: `.` does not match \r, so on a CRLF checkout a `.*$`
    // stripper strips NOTHING and every absence check below inverts.
    .replace(/^[ \t]*\/\/[^\n]*$/gm, '')

// The four comboboxes that can appear inside a form with a fixed save bar.
const PICKERS = [
  ['ServicePicker', 'src/components/ui/ServicePicker.tsx'],
  ['CustomerPicker', 'src/components/ui/CustomerPicker.tsx'],
  ['PropertySelect', 'src/components/ui/PropertySelect.tsx'],
  ['AddressAutocomplete', 'src/components/ui/AddressAutocomplete.tsx'],
] as const

// ── 1. THE RULE: a placed dropdown never crosses the floor ───────────────────
console.log('\n═══ A dropdown stops before the save bar ═══')

// The measured failure, replayed as arithmetic. Viewport 844, bar top 775,
// service field bottom 630 — the exact geometry of the production repro.
{
  const band = { top: 0, bottom: 775 }
  const anchor = { top: 580, bottom: 630 }
  const p = placeDropdown(anchor, band)
  const listBottom = anchor.bottom + DROPDOWN_GAP + p.maxHeight
  check('the production repro no longer reaches the bar',
    p.side === 'below' && listBottom <= band.bottom,
    `side=${p.side} maxHeight=${p.maxHeight} ⇒ list bottom ${listBottom}, floor ${band.bottom} ` +
    '(before the fix this was a fixed 288 ⇒ bottom 926, over a bar whose top is 775)')
}

// Sweep every field position on a phone-shaped screen: WHEREVER the field is,
// the list must fit inside the band. This is the invariant; one example is not.
{
  const band = { top: 0, bottom: 775 }
  let worstOver = 0
  let worstAt = -1
  for (let top = 0; top <= 830; top += 5) {
    const anchor = { top, bottom: top + 50 }
    const p = placeDropdown(anchor, band)
    const edge = p.side === 'below'
      ? anchor.bottom + DROPDOWN_GAP + p.maxHeight        // must not pass band.bottom
      : band.top - (anchor.top - DROPDOWN_GAP - p.maxHeight) // must not pass band.top
    const over = p.side === 'below' ? edge - band.bottom : edge
    if (over > worstOver) { worstOver = over; worstAt = top }
  }
  check('no field position anywhere on the screen produces an overflowing list',
    worstOver <= 0,
    `worst overflow ${worstOver}px with the field at y=${worstAt}`)
}

// The keyboard case: the band is the VISIBLE strip, and the field sits just
// above the bar. Below is unusable, so it must flip up and stay on screen.
{
  const band = { top: 0, bottom: 439 }   // bar top with a 336px keyboard raised
  const anchor = { top: 397, bottom: 447 }
  const p = placeDropdown(anchor, band)
  check('with the keyboard up, a field at the floor flips the list ABOVE',
    p.side === 'above',
    `side=${p.side} — below has ${band.bottom - anchor.bottom - DROPDOWN_GAP}px, which is not a list`)
  check('and the flipped list still fits above the field',
    anchor.top - DROPDOWN_GAP - p.maxHeight >= band.top,
    `top edge ${anchor.top - DROPDOWN_GAP - p.maxHeight}, band top ${band.top}`)
}

// Roomy case must be untouched — a dropdown with space behaves exactly as it
// always did, at the same 288px, on the same side.
{
  const p = placeDropdown({ top: 100, bottom: 150 }, { top: 0, bottom: 844 })
  check('a field with room to spare is unchanged (below, full height)',
    p.side === 'below' && p.maxHeight === DROPDOWN_MAX_HEIGHT,
    `side=${p.side} maxHeight=${p.maxHeight}`)
}

// ── 2. The preference order, so a fix cannot become "always flip" ────────────
console.log('\n═══ Below stays the default ═══')
{
  // Just enough room below: stay below even though above is roomier.
  const p = placeDropdown({ top: 400, bottom: 450 }, { top: 0, bottom: 450 + DROPDOWN_GAP + DROPDOWN_MIN_HEIGHT })
  check('exactly the minimum room below keeps the list below', p.side === 'below',
    `side=${p.side} — flipping a list that fits is a UI that moves for no reason`)
}
{
  // One pixel less than the minimum, and above is roomier ⇒ flip.
  const p = placeDropdown({ top: 400, bottom: 450 }, { top: 0, bottom: 450 + DROPDOWN_GAP + DROPDOWN_MIN_HEIGHT - 1 })
  check('one pixel under the minimum flips it', p.side === 'above', `side=${p.side}`)
}
{
  // Cramped BOTH ways: take the roomier side rather than emitting nothing.
  const p = placeDropdown({ top: 20, bottom: 70 }, { top: 0, bottom: 120 })
  check('cramped both ways, it takes the roomier side and still fits',
    p.maxHeight >= 0 && (p.side === 'below'
      ? 70 + DROPDOWN_GAP + p.maxHeight <= 120
      : 20 - DROPDOWN_GAP - p.maxHeight >= 0),
    `side=${p.side} maxHeight=${p.maxHeight}`)
}

// ── 3. Every combobox actually uses it ───────────────────────────────────────
console.log('\n═══ All four comboboxes are wired to the one rule ═══')
for (const [name, path] of PICKERS) {
  const code = stripComments(read(path))
  check(`${name} uses the placement hook`,
    /useDropdownPlacement\(/.test(code),
    'a fifth dropdown that opens downward over the save bar is the same bug again')
  check(`${name} applies it as a STYLE`,
    /style=\{dropdownStyle\(place\)\}/.test(code),
    'see §4 — a computed Tailwind class here does not exist at runtime')
  check(`${name} no longer hard-codes its height`,
    !/max-h-72/.test(code),
    'a fixed 288px list is exactly what ran past the bottom of the screen')
  check(`${name} anchors the list to the input's own wrapper`,
    /className="relative" ref=\{anchorRef\}/.test(code),
    'measuring the label too would place the list from the wrong top edge')
}

// ── 4. The trap that made the first fix silently wrong ───────────────────────
console.log('\n═══ Placement is a style, never a class name ═══')
{
  const hook = stripComments(read('src/hooks/useDropdownPlacement.ts'))
  const lib = stripComments(read('src/lib/dropdownPlacement.ts'))
  // tailwind.config.ts scans src/pages, src/components, src/app — NOT src/hooks
  // or src/lib. The first cut returned 'bottom-full mb-1' from the hook; the
  // class was never generated, so the list rendered BELOW while claiming ABOVE.
  const globs = read('tailwind.config.ts')
  const scansHooks = /src\/hooks/.test(globs)
  const scansLib = /src\/lib\b/.test(globs)
  check('tailwind still does not scan src/hooks or src/lib',
    !scansHooks && !scansLib,
    'if that changed, the rule below can be relaxed — until then it is load-bearing')
  for (const [where, code] of [['the hook', hook], ['the lib', lib]] as const) {
    check(`${where} emits no Tailwind positioning class`,
      !/['"`][^'"`]*\b(top-full|bottom-full|mt-\d|mb-\d|max-h-\d)\b/.test(code),
      'unscanned file ⇒ the class is never generated ⇒ the element does not move')
  }
  check('the hook returns real CSS properties instead',
    /export function dropdownStyle\(/.test(hook) && /maxHeight:/.test(hook) && /bottom:/.test(hook) && /top:/.test(hook))
}

// ── 5. The floor is published, and the bar rides the keyboard ────────────────
console.log('\n═══ The bottom chrome says where it is ═══')
{
  const bar = stripComments(read('src/components/ui/StickyActionBar.tsx'))
  const nav = stripComments(read('src/components/layout/BottomNav.tsx'))
  const lib = stripComments(read('src/lib/dropdownPlacement.ts'))
  check('a FIXED save bar marks itself as bottom chrome',
    /data-eq-bottom-chrome/.test(bar) && /fixed \?/.test(bar),
    'a sticky bar flows in the document and is not chrome over the page')
  check('the bottom nav marks itself too', /data-eq-bottom-chrome/.test(nav))
  check('the placement rule reads that marker', /data-eq-bottom-chrome/.test(lib))
  check('and reads the VISUAL viewport, not just innerHeight',
    /visualViewport/.test(lib),
    'innerHeight does not change when the software keyboard opens')

  // The keyboard fix itself. Measured: transform matrix(1,0,0,1,0,-336) with a
  // 336px keyboard, putting Save at 450–498 inside a 508px visible strip.
  check('the fixed bar translates by the keyboard inset',
    /window\.innerHeight - vv\.height - vv\.offsetTop/.test(bar) && /translateY\(/.test(bar),
    'without this the primary action sits behind the keyboard, unreachable')
  check('it listens to visualViewport resize AND scroll',
    /vv\.addEventListener\('resize'/.test(bar) && /vv\.addEventListener\('scroll'/.test(bar),
    'iOS fires scroll, not resize, when the keyboard shifts the visual viewport')
  check('no visualViewport ⇒ no transform',
    /if \(!vv\) return/.test(bar),
    'an older browser must keep exactly the old behaviour')
}

// ── 6. A blocked save says which field, and puts the owner on it ─────────────
console.log('\n═══ A blocked save is never silent ═══')
{
  const qb = stripComments(read('src/components/quotes/QuoteBuilder.tsx'))
  check('the invalid handler always toasts', /toast\.error\(first\?\.message \|\|/.test(qb),
    'an offscreen validation error with no message is what makes Save look broken')
  check('it focuses the offending field after opening its section',
    /requestAnimationFrame\(\(\) => \{[\s\S]{0,200}setFocus\(firstPath/.test(qb),
    'the section opens THIS render, so the field is not mounted until the next frame')
  check('and scrolls it into view', /scrollIntoView\(\{ block: 'center' \}\)/.test(qb),
    'a focused field under the keyboard is no more visible than an unfocused one')
  check('an errored services row resolves to a real field path',
    /services\.\$\{i\}\.\$\{sub\}/.test(qb),
    'errs.services is an ARRAY — its own key focuses nothing')
}

// ── 7. A failed write keeps the owner's work ─────────────────────────────────
console.log('\n═══ A save that did not happen loses nothing ═══')
{
  const qb = stripComments(read('src/components/quotes/QuoteBuilder.tsx'))
  const nw = stripComments(read('src/app/dashboard/quotes/new/page.tsx'))
  check('the draft is cleared only on a save that actually happened',
    /if \(await onSubmit\(v\) !== false\) autosave\.clear\(\)/.test(qb),
    'clearing on RETURN threw away minutes of typing whenever a write failed')
  check('the new-quote page returns false on a failed customer link',
    /Could not link this quote to a customer[\s\S]{0,200}return false/.test(nw))
  check('and on a failed quote-number read', /return false/.test(nw) && /existing quote numbers/.test(nw))
  check('both save buttons are disabled while a submit is in flight',
    (qb.match(/loading=\{isSubmitting\}/g) || []).length >= 2,
    'measured: two taps in one frame produced ONE quote, because the first tap disabled both')
}

// ── 8. Picker keys act on suggestions before the surrounding form ──────────
// Execute the actual handlers with synthetic events and setters. The browser
// reproduction additionally exercises native form submission and dialog Escape.
console.log('\n═══ Picker keys keep the surrounding draft intact ═══')
for (const name of ['CustomerPicker', 'PropertySelect']) {
  const source = read(`src/components/ui/${name}.tsx`)
  const body = source.match(/function onKeyDown\(e: React\.KeyboardEvent\) \{([\s\S]*?)\n  \}/)?.[1]
  if (!body) throw new Error(`Missing ${name} keyboard handler`)
  const run = new Function('open', 'setOpen', 'setHi', 'rows', 'choose', 'e', body)
  for (const key of ['Enter', 'ArrowDown']) {
    let prevented = false, opened = false, highlight = -1, choices = 0
    run(false, (value: boolean) => { opened = value }, (value: number) => { highlight = value }, [{}], () => { choices++ }, {
      key, preventDefault() { prevented = true },
    })
    check(`${name}: closed ${key} opens suggestions without implicit submit/scroll`, prevented && opened && highlight === 0 && choices === 0)
  }
  let picked = -1, prevented = false
  // The open handler reads the highlighted index from component state.
  const chooseOpen = new Function('open', 'setOpen', 'setHi', 'rows', 'choose', 'e', 'hi', body)
  chooseOpen(true, () => {}, () => {}, [{}, {}], (index: number) => { picked = index }, {
    key: 'Enter', preventDefault() { prevented = true },
  }, 1)
  check(`${name}: open Enter still chooses the highlighted row`, prevented && picked === 1)
}

{
  const source = read('src/components/ui/CustomerPicker.tsx')
  const body = source.match(/function onKey\(e: KeyboardEvent\) \{([\s\S]*?)\n    \}/)?.[1]
  if (!body) throw new Error('Missing customer dropdown Escape handler')
  const escape = new Function('openRef', 'setOpen', 'e', body)
  for (const open of [true, false]) {
    let stopped = false, closed = false
    escape({ current: open }, (next: boolean) => { closed = !next }, {
      key: 'Escape', stopPropagation() { stopped = true },
    })
    check(`CustomerPicker: ${open ? 'open Escape belongs to suggestions' : 'closed Escape reaches the enclosing dialog'}`, stopped === open && closed === open)
  }
  check('customer Escape listener captures before the dialog and removes that same listener',
    /addEventListener\('keydown', onKey, \{ capture: true \}\)/.test(source)
    && /removeEventListener\('keydown', onKey, \{ capture: true \}\)/.test(source))
}

console.log('\n── Summary ────────────────────────────────────────────────────')
if (failures) {
  console.log(`\n❌ verify:mobile-save — ${failures} failure${failures === 1 ? '' : 's'}\n`)
  process.exit(1)
}
console.log('\n✅ verify:mobile-save — the dropdown stops at the floor, the bar clears the keyboard, a blocked save says why\n')
