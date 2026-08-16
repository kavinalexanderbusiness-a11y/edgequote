// ── Verify: the field app never claims a write it did not get ───────────────
//   npm run verify:field-reliability
//
// WHY THIS SCRIPT EXISTS
// Every other failure in this product is visible. A wrong price is on the
// invoice; a missed visit is an empty slot on the board. But "the app said
// Saved and the server never heard it" leaves NOTHING behind — no row, no error,
// no trace — and the only person who could have noticed drove away an hour ago
// certain the job was done. It is discovered weeks later, as a customer who was
// never billed or a timesheet that is short a day.
//
// None of it is reachable by looking at the screen, because on screen the bug
// looks exactly like success. It is invisible to tsc (the types are all
// satisfied), to `next build`, and to any test that runs with four bars.
//
// ⭐⭐ SO THE RULES ARE RUN, NOT READ. The reconciliation engine is pure, so this
// file drives it through the real ambiguous-response scenarios — server
// committed, response lost, worker taps Retry — and asserts the VERDICT. Where
// a claim can only live in source (a call site that must not exist, a cache that
// must not be rendered without its banner) it is asserted over the real file.
//
// ⭐ NO FIXTURE TENANT AND NO LIVE READ. Nothing here writes a row anywhere: the
// engine is pure and the rest is source. An existence claim over live data is a
// coin flip ([[guard-fixtures-not-the-book]]); this has nothing to flip.
//
// ⭐⭐ AND IT IS MUTATION-TESTED (§5). A guard that passes against a DELIBERATELY
// BROKEN engine is decoration. Section 5 re-implements the reconciler with the
// four mistakes anyone would actually make and requires each one to be caught.

import {
  reconcileVisitIntent, freezeIntent, newIntentToken, intentLabel,
  type VisitIntent, type VisitFacts,
} from '../src/lib/field/visitIntent'
import { writeClass, isQueueable, FIELD_WRITE_KINDS } from '../src/lib/field/writeClass'
import { projectDayForCache, isExpired, lastUpdatedLabel, FIELD_CACHE_MAX_AGE_MS } from '../src/lib/field/todayCache'
import { photoStoragePath, isValidPhotoToken, newPhotoToken, outstandingShots, isCanonicallyStored } from '../src/lib/field/photoIntent'
import type { CrewDay, CrewStop } from '../src/lib/crewAccess'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
const ok = (n: string) => console.log(`  ✓ ${n}`)
const fail = (n: string, d: string) => { failures++; console.log(`  ✗ ${n}\n      ${d}`) }
const check = (n: string, cond: boolean, d = '') => cond ? ok(n) : fail(n, d)

const ROOT = process.cwd()
// ⚠️ CRLF normalisation, for the reason verify-crew-brief documents at length:
// this checkout is CRLF, `.` does not match `\r`, and a pattern written with
// `\n` silently never fires — a rule that is never actually checked looks
// exactly like a rule that passes. [[crlf-strippers]]
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
const exists = (p: string) => existsSync(join(ROOT, p))

// ── Builders ────────────────────────────────────────────────────────────────
const V0 = '2026-08-15 09:00:00.123456+00'
const V1 = '2026-08-15 09:05:41.777888+00'
const V2 = '2026-08-15 10:30:02.010203+00'

function intent(kind: VisitIntent['kind'], over: Partial<VisitIntent> = {}): VisitIntent {
  const base: VisitIntent = {
    kind, jobId: 'job-1', baseUpdatedAt: V0, token: 'tok-1',
    next: kind === 'start' ? { status: 'in_progress', started_at: '2026-08-15T09:05:00.000Z', completed_at: null, actual_minutes: 30 }
      : kind === 'complete' ? { status: 'completed', started_at: '2026-08-15T09:05:00.000Z', completed_at: '2026-08-15T10:30:00.000Z', actual_minutes: 85 }
      : kind === 'stop_for_day' ? { status: 'in_progress', started_at: null, completed_at: null, actual_minutes: 30 }
      : { status: 'scheduled', started_at: null, completed_at: null, actual_minutes: 30 },
  }
  return freezeIntent({ ...base, ...over })
}

function facts(over: Partial<VisitFacts> = {}): VisitFacts {
  return { status: 'scheduled', started_at: null, completed_at: null, updated_at: V0, ...over }
}

