'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Card, CardHeader, CardBody } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Button } from '@/components/ui/Button'
import { Skeleton } from '@/components/ui/Skeleton'
import { Banner } from '@/components/ui/Banner'
import { PAY_PERIOD_LABELS, type PayPeriodKind } from '@/types'
import { toast } from '@/lib/toast'
import { Wallet, Check, Info } from 'lucide-react'

// ── Payroll settings ─────────────────────────────────────────────────────────
// Overtime rules + pay period. Self-contained (loads and saves its own slice of
// business_settings), matching AutomationToggles / MessageTemplateEditor rather
// than growing the 600-line settings form.
//
// WHY THERE IS NO DEFAULT OVERTIME THRESHOLD
// Overtime law is jurisdictional. Shipping "8 and 44" as a default would silently
// inflate payroll for an Ontario owner (no daily rule) and understate it in BC
// (40/week). Blank = that rule doesn't apply. The presets below let an owner pick
// their province in one tap — an informed choice, not a hidden assumption.

const PRESETS: { key: string; label: string; daily: string; weekly: string; note: string }[] = [
  { key: 'ab', label: 'Alberta', daily: '8', weekly: '44', note: 'Over 8 h/day or 44 h/week' },
  { key: 'bc', label: 'B.C.', daily: '8', weekly: '40', note: 'Over 8 h/day or 40 h/week' },
  { key: 'on', label: 'Ontario', daily: '', weekly: '44', note: 'Over 44 h/week — no daily rule' },
  { key: 'off', label: 'No overtime', daily: '', weekly: '', note: 'Every hour paid as regular time' },
]

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

// '' -> null so a blank box means "this rule doesn't apply" rather than 0.
const numOrNull = (v: string): number | null => {
  const t = v.trim()
  if (!t) return null
  const n = Number(t)
  return Number.isFinite(n) && n > 0 ? n : null
}

