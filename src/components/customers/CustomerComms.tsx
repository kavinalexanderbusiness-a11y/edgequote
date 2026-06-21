'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Card, CardHeader, CardBody } from '@/components/ui/Card'
import { formatDate, cn } from '@/lib/utils'
import { MessageSquare, Mail, Check, Loader2 } from 'lucide-react'
import { MSG_LABELS, MsgType } from '@/lib/comms/templates'

interface LogRow { id: string; created_at: string; channel: string; template: string; status: string; detail: string | null }

// Per-customer Communication Center: consent toggles + the full SMS/email history
// (what was sent, delivery status, when). Reads notification_log.
export function CustomerComms({ customerId, smsOptIn, emailOptIn }: { customerId: string; smsOptIn: boolean; emailOptIn: boolean }) {
  const supabase = useMemo(() => createClient(), [])
  const [sms, setSms] = useState(smsOptIn)
  const [email, setEmail] = useState(emailOptIn)
  const [log, setLog] = useState<LogRow[]>([])
  const [loading, setLoading] = useState(true)

  async function loadLog() {
    const { data } = await supabase.from('notification_log')
      .select('id, created_at, channel, template, status, detail')
      .eq('customer_id', customerId).order('created_at', { ascending: false }).limit(40)
    setLog((data as LogRow[]) || [])
    setLoading(false)
  }
  useEffect(() => { loadLog() }, [customerId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function toggle(channel: 'sms' | 'email', value: boolean) {
    if (channel === 'sms') setSms(value); else setEmail(value)
    await supabase.from('customers').update(channel === 'sms' ? { sms_opt_in: value } : { email_opt_in: value }).eq('id', customerId)
  }

  return (
    <Card>
      <CardHeader>
        <h2 className="text-sm font-semibold text-ink flex items-center gap-2"><MessageSquare className="w-4 h-4 text-accent" /> Communication</h2>
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
            <p className="text-xs text-ink-muted flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…</p>
          ) : log.length === 0 ? (
            <p className="text-xs text-ink-muted">No messages sent yet.</p>
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
      </CardBody>
    </Card>
  )
}

function OptToggle({ label, icon: Icon, on, onChange }: { label: string; icon: typeof MessageSquare; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button onClick={() => onChange(!on)}
      className={cn('flex items-center gap-1.5 text-xs font-medium rounded-full px-3 py-1.5 border transition-colors',
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
