// ── Verify: the visit conversation stays internal, attributed, and honest ────
//   npm run verify:crew-messages
//
// WHY THIS SCRIPT EXISTS
// Crew Communications V1 makes four promises, and every one of them breaks in a
// way that typechecks, lints, builds and reads like an improvement in review:
//
//   1. A CUSTOMER NEVER SEES IT. One column added to get_portal_data, or one
//      `{msg.body}` in a PDF, and the conversation about a customer becomes a
//      document sent to that customer. (jobs.notes ALREADY did this once — 49 of
//      78 completed visits rendered their gate codes in the portal.)
//   2. ONLY THE ASSIGNED CREW SEES IT. Drop `j.crew_id = v_crew` from one RPC
//      and every worker in the business can read every customer's conversation
//      by changing a job id in a request.
//   3. THE AUTHOR IS DERIVED, NEVER ACCEPTED. Delete the identity trigger and a
//      client can post as anybody.
//   4. NOTHING EVER LOOKS SENT WHEN IT IS NOT. Swap the outbox for an optimistic
//      append and a message that never left the phone sits in the transcript
//      looking delivered — the office believes it was told, and nobody is.
//
// ⚠️ THIS FILE READS SQL AND TSX AS TEXT, so it strips comments first. This very
// file's comments contain every dangerous string it searches for, and so do the
// files it reads — a naive grep reports the WARNING as the BREACH. The stripper
// is CRLF-safe on purpose: `.` does not match `\r`, so a `.*$` pattern strips
// NOTHING on a CRLF checkout and every absence check silently inverts into a
// pass. (verify:customer-import and ba2095ea learned this the hard way.)

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  SCOPED_NOTE_FIELDS, AUDIENCE_READERS,
} from '../src/lib/noteScope'
import {
  MAX_MESSAGE_CHARS, unreadCount, isAttentionWorthy, messageProblem, totalUnread, unreadLabel,
  type CrewMessage, type CrewInboxItem,
} from '../src/lib/crewMessages'

let failures = 0
const ok = (n: string) => console.log(`  ✓ ${n}`)
const fail = (n: string, d: string) => { failures++; console.log(`  ✗ ${n}\n      ${d}`) }
const check = (n: string, cond: boolean, d = '') => cond ? ok(n) : fail(n, d)

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const has = (p: string) => existsSync(join(ROOT, p))

/** `[^\n\r]` rather than `.*$` — see the CRLF note above. */
const stripSql = (s: string) => s.replace(/--[^\n\r]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
const stripTs = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n\r]*/g, '')

// ── 0. The stripper actually strips ─────────────────────────────────────────
// Asserted FIRST, because every absence check below is worthless if this is a
// no-op — and a no-op stripper makes them all PASS.
console.log('\n═══ The comment stripper (every absence check depends on it) ═══')
check('strips a -- comment on a CRLF line',
  !stripSql('select a\r\n-- crew_messages\r\nfrom t').includes('crew_messages'),
  'a `.*$` pattern leaves the text behind on CRLF and inverts every check below')
check('strips a // comment on a CRLF line',
  !stripTs('const a = 1\r\n// crew_messages\r\n').includes('crew_messages'))
check('strips a JSX block comment',
  !stripTs('<div>{/* crew_messages never here */}</div>').includes('crew_messages'))
check('keeps real code',
  stripSql('select body -- a comment\nfrom crew_messages').includes('crew_messages'),
  'over-stripping would make these checks vacuous in the other direction')

const SQL_PATH = 'supabase/archive/run/RUN-2026-08-13-crew-messages.sql'
check(`${SQL_PATH} exists`, has(SQL_PATH))
const sqlRaw = has(SQL_PATH) ? read(SQL_PATH) : ''
const sql = stripSql(sqlRaw)

// ── 1. A NOTE is not a MESSAGE ──────────────────────────────────────────────
// The distinction this whole feature turns on. If it ever collapses, both halves
// break: a gate code said once in chat is buried by the twentieth reply, and a
// note appended with "…and now 1943" makes a worker read history to find truth.
console.log('\n═══ Notes and messages stay different things ═══')

