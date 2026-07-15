'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Card, CardHeader, CardBody } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'
import { enablePush, disablePush, getPushState, isIos, isStandalone, type PushState } from '@/lib/push'
import {
  Bell, BellRing, Check, MessageSquare, FileText, DollarSign, Globe, Star,
  CloudRain, CalendarClock, Sun, Smartphone,
} from 'lucide-react'

// The eight owner-facing preference rows. `key` matches the notif_prefs jsonb keys
// the send endpoint reads; absent/true = ON (opt-out model).
const PREFS = [
  { key: 'sms', label: 'New text messages', hint: 'When a customer replies by SMS', Icon: MessageSquare },
  { key: 'quote_accepted', label: 'Quote accepted', hint: 'A customer accepts a quote', Icon: FileText },
  { key: 'invoice_paid', label: 'Invoice paid', hint: 'A payment comes in', Icon: DollarSign },
  { key: 'portal_request', label: 'Portal activity', hint: 'A request from the customer portal', Icon: Globe },
  { key: 'review_received', label: 'Reviews', hint: 'A customer leaves a review', Icon: Star },
  { key: 'weather', label: 'Weather alerts', hint: 'Rain delays & weather disruptions', Icon: CloudRain },
  { key: 'daily_reminder', label: 'Daily reminders', hint: 'Your morning schedule summary', Icon: Sun },
  { key: 'schedule_change', label: 'Schedule changes', hint: 'A job is moved or rescheduled', Icon: CalendarClock },
] as const

export function PushNotificationSettings() {
  const [supabase] = useState(() => createClient())
  const [state, setState] = useState<PushState>('default')
  const [busy, setBusy] = useState(false)
  const [reason, setReason] = useState<string | null>(null)
  const [prefs, setPrefs] = useState<Record<string, boolean>>({})
  const [loaded, setLoaded] = useState(false)

  // ON unless explicitly false — so a brand-new owner gets everything.
  const isOn = (key: string) => prefs[key] !== false

  useEffect(() => {
    let active = true
    ;(async () => {
      const s = await getPushState()
      if (!active) return
      setState(s)
      const { data: { session } } = await supabase.auth.getSession()
      const user = session?.user
      if (user) {
        const { data } = await supabase.from('business_settings').select('notif_prefs').eq('user_id', user.id).maybeSingle()
        if (active) setPrefs(((data as { notif_prefs?: Record<string, boolean> } | null)?.notif_prefs) || {})
      }
      if (active) setLoaded(true)
    })()
    return () => { active = false }
  }, [supabase])

  async function toggle() {
    setBusy(true); setReason(null)
    if (state === 'subscribed') {
      await disablePush()
      setState('default')
    } else {
      const r = await enablePush()
      setState(r.state)
      if (!r.ok) setReason(r.reason || 'Could not enable notifications.')
    }
    setBusy(false)
  }

  async function setPref(key: string, value: boolean) {
    const prev = prefs
    const next = { ...prefs, [key]: value }
    setPrefs(next)   // optimistic
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { setPrefs(prev); return }
    const { error } = await supabase.from('business_settings').update({ notif_prefs: next }).eq('user_id', user.id)
    if (error) setPrefs(prev)   // revert on a failed write
  }

  const iosNeedsInstall = isIos() && !isStandalone()
  const enabled = state === 'subscribed'

  return (
    <Card>
      <CardHeader>
        <div>
          <h2 className="text-sm font-semibold text-ink flex items-center gap-2">
            <BellRing className="w-4 h-4 text-accent-text" /> Push Notifications
          </h2>
          <p className="text-xs text-ink-faint mt-0.5">
            Get alerts on this device — even when EdgeQuote is closed. Delivered through your existing notifications, so nothing is doubled up.
          </p>
        </div>
      </CardHeader>
      <CardBody className="space-y-5">
        {/* Master enable/disable */}
        <div className="flex items-center justify-between gap-4 rounded-xl border border-border p-4">
          <div className="flex items-start gap-3 min-w-0">
            <div className={cn('w-9 h-9 rounded-lg flex items-center justify-center shrink-0 border',
              enabled ? 'border-accent/30 bg-accent/10 text-accent-text' : 'border-border text-ink-muted')}>
              <Bell className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium text-ink">
                {enabled ? 'Notifications are on for this device' : 'Turn on notifications for this device'}
              </p>
              <p className="text-xs text-ink-faint mt-0.5">
                {state === 'unsupported'
                  ? 'This browser doesn’t support push notifications.'
                  : state === 'denied'
                    ? 'Blocked in your browser settings — allow notifications for this site, then try again.'
                    : enabled
                      ? 'Tap to stop receiving alerts here.'
                      : 'You’ll be asked to allow notifications.'}
              </p>
            </div>
          </div>
          <Button
            variant={enabled ? 'secondary' : 'primary'}
            loading={busy}
            onClick={toggle}
            disabled={busy || state === 'unsupported' || state === 'denied'}
            className="shrink-0">
            {!busy && (enabled ? <Check className="w-4 h-4" /> : <Bell className="w-4 h-4" />)}
            {enabled ? 'Turn off' : 'Enable'}
          </Button>
        </div>

        {iosNeedsInstall && (
          <div className="flex items-start gap-2.5 rounded-xl border border-accent/25 bg-accent/[0.06] p-3.5">
            <Smartphone className="w-4 h-4 text-accent-text shrink-0 mt-0.5" />
            <p className="text-xs text-ink-muted leading-relaxed">
              <span className="font-semibold text-ink">On iPhone &amp; iPad,</span> first install EdgeQuote: tap the
              Share button, choose <span className="font-medium text-ink">Add to Home Screen</span>, then open it from
              your Home Screen and enable notifications here.
            </p>
          </div>
        )}

        {reason && !iosNeedsInstall && (
          <p className="text-xs text-amber-400/90 leading-relaxed">{reason}</p>
        )}

        {/* Per-type preferences */}
        <div className={cn('space-y-1 transition-opacity', !enabled && 'opacity-55')}>
          <p className="text-xs font-semibold text-ink-muted uppercase tracking-wide mb-1.5">Notify me about</p>
          {PREFS.map(({ key, label, hint, Icon }) => {
            const on = isOn(key)
            return (
              <button
                key={key}
                type="button"
                role="switch"
                aria-checked={on}
                disabled={!loaded}
                onClick={() => setPref(key, !on)}
                className="w-full flex items-center justify-between gap-3 py-2.5 px-1 text-left rounded-lg hover:bg-surface/40 transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                <span className="flex items-center gap-3 min-w-0">
                  <Icon className="w-4 h-4 text-ink-muted shrink-0" />
                  <span className="min-w-0">
                    <span className="block text-sm text-ink truncate">{label}</span>
                    <span className="block text-[11px] text-ink-faint truncate">{hint}</span>
                  </span>
                </span>
                <span className={cn('relative w-9 h-5 rounded-full transition-colors shrink-0', on ? 'bg-accent' : 'bg-border-strong')}>
                  <span className={cn('absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all', on ? 'left-[18px]' : 'left-0.5')} />
                </span>
              </button>
            )
          })}
          <p className="text-[11px] text-ink-faint pt-1.5">
            Preferences apply to every device. Turning a type off stops its push on all your devices.
          </p>
        </div>
      </CardBody>
    </Card>
  )
}