export function PayrollSettings() {
  const supabase = useMemo(() => createClient(), [])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const [payPeriod, setPayPeriod] = useState<PayPeriodKind>('biweekly')
  const [anchor, setAnchor] = useState('')
  const [weekStart, setWeekStart] = useState('1')
  const [daily, setDaily] = useState('')
  const [weekly, setWeekly] = useState('')
  const [multiplier, setMultiplier] = useState('1.5')

  async function load() {
    const { data: { session } } = await supabase.auth.getSession()
    const user = session?.user
    if (!user) { setLoading(false); return }
    const { data } = await supabase
      .from('business_settings')
      .select('ot_daily_hours, ot_weekly_hours, ot_multiplier, pay_period, pay_period_anchor, pay_week_starts_on')
      .eq('user_id', user.id).maybeSingle()
    const s = data as {
      ot_daily_hours: number | null; ot_weekly_hours: number | null; ot_multiplier: number | null
      pay_period: string | null; pay_period_anchor: string | null; pay_week_starts_on: number | null
    } | null
    if (s) {
      setPayPeriod((s.pay_period as PayPeriodKind) ?? 'biweekly')
      setAnchor(s.pay_period_anchor ?? '')
      setWeekStart(String(s.pay_week_starts_on ?? 1))
      setDaily(s.ot_daily_hours != null ? String(Number(s.ot_daily_hours)) : '')
      setWeekly(s.ot_weekly_hours != null ? String(Number(s.ot_weekly_hours)) : '')
      setMultiplier(String(Number(s.ot_multiplier ?? 1.5)))
    }
    setLoading(false)
  }
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const mult = Number(multiplier) || 1.5
  const badMultiplier = mult < 1

  async function save() {
    if (badMultiplier) return
    setSaving(true)
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { setSaving(false); return }
    const { error } = await supabase.from('business_settings').update({
      pay_period: payPeriod,
      pay_period_anchor: anchor || null,
      pay_week_starts_on: Number(weekStart),
      ot_daily_hours: numOrNull(daily),
      ot_weekly_hours: numOrNull(weekly),
      ot_multiplier: mult,
    }).eq('user_id', user.id)
    setSaving(false)
    if (error) { toast.error('Could not save payroll settings: ' + error.message); return }
    setSaved(true); setTimeout(() => setSaved(false), 2000)
    toast.success('Payroll settings saved.')
  }

  function applyPreset(p: typeof PRESETS[number]) {
    setDaily(p.daily); setWeekly(p.weekly)
    if (p.key !== 'off') setMultiplier('1.5')
  }

  const d = numOrNull(daily), w = numOrNull(weekly)
  const otOff = d == null && w == null
  // One plain sentence describing exactly what these settings will do.
  const summary = otOff
    ? 'Every hour is paid as regular time — no overtime is calculated.'
    : `Overtime is paid at ${mult}× after ${[
        d != null ? `${d} h in a day` : null,
        w != null ? `${w} h in a week` : null,
      ].filter(Boolean).join(' or ')}${d != null && w != null ? ' — whichever gives more overtime, never both' : ''}.`

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <h2 className="text-sm font-semibold text-ink flex items-center gap-2"><Wallet className="w-4 h-4 text-accent" /> Payroll &amp; overtime</h2>
        </CardHeader>
        <CardBody className="space-y-3">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-14 w-full" />
        </CardBody>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-ink flex items-center gap-2">
              <Wallet className="w-4 h-4 text-accent" /> Payroll &amp; overtime
            </h2>
            <p className="text-xs text-ink-faint mt-0.5">Drives the payroll summary. Never changes a shift already worked.</p>
          </div>
          <Button size="sm" onClick={save} loading={saving} disabled={badMultiplier}>
            {saved ? <><Check className="w-3.5 h-3.5" /> Saved</> : 'Save'}
          </Button>
        </div>
      </CardHeader>

      <CardBody className="space-y-4">
        {/* ── Pay period ── */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Select label="Pay period" value={payPeriod} onChange={e => setPayPeriod(e.target.value as PayPeriodKind)}
            options={(Object.keys(PAY_PERIOD_LABELS) as PayPeriodKind[]).map(k => ({ value: k, label: PAY_PERIOD_LABELS[k] }))}
            hint="How often you run payroll." />
          <Select label="Work week starts" value={weekStart} onChange={e => setWeekStart(e.target.value)}
            options={WEEKDAYS.map((d, i) => ({ value: String(i), label: d }))}
            hint="The overtime week boundary — not the pay period." />
        </div>

        {payPeriod === 'biweekly' && (
          <Input label="A pay period start date" type="date" value={anchor} onChange={e => setAnchor(e.target.value)}
            hint="Any past payday's start date — tells EdgeQuote which two weeks pair up." />
        )}

        {/* ── Overtime ── */}
        <div>
          <p className="text-xs font-semibold text-ink-muted uppercase tracking-wide mb-1.5">Overtime rules</p>
          <div className="flex flex-wrap gap-1.5 mb-3">
            {PRESETS.map(p => (
              <button key={p.key} type="button" onClick={() => applyPreset(p)} title={p.note}
                className="inline-flex items-center rounded-full px-3 py-1.5 text-xs font-medium border border-border bg-surface text-ink-muted hover:text-ink hover:border-border-strong transition-all active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                {p.label}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Input label="Daily overtime after" type="number" min="0" max="24" step="0.5" value={daily}
              onChange={e => setDaily(e.target.value)} placeholder="—" hint="Hours. Blank = no daily rule." />
            <Input label="Weekly overtime after" type="number" min="0" max="168" step="1" value={weekly}
              onChange={e => setWeekly(e.target.value)} placeholder="—" hint="Hours. Blank = no weekly rule." />
            <Input label="Overtime multiplier" type="number" min="1" step="0.1" value={multiplier}
              onChange={e => setMultiplier(e.target.value)}
              error={badMultiplier ? 'Must be at least 1' : undefined}
              hint="1.5 = time-and-a-half." />
          </div>
        </div>

        <Banner tone={otOff ? 'neutral' : 'accent'} icon={Info}>{summary}</Banner>

        <p className="text-[11px] text-ink-faint">
          EdgeQuote doesn’t assume an overtime rule, because it differs by province — pick your
          province above or set your own. These rules apply when payroll is calculated; they never
          rewrite a shift someone already worked.
        </p>
      </CardBody>
    </Card>
  )
}