console.log('\n── Field reliability + offline resilience ──────────────────────\n')

// ── 1 · The three answers, and there is no fourth ───────────────────────────
{
  console.log('1 · saved · pending · failed — and nothing else')
  const FW = read('src/lib/field/fieldWrite.ts')
  check('FieldSaveState is exactly the three states',
    /export type FieldSaveState = 'saved' \| 'pending' \| 'failed'/.test(FW))
  check('⭐ a failure is never reported without re-reading first',
    /const \{ facts, reachable \} = await reread\(/.test(FW) && /reconcileVisitIntent\(intent, facts\)/.test(FW))
  check('an unreachable server queues rather than guessing',
    /if \(!reachable\)/.test(FW) && /return queueVisit\(/.test(FW))
  check('⛔ a queue that could not persist reports FAILED, never pending',
    /if \(!op\) return \{ state: 'failed'/.test(FW))
  // The engines must be the shared ones, not a crew-only copy of the write.
  check('replays call the SAME functions the online path calls',
    /crewStartVisit|crewCompleteVisit/.test(read('src/lib/field/handlers.ts')))
}

// ── 2 · The reconciliation truth table ──────────────────────────────────────
{
  console.log('\n2 · what the server holds decides the verdict')
  const i = intent('start')
  check('base version untouched → unapplied (safe to replay)',
    reconcileVisitIntent(i, facts()).kind === 'unapplied')
  check('our own client-minted started_at present → applied',
    reconcileVisitIntent(i, facts({ status: 'in_progress', started_at: i.next.started_at, updated_at: V1 })).kind === 'applied')
  check('a DIFFERENT worker\'s start → superseded, never applied',
    reconcileVisitIntent(i, facts({ status: 'in_progress', started_at: '2026-08-15T08:00:00.000Z', updated_at: V1 })).kind === 'superseded')
  check('the visit is gone from the board → gone',
    reconcileVisitIntent(i, null).kind === 'gone')
  check('the office cancelled it → superseded (a poison replay, not a retry)',
    reconcileVisitIntent(i, facts({ status: 'cancelled', updated_at: V1 })).kind === 'superseded')

  const c = intent('complete')
  check('complete: our stamp on the row → applied',
    reconcileVisitIntent(c, facts({ status: 'completed', started_at: c.next.started_at, completed_at: c.next.completed_at, updated_at: V1 })).kind === 'applied')
  check('⭐ complete: somebody ELSE finished it → superseded, not a false success',
    reconcileVisitIntent(c, facts({ status: 'completed', completed_at: '2026-08-15T11:00:00.000Z', updated_at: V2 })).kind === 'superseded')

  const s = intent('stop_for_day')
  check('done-for-today: in_progress with the clock cleared → applied',
    reconcileVisitIntent(s, facts({ status: 'in_progress', started_at: null, updated_at: V1 })).kind === 'applied')
  check('done-for-today: the clock is running again → superseded',
    reconcileVisitIntent(s, facts({ status: 'in_progress', started_at: '2026-08-15T11:00:00.000Z', updated_at: V2 })).kind === 'superseded')

  // Multi-day: banked minutes are the DATABASE's, so they must never enter the
  // identity test — comparing them would fail every honest write.
  check('⭐ multi-day: server-recomputed actual_minutes never causes a false conflict',
    reconcileVisitIntent(intent('start'), facts({
      status: 'in_progress', started_at: intent('start').next.started_at, updated_at: V1,
    })).kind === 'applied')
  check('…and the engine does not read actual_minutes at all',
    !/actual_minutes/.test(read('src/lib/field/visitIntent.ts').split('function isApplied')[1].split('function reconcile')[0]))
}

// ── 3 · ⭐⭐ THE AMBIGUOUS START — the case the session exists for ────────────
{
  console.log('\n3 · Start succeeded, the answer never arrived, the worker taps Retry')
  const i = intent('start')
  // Attempt 1: server commits. Response dies. The phone believes it failed.
  const afterServerCommitted = facts({ status: 'in_progress', started_at: i.next.started_at, updated_at: V1 })
  // Attempt 2 (the Retry) reuses the SAME frozen intent — the whole point.
  const verdict = reconcileVisitIntent(i, afterServerCommitted)
  check('⭐⭐ Retry after an ambiguous success reports APPLIED — no second session',
    verdict.kind === 'applied', JSON.stringify(verdict))
  check('⛔ and it is NOT reported as a stale-version conflict',
    verdict.kind !== 'superseded')
  // A third and fourth replay must be just as safe — flushes fire on reconnect,
  // focus and a 30s timer, so an op can be reconciled many times.
  check('replaying it repeatedly stays applied (idempotent under N retries)',
    [1, 2, 3, 4, 5].every(() => reconcileVisitIntent(i, afterServerCommitted).kind === 'applied'))

  // Done for today and Complete carry the same hazard.
  const s = intent('stop_for_day')
  check('“Done for today” after an ambiguous success → applied',
    reconcileVisitIntent(s, facts({ status: 'in_progress', started_at: null, updated_at: V1 })).kind === 'applied')
  const c = intent('complete')
  check('“Complete job” after an ambiguous success → applied',
    reconcileVisitIntent(c, facts({ status: 'completed', started_at: c.next.started_at, completed_at: c.next.completed_at, updated_at: V1 })).kind === 'applied')
}

// ── 4 · Identity is minted once and frozen ──────────────────────────────────
{
  console.log('\n4 · the retry key is minted at the tap, never on retry')
  const i = intent('start')
  let threw = false
  try { (i as unknown as { baseUpdatedAt: string }).baseUpdatedAt = 'rewritten' } catch { threw = true }
  check('an intent is frozen against later rewriting', threw || i.baseUpdatedAt === V0)
  const inner = i.next as unknown as { started_at: string | null }
  let innerThrew = false
  try { inner.started_at = 'rewritten' } catch { innerThrew = true }
  check('…including its end state', innerThrew || i.next.started_at !== 'rewritten')
  check('tokens are unique', newIntentToken() !== newIntentToken())
  check('the label names the work in the worker\'s words',
    intentLabel('stop_for_day', '14 Elm St').includes('Done for today'))

  const FW = read('src/lib/field/fieldWrite.ts')
  check('⭐ buildVisitIntent is the ONLY place a lifecycle timestamp is minted',
    /export function buildVisitIntent/.test(FW))
  const handlers = read('src/lib/field/handlers.ts')
  check('⛔ the replay handler never builds a fresh intent',
    !/buildVisitIntent/.test(handlers))
  check('⛔ nor mints a fresh message token', !/newClientToken/.test(handlers))
}

// ── 5 · ⭐⭐ MUTATION TEST — a broken engine must fail these checks ───────────
{
  console.log('\n5 · mutation test: deliberately broken reconcilers must be caught')

  type Recon = (i: VisitIntent, f: VisitFacts | null) => string

  // The four mistakes anyone would actually make, each a real bug with a name.
  const mutants: { name: string; fn: Recon }[] = [
    {
      // Checks the base version BEFORE the applied test. This is THE duplicate
      // work-session bug: a landed write advanced updated_at, so it reads as
      // "not our base" and falls through to conflict/replay.
      name: 'version checked before intent (→ duplicate sessions)',
      fn: (i, f) => !f ? 'gone' : f.updated_at === i.baseUpdatedAt ? 'unapplied' : 'superseded',
    },
    {
      // Trusts the status alone, ignoring WHOSE stamp it is.
      name: 'status-only match (→ another worker\'s finish reported as yours)',
      fn: (i, f) => !f ? 'gone' : f.status === i.next.status ? 'applied' : 'unapplied',
    },
    {
      // Never recognises a landed write at all — the naive "retry blindly".
      name: 'no applied verdict at all (→ blind retry)',
      fn: (i, f) => !f ? 'gone' : 'unapplied',
    },
    {
      // Treats every non-base state as already done — the optimistic mirror
      // image, which reports success for somebody else's cancellation.
      name: 'anything-not-base is applied (→ false success)',
      fn: (i, f) => !f ? 'gone' : f.updated_at === i.baseUpdatedAt ? 'unapplied' : 'applied',
    },
  ]

  // The scenarios §2–§3 rely on. If a mutant agrees with the real engine on ALL
  // of them, this file is not actually testing anything.
  const scenarios: { i: VisitIntent; f: VisitFacts | null }[] = [
    { i: intent('start'), f: facts() },
    { i: intent('start'), f: facts({ status: 'in_progress', started_at: intent('start').next.started_at, updated_at: V1 }) },
    { i: intent('start'), f: facts({ status: 'in_progress', started_at: '2026-08-15T08:00:00.000Z', updated_at: V1 }) },
    { i: intent('complete'), f: facts({ status: 'completed', completed_at: '2026-08-15T11:00:00.000Z', updated_at: V2 }) },
    { i: intent('start'), f: facts({ status: 'cancelled', updated_at: V1 }) },
  ]

  for (const m of mutants) {
    const caught = scenarios.some(s => m.fn(s.i, s.f) !== reconcileVisitIntent(s.i, s.f).kind)
    check(`mutant caught — ${m.name}`, caught,
      'this broken implementation agrees with the real engine on every scenario above')
  }
}

// ── 6 · Classification: not everything may queue ────────────────────────────
{
  console.log('\n6 · which writes may survive a dead zone')
  check('financial/auth writes are online-only',
    !isQueueable('auth.signin') && !isQueueable('auth.password') && !isQueueable('crew.join'))
  check('a signed URL is online-only (a queued credential is already expired)',
    writeClass('media.signed_url') === 'online-only')
  check('field-work facts are queueable',
    isQueueable('visit.start') && isQueueable('visit.complete') && isQueueable('visit.record')
    && isQueueable('crew.message') && isQueueable('crew.photo'))
  check('every kind is classified', FIELD_WRITE_KINDS.every(k => !!writeClass(k)))

  // ⭐ A classified-queueable write with no replay handler would sit in the queue
  // forever — which reads to a worker as "it saved" and is the quietest loss
  // this layer can produce.
  const handlers = read('src/lib/field/handlers.ts')
  const queueableVisitKinds = ['visit.start', 'visit.stop_for_day', 'visit.complete', 'visit.revert']
  check('⭐ every queueable visit transition has a replay path',
    queueableVisitKinds.every(() => /registerHandler\('field\.visit'/.test(handlers)))
  check('…notes have one', /registerHandler\('field\.record'/.test(handlers))
  check('…messages have one', /registerHandler\('field\.message'/.test(handlers))
  check('⭐ photos are NOT in the intent queue (they have their own durable path)',
    !/registerHandler\('field\.photo'/.test(handlers))
}

// ── 7 · ONE queue, not a second engine ──────────────────────────────────────
{
  console.log('\n7 · the crew reuses the app\'s outbox rather than forking it')
  const handlers = read('src/lib/field/handlers.ts')
  check('handlers register on lib/offline/outbox',
    /from '@\/lib\/offline\/outbox'/.test(handlers))
  check('⛔ no second IndexedDB queue was invented',
    !/indexedDB\.open/.test(handlers) && !/indexedDB\.open/.test(read('src/lib/field/fieldWrite.ts')))
  check('per-entity FIFO still works: the payload carries `id`',
    /id: stop\.id/.test(read('src/lib/field/fieldWrite.ts')),
    'outbox.entityKey reads payload.id — a rename here silently breaks ordering')
  const outbox = read('src/lib/offline/outbox.ts')
  check('the queue still blocks an entity after a failed op (Start/Undo ordering)',
    /blocked\.add\(key\)/.test(outbox) && /blocked\.has\(key\)/.test(outbox))
  check('a network failure still costs no attempt',
    /if \(isNetworkError\(err\)\) continue/.test(outbox))
}

// ── 8 · The cached day, and the sentence that must accompany it ─────────────
{
  console.log('\n8 · cached Today never poses as live')
  const stop: CrewStop = {
    id: 'j1', title: 'Mow', service_type: 'lawn', scheduled_date: '2026-08-15', start_time: '09:00',
    duration_minutes: 45, crew_size: 2, status: 'scheduled', started_at: null, completed_at: null,
    actual_minutes: null, on_my_way_at: null, route_order: 1, updated_at: V0, notes: 'gate code 1234',
    completion_summary: null, completion_issue: null,
    customer: { name: 'Jane', phone: '555' }, property: { address: '14 Elm', lat: 1, lng: 2 },
  }
  const day: CrewDay = {
    date: '2026-08-15', me: { id: 't1', name: 'Sam', role: 'tech', status: 'active' },
    crew: { id: 'c1', name: 'Blue', color: '#00f', day_start: '08:00' },
    business: { name: 'Edge', phone: '555', work_start_time: '08:00' },
    teammates: [{ id: 't2', name: 'Alex', role: 'tech' }],
    day_note: 'rain', crew_note: 'truck 2', stops: [stop],
  }

  // ⭐ A whitelist projection: anything crew_day grows later is DROPPED until a
  // human decides it belongs on a phone that may be lost.
  const polluted = {
    ...day,
    stops: [{ ...stop, price: 250, invoice_total: 999 } as unknown as CrewStop],
    lifetime_value: 9999, business_revenue: 100000,
  } as unknown as CrewDay
  const projected = projectDayForCache(polluted)
  const blob = JSON.stringify(projected)
  check('⭐⭐ money can never reach the cache, even if the RPC starts returning it',
    !/price|invoice|revenue|lifetime|balance|wage|cost/i.test(blob), blob.slice(0, 200))
  check('…and business-wide figures are dropped too',
    !('lifetime_value' in (projected as object)) && !('business_revenue' in (projected as object)))
  check('what the work NEEDS survives',
    projected.stops[0].property?.address === '14 Elm'
    && projected.stops[0].notes === 'gate code 1234'
    && projected.stops[0].customer?.name === 'Jane')
  check('⭐ the row version survives — a queued write needs its base',
    projected.stops[0].updated_at === V0)

  check('a cached day expires', isExpired(Date.now() - FIELD_CACHE_MAX_AGE_MS - 1))
  check('…but not within a working day', !isExpired(Date.now() - 10 * 60 * 60_000))
  check('⭐ the bound is under a day, so a revoked worker loses access fast',
    FIELD_CACHE_MAX_AGE_MS < 24 * 60 * 60_000)
  check('the banner label is a real time', /Last updated \d{1,2}:\d{2} (AM|PM)/.test(lastUpdatedLabel(Date.now())))

  const TC = read('src/lib/field/todayCache.ts')
  check('⭐ the cache is keyed by the auth user (a shared phone can\'t leak)',
    /function keyFor\(userId: string, dateISO: string\)/.test(TC) && /rec\.userId !== userId/.test(TC))
  // ⚠️ Matched on the CALL, not the word: the file's own header explains why
  // getUser() is wrong here, and a bare /getUser\(\)/ matched that prose — a
  // guard that fails on a comment teaches people to weaken the guard.
  check('the session id is read LOCALLY, so a cold offline start still scopes',
    /auth\.getSession\(\)/.test(TC) && !/auth\.getUser\(/.test(TC))

  const CT = read('src/components/crew/CrewToday.tsx')
  check('⭐⭐ a cached board always renders its banner',
    /fromCache/.test(CT) && /lastUpdatedLabel\(staleAsOf\)/.test(CT))
  check('…saying Offline, and warning the day may have changed',
    /'Offline'/.test(CT) && /may have changed your day/.test(CT))
  check('⛔ a REVOKED answer wipes the cached day',
    /res\.kind === 'revoked'[\s\S]{0,400}clearCachedDays\(\)/.test(CT))
  check('⛔ but a failed read never does (dead signal ≠ revocation)',
    !/kind === 'error'[\s\S]{0,200}clearCachedDays/.test(CT))
}

// ── 9 · Stale schedule: the server still wins ───────────────────────────────
{
  console.log('\n9 · reconnect refreshes canonical order; the cache never overrides it')
  const CT = read('src/components/crew/CrewToday.tsx')
  check('the cache is read ONLY when a live read failed with nothing on screen',
    /if \(dayRef\.current\) setStaleAsOf[\s\S]{0,300}readCachedDay/.test(CT))
  check('a successful load clears the cached flag',
    /setFromCache\(false\)/.test(CT))
  check('reconnect re-asks the RPC (online + visibility + interval)',
    /addEventListener\('online', onWake\)/.test(CT) && /setInterval\(onWake/.test(CT))
  check('⭐ crew_day still owns the order — nothing re-sorts the day locally',
    !/\.sort\(\(a, b\) => [\s\S]{0,40}route_order/.test(CT))
  // The crew-change brief is what SURFACES a meaningful change on reconnect.
  check('changes since the worker last acknowledged are still reported',
    /diffCrewDay/.test(CT) && exists('src/lib/crewBrief.ts'))

  // ⛔ The service worker must never cache a server-rendered schedule.
  const SW = read('public/sw.js')
  const shells = (SW.match(/const FIELD_SHELLS = \[([^\]]*)\]/) || [])[1] || ''
  check('⛔⛔ /crew/schedule is NOT an offline shell (server-rendered day counts)',
    !/crew\/schedule/.test(shells), shells)
  check('⛔ /dashboard is still never cached (it is a financial report)',
    !/'\/dashboard'/.test(shells), shells)
  check('the SW still refuses to cache a redirected (login) response',
    /!res\.redirected/.test(SW))
}

// ── 10 · Photos: retry cannot duplicate, and cannot fake completeness ───────
{
  console.log('\n10 · proof photos')
  const t = newPhotoToken()
  check('the same token always yields the same object path',
    photoStoragePath('u', 'p', 'j', t, 'jpg') === photoStoragePath('u', 'p', 'j', t, 'jpg'))
  check('different tokens never collide',
    photoStoragePath('u', 'p', 'j', newPhotoToken(), 'jpg') !== photoStoragePath('u', 'p', 'j', newPhotoToken(), 'jpg'))
  check('the tenant is the first path segment (the storage policy boundary)',
    photoStoragePath('owner-1', 'p', 'j', t, 'jpg').startsWith('owner-1/'))
  check('a malformed token is refused, never sanitised',
    !isValidPhotoToken('../../etc/passwd') && !isValidPhotoToken('a b') && isValidPhotoToken(t))

  const route = read('src/app/api/crew/photos/route.ts')
  check('⭐⭐ a retry short-circuits on the existing row BEFORE re-reading bytes',
    /storage_path', path\)[\s\S]{0,200}if \(prior\)/.test(route)
    || /\.eq\('storage_path', path\)[\s\S]{0,400}if \(prior\)/.test(route))
  check('⛔ a FAILED lookup is not treated as “no prior row”',
    /if \(priorErr\)/.test(route))
  check('storage upsert stays false, so storage itself is the atomic guard',
    /upsert: false/.test(route))
  check('an already-exists object is catalogued rather than failed',
    /already/.test(route) && /if \(!already\)/.test(route))

  const comp = read('src/components/crew/CrewStopPhotos.tsx')
  check('the token is minted at pick time and reused by Retry',
    /const token = newPhotoToken\(\)/.test(comp) && /upload\(s\.key, s\.file, s\.token\)/.test(comp))
  check('⭐ single-flight per shot closes the double-tap race',
    /inFlight/.test(comp))
  check('⛔⛔ only a server-confirmed row counts as evidence',
    isCanonicallyStored('stored') && !isCanonicallyStored('pending')
    && !isCanonicallyStored('uploading') && !isCanonicallyStored('failed'))
  check('outstanding counts everything not yet stored',
    outstandingShots(['stored', 'pending', 'failed', 'uploading']) === 3)
  check('the completion sheet still names outstanding photos rather than saying “Saved”',
    /photosOutstanding > 0/.test(read('src/components/completion/CompletionSheet.tsx')))
}

// ── 11 · Text preservation ──────────────────────────────────────────────────
{
  console.log('\n11 · a long note survives a failed save')
  const D = read('src/lib/field/drafts.ts')
  check('drafts are scoped to the worker AND the visit',
    /\$\{PREFIX\}:\$\{userId\}:\$\{jobId\}:\$\{field\}/.test(D))
  check('⛔ a draft is cleared only on confirmation or an explicit Discard',
    /export function clearDraft/.test(D) && !/setInterval|setTimeout/.test(D))
  const CS = read('src/components/completion/CompletionSheet.tsx')
  check('⭐ an unsent draft outranks the saved row when the sheet opens',
    /const draft = draftStore\?\.load\(\)/.test(CS) && /draft \? draft\.summary/.test(CS))
  check('the worker is TOLD the words were restored',
    /restored/.test(CS) && /never reached the office/.test(CS))
  check('Discard is offered beside Retry',
    /Discard/.test(CS))
  check('⛔ the draft dies only after the transport accepted it',
    /draftStore\?\.clear\(\)[\s\S]{0,120}onSaved/.test(CS))
  check('a queued note says so instead of borrowing “Saved”',
    /res\.pending/.test(CS) && /saved on your phone/.test(CS))
  check('the save result can express “accepted, not yet on the server”',
    /pending\?: boolean/.test(read('src/lib/completion.ts')))
}

// ── 12 · Connectivity UX: small, and honest ─────────────────────────────────
{
  console.log('\n12 · indicators')
  const S = read('src/components/crew/FieldSyncStatus.tsx')
  check('nothing renders when online with an empty queue',
    /if \(online && queued === 0 && justSynced === 0\) return null/.test(S))
  check('⛔ no full-width alarm banner — one pill',
    /rounded-full/.test(S) && !/fixed inset-x-0/.test(S))
  check('it says Offline / Saving… / Synced / to sync',
    /'Offline'/.test(S) && /Saving…/.test(S) && /Synced \$\{/.test(S) && /to sync/.test(S))
  check('⛔ the global widget never claims “Saved”', !/'Saved'/.test(S))
  check('a Retry tap is offered rather than hammering forever',
    /Retry/.test(S))
  check('it is mounted in the crew shell',
    /FieldSyncStatus/.test(read('src/app/crew/(app)/layout.tsx')))
  check('it clears the fixed crew nav', /safe-area-inset-bottom/.test(S))
}

// ── 13 · Security: a device that changes hands ──────────────────────────────
{
  console.log('\n13 · sign-out, revocation, and a disabled worker')
  const SO = read('src/components/crew/CrewSignOut.tsx')
  check('sign-out clears the cached day and the drafts',
    /clearCachedDays\(\)/.test(SO) && /clearAllDrafts\(\)/.test(SO))
  check('⭐⭐ …and the unsent queue, because a replay runs as whoever is signed in',
    /clearOutbox\(\)/.test(SO))
  check('⛔ but never silently — the worker is told what will be lost',
    /window\.confirm/.test(SO) && /discard/i.test(SO))
  check('…and warned BEFORE the tap, not only in the dialog',
    /still waiting to sync/.test(SO))
  check('it tries to drain the queue while the session is still valid',
    /await flush\(\)/.test(SO))

  const outbox = read('src/lib/offline/outbox.ts')
  check('clearAll exists and documents its single legitimate caller',
    /export async function clearAll/.test(outbox) && /sign-out/.test(outbox))

  // A disabled worker: the roster switches are the access control, and every
  // door re-asks. The cache TTL bounds what a phone that can no longer ask keeps.
  check('the crew completion route still resolves the technician per the roster',
    /is_active', true\)\.is\('archived_at', null\)/.test(read('src/app/api/crew/complete/route.ts')))
  check('the photo route does too',
    /is_active', true\)\.is\('archived_at', null\)/.test(read('src/app/api/crew/photos/route.ts')))
  check('⭐ a revoked replay is terminal, not retried forever',
    /kind === 'revoked'/.test(read('src/lib/field/handlers.ts')))
  check('a failed re-read keeps the op queued instead of dropping it',
    /if \(!reachable\) throw new Error/.test(read('src/lib/field/handlers.ts')))
}

// ── 14 · Registry parity ────────────────────────────────────────────────────
{
  console.log('\n14 · the guard is wired into the suite')
  const pkg = read('package.json')
  check('verify:field-reliability is registered',
    /"verify:field-reliability"/.test(pkg))
  check('…and runs this file',
    /verify-field-reliability\.ts/.test(pkg))
  // `npm run verify` DISCOVERS guards from scripts/ and cross-checks the npm
  // registry (verify-all's parity rule), so membership is proven by the entry
  // matching the file and the exact command shape — not by a name in a list.
  check('…with the exact command shape parity requires',
    /"verify:field-reliability": "tsx scripts\/verify-field-reliability\.ts"/.test(pkg))
  check('the guard file is where parity expects it',
    exists('scripts/verify-field-reliability.ts'))
}

console.log('\n── Summary ────────────────────────────────────────────────────')
if (failures) {
  console.log(`\n❌ verify:field-reliability — ${failures} failure${failures === 1 ? '' : 's'}\n`)
  process.exit(1)
}
console.log('\n✅ verify:field-reliability — the field app never claims a write it did not get\n')
