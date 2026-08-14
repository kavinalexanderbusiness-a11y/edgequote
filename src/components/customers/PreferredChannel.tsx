'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Card, CardBody } from '@/components/ui/Card'
import { MessageSquare, Mail, Phone, CircleSlash, AlertTriangle } from 'lucide-react'
import { toast } from '@/lib/toast'
import { tenantCapabilities, type TenantCapabilities } from '@/lib/capabilities'
import { resolveReach, reachSummary, type PreferredChannel as Pref } from '@/lib/comms/reach'
import type { Customer } from '@/types'

// ── "How do I reach this person?" — the one answer, and the one place to set it ─
//
// This card states what a message to this customer would ACTUALLY do, and lets
// the owner record what the customer asked for. Those are two different facts and
// the card never lets them be confused: the sentence is computed by resolveReach
// (lib/comms/reach), which applies consent, contact and tenant capability FIRST
// and only then orders by preference. So picking "Text" for someone who has
// opted out of SMS does not enable texting — it changes the sentence to say, in
// as many words, that they prefer a text and will get an email instead.
//
// It lives above the profile's fold-out rather than inside it because it answers
// a phone-call question ("what do I do to contact them right now"), which is the
// same reason the owed/notes/schedule cards sit up there.
//
// Preference deliberately writes NO audit row. consent_changes exists to prove
// who granted or revoked PERMISSION; a preference grants nothing, and logging it
// beside real consent history would imply it did.

const OPTIONS: { value: Pref | null; label: string; icon: typeof Mail }[] = [
  { value: 'sms', label: 'Text', icon: MessageSquare },
  { value: 'email', label: 'Email', icon: Mail },
  { value: 'phone', label: 'Call', icon: Phone },
  { value: null, label: 'No preference', icon: CircleSlash },
]

export function PreferredChannelCard({ customer, onChange }: {
  customer: Customer
  onChange?: (patch: Partial<Customer>) => void
}) {
  const supabase = useMemo(() => createClient(), [])
  const [saving, setSaving] = useState<'idle' | Pref | 'none'>('idle')
  // What the PLATFORM permits this business to send on. Undefined until read, and
  // resolveReach then answers on consent alone — exactly today's behaviour. Once
  // read, a capability the tenant lacks blocks the channel here just as it does
  // in dispatch. A failed read resolves to NO_CAPABILITIES, so this card can only
  // ever be MORE conservative than the send, never more optimistic.
  const [caps, setCaps] = useState<TenantCapabilities | undefined>(undefined)

  useEffect(() => {
    let alive = true
    ;(async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return
      const c = await tenantCapabilities(supabase, user.id)
      if (alive) setCaps(c)
    })()
    return () => { alive = false }
  }, [supabase])

  const selected = customer.preferred_channel ?? null
  const verdict = resolveReach(
    {
      phone: customer.phone, email: customer.email,
      sms_opt_in: !!customer.sms_opt_in, email_opt_in: !!customer.email_opt_in,
      message_prefs: null, preferred_channel: selected,
    },
    { caps },
  )

  async function choose(value: Pref | null) {
    if (value === selected) return
    setSaving(value ?? 'none')
    const { error } = await supabase.from('customers')
      .update({ preferred_channel: value }).eq('id', customer.id)
    setSaving('idle')
    if (error) { toast.error('Could not save the preference — please try again.'); return }
    // Lift to the parent so the sentence above recomputes immediately instead of
    // waiting for a realtime tick — the same contract the sibling cards use.
    onChange?.({ preferred_channel: value })
  }

  // Tone follows the TRUTH, not the preference: red when nothing can reach them,
  // amber when we are knowingly doing something other than what they asked.
  const tone = !verdict.best ? 'bad' : verdict.state === 'overruled' ? 'warn' : 'ok'

  return (
    <Card className={tone === 'bad' ? 'border-red-500/30' : tone === 'warn' ? 'border-amber-500/30' : undefined}>
      <CardBody className="space-y-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Preferred contact</p>
          <p className={`text-sm mt-1 flex items-start gap-1.5 ${tone === 'bad' ? 'text-red-300' : tone === 'warn' ? 'text-amber-300' : 'text-ink'}`}>
            {tone !== 'ok' && <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />}
            {reachSummary(verdict)}
          </p>
        </div>

        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Preferred contact method">
          {OPTIONS.map(o => {
            const on = selected === o.value
            const busy = saving === (o.value ?? 'none')
            return (
              <button
                key={o.label} type="button" aria-pressed={on} disabled={saving !== 'idle'}
                onClick={() => choose(o.value)}
                className={`inline-flex items-center gap-1.5 min-h-[40px] px-3 py-2 rounded-lg border text-xs font-medium transition-colors disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
                  on ? 'border-accent bg-accent/15 text-accent-text' : 'border-border-strong bg-surface text-ink-muted hover:border-accent/40'
                }`}
              >
                <o.icon className="w-3.5 h-3.5" aria-hidden="true" />
                {busy ? 'Saving…' : o.label}
              </button>
            )
          })}
        </div>

        <p className="text-[11px] text-ink-faint">
          A preference, not a permission — it never overrides consent, a STOP, or what
          this business is enabled to send. Consent stays in Communication below.
        </p>
      </CardBody>
    </Card>
  )
}