const jobsNotes = SCOPED_NOTE_FIELDS.find(f => f.table === 'jobs' && f.column === 'notes')
check('jobs.notes still exists and is still the CREW-audience standing instruction',
  !!jobsNotes && jobsNotes.audience === 'crew',
  'the durable instruction must not have been replaced by the conversation')

const msgField = SCOPED_NOTE_FIELDS.find(f => f.table === 'crew_messages')
check('crew_messages is registered in the audience registry',
  !!msgField,
  'an audience the registry does not know about is an audience verify:scoped-notes cannot hold')
check('crew_messages is CREW audience, and crew excludes the customer',
  !!msgField && msgField.audience === 'crew' && !AUDIENCE_READERS.crew.includes('customer'))
check('crew_messages claims the WHOLE-TABLE guarantee',
  !!msgField && msgField.wholeTable === true,
  'without it verify:scoped-notes falls back to a column-list check, which nested projections defeat')
check('crew_messages names what enforces it',
  !!msgField && /RPC|DEFINER|projection|portal/i.test(msgField.enforcedBy),
  'an audience claim with no named enforcement is a comment, not a boundary')

// ⛔ THE ANTI-PATTERN THE MODEL EXISTS TO PREVENT. Session 35 settled that the
// audience of text is a property of the COLUMN/TABLE, never of a flag: a wrong
// enum value is one UPDATE from publishing a gate code.
// ⚠️ Scoped to the COLUMN LIST, not the whole file. `comment on table … is
// 'CREW AUDIENCE …'` is a string LITERAL, which stripSql does not remove and
// must not — so a whole-file grep reports the documentation as the defect. The
// claim being tested is about columns, so read the columns.
const createBlock = (table: string): string => {
  const i = sql.indexOf(`create table if not exists public.${table} (`)
  if (i < 0) return ''
  return sql.slice(i, sql.indexOf('\n);', i))
}
const msgColumns = createBlock('crew_messages')
check('the crew_messages column list was located (mechanism control)',
  /author_kind/.test(msgColumns) && /client_token/.test(msgColumns),
  'if this fails the enum check below is reading an empty string and proves nothing')
check('no visibility/audience enum was introduced on the conversation',
  msgColumns.length > 0 && !/^\s*(visibility|audience|is_public|customer_visible)\s+\w/mi.test(msgColumns),
  'a per-row visibility switch on crew_messages would be a control whose only use is to leak')

// ── 2. Tenancy and assignment, in SQL ───────────────────────────────────────
console.log('\n═══ Whose conversation is this ═══')

const fnBody = (name: string): string => {
  const start = sql.indexOf(`function public.${name}(`)
  if (start < 0) return ''
  const rest = sql.slice(start)
  const end = rest.indexOf('$$;')
  return end < 0 ? rest : rest.slice(0, end)
}

const READ_DOORS = ['crew_job_messages', 'crew_post_message', 'crew_message_inbox']
for (const fn of READ_DOORS) {
  const body = fnBody(fn)
  check(`${fn} exists`, body.length > 0, 'the crew door is missing entirely')
  if (!body) continue
  // MECHANISM CONTROL: prove the slice really is the function body, so the
  // assertions below are findings about the SQL and not about an empty string.
  check(`${fn}'s body was actually located (mechanism control)`,
    /crew_employer\(\)/.test(body),
    'if this fails, fnBody is not reading the function and every check on it proves nothing')
  check(`${fn} derives the employer from the SESSION, never a parameter`,
    /v_employer\s+uuid\s*:=\s*public\.crew_employer\(\)/.test(body),
    'a tenant taken from the request is a tenant the caller chooses')
  check(`${fn} derives the crew from the SESSION`,
    /v_crew\s+uuid\s*:=\s*public\.crew_crew_id\(\)/.test(body))
  check(`${fn} returns NULL (revoked) when either is missing`,
    /if v_employer is null or v_crew is null then\s*return null;/.test(body),
    'a deactivated worker must get "revoked", not an empty-but-plausible conversation')
  check(`${fn} scopes the visit by BOTH employer and crew`,
    /j\.user_id = v_employer/.test(body) && /j\.crew_id = v_crew/.test(body),
    'without the crew clause, any worker reads any customer\'s conversation by changing a job id')
  check(`${fn} pins its search_path`, /set search_path/i.test(sql.slice(sql.indexOf(`function public.${fn}(`) - 400, sql.indexOf(`function public.${fn}(`) + 400)),
    'a DEFINER function without a pinned search_path is a privilege-escalation primitive')
}

