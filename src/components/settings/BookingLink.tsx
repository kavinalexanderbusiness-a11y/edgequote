'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { ensureBookingToken, bookingUrl } from '@/lib/booking'
import { Card, CardHeader, CardBody } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Globe, Check, ExternalLink, Copy } from 'lucide-react'

const CHANNELS = [
  { key: 'website', label: 'Website' },
  { key: 'google_business', label: 'Google' },
  { key: 'qr', label: 'QR code' },
  { key: 'facebook', label: 'Facebook' },
  { key: 'nextdoor', label: 'Nextdoor' },
]

// Settings card: enable the public booking funnel + copy/share the link.
export function BookingLink() {
  const supabase = createClient()
  const [enabled, setEnabled] = useState(false)
  const [token, setToken] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let active = true
    ;(async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { if (active) setLoaded(true); return }
      const { data } = await supabase.from('business_settings').select('booking_enabled, booking_token').eq('user_id', user.id).maybeSingle()
      if (active) { setEnabled(!!(data as { booking_enabled?: boolean } | null)?.booking_enabled); setToken((data as { booking_token?: string | null } | null)?.booking_token ?? null); setLoaded(true) }
    })()
    return () => { active = false }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function toggle(v: boolean) {
    setBusy(true)
    setEnabled(v)
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { setBusy(false); return }
    let t = token
    if (v && !t) { t = await ensureBookingToken(supabase, user.id); setToken(t) }
    await supabase.from('business_settings').update({ booking_enabled: v }).eq('user_id', user.id)
    setBusy(false)
  }

  const url = token ? bookingUrl(token) : ''
  async function copy() { try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1800) } catch { /* clipboard optional */ } }
  const [copiedCh, setCopiedCh] = useState<string | null>(null)
  async function copyTagged(channel: string) {
    try { await navigator.clipboard.writeText(`${url}?utm_source=${channel}`); setCopiedCh(channel); setTimeout(() => setCopiedCh(null), 1800) } catch { /* clipboard optional */ }
  }

  if (!loaded) return null
  return (
    <Card className="mt-6">
      <CardHeader>
        <div>
          <h2 className="text-sm font-semibold text-ink flex items-center gap-2"><Globe className="w-4 h-4 text-accent" /> Online Booking</h2>
          <p className="text-xs text-ink-faint mt-0.5">A public link where prospects get an instant quote from your pricing and book themselves — 24/7. New bookings appear in Quotes as a “sent” quote.</p>
        </div>
      </CardHeader>
      <CardBody className="space-y-3">
        <label className="flex items-center justify-between gap-3 rounded-lg border border-border bg-bg-tertiary px-3 py-2.5 cursor-pointer">
          <span className="text-sm text-ink">Enable online booking</span>
          <button type="button" disabled={busy} onClick={() => toggle(!enabled)} aria-pressed={enabled}
            className={`relative w-11 h-6 rounded-full transition-colors shrink-0 ${enabled ? 'bg-emerald-500' : 'bg-border-strong'}`}>
            <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${enabled ? 'translate-x-5' : ''}`} />
          </button>
        </label>

        {enabled && url && (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <input readOnly value={url} className="flex-1 min-w-0 bg-bg-tertiary border border-border-strong rounded-lg px-3 py-2 text-xs text-ink-muted outline-none" />
              <Button size="sm" variant="secondary" onClick={copy}>{copied ? <><Check className="w-3.5 h-3.5" /> Copied</> : <><Copy className="w-3.5 h-3.5" /> Copy</>}</Button>
              <a href={url} target="_blank" rel="noopener noreferrer"><Button size="sm" variant="ghost"><ExternalLink className="w-3.5 h-3.5" /></Button></a>
            </div>
            <p className="text-xs text-ink-faint">Put this link on your website, Google profile, flyers, and social — or as a QR code on a yard sign.</p>
            <div className="pt-1">
              <p className="text-[11px] text-ink-faint mb-1.5">Tagged links — copy a different one per channel to see where each lead came from:</p>
              <div className="flex flex-wrap gap-1.5">
                {CHANNELS.map(ch => (
                  <button key={ch.key} type="button" onClick={() => copyTagged(ch.key)}
                    className="text-xs font-medium rounded-lg border border-border-strong bg-surface text-ink-muted hover:text-ink px-2.5 py-1.5 transition-colors">
                    {copiedCh === ch.key ? <span className="inline-flex items-center gap-1 text-emerald-400"><Check className="w-3 h-3" /> Copied</span> : ch.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  )
}
