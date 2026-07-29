'use client'

import { confirm as confirmDialog } from '@/lib/confirm'
import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Card, CardHeader, CardBody } from '@/components/ui/Card'
import { InlineEmpty } from '@/components/ui/EmptyState'
import { SkeletonRows } from '@/components/ui/Skeleton'
import { formatDate, cn } from '@/lib/utils'
import { MessageSquare, Mail, Check } from 'lucide-react'
import { MSG_LABELS, MsgType } from '@/lib/comms/templates'
import { applyConsent, SMS_CONSENT_WARNING } from '@/lib/consent'
import { toast } from '@/lib/toast'

interface LogRow { id: string; created_at: string; channel: string; template: string; status: string; detail: string | null }
interface ConsentRow { id: string; created_at: string; channel: string; old_value: boolean | null; new_value: boolean | null; source: string; changed_by: string | null }

// Per-customer Communication Center: consent toggles + the full SMS/email history
// (what was sent, delivery status, when). Reads notification_log.
export function CustomerComms({ customerId, smsOptIn, emailOptIn, onChange }: {
  customerId: string; smsOptIn: boolean; emailOptIn: boolean
  /** Lift a saved consent change to the parent, so the header badge and this card can
   *  never disagree about whether texting is allowed. The sibling cards (CommsHealth,
   *  ReviewLifecycle, PaymentMethodCard) all report upward the same way. */
  onChange?: (patch: { sms_opt_in?: boolean; email_opt_in?: boolean }) => void
}) {
  const supabase = useMemo(() => createClient(), [])
  const [sms, setSms] = useState(smsOptIn)
  const [email, setEmail] = useState(emailOptIn)
  // Re-seed when the record changes underneath us — a consent change made from the
  // list's bulk action, another device, or the sibling card arrives here as new props
  // via the page's realtime refetch. Without this the toggle keeps showing the value it
  // was mounted with, and one page states two different answers about consent.
  useEffect(() => { setSms(smsOptIn); setEmail(emailOptIn) }, [smsOptIn, emailOptIn])
  const [log, setLog] = useState<LogRow[]>([])
  const [consentLog, setConsentLog] = useState<ConsentRow[]>([])
  const [loading, setLoading] = useState(true)

  async function loadLog() {
    const [msgRes, conRes] = await Promise.all([
      supabase.from('notification_log').select('id, created_at, channel, template, status, detail')
        .eq('customer_id', customerId).order('created_at', { ascending: false }).limit(40),
      supabase.from('consent_changes').select('id, created_at, channel, old_value, new_value, source, changed_by')
        .eq('customer_id', customerId).order('created_at', { ascending: false }).limit(20),
    ])
    setLog((msgRes.data as LogRow[]) || [])
    setConsentLog((conRes.data as ConsentRow[]) || [])
    setLoading(false)
  }
  useEffect(() => { loadLog() }, [customerId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function toggle(channel: 'sms' | 'email', value: boolean) {
    // Enabling SMS requires explicit confirmation (carrier/Twilio/CASL).
    if (channel === 'sms' && value) {
      const ok = await confirmDialog({ title: 'Enable SMS for this customer?', message: SMS_CONSENT_WARNING, confirmLabel: 'Enable SMS' })
      if (!ok) return
    }
    const prevSms = sms, prevEmail = email
    // Optimistic flip — reverted below if the write doesn't land. Consent is the gate on
    // every automated message, so a pill that says "SMS On" after a failed save is the
    // most expensive lie this page can tell: the owner believes they may text.
    if (channel === 'sms') setSms(value); else setEmail(value)
    const revert = () => { setSms(prevSms); setEmail(prevEmail) }
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { revert(); toast.error('Could not save — please sign in again.'); return }
    // Update + audit (who/when/old→new) via the shared consent layer.
    const { error } = await applyConsent(supabase, {
      targets: [{ id: customerId, sms_opt_in: prevSms, email_opt_in: prevEmail }],
      channel, value, userId: user.id, changedBy: user.email || user.id, source: 'single',
    })
    if (error) { revert(); toast.error('Could not update consent: ' + error); return }
    // Tell the parent, so the identity header's badge updates now rather than waiting
    // for a realtime tick to refetch the whole page.
    onChange?.(channel === 'sms' ? { sms_opt_in: value } : { email_opt_in: value })
    loadLog() // refresh consent history with the new audit row
  }

  return (
    <Card>
      <CardHeader>
        <h2 className="text-sm font-semibold text-ink flex items-center gap-2"><MessageSquare className="w-4 h-4 text-accent-text" /> Communication</h2>
        <p className="text-xs text-ink-faint mt-0.5">Consent controls every automated and one-tap message to this customer.</p>
      </CardHeader>
      <CardBody className="space-y-4">
        {/* Opt-in toggles */}
        <div className="flex flex-wrap gap-2">
          <OptToggle label="SMS" icon={MessageSquare} on={sms} onChange={v => toggle('sms', v)} />
          <OptToggle label="Email" icon={Mail} on={email} onChange={v => toggle('email', v)} />
        </div>

        {/* History */}
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint mb-1.5">History</p>
          {loading ? (
            <SkeletonRows count={3} />
          ) : log.length === 0 ? (
            <InlineEmpty className="py-3">No messages sent yet.</InlineEmpty>
          ) : (
            <div className="space-y-1">
              {log.map(r => (
                <div key={r.id} className="flex items-center gap-2 text-xs py-1 border-b border-border/50 last:border-0">
                  {r.channel === 'email' ? <Mail className="w-3.5 h-3.5 text-ink-faint shrink-0" /> : <MessageSquare className="w-3.5 h-3.5 text-ink-faint shrink-0" />}
                  <span className="text-ink font-medium">{MSG_LABELS[r.template as MsgType] || r.template}</span>
                  <StatusTag status={r.status} detail={r.detail} />
                  <span className="text-ink-faint ml-auto shrink-0">{formatDate(r.created_at)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Consent history — who changed SMS/email opt-in, when, old → new */}
        {consentLog.length > 0 && (
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint mb-1.5">Consent history</p>
            <div className="space-y-1">
              {consentLog.map(r => (
                <div key={r.id} className="flex items-center gap-2 text-xs py-1 border-b border-border/50 last:border-0">
                  <span className="text-ink font-medium uppercase">{r.channel}</span>
                  <span className={r.new_value ? 'text-emerald-400' : 'text-ink-muted'}>{r.old_value ? 'On' : 'Off'} → {r.new_value ? 'On' : 'Off'}</span>
                  <span className="text-ink-faint truncate">· {r.source}{r.changed_by ? ` · ${r.changed_by}` : ''}</span>
                  <span className="text-ink-faint ml-auto shrink-0">{formatDate(r.created_at)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  )
}

function OptToggle({ label, icon: Icon, on, onChange }: { label: string; icon: typeof MessageSquare; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button onClick={() => onChange(!on)} aria-pressed={on}
      className={cn('flex items-center gap-1.5 text-xs font-medium rounded-full px-3 py-1.5 border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
        on ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10' : 'text-ink-muted border-border bg-bg-tertiary hover:text-ink')}>
      <Icon className="w-3.5 h-3.5" /> {label}: {on ? <span className="inline-flex items-center gap-0.5">On <Check className="w-3 h-3" /></span> : 'Off'}
    </button>
  )
}

function StatusTag({ status, detail }: { status: string; detail: string | null }) {
  const tone = status === 'sent' ? 'text-emerald-400'
    : status === 'failed' || status === 'error' ? 'text-red-400'
    : 'text-ink-faint'
  const label = status === 'sent' ? 'sent' : status === 'skipped' ? `skipped${detail ? ` (${detail})` : ''}` : status === 'disabled' ? 'disabled' : status
  return <span className={cn('text-[10px] font-semibold', tone)} title={detail || undefined}>· {label}</span>
}
