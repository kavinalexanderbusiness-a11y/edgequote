import Link from 'next/link'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Base & Premium plans | EdgeQuote',
  description: 'Preview EdgeQuote Base and Premium monthly plans.',
}

const plans = [
  {
    name: 'Base', price: 29, audience: 'For independent operators',
    features: ['Customer management', 'Quotes and invoices', 'Job scheduling', 'Customer payment collection'],
  },
  {
    name: 'Premium', price: 59, audience: 'For growing teams',
    features: ['Everything planned for Base', 'Crew workflows and assignments', 'Time tracking and payroll tools', 'Business reporting'],
  },
]

export default function PlansPage() {
  return (
    <main className="min-h-screen bg-bg px-4 py-12 text-ink">
      <div className="mx-auto max-w-3xl">
        <nav aria-label="Account navigation" className="flex items-center justify-between gap-4 text-sm">
          <Link href="/login" className="font-bold text-ink hover:underline">EdgeQuote</Link>
          <Link href="/login" className="text-accent-text hover:underline">Sign in</Link>
        </nav>
        <header className="my-10 text-center">
          <p className="text-sm font-semibold text-accent-text">Planned monthly subscriptions</p>
          <h1 className="mt-3 text-3xl font-bold">A plan for your business</h1>
          <p className="mt-3 text-ink-muted">Start with an account. Compare Base and Premium as your business grows.</p>
        </header>
        <div className="rounded-xl border border-border bg-bg-secondary p-4 text-sm text-ink-muted">
          <p className="font-semibold text-ink">Subscription checkout is not available yet.</p>
          <p className="mt-1">These are planned prices and feature bundles. Creating an account does not start a paid subscription or charge your card. Final terms will be shown before you confirm a purchase.</p>
        </div>
        <div className="mt-6 grid gap-5 sm:grid-cols-2">
          {plans.map(plan => (
            <section key={plan.name} aria-labelledby={`plan-${plan.name}`} className="rounded-2xl border border-border bg-bg-secondary p-6">
              <h2 id={`plan-${plan.name}`} className="text-xl font-bold">{plan.name}</h2>
              <p className="mt-1 text-sm text-ink-muted">{plan.audience}</p>
              <p className="my-6"><span className="text-3xl font-bold">CA${plan.price}</span><span className="text-sm text-ink-muted"> / month</span></p>
              <p className="text-xs text-ink-faint">Planned price in Canadian dollars, before applicable tax.</p>
              <ul className="mt-5 space-y-3 text-sm text-ink-muted">
                {plan.features.map(feature => <li key={feature}>{feature}</li>)}
              </ul>
            </section>
          ))}
        </div>
        <div className="mt-8 text-center">
          <Link href="/signup" className="inline-flex min-h-12 items-center justify-center rounded-xl bg-accent px-6 py-3 font-semibold text-black hover:opacity-90">Create account</Link>
          <p className="mt-3 text-sm text-ink-muted">Already registered? <Link href="/setup" className="text-accent-text hover:underline">Continue to your workspace</Link></p>
          <p className="mt-4 text-xs text-ink-faint">Account availability is checked during signup. These plans cover your EdgeQuote subscription; customer invoice payments are separate.</p>
        </div>
      </div>
    </main>
  )
}
