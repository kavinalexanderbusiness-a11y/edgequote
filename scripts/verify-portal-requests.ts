// ── Customer portal requests — `npm run verify:portal-requests` ──────────────
//
// WHY THIS EXISTS
// A customer can now ask their provider for work from the portal. The entire
// feature rests on ONE claim that is easy to state and easy to erode:
//
//        A REQUEST IS AN ASK, NOT AN OUTCOME.
//
// It is not a visit, not a schedule change, not an approved price. Every failure
// mode here is the same shape — something downstream starts treating the ask as
// settled — and each of them is quiet:
//
//   • a request that creates or prefills a visit (the owner "confirms" a booking
//     nobody made, and a customer who asked to MOVE Thursday gets a second visit)
//   • a price a customer typed into a request arriving in a quote as though the
//     business had offered it
//   • an owner-only field reaching the portal, or a customer photo reaching a
//     surface it wasn't scoped for
//   • the same ask landing twice because a phone lost one response
//
// So this guard drives the REAL engine (lib/portalRequests is pure — no React,
// no Supabase — so the production logic runs here unmodified), and then pins the
// structural facts in the migration and at each call site. §2 is the important
// half: the database is what actually enforces the media and duplicate rules, so
// the guard reads the migration rather than trusting the client.
//
// Offline. No network, no database.

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import {
  REQUEST_KINDS, REQUEST_PHOTO_BUCKET, MAX_REQUEST_PHOTOS,
  alternateActions, isOpenRequest, isRequestKind, isRequestPhotoPath, openRequests,
  recommendedAction, requestDetails, requestKindCustomerLabel, requestKindLabel,
  requestPhotoExt, requestPhotoPath, requestPhotoPaths,
} from '../src/lib/portalRequests'

