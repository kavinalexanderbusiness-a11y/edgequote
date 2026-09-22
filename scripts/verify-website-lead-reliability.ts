// Static contract checks for the three website-lead reliability seams. These are
// deliberately deterministic: no customer is created, no email/push is sent, and no
// live database is touched.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const root = process.cwd()
const read = (p: string) => readFileSync(join(root, p), 'utf8')
const intake = read('src/lib/intake.ts')
const websiteHealth = read('src/components/settings/WebsiteIntegration.tsx')
const pushStatus = read('src/app/api/push/status/route.ts')
const pushSettings = read('src/components/settings/PushNotificationSettings.tsx')
const migration = read('supabase/migrations/20260921235500_portal_request_mute_exception.sql')

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) { passed++; console.log(`  ✅ ${name}`) }
  else { failed++; console.log(`  ❌ ${name}${detail ? `\n     ${detail}` : ''}`) }
}

async function main() {
console.log('\n═══ Owner website-lead email is visible and delivery-trackable ═══')
check('the sender writes through the canonical notification_log helper',
  /import \{ logSend \} from '@\/lib\/comms\/log'/.test(intake)
  && /await logSend\(admin, \{/.test(intake))
check('provider rejection is recorded as error rather than discarded',
  /status = result\.sent \? 'sent' : 'error'/.test(intake)
  && /detail \+= ` · \$\{result\.error \|\| result\.reason\}`/.test(intake))
check('provider ids are kept so Resend webhooks can advance delivery status',
  /provider: status === 'sent' \? 'resend' : null/.test(intake)
  && /providerId,/.test(intake))
check('missing provider and missing recipient are recorded distinctly',
  /status = 'disabled'/.test(intake) && /status = 'skipped'/.test(intake))
check('email observability can never fail an already-durable lead',
  /logSafeServerError\('intake\.owner_email_unexpected'/.test(intake))
check('Website Health reads and displays the canonical alert log',
  /notification_log/.test(websiteHealth)
  && /WEBSITE_LEAD_OWNER_ALERT_TEMPLATE/.test(websiteHealth)
  && /Last owner alert email/.test(websiteHealth))

console.log('\n═══ Structured portal requests bypass mute; ordinary messages do not ═══')
check('the migration recognizes a structured portal request from message metadata',
  /v_portal_request := new\.channel = 'portal'[\s\S]*new\.meta \? 'service_request_id'/.test(migration))
check('mute still returns early for anything other than a portal request',
  /coalesce\(v_muted, false\) and not v_portal_request then return new/.test(migration))
check('the bypassed notification is typed portal_request',
  /case when v_portal_request then 'portal_request' else 'new_message' end/.test(migration))

// Execute the migration against a disposable PostgreSQL engine and exercise both
// sides of the rule. This proves the SQL itself, rather than only its spelling.
const db = await PGlite.create()
await db.exec(`
  create role anon;
  create role authenticated;
  create role service_role;
  create table public.conversations (id uuid primary key, muted boolean not null default false);
  create table public.customers (id uuid primary key, name text);
  create table public.notifications (
    id uuid primary key default gen_random_uuid(), user_id uuid not null, type text not null,
    title text not null, body text, customer_id uuid, entity_type text, entity_id uuid, href text
  );
  create table public.messages (
    id uuid primary key, user_id uuid not null, conversation_id uuid not null, customer_id uuid,
    direction text not null, channel text not null, body text not null, meta jsonb
  );
`)
await db.exec(migration)
await db.exec(`create trigger trg_notify_inbound_message after insert on public.messages
  for each row execute function public.notify_inbound_message()`)
const userId = '00000000-0000-0000-0000-000000000001'
const customerId = '00000000-0000-0000-0000-000000000002'
const conversationId = '00000000-0000-0000-0000-000000000003'
await db.exec(`
  insert into public.customers (id, name) values ('${customerId}', 'Muted Customer');
  insert into public.conversations (id, muted) values ('${conversationId}', true);
  insert into public.messages (id, user_id, conversation_id, customer_id, direction, channel, body, meta)
  values
    ('00000000-0000-0000-0000-000000000004', '${userId}', '${conversationId}', '${customerId}', 'inbound', 'sms', 'ordinary reply', '{}'::jsonb),
    ('00000000-0000-0000-0000-000000000005', '${userId}', '${conversationId}', '${customerId}', 'inbound', 'portal', 'new website lead', '{"service_request_id":"00000000-0000-0000-0000-000000000006"}'::jsonb);
`)
const notificationRows = (await db.query<{ type: string; body: string }>(
  'select type, body from public.notifications order by body',
)).rows
check('runtime: an ordinary inbound message stays suppressed in a muted conversation',
  !notificationRows.some(r => r.body === 'ordinary reply'))
check('runtime: the structured portal request still creates one bell row',
  notificationRows.length === 1
  && notificationRows[0]?.type === 'portal_request'
  && notificationRows[0]?.body === 'new website lead')
await db.close()

console.log('\n═══ Push readiness is non-secret, authenticated, and device-aware ═══')
check('push diagnostics require an authenticated owner',
  /getUser\(\)/.test(pushStatus) && /unauthorized/.test(pushStatus))
check('push diagnostics report booleans/counts without returning config values',
  /publicVapid,/.test(pushStatus) && /dispatchSecretMatches,/.test(pushStatus)
  && /subscriptionCount:/.test(pushStatus)
  && !/endpoint_url\s*:/.test(pushStatus)
  && !/secret\s*: config/.test(pushStatus))
check('Settings distinguishes the local browser subscription from saved devices',
  /This browser subscription/.test(pushSettings)
  && /Saved devices/.test(pushSettings)
  && /\/api\/push\/status/.test(pushSettings))

console.log(`\n${'═'.repeat(60)}\n  PASS ${passed}   FAIL ${failed}`)
if (failed) process.exit(1)
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
