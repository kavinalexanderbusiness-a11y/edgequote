'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Card, CardHeader, CardBody } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { StatTile } from '@/components/ui/StatTile'
import { SkeletonTiles } from '@/components/ui/Skeleton'
import { analyzeSms, smsCost, formatSmsCost, resolveSmsPricing, type SmsPricing } from '@/lib/sms/segments'
import { loadSmsPricing, invalidateSmsPricing } from '@/lib/sms/useSmsPricing'
import { SENT_STATES } from '@/lib/comms/delivery'
import { MessageSquareText, Check, AlertTriangle } from 'lucide-react'

interface Row { body: string | null; created_at: string; status: string | null }

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
      const { data: { session } } = await supabase.auth.getSession()
      const user = session?.user
      if (!user) { if (active) setRows([]); return }
      const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0)
      const { data } = await supabase.from('messages')
        .select('body, created_at, status')
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
    let sentMonth = 0, sentToday = 0, segMonth = 0, spend = 0, failed = 0
    for (const r of rows) {
      // Count (and bill) only what actually reached the carrier. This used to count
      // EVERY outbound row, so a send that never left the building — 'error' (Twilio
      // rejected the request) or 'disabled' (no credentials, we never called out) —
      // was still reported as "SMS sent" and charged in "Est. spend". Both numbers
      // overclaimed, and the spend one was simply wrong: nobody bills you for a
      // request that was refused.
      //
      // SENT_STATES is THE definition of "the send happened" (lib/comms/delivery) —
      // the same list the resend-dedupe uses. It includes 'failed'/'bounced' on
      // purpose: the carrier accepted and attempted those, so they ARE billable.
      // A null status is a legacy row from before status tracking; counting it
      // preserves the historical total rather than silently deflating this month.
      const s = (r.status || '').toLowerCase()
      if (s && !(SENT_STATES as readonly string[]).includes(s)) continue
      sentMonth++
      const info = analyzeSms(r.body || '')
      segMonth += info.segments
      spend += smsCost(info.segments, info.encoding, 1, pricing)
      if (new Date(r.created_at) >= todayStart) sentToday++
      if (s === 'failed' || s === 'bounced' || s === 'spam') failed++
    }
    return { sentMonth, sentToday, segMonth, spend, failed, avg: segMonth > 0 ? spend / segMonth : pricing.gsm7 }
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
          <h2 className="text-sm font-semibold text-ink flex items-center gap-2"><MessageSquareText className="w-4 h-4 text-accent-text" /> Messaging Usage &amp; Pricing</h2>
          <p className="text-xs text-ink-faint mt-0.5">Set your estimated per-segment cost — every composer preview uses these values. For awareness, not billing.</p>
        </div>
      </CardHeader>
      <CardBody className="space-y-4">
        {/* Configurable pricing */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Input label={`Cost / GSM-7 segment (${currency})`} fieldSize="sm"
            type="number" step="0.001" min="0" value={gsm7} onChange={e => setGsm7(e.target.value)} />
          <Input label="Cost / Unicode segment" hint="optional" fieldSize="sm"
            type="number" step="0.001" min="0" value={unicode} placeholder={gsm7} onChange={e => setUnicode(e.target.value)} />
          <Input label="Currency" fieldSize="sm"
            type="text" value={currency} maxLength={3} onChange={e => setCurrency(e.target.value.toUpperCase())} />
          <Input label="Provider" hint="reference" fieldSize="sm"
            type="text" value={provider} onChange={e => setProvider(e.target.value)} />
        </div>
        <div className="flex items-center gap-3">
          <Button size="sm" onClick={save} loading={saving}>
            {saved && <Check className="w-3.5 h-3.5" />}{saved ? 'Saved' : 'Save pricing'}
          </Button>
          {err && <span className="text-xs text-red-400 animate-fade">{err}</span>}
        </div>

        {/* Usage stats */}
        {!stats ? (
          <SkeletonTiles count={4} className="sm:grid-cols-4 gap-2.5" />
        ) : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
              <StatTile label="SMS sent today" value={String(stats.sentToday)} />
              <StatTile label="SMS sent this month" value={String(stats.sentMonth)} />
              <StatTile label="Est. spend this month" value={formatSmsCost(stats.spend, pricing.currency)} tone="accent" />
              <StatTile label="Avg cost / segment" value={formatSmsCost(stats.avg, pricing.currency)} />
            </div>
            <p className="text-[11px] text-ink-faint italic">
              {stats.segMonth} SMS segment{stats.segMonth !== 1 ? 's' : ''} sent this month. Counts only messages the carrier accepted — attempts that never left (no credentials, or a rejected request) aren&rsquo;t billed and aren&rsquo;t counted. Estimated messaging cost; actual carrier charges may vary.
            </p>
            {/* Delivery outcome — only shown once the webhooks have actually told us
                something. Before delivery tracking this was unknowable, and silence is
                the honest default: no webhook, no claim. */}
            {stats.failed > 0 && (
              <p className="text-[11px] text-amber-400 flex items-center gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                {stats.failed} message{stats.failed !== 1 ? 's' : ''} the carrier couldn&rsquo;t deliver this month — open the customer&rsquo;s conversation to see why.
              </p>
            )}
          </>
        )}
      </CardBody>
    </Card>
  )
}
