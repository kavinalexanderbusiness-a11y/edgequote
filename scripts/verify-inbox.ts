// ── Verify: the inbox stays a phone-first daily tool that never lies ─────────
//   npm run verify:inbox
//
// WHY THIS SCRIPT EXISTS
// Messages is the one screen an owner opens forty times a day, usually on a
// phone, usually mid-driveway. Two kinds of regressions keep trying to creep
// back in:
//   · ergonomic — the composer drifting below a page-length thread, desktop
//     chrome crowding a 390px screen, decoration glyphs on every row;
//   · honesty — a failed read wearing the friendly empty state, a failed reply
//     looking sent, an optimistic write outrunning its error branch.
// The honesty class has been fixed once already (this suite pins those fixes so
// they stay fixed); the ergonomic contracts are from the daily-work pass.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
const ok = (n: string) => console.log(`  ✓ ${n}`)
const fail = (n: string, d = '') => { failures++; console.log(`  ✗ ${n}${d ? `\n      ${d}` : ''}`) }
const check = (n: string, cond: boolean, d = '') => cond ? ok(n) : fail(n, d)
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

const PAGE = read('src/app/dashboard/messages/page.tsx')
const THREAD = read('src/components/messages/ConversationThread.tsx')

// ── 1. Phone-first: one surface at a time ────────────────────────────────────
console.log('\n═══ On a phone, an open thread IS the screen ═══')
check('the page header hides while a thread is open on mobile',
  /sel && 'hidden lg:block'[\s\S]{0,200}PageHeader/.test(PAGE))
check('search hides while a thread is open on mobile',
  /'relative', sel && 'hidden lg:block'/.test(PAGE))
check('the filter pills hide while a thread is open on mobile',
  /sel && 'hidden lg:flex'/.test(PAGE))
check('the thread panel pins to the viewport on mobile (dvh), capped on desktop',
  /h-\[calc\(100dvh-[\d.]+rem\)\]/.test(PAGE) && /lg:max-h-\[\d+vh\]/.test(PAGE),
  'without a bounded height the composer sits below every bubble, a full page-scroll away')
check('the list panel swaps out (push-nav), never squeezes beside the thread',
  /sel && 'hidden lg:flex'/.test(PAGE) && /sel \? 'flex/.test(PAGE))
check('the thread interior keeps its own scrolling bubble box',
  /flex-1 overflow-y-auto/.test(THREAD) && /flex flex-col h-full min-h-0/.test(THREAD))

// ── 2. Rows carry signal, not decoration ─────────────────────────────────────
console.log('\n═══ A glyph on every row is a glyph on no row ═══')
check('the channel icon renders ONLY for the exceptions (portal / email)',
  /c\.last_channel === 'portal' \|\| c\.last_channel === 'email'\) &&/.test(PAGE),
  'SMS is the default — an SMS icon 40 times per screen is noise the eye must skip')

// ── 3. Every filter's emptiness says what it MEANS ───────────────────────────
console.log('\n═══ Empty states tell the owner what to do (or that they are done) ═══')
check('an empty Needs-reply celebrates, never onboards',
  /'All caught up'/.test(PAGE) && /Nobody is waiting on a reply from you\./.test(PAGE),
  'the generic "No conversations yet" copy in that spot reads as a malfunction')
check('an empty Snoozed explains snooze semantics', /Snoozed conversations wait here until their time comes/.test(PAGE))
check('a FAILED load never wears the friendly empty state',
  /list\.length === 0 && loadError/.test(PAGE) &&
  PAGE.indexOf('list.length === 0 && loadError') < PAGE.indexOf("filter === 'archived' ? 'No archived chats'"),
  'the failed-read branch must be checked BEFORE the empty-inbox copy')

// ── 4. The honesty fixes stay fixed ──────────────────────────────────────────
console.log('\n═══ Optimism never outruns its error branch ═══')
check('a failed reply removes the optimistic bubble AND restores the draft',
  /setItems\(prev => prev\.filter\(i => i\.id !== pendId\)\)\s*\n\s*setText\(t\)/.test(THREAD),
  'a bubble that stays after a failed send is a reply the customer never got')
check('delete verifies BEFORE the row disappears',
  PAGE.indexOf("from('conversations').delete().eq('id', c.id)") < PAGE.indexOf('removeLocal(c.id)'))
check('archiving clears unread with it (no phantom badge)',
  /archived_at: now, unread: 0/.test(PAGE))
check('label toggles re-read current labels (search rows may not carry them)',
  /\.select\('labels'\)\.eq\('id', c\.id\)/.test(PAGE),
  'a whole-array write computed from an undefined field silently deletes every label')
check('a slow thread load can never paint over a newer conversation',
  /reqSeq\.current/.test(THREAD) && /mySeq !== reqSeq\.current/.test(THREAD))
check('a superseded page load discards itself',
  /mySeq !== loadSeq\.current\) return/.test(PAGE))
check('out-of-order search responses are dropped',
  /seq !== searchSeq\.current\) return/.test(PAGE))

console.log(failures === 0
  ? '\n✅ inbox: read, reply, return — honest at every step, one-handed on a phone.\n'
  : `\n❌ inbox: ${failures} contract${failures === 1 ? '' : 's'} broken.\n`)
process.exit(failures === 0 ? 0 : 1)
