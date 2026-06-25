'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Card, CardHeader, CardBody } from '@/components/ui/Card'
import { analyzeSms, smsCost, formatSmsCost, resolveSmsPricing, type SmsPricing } from '@/lib/sms/segments'
import { loadSmsPricing, invalidateSmsPricing } from '@/lib/sms/useSmsPricing'
import { Button } from '@/components/ui/Button'
import { MessageSquareText, Loader2, Check } from 'lucide-react'

interface Row { body: string | null; created_at: string }

// Messaging usage + the CONFIGURABLE pricing that drives every composer's estimate.
// Spend is computed from REAL segment counts of this month's outbound SMS bodies
// (existing messages table) using the owner's per-encoding prices — so the card and
// the live previews always agree. No new tables; sms_pricing is one jsonb column.
export function MessagingUsage() {
  const [supabase] = useState(() => createClient())
  const [rows, setRows] = useState<Row[] | null>(null)

  // Editable pricing config.
  const [gsm7, setGsm7] = useState('0.015')
  const [unicode, setUnicode] = useState('')   // optional; blank = same as GSM-7
  const [currency, setCurrency] = useState('CAD')
  const [provider, setProvider] = useState('Twilio')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    ;(async () => {
      const p = await loadSmsPricing()
      if (!active) return
      setGsm7(String(p.gsm7))
      setUnicode(p.unicode !== p.gsm7 ? String(p.unicode) : '')
      setCurrency(p.currency)
      setProvider(p.provider || '')
    })()
    ;(async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { if (active) setRows([]); return }
      const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0)
      const { data } = await supabase.from('messages')
        .select('body, created_at')
        .eq('user_id', user.id).eq('direction', 'outbound').eq('channel', 'sms')
        .gte('created_at', monthStart.toISOString())
        .order('created_at', { ascending: false }).limit(5000)
      if (active) setRows((data as Row[]) || [])
    })()
    return () => { active = false }
  }, [supabase])

  const pricing = useMemo<SmsPricing>(() => resolveSmsPricing({
    currency, provider,
    gsm7: parseFloat(gsm7),
    unicode: unicode.trim() ? parseFloat(unicode) : undefined,
  }), [gsm7, unicode, currency, provider])

  const stats = useMemo(() => {
    if (!rows) return null
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0)
    let sentMonth = 0, sentToday = 0, segMonth = 0, spend = 0
    for (const r of rows) {
      sentMonth++
      const info = analyzeSms(r.body || '')
      segMonth += info.segments
      spend += smsCost(info.segments, info.encoding, 1, pricing)
      if (new Date(r.created_at) >= todayStart) sentToday++
    }
    return { sentMonth, sentToday, segMonth, spend, avg: segMonth > 0 ? spend / segMonth : pricing.gsm7 }
  }, [rows, pricing])

  async function save() {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return
    setSaving(true); setErr(null)
    const { error } = await supabase.from('business_settings').update({ sms_pricing: pricing }).eq('user_id', user.id)
    setSaving(false)
    if (error) { setErr('Could not save — run the sms_pricing migration first.'); return }
    invalidateSmsPricing(pricing)
    setSaved(true); setTimeout(() => setSaved(false), 2000)
  }

  return (
    <Card>
      <CardHeader>
        <div>
          <h2 className="text-sm font-semibold text-ink flex items-center gap-2"><MessageSquareText className="w-4 h-4 text-accent" /> Messaging Usage &amp; Pricing</h2>
          <p className="text-xs text-ink-faint mt-0.5">Set your estimated per-segment cost — every composer preview uses these values. For awareness, not billing.</p>
        </div>
      </CardHeader>
      <CardBody className="space-y-4">
        {/* Configurable pricing */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Field label={`Cost / GSM-7 segment (${currency})`}>
            <input type="number" step="0.001" min="0" value={gsm7} onChange={e => setGsm7(e.target.value)} className={inputCls} />
          </Field>
          <Field label={`Cost / Unicode segment`} hint="optional">
            <input type="number" step="0.001" min="0" value={unicode} placeholder={gsm7} onChange={e => setUnicode(e.target.value)} className={inputCls} />
          </Field>
          <Field label="Currency">
            <input type="text" value={currency} maxLength={3} onChange={e => setCurrency(e.target.value.toUpperCase())} className={inputCls} />
          </Field>
          <Field label="Provider" hint="reference">
            <input type="text" value={provider} onChange={e => setProvider(e.target.value)} className={inputCls} />
          </Field>
        </div>
        <div className="flex items-center gap-3">
          <Button size="sm" onClick={save} loading={saving}>
            {saved ? <><Check className="w-3.5 h-3.5" /> Saved</> : 'Save pricing'}
          </Button>
          {err && <span className="text-[11px] text-amber-400">{err}</span>}
        </div>

        {/* Usage stats */}
        {!stats ? (
          <div className="py-4 text-center text-xs text-ink-muted flex items-center justify-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading usage…</div>
        ) : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
              <UsageStat label="SMS sent today" value={String(stats.sentToday)} />
              <UsageStat label="SMS sent this month" value={String(stats.sentMonth)} />
              <UsageStat label="Est. spend this month" value={formatSmsCost(stats.spend, pricing.currency)} tone="text-accent" />
              <UsageStat label="Avg cost / segment" value={formatSmsCost(stats.avg, pricing.currency)} />
            </div>
            <p className="text-[11px] text-ink-faint italic">
              {stats.segMonth} SMS segment{stats.segMonth !== 1 ? 's' : ''} sent this month. Estimated messaging cost — actual carrier/provider charges may vary.
            </p>
          </>
        )}
      </CardBody>
    </Card>
  )
}

const inputCls = 'w-full bg-bg-tertiary border border-border-strong rounded-lg px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent'

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 min-w-0">
      <span className="text-[10px] font-semibold text-ink-faint uppercase tracking-wide truncate">{label}{hint && <span className="normal-case font-normal text-ink-faint"> · {hint}</span>}</span>
      {children}
    </label>
  )
}

function UsageStat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-xl border border-border bg-bg-secondary px-3 py-2.5">
      <p className="text-[10px] font-semibold text-ink-faint uppercase tracking-wide leading-none">{label}</p>
      <p className={`text-lg font-bold mt-1 tabular-nums ${tone || 'text-ink'}`}>{value}</p>
    </div>
  )
}