let pass = 0, fail = 0
const H = (t: string) => console.log(`\n═══ ${t} ═══`)
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}${detail ? `\n     ${detail}` : ''}`) }
}

const ROOT = join(__dirname, '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
// ⚠️ CRLF-safe: `.` does not match `\r`, so the usual `^\s*\/\/.*$` stripper is a
// no-op on a CRLF checkout and every "this file must not contain X" check below
// would then read its own explanatory COMMENTS as the thing it forbids.
const stripComments = (s: string) =>
  s.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[^\S\n]*\/\/[^\n]*$/gm, '')
const code = (p: string) => stripComments(read(p))
// ⚠️ SQL needs its own stripper, and needs it MORE. Every file in this feature
// documents the rule it enforces in prose — the migration's own comments say
// "MUST NOT be selected by get_portal_data" and name jobs/quotes/invoices — so a
// raw-source regex reports the CURE as the DISEASE. (Two guards in this repo have
// already been bitten by exactly that.) `--` only: no `$…$` body in this feature
// contains a `--` inside a string literal.
const stripSql = (s: string) => s.replace(/^[^\S\n]*--[^\n]*$/gm, '').replace(/--[^\n]*$/gm, '')

/** Every .sql file under a directory, recursively. Archived history is EXCLUDED
 *  unless explicitly asked for: it holds superseded bodies by design, and a
 *  guard satisfied by one of those passes while the live rule is gone. */
function sqlFilesUnder(dir: string, out: string[] = [], includeArchive = false): string[] {
  const abs = join(ROOT, dir)
  if (!existsSync(abs)) return out
  for (const e of readdirSync(abs, { withFileTypes: true })) {
    if (e.name === 'archive' && !includeArchive) continue
    const rel = `${dir}/${e.name}`
    if (e.isDirectory()) sqlFilesUnder(rel, out, includeArchive)
    else if (e.name.endsWith('.sql')) out.push(rel)
  }
  return out
}

const UUID_A = '11111111-2222-3333-4444-555555555555'
const UUID_B = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const GOOD_PATH = `portal/${UUID_A}/${UUID_B}.jpg`

// ═══════════════════════════════════════════════════════════════════════════
H('1 · the engine — kinds and their words')

check('the five kinds are exactly what the database allows',
  JSON.stringify([...REQUEST_KINDS].sort()) ===
  JSON.stringify(['additional_work', 'appointment', 'plan_change', 'reschedule', 'service']))
check('an unknown kind is not a kind', !isRequestKind('booked') && !isRequestKind('') && !isRequestKind(null))
check('every kind has an owner label and a customer label',
  REQUEST_KINDS.every(k => requestKindLabel(k).length > 0 && requestKindCustomerLabel(k).length > 0))
// A kind nobody named must not silently read as one that IS named.
check('an unknown kind falls back, it does not impersonate',
  requestKindLabel('nonsense') === 'Request' && requestKindCustomerLabel('nonsense') === 'Something else')
// The one word that must never appear: a request has not been booked, agreed or
// approved, and a label saying so would be the lie the whole feature guards.
check('no label claims the work is settled',
  REQUEST_KINDS.every(k => !/\b(booked|approved|confirmed|scheduled|agreed)\b/i
    .test(`${requestKindLabel(k)} ${requestKindCustomerLabel(k)}`)))

// ═══════════════════════════════════════════════════════════════════════════
H('2 · media stays scoped — and the DATABASE is what enforces it')

check('the bucket is the one customer-supplied photos already use',
  REQUEST_PHOTO_BUCKET === 'booking-uploads')
check('a well-formed path is accepted', isRequestPhotoPath(GOOD_PATH))
check('every accepted extension round-trips',
  ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'].every(e => isRequestPhotoPath(`portal/${UUID_A}/${UUID_B}.${e}`)))

// The vectors that matter. Each of these was ALSO refused by the live RPC.
const REJECT: [string, string][] = [
  ['an absolute URL', 'https://evil.example.com/x.jpg'],
  ['a supabase URL for this same bucket', `https://x.supabase.co/storage/v1/object/public/booking-uploads/${GOOD_PATH}`],
  ['another bucket', `job-photos/${UUID_A}/${UUID_B}.jpg`],
  ['the private crew bucket', `crew-media/${UUID_A}/${UUID_B}.jpg`],
  ['path traversal', `portal/../../crew-media/${UUID_A}/${UUID_B}.jpg`],
  ['a non-image extension', `portal/${UUID_A}/${UUID_B}.svg`],
  ['a script extension', `portal/${UUID_A}/${UUID_B}.html`],
  ['a customer-supplied filename', `portal/${UUID_A}/my photo.jpg`],
  ['a missing segment', `portal/${UUID_B}.jpg`],
  ['a leading slash', `/portal/${UUID_A}/${UUID_B}.jpg`],
  ['a trailing query string', `portal/${UUID_A}/${UUID_B}.jpg?x=1`],
  ['an empty string', ''],
]
for (const [label, v] of REJECT) check(`refused: ${label}`, !isRequestPhotoPath(v), v)
check('a non-string is refused', !isRequestPhotoPath(null) && !isRequestPhotoPath(42) && !isRequestPhotoPath({}))

check('a mixed array keeps only what is valid',
  JSON.stringify(requestPhotoPaths([GOOD_PATH, 'https://evil.example.com/x.jpg', null, `job-photos/${UUID_A}/${UUID_B}.jpg`])) ===
  JSON.stringify([GOOD_PATH]))
check('a non-array reads as no photos',
  requestPhotoPaths(null).length === 0 && requestPhotoPaths('a string').length === 0 && requestPhotoPaths(undefined).length === 0)
check(`render caps at ${MAX_REQUEST_PHOTOS} however many arrived`,
  requestPhotoPaths(Array.from({ length: 40 }, (_, i) => `portal/${UUID_A}/aaaaaaaa-bbbb-cccc-dddd-${String(i).padStart(12, '0')}.jpg`)).length === MAX_REQUEST_PHOTOS)

check('the path builder produces a path the validator accepts',
  requestPhotoPath(UUID_A, UUID_B, 'png') === `portal/${UUID_A}/${UUID_B}.png`)
check('the path builder refuses an extension the bucket path cannot carry',
  requestPhotoPath(UUID_A, UUID_B, 'svg') === null && requestPhotoPath(UUID_A, UUID_B, '') === null)
