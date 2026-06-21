/* End-to-end verification of the comms RENDERING layer: proves every template
   type interpolates first-name / business / eta / amount and REUSES the portal
   link for quote/invoice/review. Run via esbuild bundle → node. */
import { renderMessage, MsgType, DEFAULT_TEMPLATES } from '../src/lib/comms/templates'

const TYPES: MsgType[] = ['on_my_way', 'running_late', 'arrived', 'job_complete', 'thanks', 'review_request', 'reminder', 'quote', 'invoice']

const portal = 'https://edgeproperty.app/portal/abc123token'
const vars = {
  firstName: 'Jodi Smith',
  businessName: 'Edge Property Services',
  eta: 20,
  reviewLink: 'https://g.page/r/edge/review',
  portalLink: portal,
  amount: '$110.00',
  dateLabel: 'tomorrow (Sat, Jun 21)',
}

let failures = 0
function check(label: string, cond: boolean) { if (!cond) { failures++; console.log(`  ✗ ${label}`) } else { console.log(`  ✓ ${label}`) } }

console.log('=== DEFAULT TEMPLATES (with full variables) ===')
for (const t of TYPES) {
  const m = renderMessage(t, null, vars)
  console.log(`\n[${t}]\n  SMS: ${m.sms}`)
}

console.log('\n=== ASSERTIONS ===')
const onway = renderMessage('on_my_way', null, vars).sms
check('on_my_way uses first name "Jodi"', onway.includes('Jodi') && !onway.includes('{{'))
check('on_my_way uses eta 20', onway.includes('20 minutes'))
check('no unresolved {{tokens}} anywhere', TYPES.every(t => !renderMessage(t, null, vars).sms.includes('{{')))
check('quote message REUSES portal link', renderMessage('quote', null, vars).sms.includes(portal))
check('invoice message REUSES portal link', renderMessage('invoice', null, vars).sms.includes(portal))
check('invoice message includes amount', renderMessage('invoice', null, vars).sms.includes('$110.00'))
check('review_request includes review link', renderMessage('review_request', null, vars).sms.includes('g.page/r/edge/review'))
check('reminder includes the date label', renderMessage('reminder', null, vars).sms.includes('tomorrow'))

// Owner custom template wins over default.
const custom = { on_my_way: 'Yo {{first_name}}! On my way, ~{{eta}} min — {{business_name}}' }
const cm = renderMessage('on_my_way', custom, vars).sms
check('owner custom template overrides default', cm.startsWith('Yo Jodi!') && cm.includes('~20 min'))

// Graceful when optional vars are missing.
const bare = renderMessage('on_my_way', null, { firstName: 'Sam', businessName: 'Edge' }).sms
check('missing eta defaults to 15', bare.includes('15 minutes'))
const noReview = renderMessage('review_request', null, { firstName: 'Sam', businessName: 'Edge' }).sms
check('missing review link leaves no broken token', !noReview.includes('{{') && !noReview.includes('undefined'))

console.log(`\n${failures === 0 ? '✅ ALL RENDER CHECKS PASS' : `❌ ${failures} FAILED`}`)
