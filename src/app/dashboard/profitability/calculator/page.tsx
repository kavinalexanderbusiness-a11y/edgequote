'use client'

import { useState, type FormEvent } from 'react'
import { PageContainer } from '@/components/layout/PageContainer'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card, CardBody } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { calculateJobEarnings, allocateMonthlyRound, type EarningsInput } from '@/lib/jobEarnings'

const fields: { key: keyof EarningsInput; label: string; hint?: string }[] = [
  { key: 'customerTotal', label: 'Customer total for this round ($)', hint: 'Use revenue for the same round as the time below, not the whole monthly plan.' },
  { key: 'salesTax', label: 'Sales tax included ($)', hint: 'Enter the actual amount, if any.' },
  { key: 'ownerMinutes', label: 'Your total minutes', hint: 'Include loading, driving, clearing and unloading.' },
  { key: 'helperMinutes', label: 'Combined helper minutes', hint: 'Add everyone else’s time. Two helpers for 60 minutes each = 120.' },
  { key: 'helperPay', label: 'Total helper pay ($)' },
  { key: 'fuel', label: 'Fuel and consumables ($)' },
  { key: 'paymentFees', label: 'Payment fees ($)' },
  { key: 'otherCosts', label: 'Other allocated costs ($)', hint: 'Include equipment wear, maintenance and other costs where known.' },
]
const initial = { customerTotal: '0', salesTax: '0', ownerMinutes: '120', helperMinutes: '0', helperPay: '0', fuel: '0', paymentFees: '0', otherCosts: '0' }
const money = (n: number) => new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(n)

export default function JobEarningsPage() {
  const [values, setValues] = useState(initial)
  const [result, setResult] = useState<ReturnType<typeof calculateJobEarnings> | null>(null)
  const [error, setError] = useState('')
  const [monthly, setMonthly] = useState('0')
  const [rounds, setRounds] = useState('8')
  let allocation: number | null = null
  try { if (monthly !== '' && rounds !== '') allocation = allocateMonthlyRound(Number(monthly), Number(rounds)) } catch { /* inline help below */ }
  function calculate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    try {
      if (Object.values(values).some(value => value.trim() === '')) throw new Error('Fill in every field. Use 0 where a cost does not apply.')
      setResult(calculateJobEarnings(Object.fromEntries(Object.entries(values).map(([key, value]) => [key, Number(value)])) as unknown as EarningsInput))
      setError('')
    } catch (e) { setResult(null); setError(e instanceof Error ? e.message : 'Check the amounts and minutes.') }
  }
  return <PageContainer width="wide">
    <PageHeader crumb={{ label: 'Route Profitability', href: '/dashboard/profitability' }} title="Job earnings calculator" description="Compare revenue, crew time and costs before taking on more work." />
    <p className="text-sm text-ink-muted mb-6">A planning worksheet. Your entries do not change quotes, invoices or bookings and are not saved when you leave.</p>
    <form onSubmit={calculate} className="space-y-5">
      <Card><CardBody><h2 className="text-base font-semibold text-ink mb-5">One job or route round</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">{fields.map(field => <Input key={field.key} id={field.key} label={field.label} hint={field.hint} type="number" min={field.key === 'ownerMinutes' ? '1' : '0'} step={field.key.endsWith('Minutes') ? '1' : '0.01'} required value={values[field.key]} onChange={e => { setValues(current => ({ ...current, [field.key]: e.target.value })); setResult(null); setError('') }} />)}</div>
      </CardBody></Card>
      <Button type="submit">Calculate this round</Button>
      {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
    </form>
    <div aria-live="polite" aria-atomic="true" className="mt-6">{result && <Card><CardBody>
      <h2 className="text-base font-semibold text-ink mb-4">Your results</h2>
      <dl className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">{[
        ['Revenue per man-hour', money(result.revenuePerManHour)],
        ['Revenue excluding sales tax', money(result.revenue)],
        ['Total labour hours', result.labourHours.toFixed(2)],
        ['Left after entered costs', money(result.remaining)],
        ['Left per hour of your time', money(result.remainingPerOwnerHour)],
        ['Entered costs', money(result.costs)],
      ].map(([label, value]) => <div key={label}><dt className="text-xs text-ink-muted">{label}</dt><dd className="text-2xl font-semibold text-ink tabular-nums mt-1">{value}</dd></div>)}</dl>
      <p className="text-xs text-ink-muted mt-5">What is left still includes pay for your own labour, before income tax and any costs you have not entered. It is not net profit.</p>
    </CardBody></Card>}</div>
    <Card className="mt-6"><CardBody><h2 className="text-base font-semibold text-ink mb-2">Monthly-plan check</h2>
      <p className="text-sm text-ink-muted mb-5">Spread the monthly total across expected rounds, then use that round amount above. More snow rounds mean less revenue per round. This is a scenario, not a forecast or a cap on visits.</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-5"><Input id="monthlyTotal" label="Monthly customer total ($)" type="number" min="0" step="0.01" value={monthly} onChange={e => setMonthly(e.target.value)} /><Input id="monthlyRounds" label="Expected rounds" type="number" min="1" step="1" value={rounds} onChange={e => setRounds(e.target.value)} /></div>
      <p className="text-sm text-ink mt-4" aria-live="polite">{allocation !== null ? `${money(allocation)} customer receipts per round, before any sales-tax deduction.` : 'Enter a valid monthly total and at least one whole round.'}</p>
    </CardBody></Card>
  </PageContainer>
}
