import Link from 'next/link'
import type { Metadata } from 'next'
import { PRODUCT_PLANS } from '@/lib/productPlans'

export const metadata: Metadata = {
  title: 'Base, Plus & Premium plans | EdgeHQ',
  description: 'Preview EdgeHQ Base, Plus and Premium monthly plans. Start with free early access, with no card required or automatic conversion.',
}

const priceFormat = new Intl.NumberFormat('en-CA', {
  style: 'currency', currency: 'CAD', currencyDisplay: 'code', maximumFractionDigits: 0,
})
const linkFocus = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg'

export default function PlansPage() {
  return (
    <main className="min-h-screen bg-bg px-4 py-12 text-ink">
      <div className="mx-auto max-w-6xl">
        <nav aria-label="Account navigation" className="flex items-center justify-between gap-4 text-sm">
          <Link href="/login" className={`rounded font-bold text-ink hover:underline ${linkFocus}`}>EdgeHQ</Link>
          <Link href="/login" className={`rounded text-accent-text hover:underline ${linkFocus}`}>Sign in</Link>
        </nav>
        <header className="mx-auto my-10 max-w-2xl text-center">
          <p className="text-sm font-semibold text-accent-text">Plan preview</p>
          <h1 className="mt-3 text-3xl font-bold">Room for your business to grow</h1>
          <p className="mt-3 text-ink-muted">Start with free early access. Explore the monthly plans for when you choose to subscribe.</p>
        </header>
        <aside aria-labelledby="early-access-heading" className="rounded-xl border border-border bg-bg-secondary p-5 text-sm text-ink-muted">
          <h2 id="early-access-heading" className="font-semibold text-ink">Free early access. No card required.</h2>
          <p className="mt-2">Paid subscriptions are not available yet. Signing up does not start a paid plan, and early access will not convert automatically. You will see the terms and choose whether to subscribe when billing becomes available.</p>
          <p className="mt-2">Already using EdgeHQ? Your current access stays the same until you explicitly choose a paid plan.</p>
        </aside>
        <div className="mt-6 grid gap-5 md:grid-cols-3">
          {PRODUCT_PLANS.map((plan, index) => {
            const previous = PRODUCT_PLANS[index - 1]
            const previousFeatures = new Set(previous?.features.map(feature => feature.id))
            const additions = plan.features.filter(feature => !previousFeatures.has(feature.id))
            return (
              <section key={plan.id} aria-labelledby={`plan-${plan.id}`} className="flex h-full flex-col rounded-2xl border border-border bg-bg-secondary p-6">
                <h2 id={`plan-${plan.id}`} className="text-xl font-bold">{plan.name}</h2>
                <p className="mt-2 text-sm text-ink-muted">{plan.summary}</p>
                <p className="mb-2 mt-6"><span className="text-3xl font-bold">{priceFormat.format(plan.monthlyPriceCents / 100)}</span><span className="text-sm text-ink-muted"> / month</span></p>
                <p className="text-xs text-ink-faint">Preview price, before applicable tax.</p>
                {previous ? <p className="mt-5 text-sm font-medium text-ink">Everything in {previous.name}, plus:</p> : null}
                <ul className="mt-5 space-y-3 text-sm text-ink-muted">
                  {additions.map(feature => <li key={feature.id} className="flex gap-2"><span aria-hidden="true" className="text-accent-text">✓</span><span>{feature.label}</span></li>)}
                </ul>
              </section>
            )
          })}
        </div>
        <div className="mt-6 grid gap-5 text-sm text-ink-muted md:grid-cols-2">
          <section aria-labelledby="records-heading" className="rounded-xl border border-border p-5">
            <h2 id="records-heading" className="font-semibold text-ink">Your records stay yours</h2>
            <p className="mt-2">Billing will not block access to existing business records, payment recording, exports or saved-draft recovery.</p>
          </section>
          <section aria-labelledby="included-heading" className="rounded-xl border border-border p-5">
            <h2 id="included-heading" className="font-semibold text-ink">Clear about what is included</h2>
            <p className="mt-2">Operational suggestions help you decide what to do; they do not act or message customers on their own.</p>
            <p className="mt-2">These previews do not include paid scanning, SMS or email credits, AI credits, online payment processing or unlimited seats and usage.</p>
          </section>
        </div>
        <div className="mt-8 text-center">
          <Link href="/signup" className={`inline-flex min-h-12 items-center justify-center rounded-xl bg-accent px-6 py-3 font-semibold text-black hover:opacity-90 ${linkFocus}`}>Start free early access</Link>
          <p className="mt-3 text-sm text-ink-muted">Already registered? <Link href="/setup" className={`rounded text-accent-text hover:underline ${linkFocus}`}>Continue to your workspace</Link></p>
          <p className="mt-4 text-xs text-ink-faint">Account availability is checked during signup. Platform subscriptions are separate from payments your customers make to your business.</p>
        </div>
      </div>
    </main>
  )
}