// The message rows themselves are scoped too — a job scoped correctly does not
// help if the message read is scoped only by job_id.
check('crew_job_messages scopes the message rows by tenant as well as visit',
  /x\.job_id = v_job\.id and x\.user_id = v_employer/.test(fnBody('crew_job_messages')),
  'carrying user_id too means a future bug that widened the job lookup still cannot cross a tenant')
check('crew_message_inbox scopes messages AND jobs by the employer',
  /m\.user_id = v_employer/.test(fnBody('crew_message_inbox')) &&
  /j\.user_id = v_employer/.test(fnBody('crew_message_inbox')))

check('the crew write derives user_id from the session, never from a parameter',
  /insert into public\.crew_messages[\s\S]{0,220}values \(v_employer,/.test(fnBody('crew_post_message')),
  'the tenant on a written row must come from crew_employer(), never from the client')

// ⛔ THE FOUNDING RULE. A crew RLS policy is row-level, so granting the row
// grants every column — that is why crew_day exists instead of a policy.
check('the migration grants crew NO table policy',
  !/create policy[^;]*crew_employer\(\)/i.test(sql),
  'a crew RLS policy on crew_messages would re-open the hole crew-mode closed: RLS is ROW-level')

check('the owner policy also proves the VISIT belongs to the same business',
  /with check \(\s*auth\.uid\(\) = user_id\s*and exists \(select 1 from public\.jobs j where j\.id = job_id and j\.user_id = auth\.uid\(\)\)/.test(sql),
  'without it a caller could attach a message to another tenant\'s job and still own the row')

check('anon is revoked from both tables',
  /revoke all on public\.crew_messages\s+from anon/.test(sql) &&
  /revoke all on public\.crew_message_reads\s+from anon/.test(sql),
  'Supabase default privileges grant anon full DML at CREATE TIME — read the ACL back, never assume')

check('the RPCs are revoked from anon and granted only to authenticated',
  READ_DOORS.every(fn => new RegExp(`revoke execute on function public\\.${fn}\\(`).test(sql)) &&
  READ_DOORS.every(fn => new RegExp(`grant  ?execute on function public\\.${fn}\\(`).test(sql)),
  'Supabase grants EXECUTE to anon at CREATE time and `revoke from public` does not remove it')

// ── 3. The author is decided by the database ────────────────────────────────
console.log('\n═══ Identity cannot be forged ═══')

const identity = fnBody('crew_message_identity')
check('the identity trigger exists and fires BEFORE INSERT',
  identity.length > 0 && /before insert on public\.crew_messages/.test(sql))
check('it overwrites the author from auth.uid()',
  /v_uid\s+uuid\s*:=\s*auth\.uid\(\)/.test(identity) &&
  /new\.author_kind\s*:=\s*'owner'/.test(identity) &&
  /new\.author_kind\s*:=\s*'crew'/.test(identity),
  'if the trigger trusted the submitted columns, any writer could post as anybody')
check('a crew author must actually work for the tenant being written to',
  /crew_employer\(\) is distinct from new\.user_id/.test(identity) &&
  /raise exception/.test(identity),
  'the roster switches are the access control, re-asked at write time')
check('an unauthenticated human message is refused',
  /if v_uid is null then\s*raise exception/.test(identity))
check('the identity trigger is not callable by a client',
  /revoke execute on function public\.crew_message_identity\(\) from public, anon, authenticated/.test(sql))

// ── 4. Exactly once ─────────────────────────────────────────────────────────
console.log('\n═══ A double tap is not two messages ═══')

check('a partial unique index pins (visit, writer, token)',
  /create unique index[\s\S]{0,120}crew_messages \(job_id, created_by, client_token\)\s*where client_token is not null/.test(sql),
  'without the partial clause, two token-less rows would collide')
check('the write answers a replay with the row that already landed',
  /on conflict \(job_id, created_by, client_token\) where client_token is not null do nothing/.test(fnBody('crew_post_message')) &&
  /if v_row\.id is null then\s*select \* into v_row/.test(fnBody('crew_post_message')),
  'returning an error on a replay invites the second tap that creates the duplicate')

const LIB = 'src/lib/crewMessages.ts'
const lib = stripTs(read(LIB))
check('the client mints the token OUTSIDE the send function',
  !/function postCrewMessage[\s\S]{0,400}newClientToken\(\)/.test(lib) &&
  !/function postOwnerMessage[\s\S]{0,600}newClientToken\(\)/.test(lib),
  'minting per ATTEMPT instead of per MESSAGE makes the database replay guard a no-op')
for (const f of ['src/components/crew/CrewStopConversation.tsx', 'src/components/crew/CrewInbox.tsx',
  'src/components/schedule/VisitConversation.tsx']) {
  const src = stripTs(read(f))
  check(`${f} reuses one token across retries`,
    /token:\s*newClientToken\(\)/.test(src) && /attempt\(entry\)/.test(src) &&
    !/attempt[\s\S]{0,300}newClientToken\(\)/.test(src),
    'the retry path must reuse entry.token, never mint a fresh one')
}

// ── 5. Nothing looks sent when it is not ────────────────────────────────────
console.log('\n═══ Honest sending ═══')

const VIEW = 'src/components/conversation/ConversationView.tsx'
const view = stripTs(read(VIEW))
check('the view renders an outbox with its own failed state',
  /pending\.map/.test(view) && /'failed'/.test(view) && /onRetry/.test(view),
  'a failed send must be visible IN THE THREAD, not only in a toast that scrolls away')
// ⚠️ ANCHORED TO THE PENDING BUBBLE (`p.state`), not to any `state === 'failed'`
// in the file. Mutation testing caught this: blanking the pending bubble's
// classes still passed, because the loose pattern matched the ATTACHMENT chip's
// own failed styling further down. A guard that can be satisfied by a different
// element than the one it names is not watching anything.
check('a pending message is visually distinct from a sent one',
  /p\.state === 'failed'\s*\?\s*'[^']*border-red[^']*'\s*:\s*'[^']*opacity/.test(view),
  'if in-flight and delivered look identical, the screen is claiming a send it did not get')
check('the view never optimistically marks a message delivered',
  !/setMessages/.test(view),
  'the container appends only what the server returned')

for (const f of ['src/components/crew/CrewStopConversation.tsx', 'src/components/crew/CrewInbox.tsx',
  'src/components/schedule/VisitConversation.tsx']) {
  const src = stripTs(read(f))
  check(`${f} appends only the server's row`,
    /setMessages\(prev => prev\.some\(m => m\.id === /.test(src),
    'appending the typed text instead of the returned row is how an unsent message looks sent — and the id check is what stops a retry painting the same message twice')
  check(`${f} keeps a failed send in the outbox`,
    /state: 'failed'/.test(src) && /error:/.test(src))
}

check('the library reports every failing path rather than throwing away the reason',
  /return \{ kind: 'error'/.test(lib) && /return \{ error:/.test(lib))
check('a failed READ is not rendered as an empty conversation',
  /loadError/.test(view) && /messages\.length === 0 && pending\.length === 0/.test(view),
  '"nobody said anything" and "we could not ask" are different facts')

// ⭐ THE THREE-OUTCOME RULE (lib/crewAccess's, and it applies identically here).
// ⚠️ ASSERTED PER FUNCTION. Mutation testing caught a whole-file version of this:
// folding error→revoked inside loadCrewConversation still passed, because the
// other two doors still contained the string it was grepping for. One door
// silently losing the distinction is exactly the bug — it is the one that tells
// a worker in a dead zone that they were fired.
const libFn = (name: string): string => {
  const i = lib.indexOf(`export async function ${name}`)
  if (i < 0) return ''
  const rest = lib.slice(i)
  const end = rest.indexOf('\nexport ', 1)
  return end < 0 ? rest : rest.slice(0, end)
}
for (const door of ['loadCrewConversation', 'postCrewMessage', 'loadCrewInbox']) {
  const body = libFn(door)
  check(`${door} was located (mechanism control)`, /supabase\.rpc\(/.test(body),
    'if this fails the outcome check below is reading an empty string')
  check(`${door} keeps error and revoked apart`,
    /if \(error\) return \{ kind: 'error'/.test(body) && /if \(!data\) return \{ kind: 'revoked' \}/.test(body),
    'supabase-js RESOLVES {error} on a dead connection — folding it into null tells a worker in a dead zone they were fired')
}

// ── 6. Unread is ONE rule, spelled the same everywhere ──────────────────────
console.log('\n═══ Unread ═══')

const msg = (over: Partial<CrewMessage>): CrewMessage => ({
  id: 'm1', body: 'hi', author_kind: 'crew', author_name: 'Jake',
  author_technician_id: null, event_type: null, mine: false,
  created_at: '2026-08-13T10:00:00Z', ...over,
});

{
  const mark = '2026-08-13T09:00:00Z'
  check('a teammate\'s newer message is unread',
    unreadCount([msg({})], mark) === 1)
  check('my own message is never unread to me',
    unreadCount([msg({ mine: true })], mark) === 0)
  check('a message older than my mark is read',
    unreadCount([msg({ created_at: '2026-08-13T08:00:00Z' })], mark) === 0)
  check('a system line is context, not unread',
    unreadCount([msg({ author_kind: 'system', event_type: 'schedule_changed' })], mark) === 0,
    'counting it would badge the owner for their own reschedule')
  check('never-read means everything from others counts',
    unreadCount([msg({}), msg({ id: 'm2', mine: true })], null) === 1)
  check('isAttentionWorthy is the single predicate behind it',
    isAttentionWorthy(msg({})) && !isAttentionWorthy(msg({ mine: true })) &&
    !isAttentionWorthy(msg({ author_kind: 'system' })))
}

check('the SQL inbox spells the SAME rule',
  /m\.created_by is distinct from v_uid\s*and m\.author_kind <> 'system'/.test(sql),
  'three answers to "what is unread" is three badges that disagree on one screen')
check('the owner roll-up spells the SAME rule',
  /m\.created_by === ownerId \|\| m\.author_kind === 'system'/.test(lib))
check('the read mark is taken from the NEWEST MESSAGE, not now()',
  /values \(v_employer, v_job\.id, v_uid, v_high\)/.test(fnBody('crew_job_messages')) &&
  !/last_read_at, now\(\)\)/.test(fnBody('crew_job_messages')),
  'stamping now() marks a message that arrives during the round trip as already read')
check('read state is one row per (visit, reader), not one per message',
  /primary key \(job_id, reader_id\)/.test(sql),
  'a per-message receipt table costs rows(messages × members) and buys a feature nobody asked for')

{
  const item = (over: Partial<CrewInboxItem>): CrewInboxItem => ({
    job_id: 'j1', title: 'Mulch', customer_name: 'Allison', scheduled_date: '2026-08-13',
    status: 'scheduled', unread: 0, last_at: '2026-08-13T10:00:00Z',
    last_author: 'Jake', last_body: 'Need another bag', ...over,
  })
  check('the nav badge totals every conversation',
    totalUnread([item({ unread: 2 }), item({ job_id: 'j2', unread: 1 }), item({ job_id: 'j3' })]) === 3)
  check('one phrasing for the count, everywhere',
    unreadLabel(3) === '3 new' && unreadLabel(0) === '')
}

// ── 7. The composer's limits agree with the database's ──────────────────────
console.log('\n═══ Limits ═══')
check('the client cap matches the CHECK constraint',
  new RegExp(`char_length\\(body\\) <= ${MAX_MESSAGE_CHARS}`).test(sql),
  'a client cap looser than the constraint is a save that fails at the last moment')
check('the RPC refuses an over-long body before writing',
  new RegExp(`char_length\\(v_body\\) > ${MAX_MESSAGE_CHARS}`).test(fnBody('crew_post_message')))
check('blank bodies are refused at BOTH ends',
  /btrim\(body\) <> ''/.test(sql) && messageProblem('   ') !== null)
check('a legitimate message passes', messageProblem('Use the side gate') === null)
check('an over-long message is refused by the client too',
  messageProblem('x'.repeat(MAX_MESSAGE_CHARS + 1)) !== null)

// ── 8. System events join a conversation, they never start one ─────────────
console.log('\n═══ System events ═══')

const schedEvent = fnBody('crew_message_schedule_event')
check('the schedule event exists', schedEvent.length > 0)
check('⭐ it only fires where a conversation ALREADY exists',
  /if not exists \(select 1 from public\.crew_messages m where m\.job_id = new\.id\) then\s*return new;/.test(schedEvent),
  'THE rule that stops chat becoming a database changelog — and what makes bulk reschedules free')
check('it fires only on a date or time change',
  /new\.scheduled_date is not distinct from old\.scheduled_date\s*and new\.start_time is not distinct from old\.start_time/.test(schedEvent),
  'any other jobs UPDATE — a crew status write, a price edit — must not append a line')
check('it does not call to_char on a `time` value',
  !/to_char\((old|new)\.start_time/.test(schedEvent),
  'to_char(time, text) has no overload in PostgreSQL and would raise on every retimed visit')
check('a system event carries no author',
  /new\.created_by\s*:=\s*null/.test(identity) && /new\.author_kind\s*:=\s*'system'/.test(identity))

// ── 9. Telling the owner, without spamming them ────────────────────────────
console.log('\n═══ Notification ═══')

const notify = fnBody('crew_message_notify')
check('only a CREW message rings the owner',
  /if new\.author_kind <> 'crew' then\s*return new;/.test(notify),
  'the owner\'s own message, and a system line, must not notify the owner')
check('⭐ deduped on UNREAD, not for all time',
  /n\.type = 'crew_message'[\s\S]{0,80}n\.read = false/.test(notify),
  'a for-all-time dedupe would silence the second half of every exchange')
check('the bell deep-links to the visit',
  /'\/dashboard\/schedule\?job=' \|\| new\.job_id/.test(notify),
  'a notification that lands on the bare board is a notification that loses the message')
check('⛔ no SMS or email is sent from the conversation',
  !/comms\/send|twilio|resend|sendgrid|send_sms|send_email/i.test(sql) &&
  !/comms\/send|twilio|resend/i.test(lib),
  'those cost money, reach people off-shift, and route through the CUSTOMER consent + governor architecture')

const notifLib = stripTs(read('src/lib/notifications.ts'))
check('crew_message is a known notification type with a priority',
  /crew_message: 'update'/.test(notifLib),
  'unknown types default to update but carry no verb or noun, so the bell reads as raw machine text')
check('crew_message is NOT in the action-needed tier',
  !/crew_message: 'action'/.test(notifLib),
  'a chatty morning would fill the "needs you" list and push a lost payment out of sight')
check('it is push-preference-mapped, so it can be turned off',
  /crew_message: 'crew_message'/.test(stripTs(read('src/app/api/push/send/route.ts'))) &&
  /key: 'crew_message'/.test(stripTs(read('src/components/settings/PushNotificationSettings.tsx'))),
  'an unmapped type is ON by default with no switch anywhere in Settings')

// ── 10. Media reuses Session 35, and stays on its own side ─────────────────
console.log('\n═══ Attachments ═══')

check('attachments are ONE nullable column on crew_media, not a second table',
  /alter table public\.crew_media\s*add column if not exists message_id uuid references public\.crew_messages\(id\) on delete cascade/.test(sql),
  'a second private bucket would mean keeping the ceiling, the MIME allowlist, the RLS and the signing story in step across two places')
check('there is no second media bucket',
  !/storage\.buckets/.test(sql) && !/'crew-media-2'|'message-media'/.test(sql))

const mediaRoute = stripTs(read('src/app/api/crew/media/route.ts'))
// ⚠️ THE SAME THREE QUESTIONS, ASKED IN ONE PLACE NOW. Session 66 moved
// identity and assignment into lib/workerAccess: three doors had drifted onto
// the pre-S65 model (crew only; no crew ⇒ refused outright), so a worker
// assigned BY NAME could not upload to their own visit. The door must delegate,
// and the layer must still ask all three — which verify:worker-access proves
// against real Postgres and mutation-tests predicate by predicate.
const accessLayer = stripTs(read(join('src', 'lib', 'workerAccess.ts')))
check('the upload door proves the worker from the DATABASE',
  /authorizeWorkerVisit\(/.test(mediaRoute) && /from\('technicians'\)/.test(accessLayer))
check('the upload door resolves the worker by the roster switches',
  /eq\('is_active', true\)/.test(accessLayer) && /is\('archived_at', null\)/.test(accessLayer) &&
  /eq\('auth_user_id', authUserId\)/.test(accessLayer),
  'a worker deactivated mid-shift must fail HERE, unexpired JWT and all')
check('the upload door proves the visit belongs to this worker\'s employer AND assignment',
  /eq\('id', jobId\)/.test(accessLayer) &&
  /eq\('user_id', worker\.employerId\)/.test(accessLayer) &&
  /workerCoversVisit\(worker, visit\)/.test(accessLayer))
check('⭐ the upload door ALSO proves the message is on that visit',
  /from\('crew_messages'\)[\s\S]{0,200}eq\('id', messageId\)\.eq\('job_id', j\.id\)\.eq\('user_id', j\.user_id\)/.test(mediaRoute),
  'without it, a message id from another visit or another business could carry a file')
check('every stored identity comes from the VERIFIED job row, never the form',
  /user_id: j\.user_id/.test(mediaRoute) && /job_id: j\.id/.test(mediaRoute),
  'a crafted owner id in the form data must have nowhere to go')
check('a failed catalogue write rolls the stored object back',
  /if \(rowErr \|\| !row\) \{[\s\S]{0,160}storage[\s\S]{0,60}\.remove\(\[path\]\)/.test(mediaRoute),
  'storage must never drift from the catalogue — a stored object with no row is invisible and still signable')
check('no service key configured means the door stays SHUT',
  /if \(!admin\) return NextResponse\.json[\s\S]{0,120}503/.test(mediaRoute),
  'never fall back to a weaker check')
check('the upload returns no URL — signing stays in one place',
  !/getPublicUrl/.test(mediaRoute) && /createSignedUrls/.test(mediaRoute),
  'getPublicUrl on this bucket would make the link itself the permission')

// ⚠️ THE FILTER THAT KEEPS THE TWO KINDS APART. Without it, a photo somebody
// sent in the conversation renders as a WORK INSTRUCTION for the visit.
check('the day-summary count excludes message attachments',
  /is\('message_id', null\)[\s\S]{0,200}scheduled_date/.test(mediaRoute) ||
  /\.is\('message_id', null\)/.test(mediaRoute.slice(0, mediaRoute.indexOf('wantSummary') + 2000)),
  'the "2 photos · 1 video" label would count chat photos the instructions do not contain')
check('the crew instructions view filters attachments out',
  /filter\(m => !m\.message_id\)/.test(stripTs(read('src/components/crew/CrewStopMedia.tsx'))))
check('the owner reference-media list filters attachments out',
  /\.is\('message_id', null\)/.test(stripTs(read('src/lib/crewMedia.ts'))),
  'otherwise every chat photo appears in the owner\'s "work instructions" box and is sent to the crew as one')

// ── 11. The view is pure, and the crew door is the only crew door ──────────
console.log('\n═══ Doors ═══')

check(`${VIEW} performs NO data access`,
  !/\.from\(/.test(view) && !/\.rpc\(/.test(view) && !/createClient/.test(view) && !/fetch\(/.test(view),
  'a shared presentational component that could reach a door would let the crew screen reach the owner\'s')

const crewChat = stripTs(read('src/components/crew/CrewStopConversation.tsx'))
const crewInbox = stripTs(read('src/components/crew/CrewInbox.tsx'))
for (const [name, src] of [['CrewStopConversation', crewChat], ['CrewInbox', crewInbox]] as const) {
  check(`${name} never touches a table directly`,
    !/\.from\('crew_messages'\)/.test(src) && !/\.from\('crew_message_reads'\)/.test(src) && !/\.from\('jobs'\)/.test(src),
    'a crew session has no grants — a direct read returns an EMPTY conversation, which reads as "nobody said anything"')
  check(`${name} never imports the owner door`,
    !/loadOwnerConversation|postOwnerMessage|loadOwnerUnread/.test(src),
    'the owner path would silently return nothing for a crew session')
}
check('the owner screen uses the owner door',
  /loadOwnerConversation|postOwnerMessage/.test(stripTs(read('src/components/schedule/VisitConversation.tsx'))))

// ⭐ ONE feed, not one per component — the NotificationBell lesson.
check('the crew badge and the stop cards share ONE inbox feed',
  /startCrewInboxFeed/.test(stripTs(read('src/components/crew/CrewNav.tsx'))) &&
  /startCrewInboxFeed/.test(stripTs(read('src/components/crew/CrewToday.tsx'))) &&
  /refs\+\+/.test(lib) && /refs--/.test(lib),
  'two components each running their own effect against one source is the bug NotificationBell already paid for')
check('a failed refresh keeps the last known list',
  /else if \(res\.kind === 'revoked'\) \{ inboxItems = \[\]/.test(lib) && /else inboxState = 'error'/.test(lib),
  'blanking the list on a dead signal tells a worker their messages are gone')

// ── 12. The crew conversation is separate from the CUSTOMER one ────────────
console.log('\n═══ Two audiences, two buttons ═══')

const dayOps = stripTs(read('src/components/schedule/DayOpsPanel.tsx'))
check('the owner card offers BOTH, under different words',
  /label="Message"/.test(dayOps) && /Crew chat/.test(dayOps),
  'one button for two audiences is how a gate code ends up in an SMS')
check('the crew panel and the customer panel are separate state',
  /setChatId\(null\)/.test(dayOps) && /setMessageId\(null\)/.test(dayOps))
check('the crew conversation is labelled as internal on the owner\'s screen',
  /your team only/i.test(dayOps),
  'the owner must never have to guess who reads what they are about to type')
check('the crew composer does not route through the customer comms engine',
  !/comms\/send/.test(crewChat) && !/comms\/send/.test(stripTs(read('src/components/schedule/VisitConversation.tsx'))))

// ── 13. Mobile: a thumb, in a truck ────────────────────────────────────────
console.log('\n═══ 375 / 390 / 430 ═══')

check('Send is a real tap target',
  /tap-target[^"]*h-10[^"]*"[\s\S]{0,200}aria-label="Send message"/.test(view) ||
  /aria-label="Send message"[\s\S]{0,200}tap-target/.test(view),
  'a 28px send button is unusable with a glove')
check('Retry and Discard are tap targets too',
  (view.match(/tap-target/g) || []).length >= 3)
check('⭐ the composer is NOT fixed-position',
  !/fixed[^"]*bottom-0/.test(view),
  'a fixed composer is what puts Send under the iOS keyboard; in flow, focusing the box scrolls both into view')
check('the thread scrolls inside itself rather than the page',
  /overflow-y-auto/.test(view) && /max-h-\[/.test(view))
check('long messages wrap instead of truncating',
  /whitespace-pre-wrap break-words/.test(view) && !/truncate[^"]*"\s*>\{m\.body\}/.test(view),
  'an ellipsis through the middle of a gate code is useless')
check('media is width-bounded',
  /max-w-full/.test(view),
  'an unbounded phone photo pushes the conversation sideways and takes Send off-screen with it')
check('the stop-card disclosure is a tap target',
  /tap-target/.test(crewChat))
check('the crew nav badge is announced to a screen reader',
  /aria-label=\{showBadge \? `\$\{label\}, \$\{unread\} unread`/.test(stripTs(read('src/components/crew/CrewNav.tsx'))))

// ── Summary ────────────────────────────────────────────────────────────────
console.log('\n── Summary ────────────────────────────────────────────────────\n')
if (failures) {
  console.log(`❌ verify:crew-messages — ${failures} failure${failures === 1 ? '' : 's'}`)
  process.exit(1)
}
console.log('✅ verify:crew-messages — the conversation is internal, attributed, and honest about sending.')
