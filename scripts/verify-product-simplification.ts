import { readFileSync } from 'node:fs'

let pass = 0
let fail = 0
function check(name: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass++
    console.log(`  ✅ ${name}`)
  } else {
    fail++
    console.log(`  ❌ ${name}\n     expected: ${JSON.stringify(expected)}\n     actual:   ${JSON.stringify(actual)}`)
  }
}

const quotePage = readFileSync('src/app/dashboard/quotes/page.tsx', 'utf8')
const quoteList = readFileSync('src/components/quotes/QuoteList.tsx', 'utf8')
const payments = readFileSync('src/app/dashboard/payments/page.tsx', 'utf8')

console.log('\n═══ Product simplification contracts ═══')
check('quote summary separates actionable and blocked follow-ups',
  quotePage.includes('followupsReady') && quotePage.includes('followupsBlocked') && quotePage.includes('chaseBlockedReason(customer)'), true)
check('actionable follow-up summary opens the exact queue',
  quotePage.includes("router.push('/dashboard/quotes?followup=1')"), true)
check('blocked follow-up summary opens data quality',
  quotePage.includes("router.push('/dashboard/data-quality')"), true)
check('quote list status is read-only',
  quoteList.includes('<StatusBadge status={q.status}') && !quoteList.includes('<QuoteStatusControl'), true)
check('payment evidence is disclosed on demand',
  payments.includes('<details') && payments.includes('Payment evidence') && payments.includes('{r.notes}'), true)
check('payment evidence remains searchable',
  payments.includes('r.customers?.name, r.invoices?.invoice_number, r.notes'), true)

console.log(`\n${'═'.repeat(60)}\n  PASS ${pass}   FAIL ${fail}`)
if (fail > 0) process.exit(1)