check('the path builder refuses an id that is not a uuid',
  requestPhotoPath('../crew-media', UUID_B, 'jpg') === null && requestPhotoPath(UUID_A, 'my file', 'jpg') === null)
check('the extension comes from the MIME type first',
  requestPhotoExt('whatever.txt', 'image/png') === 'png')
check('a file we cannot place is refused rather than guessed',
  requestPhotoExt('resume.pdf', 'application/pdf') === null && requestPhotoExt('script.svg', 'image/svg+xml') === null)
check('a phone that reports no MIME type still works from the name',
  requestPhotoExt('IMG_0042.HEIC', '') === 'heic')

// The DATABASE is the enforcement; the TypeScript above is a render-time refusal.
{
  // ⭐ THE APPLY PATH IS THE SUBJECT, NOT THIS FEATURE'S OWN FILE.
  // supabase/migrations/ is what a rebuild runs, and its baseline is GENERATED
  // from production — so asserting against it proves the rule survives a
  // regeneration by someone else. This feature's original migration now lives in
  // supabase/archive/ledger/ as history; `sqlFilesUnder` deliberately skips
  // archive/, because a guard satisfied by a superseded copy is a guard that
  // passes while the live rule is gone.
  const APPLY = sqlFilesUnder('supabase/migrations')
  check('there is an apply path to check', APPLY.length > 0, 'supabase/migrations is empty')
  const sql = stripSql(APPLY.map(read).join('\n'))
  // The original migration is still REPRESENTED, in the archive the migration
  // system keeps history in — losing it would mean production ran SQL the repo
  // cannot show anyone.
  check('the portal-requests migration is preserved in the ledger archive',
    sqlFilesUnder('supabase/archive/ledger', [], true).some(p => /portal_requests/i.test(p)))
  check('a CHECK constraint — not app code — validates the photo column',
    /add constraint "?service_requests_photos_check"?[\s\S]{0,120}check \((public\.)?portal_request_photos_ok\(photos\)\)/i.test(sql))
  check('the validator caps the count in SQL too',
    /portal_request_photos_ok[\s\S]{0,400}array_length\(p, 1\), 0\) <= 6/i.test(sql))
  check('the SQL validator pins the same portal/<uuid>/<uuid>.<ext> shape',
    /\^portal\/\[0-9a-f\]\{8\}/.test(sql) && /\\\.\(jpg\|jpeg\|png\|webp\|heic\|heif\)\$/.test(sql))
  check('the media column stores paths, never URLs (no https in the shape)',
    !/portal_request_photos_ok[\s\S]{0,400}https/i.test(sql))

  H('3 · a request cannot become work — proven in the migration')
  const fnStart = sql.indexOf('CREATE OR REPLACE FUNCTION public.portal_submit_request')
  // Bounded at the function's own terminator, so the scan below is the request
  // door's body and not "everything after it in the file".
  const body = fnStart < 0 ? '' : sql.slice(fnStart, sql.indexOf('$function$;', fnStart))
  check('the request door body was located and is bounded', body.length > 200 && body.length < 6000, `${body.length} chars`)
  check('the request door writes to service_requests and nothing else',
    (body.match(/insert into public\.\w+/gi) || []).every(m => /service_requests/i.test(m)),
    (body.match(/insert into public\.\w+/gi) || []).join(', '))
  check('the request door updates no table at all',
    !/^\s*update public\./mi.test(body))
  for (const t of ['jobs', 'quotes', 'invoices', 'payments', 'job_recurrences']) {
    // It may READ them (that is how it re-scopes a caller-supplied id); it must
    // never write one.
    check(`no write to ${t} anywhere in the request door`,
      !new RegExp(`(insert into|update|delete from)\\s+public\\.${t}\\b`, 'i').test(body))
  }
  check('a caller-supplied job id is re-resolved against the token’s customer',
    /from public\.jobs where id = p_job_id and customer_id = v_customer and user_id = v_user/i.test(body))
  check('a caller-supplied plan id is re-resolved the same way',
    /from public\.job_recurrences where id = p_recurrence_id and customer_id = v_customer and user_id = v_user/i.test(body))
  check('a revoked token resolves to nobody',
    /from public\.customer_portal_tokens where token = p_token and not revoked/i.test(body))
  check('every insert is stamped from_portal, so the owner queue can tell an ask from a lead',
    /from_portal[\s\S]{0,400}values[\s\S]{0,400}true/i.test(body))

  H('4 · the same ask cannot land twice')
  check('a partial UNIQUE INDEX enforces it in the database',
    /create unique index[\s\S]{0,80}service_requests_open_dedup_idx[\s\S]{0,200}\(customer_id, dedup_key\)[\s\S]{0,160}where \(*dedup_key is not null\)* and \(*status = 'new'/i.test(sql))
  check('the insert absorbs the collision instead of erroring at the customer',
    /on conflict do nothing/i.test(body))
  check('the dedup key covers the ask, the date and the visit',
    /v_key := md5\(p_kind[\s\S]{0,200}p_preferred_date[\s\S]{0,80}p_job_id/i.test(body))
  check('a repeated submission still reports success (the request IS on file)',
    /on conflict do nothing;[\s\S]{0,200}return true;/i.test(body))
  check('the free-text door is a WRAPPER, not a second implementation',
    /FUNCTION public\.portal_request_service[\s\S]{0,400}return public\.portal_submit_request\(/i.test(sql))
  // ⭐ Stated as the INVARIANT rather than as the DROP that established it. The
  // baseline is generated from production, so it defines what exists and never
  // records a drop — but the thing that actually matters is that a rebuilt
  // database has exactly ONE of these. Two overloads differing only by a
  // defaulted trailing parameter make a 7-named-argument PostgREST call
  // ambiguous, and every portal request would start failing with "function is
  // not unique".
  const submitDefs = sql.match(/FUNCTION public\.portal_submit_request\s*\(/gi) || []
  check('the apply path defines exactly ONE portal_submit_request', submitDefs.length === 1, `${submitDefs.length} definitions`)
  check('…and it is the 8-argument signature that takes photos',
    /FUNCTION public\.portal_submit_request\([\s\S]{0,400}p_photos text\[\]/i.test(sql))
  check('a rebuilt database grants it to anon (the portal is a no-login surface)',
    /grant execute on function public\."?portal_submit_request"?\((p_token )?text, ?(p_message )?text, ?(p_kind )?text, ?(p_preferred_date )?date, ?(p_job_id )?uuid, ?(p_recurrence_id )?uuid, ?(p_details )?jsonb, ?(p_photos )?text\[\]\) to anon/i.test(sql))
  check('a closed request records when, and an open one never can',
    /service_requests_resolved_at_check[\s\S]{0,140}\(*resolved_at is null\)* or \(*status <> 'new'/i.test(sql))
  check("the status vocabulary is three words, reusing production's own 'handled'",
    /service_requests_status_check[\s\S]{0,160}'new'[\s\S]{0,40}'handled'[\s\S]{0,40}'dismissed'/i.test(sql))
}

// ═══════════════════════════════════════════════════════════════════════════
H('5 · the owner queue counts asks, not leads')

const R = (o: Partial<{ from_portal: boolean; status: string }>) =>
  ({ from_portal: true, status: 'new', ...o })
check('an open portal ask is open', isOpenRequest(R({})))
check('a handled ask is not', !isOpenRequest(R({ status: 'handled' })))
check('a dismissed ask is not', !isOpenRequest(R({ status: 'dismissed' })))
// ⭐ The one that matters: service_requests is shared with website leads and
// online bookings, which close in their OWN lifecycles and sit at status='new'
// forever. Production had 27 such rows on the day this shipped.
check('a website lead sitting at status=new is NOT a customer request',
  !isOpenRequest(R({ from_portal: false })))
check('openRequests filters a mixed table down to the asks only',
  openRequests([R({}), R({ from_portal: false }), R({ status: 'handled' }), R({})]).length === 2)
check('a null or undefined table reads as none, not as a crash',
  openRequests(null).length === 0 && openRequests(undefined).length === 0)

// ═══════════════════════════════════════════════════════════════════════════
H('6 · the recommended action opens a door, and carries no money through it')

const CUST = 'cccccccc-1111-2222-3333-444444444444'
for (const kind of REQUEST_KINDS) {
  const a = recommendedAction({ kind, customer_id: CUST, job_id: null })
  check(`${kind}: has a label, an href and a hint`, !!a.label && !!a.href && !!a.hint)
  // ⭐ Nothing about the ask may ride into the creation door. A price a customer
  // typed cannot become a quote line, and a date they asked for cannot become a
  // booked visit, if the link cannot carry either.
  check(`${kind}: the door carries no amount, service or date`,
    !/[?&](amount|price|total|service|date|line|request)=/i.test(a.href), a.href)
  check(`${kind}: the door names nothing but the customer`,
    a.href.split('?')[1] === undefined || /^customer=[0-9a-f-]+$/.test(a.href.split('?')[1]), a.href)
}
check('a quote ask opens the quote builder on this customer',
  recommendedAction({ kind: 'service', customer_id: CUST, job_id: null }).href === `/dashboard/quotes/new?customer=${CUST}`)
check('extra work is priced in a quote — there is no invented change-order object',
  recommendedAction({ kind: 'additional_work', customer_id: CUST, job_id: 'j1' }).key === 'quote')
// ⭐ `?customer=` on the schedule page opens a prefilled NEW-visit form. Putting
// that in front of "please move Thursday" is how a request becomes a DUPLICATE
// visit — the exact failure this feature must not have.
check('a schedule change opens the schedule BARE — never a new-visit form',
  recommendedAction({ kind: 'reschedule', customer_id: CUST, job_id: 'j1' }).href === '/dashboard/schedule')
check('a plan change does the same', recommendedAction({ kind: 'plan_change', customer_id: CUST, job_id: null }).href === '/dashboard/schedule')
// An appointment request IS new work, so the prefilled door is correct there.
check('only a NEW appointment prefills the schedule, and only with the customer',
  recommendedAction({ kind: 'appointment', customer_id: CUST, job_id: null }).href === `/dashboard/schedule?customer=${CUST}`)
check('a request with no customer still yields a usable door',
  recommendedAction({ kind: 'service', customer_id: null, job_id: null }).href === '/dashboard/quotes/new')
check('every hint states what has NOT happened',
  REQUEST_KINDS.every(k => /nothing|yourself|you set|untouched/i.test(recommendedAction({ kind: k, customer_id: CUST, job_id: null }).hint)))
check('the alternates never repeat the recommendation',
  REQUEST_KINDS.every(k => {
    const p = recommendedAction({ kind: k, customer_id: CUST, job_id: null })
    return alternateActions({ kind: k, customer_id: CUST, job_id: null }).every(a => a.key !== p.key)
  }))
check('an appointment request is never also offered the bare schedule (one schedule door)',
  alternateActions({ kind: 'appointment', customer_id: CUST, job_id: null }).every(a => a.key !== 'schedule'))

H('7 · the free-form details blob is read defensively, never rendered raw')
check('known keys survive', JSON.stringify(requestDetails({ window: 'morning', service: 'Mowing' })) === JSON.stringify({ window: 'morning', service: 'Mowing' }))
check('an unknown window is dropped, not shown', requestDetails({ window: 'whenever' }).window === undefined)
check('unknown keys are dropped entirely', JSON.stringify(requestDetails({ evil: '<script>', amount: 999 })) === '{}')
check('a non-object reads as empty', JSON.stringify(requestDetails('nope')) === '{}' && JSON.stringify(requestDetails(null)) === '{}' && JSON.stringify(requestDetails([1, 2])) === '{}')
check('long values are capped', (requestDetails({ service: 'x'.repeat(500) }).service || '').length <= 80)

// ═══════════════════════════════════════════════════════════════════════════
H('8 · the portal side — every customer action is still a REQUEST')
{
  const tab = code('src/app/portal/[token]/components/RequestsTab.tsx')
  const client = code('src/app/portal/[token]/PortalClient.tsx')
  check('the composer sends through the request pipeline',
    /actions\.submitRequest\(/.test(tab))
  // The portal writes no table, ever. `.from(` is allowed only for storage.
  const portalDir = join(ROOT, 'src', 'app', 'portal')
  const portalFiles: string[] = []
  ;(function walk(d: string) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p); else if (/\.tsx?$/.test(p)) portalFiles.push(p)
    }
  })(portalDir)
  const dbWrites = portalFiles.filter(f => /supabase\s*\n?\s*\.from\(/.test(stripComments(readFileSync(f, 'utf8'))))
  check('no portal file writes a table directly — every action is an RPC', dbWrites.length === 0, dbWrites.join(', '))
  check('the composer uploads photos BEFORE it writes the message',
    /uploadRequestPhotos[\s\S]{0,900}const msg = \[head/.test(tab))
  check('a request whose photos all failed is not sent as though they attached',
    /res\.failed > 0 && res\.paths\.length === 0[\s\S]{0,300}return/.test(tab))
  check('the photo count in the message comes from what LANDED, not what was picked',
    /paths\.length \? `\(\$\{paths\.length\} photo/.test(tab))
  check('a date only travels with a schedule change',
    /preferredDate: kind === 'reschedule' && date \? date : null/.test(tab))
  check('a visit id only travels with a schedule change',
    /jobId: kind === 'reschedule' && chosenJob \? chosenJob\.id : null/.test(tab))
  check('the upload keeps the storage PATH and discards the customer’s filename',
    /requestPhotoPath\(batch, crypto\.randomUUID\(\), ext\)/.test(client))
  check('the portal token never becomes part of a public-bucket path',
    !/requestPhotoPath\([^)]*token/.test(client))
  check('a failed upload is counted, never returned as a path',
    /if \(error\) failed\+\+[\s\S]{0,60}else paths\.push\(path\)/.test(client))

  // The copy IS the feature. Both the pre-send helper and the confirmation must
  // say that nothing happened yet.
  const tabRaw = read('src/app/portal/[token]/components/RequestsTab.tsx')
  check('the button’s helper text says nothing is booked, changed or charged',
    /This sends a request — nothing is booked, changed or charged until/.test(tabRaw))
  check('the confirmation says it again, after the send',
    /nothing is booked, changed or charged until \{who === 'We' \? 'we get' : 'they get'\} back to you/.test(tabRaw))
  check('the appointment card keeps its own "nothing is booked" line',
    /This sends a request — nothing is booked until we confirm/.test(tabRaw))
}

// ═══════════════════════════════════════════════════════════════════════════
H('9 · the owner side — the card acts on an ask and closes it honestly')
{
  const card = code('src/components/messages/RequestCard.tsx')
  check('it reads only PORTAL requests that are still open',
    /\.eq\('from_portal', true\)[\s\S]{0,60}\.eq\('status', 'new'\)/.test(card))
  check('it scopes every read to the signed-in owner',
    (card.match(/\.eq\('user_id', uid\)/g) || []).length >= 2)
  check('a failed read is not "no requests"', /setLoadError\(!!error\)/.test(card))
  // ⭐ A Supabase update RESOLVES on failure. Removing the row optimistically
  // would leave the owner believing they closed a request the customer is still
  // waiting on.
  check('the close is VERIFIED before the row leaves the screen',
    /\.update\(\{ status, resolved_at[\s\S]{0,140}\.select\('id'\)[\s\S]{0,200}if \(error \|\| !data\?\.length\)[\s\S]{0,200}return/.test(card))
  check('closing writes only status and resolved_at',
    /\.update\(\{ status, resolved_at: new Date\(\)\.toISOString\(\) \}\)/.test(card))
  check('the card can write to service_requests and nothing else',
    (card.match(/\.from\('(\w+)'\)/g) || []).every(m => /service_requests|jobs/.test(m)) &&
    !/\.from\('jobs'\)[\s\S]{0,120}\.(insert|update|delete)\(/.test(card))
  check('photos are re-validated at render, not trusted from the row',
    /requestPhotoPaths\(r\.photos\)/.test(card))
  check('the photo URL is built from the bucket named in code',
    /storage\.from\(REQUEST_PHOTO_BUCKET\)\.getPublicUrl/.test(card))
  check('the recommended action comes from the engine, not from this component',
    /recommendedAction\(r\)/.test(card) && !/dashboard\/quotes\/new\?customer=/.test(card))
  check('closing a request does not message the customer, and says so',
    /doesn’t message the customer/.test(read('src/components/messages/RequestCard.tsx')))

  const page = code('src/app/dashboard/messages/page.tsx')
  check('the card is mounted in the inbox, where the notification already lands',
    /<RequestCard customerId=\{sel\.customer_id\}/.test(page))
  check('the Requests view keeps a conversation until the request is CLOSED, not until it is read',
    /if \(f === 'requests'\) return !!openReq && !!c\.customer_id && openReq\.has\(c\.customer_id\)/.test(page))
  check('a failed request read leaves the previous set alone rather than emptying the pill',
    /reqRes\.error \? openReqRef\.current/.test(page))
  check('the pill only appears while someone is waiting',
    /f\.key === 'requests' && counts\.requests === 0 && filter !== 'requests'/.test(page))
  check('the empty Requests view says what its emptiness MEANS',
    /Nobody is waiting on you/.test(read('src/app/dashboard/messages/page.tsx')))
}

// ═══════════════════════════════════════════════════════════════════════════
H('10 · the dashboard counts it once, not twice')
{
  const pri = code('src/lib/dashboard/priorities.ts')
  const data = code('src/lib/dashboard/data.ts')
  check('there is a requests tier', /kind: 'requests'/.test(pri))
  // ⭐ Submitting a request writes an inbound portal message. Without this the
  // queue would say "answer 1 request" AND "reply to 1 message" about one person
  // asking for one thing — the same double count the leads row already fixed.
  check('customers with an open request are excluded from the unread-messages tier',
    /requestCustomerIds\.has\(c\.customer_id\)/.test(pri))
  // ⭐ A wrong query-param name is a DEAD LINK that looks alive: the inbox reads
  // `?f=`, ignores anything else, and lands on All — so the owner taps "answer 3
  // requests" and gets their whole inbox with nothing saying why. Caught only by
  // pinning the param against the filter key it must match.
  check('the queue row deep-links with the param the inbox actually reads',
    /href: '\/dashboard\/messages\?f=requests'/.test(pri))
  check('…and that filter key exists in the inbox',
    /\{ key: 'requests', label: 'Requests'/.test(code('src/app/dashboard/messages/page.tsx')))
  check('the tier sits above unread messages',
    /kind: 'requests'[\s\S]{0,200}score: 32_000/.test(pri) && /kind: 'messages'[\s\S]{0,200}score: 30_000/.test(pri))
  check('the engine is fed rows already filtered by ITS OWN predicate',
    // Either form of the same chain: the inline call, or S97's named binding —
    // ONE openRequests() result feeding both the engine and the briefing's
    // requestsOpen count, so the two can never disagree. What must never pass
    // is computePriorities receiving reqRes rows raw.
    /requests: openRequests\(/.test(data)
    || (/const openReqs = openRequests\(/.test(data) && /requests: openReqs,/.test(data)))
  check('the dashboard query asks the database for open portal rows',
    /from\('service_requests'\)[\s\S]{0,200}\.eq\('from_portal', true\)[\s\S]{0,60}\.eq\('status', 'new'\)/.test(data))
  check('a failed request read takes the dashboard down rather than painting a reassuring zero',
    /reqRes\.error \? `customer requests/.test(data))
}

// ═══════════════════════════════════════════════════════════════════════════
H('11 · internal notes stay internal')
{
  // The portal's ONE data source is get_portal_data, and this feature did not
  // touch it. Pin that the owner-private columns are still absent from it, so a
  // later "just add one field" cannot ride in on this lane.
  // Whichever file the repo currently keeps the portal RPC in — CANONICAL on
  // today's main, the generated baseline once Session 41 lands. There must be
  // exactly ONE (verify:portal-canonical owns that rule; this re-states it so
  // this guard cannot silently read the wrong copy).
  const defFiles = sqlFilesUnder('supabase')
    .filter(p => /create\s+(or\s+replace\s+)?function\s+public\.get_portal_data/i.test(read(p)))
  check('exactly one file in the apply path defines get_portal_data', defFiles.length === 1, defFiles.join(', '))
  const defFile = defFiles[0]
  if (defFile) {
    // ⚠️ Stripped FIRST. The live definition documents, in a `--` comment inside
    // its own body, that completion_issue is internal and absent — so an
    // unstripped scan finds the word and reports a leak that is actually the
    // note explaining there is none.
    const all = stripSql(read(defFile))
    const start = all.search(/CREATE OR REPLACE FUNCTION public\.get_portal_data/i)
    const def = all.slice(start, all.indexOf('$function$;', start))
    for (const col of ['internal_notes', 'completion_issue', 'crew_media', 'lead_meta']) {
      check(`get_portal_data still does not select ${col}`, !new RegExp(`\\b${col}\\b`).test(def))
    }
    check('the customer portal payload carries no service_requests at all',
      !/service_requests/i.test(def))
  }
  // The owner's card is owner-only by construction: it lives under
  // src/components/messages (a dashboard surface) and the portal imports nothing
  // from it.
  const portalFiles: string[] = []
  ;(function walk(d: string) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p); else if (/\.tsx?$/.test(p)) portalFiles.push(p)
    }
  })(join(ROOT, 'src', 'app', 'portal'))
  const leaks = portalFiles.filter(f => /components\/messages\/RequestCard|dashboard\//.test(readFileSync(f, 'utf8')))
  check('no portal file imports an owner surface', leaks.length === 0, leaks.join(', '))
  check('the engine exposes no owner-only copy to the portal bundle by accident',
    !/internal|private note/i.test(code('src/lib/portalRequests.ts').replace(/hint:/g, '')))
}

// ═══════════════════════════════════════════════════════════════════════════
H('12 · mobile')
{
  const tabRaw = read('src/app/portal/[token]/components/RequestsTab.tsx')
  const card = read('src/components/messages/RequestCard.tsx')
  // 16px inputs: anything smaller and iOS Safari zooms the page on focus, which
  // on a phone means the form jumps under the thumb mid-type.
  check('the composer textarea does not trigger iOS zoom on focus',
    /text-base sm:text-sm[\s\S]{0,200}aria-label="What do you need\?"/.test(tabRaw) ||
    /aria-label="What do you need\?"[\s\S]{0,400}text-base sm:text-sm/.test(tabRaw))
  check('the type picker meets the gloved-thumb target',
    /role="radiogroup"[\s\S]{0,400}tap-target-y/.test(tabRaw))
  check('the photo button meets it too', /tap-target-y[\s\S]{0,600}Add photos/.test(tabRaw))
  check('the type picker is a radiogroup, not a select (three options, no modal wheel)',
    /role="radiogroup"/.test(tabRaw) && /role="radio" aria-checked/.test(tabRaw))
  check('the primary owner action is full-width on a phone',
    /<ButtonLink href=\{action\.href\}[^>]*className="w-full sm:w-auto"/.test(card))
  check('the owner card’s facts stack on a phone and pair on a desktop',
    /grid-cols-1 sm:grid-cols-2/.test(card))
  check('the customer’s words wrap instead of overflowing a narrow card',
    /whitespace-pre-wrap break-words/.test(card))
  check('photo thumbnails wrap rather than forcing a horizontal scroll',
    /flex flex-wrap gap-1\.5/.test(card))
}

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${'─'.repeat(72)}`)
if (fail === 0) console.log(`✅ PORTAL REQUESTS OK — ${pass} checks passed.\n   A request is an ask: it writes one row, prices nothing, and books nothing.\n`)
else console.error(`❌ PORTAL REQUESTS FAILED — ${fail} failed, ${pass} passed.\n`)
process.exit(fail === 0 ? 0 : 1)

// Referenced so the import list above is the real contract this guard drives.
export { existsSync }
