import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildOwnerReminder, dueOwnerReminderSlots, ownerReminderId,
  type OwnerReminderInput, type OwnerReminderSettings,
} from '../src/lib/ownerReminders'

let pass = 0, fail = 0
function check(name: string, condition: boolean, detail = '') {
  if (condition) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}${detail ? `\n     ${detail}` : ''}`) }
}
function eq(name: string, actual: unknown, expected: unknown) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

const settings: OwnerReminderSettings = {
  userId: '00000000-0000-4000-8000-000000000001',
  timeZone: 'America/Edmonton', workStartTime: '08:00', dailyCapacityHours: 8, prefs: {},
}

console.log('\n═══ Tenant-local delivery windows ═══')
eq('07:00 Calgary is the morning window', dueOwnerReminderSlots(settings, new Date('2026-09-12T13:05:00Z')), ['workday_prep'])
eq('a missed morning run catches up inside the safe window', dueOwnerReminderSlots(settings, new Date('2026-09-12T15:05:00Z')), ['workday_prep'])
eq('morning catch-up stops before noon', dueOwnerReminderSlots(settings, new Date('2026-09-12T18:05:00Z')), [])
eq('17:00 Calgary is the close window', dueOwnerReminderSlots(settings, new Date('2026-09-12T23:05:00Z')), ['day_close'])
eq('a UTC day rollover stays in Calgary close-of-day catch-up', dueOwnerReminderSlots(settings, new Date('2026-09-13T01:00:00Z')), ['day_close'])
eq('daily master opt-out stops both slots', dueOwnerReminderSlots({ ...settings, prefs: { daily_reminder: false } }, new Date('2026-09-12T13:05:00Z')), [])
eq('winter offset is resolved by IANA data', dueOwnerReminderSlots(settings, new Date('2026-12-12T14:05:00Z')), ['workday_prep'])
eq('spring DST transition still resolves the workday window', dueOwnerReminderSlots(settings, new Date('2027-03-14T13:05:00Z')), ['workday_prep'])

console.log('\n═══ Atomic identity ═══')
const id = ownerReminderId(settings.userId, '2026-09-12', 'workday_prep')
eq('same owner/date/slot produces the same UUID', ownerReminderId(settings.userId, '2026-09-12', 'workday_prep'), id)
check('ID is valid UUID shape', /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id))
check('next day gets a different ID', ownerReminderId(settings.userId, '2026-09-13', 'workday_prep') !== id)
check('close digest gets a different ID', ownerReminderId(settings.userId, '2026-09-12', 'day_close') !== id)

const base: OwnerReminderInput = {
  settings, now: new Date('2026-09-12T13:05:00Z'),
  todayJobs: [
    { id: 'j1', scheduledDate: '2026-09-12', status: 'scheduled', startTime: '08:00', durationMinutes: 90, crewId: 'c1', hasPrepNotes: true },
    { id: 'j2', scheduledDate: '2026-09-12', status: 'scheduled', startTime: null, crewId: 'c2' },
    { id: 'j3', scheduledDate: '2026-09-12', status: 'cancelled', startTime: '06:00', crewId: 'c1' },
  ],
  tomorrowJobs: [],
  invoices: [
    { id: 'i1', status: 'partial', amount: 250, amountPaid: 125, dueDate: '2026-09-10' },
    { id: 'i2', status: 'paid', amount: 999, amountPaid: 0, dueDate: '2026-09-01' },
  ],
  equipment: [
    { name: 'Truck 1', crewId: 'c1', status: 'active' },
    { name: 'Retired mower', crewId: 'c1', status: 'retired' },
    { name: 'Unassigned trailer', crewId: null, status: 'active' },
  ],
}

console.log('\n═══ Morning digest truth ═══')
const morning = buildOwnerReminder(base, 'workday_prep')!
check('cancelled work is excluded', morning.title.includes('2 jobs'))
check('recorded arrival start/duration becomes a window', morning.body.includes('8 AM–9:30 AM'))
check('missing arrival time is disclosed', morning.body.includes('1 time not set'))
check('only active crew-assigned equipment is named', morning.body.includes('Truck 1') && !morning.body.includes('Retired mower') && !morning.body.includes('Unassigned trailer'))
check('private note text is not put on the lock screen', morning.body.includes('Visit notes are recorded') && !morning.body.includes('gate'))
check('morning digest does not repeat the close-of-day money reminder', !morning.body.includes('invoice') && !morning.body.includes('$125'))

console.log('\n═══ Close digest and preferences ═══')
const close = buildOwnerReminder({
  ...base, now: new Date('2026-09-12T23:05:00Z'),
  todayJobs: [
    { id: 'done-no-invoice', scheduledDate: '2026-09-12', status: 'completed' },
    { id: 'done-free', scheduledDate: '2026-09-12', status: 'completed', noCharge: true },
    { id: 'open', scheduledDate: '2026-09-12', status: 'scheduled' },
  ],
  tomorrowJobs: [{ id: 'tomorrow', scheduledDate: '2026-09-13', status: 'scheduled', startTime: '10:00' }],
  invoices: [...base.invoices, { id: 'draft', jobId: 'done-free', status: 'draft', amount: 40, amountPaid: 0 }],
}, 'day_close')!
check('close digest includes unfinished work', close.body.includes('1 job still open'))
check('only chargeable completed uninvoiced work is counted', close.body.includes('1 completed job needs an invoice'))
check('draft invoice is a review/send action', close.body.includes('1 draft invoice'))
check('tomorrow plan is included without inventing an end time', close.body.includes('Tomorrow: 1 job; 10 AM'))
check('phone body remains bounded', close.body.length <= 420)

const gstClose = buildOwnerReminder({
  ...base,
  settings: { ...settings, gstPercent: 5 },
  now: new Date('2026-09-12T23:05:00Z'),
  todayJobs: [], tomorrowJobs: [], equipment: [],
  invoices: [{ id: 'gst-partial', status: 'partial', amount: 100, amountPaid: 25, dueDate: '2026-09-10' }],
}, 'day_close')!
check('collection uses canonical GST-inclusive partial balance', gstClose.body.includes('$80.00') && !gstClose.body.includes('$75.00'))

const noMoney = buildOwnerReminder({ ...base, settings: { ...settings, prefs: { invoice_followup: false, overdue_balance: false } } }, 'day_close')!
check('money sections obey their own opt-outs', !noMoney.body.includes('invoice') && !noMoney.body.includes('$125'))
eq('money opt-outs keep the close reminder on the schedule', noMoney.title, 'Close the day')
eq('money opt-outs keep the close action on the schedule', noMoney.href, '/dashboard/schedule?date=2026-09-13')
eq('empty non-actionable close produces no alert', buildOwnerReminder({ ...base, todayJobs: [], tomorrowJobs: [], invoices: [], equipment: [] }, 'day_close'), null)

console.log('\n═══ Route wiring and privacy ═══')
const route = readFileSync(join(process.cwd(), 'src/app/api/cron/owner-reminders/route.ts'), 'utf8')
check('route uses the shared cron guard', route.includes('if (!cronSecretOk(req))'))
check('route targets explicit push subscribers', route.includes("from('push_subscriptions')"))
check('route includes every canonical open invoice status', route.includes("['draft', 'unpaid', 'sent', 'partial']"))
check('route loads GST and discount inputs for canonical balances', route.includes('gst_percent') && route.includes('discount_type, discount_value'))
check('route does not query derived overdue as a stored status', !route.includes("'overdue']).order"))
check('all business reads are tenant-scoped', (route.match(/\.eq\('user_id', settings\.userId\)/g) || []).length >= 4)
check('notification insert uses deterministic planned ID', /id:\s*planned\.id/.test(route))
check('23505 is treated as an ordinary duplicate', route.includes("error.code === '23505'"))
check('customer communication pipeline is never called', !/dispatchToCustomer|sendSms|sendEmail/.test(route))
check('raw job notes are not copied to notification body', !/body:\s*j\.notes/.test(route))
const scheduler = readFileSync(join(process.cwd(), 'supabase/migrations/20260912083642_owner_reminder_scheduler.sql'), 'utf8')
check('Supabase Cron invokes the producer hourly', scheduler.includes("'5 * * * *'") && scheduler.includes('/api/cron/owner-reminders'))
check('scheduler reads URL and auth from Vault', scheduler.includes('vault.decrypted_secrets') && scheduler.includes('edgehq_cron_secret'))
check('scheduler embeds no URL or secret value', !/https:\/\//.test(scheduler) && !/Bearer [A-Za-z0-9_-]{12}/.test(scheduler))

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
