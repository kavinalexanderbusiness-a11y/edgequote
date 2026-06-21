'use client'

import { useState } from 'react'
import { MsgType, MSG_LABELS } from '@/lib/comms/templates'
import { cn } from '@/lib/utils'
import { Navigation, Clock, MapPin, CheckCircle2, Heart, Star, Loader2, Check, AlertTriangle } from 'lucide-react'

// One-tap field messaging for a single visit. Sends through /api/comms/send
// (owner session, opt-in-gated, logged). Texting/email stay off until provider
// keys exist — the result line says exactly why if a send is skipped.
interface Props {
  jobId: string
  customerId: string | null
  customerName: string
}

const BUTTONS: { type: MsgType; icon: typeof Navigation; needsEta?: boolean; tone?: string }[] = [
  { type: 'on_my_way', icon: Navigation, needsEta: true, tone: 'text-sky-300 border-sky-400/30 bg-sky-400/10 hover:bg-sky-400/20' },
  { type: 'running_late', icon: Clock, needsEta: true, tone: 'text-amber-300 border-amber-400/30 bg-amber-400/10 hover:bg-amber-400/20' },
  { type: 'arrived', icon: MapPin },
  { type: 'job_complete', icon: CheckCircle2, tone: 'text-emerald-300 border-emerald-400/30 bg-emerald-400/10 hover:bg-emerald-400/20' },
  { type: 'thanks', icon: Heart },
  { type: 'review_request', icon: Star, tone: 'text-violet-300 border-violet-400/30 bg-violet-400/10 hover:bg-violet-400/20' },
]

interface Outcome { ok: boolean; text: string }

export function JobMessages({ jobId, customerId, customerName }: Props) {
  const [eta, setEta] = useState('15')
  const [busy, setBusy] = useState<MsgType | null>(null)
  const [outcome, setOutcome] = useState<Record<string, Outcome>>({})

  async function send(type: MsgType) {
    if (!customerId) { setOutcome(o => ({ ...o, [type]: { ok: false, text: 'No customer linked to this job.' } })); return }
    setBusy(type)
    try {
      const res = await fetch('/api/comms/send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customerId, template: type, jobId, vars: { eta } }),
      })
      const data = await res.json()
      setOutcome(o => ({ ...o, [type]: summarize(data) }))
    } catch (e) {
      setOutcome(o => ({ ...o, [type]: { ok: false, text: e instanceof Error ? e.message : 'Failed to send.' } }))
    }
    setBusy(null)
  }

  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-2">
        <label className="text-[10px] uppercase tracking-wide text-ink-faint">ETA (min)</label>
        <input type="number" min="1" step="5" value={eta} onChange={e => setEta(e.target.value)}
          className="w-16 bg-bg-tertiary border border-border-strong rounded-lg px-2 py-1 text-sm text-ink outline-none focus:border-accent" />
        <span className="text-[10px] text-ink-faint">used by On my way / Running late · texting {customerName.split(' ')[0]}</span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
        {BUTTONS.map(b => {
          const oc = outcome[b.type]
          return (
            <button key={b.type} onClick={() => send(b.type)} disabled={busy !== null}
              className={cn('h-9 rounded-lg border text-xs font-medium flex items-center justify-center gap-1.5 active:scale-95 transition-transform disabled:opacity-50',
                b.tone || 'border-border text-ink-muted hover:text-ink hover:bg-black/10')}>
              {busy === b.type ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <b.icon className="w-3.5 h-3.5" />}
              {MSG_LABELS[b.type]}
            </button>
          )
        })}
      </div>
      {Object.entries(outcome).slice(-1).map(([type, oc]) => (
        <div key={type} className={cn('flex items-start gap-1.5 text-[11px] rounded-lg px-2.5 py-1.5 border',
          oc.ok ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10' : 'text-amber-400 border-amber-500/30 bg-amber-500/10')}>
          {oc.ok ? <Check className="w-3.5 h-3.5 shrink-0 mt-px" /> : <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />}
          <span><span className="font-semibold">{MSG_LABELS[type as MsgType]}:</span> {oc.text}</span>
        </div>
      ))}
    </div>
  )
}

// Turn the send route response into one human line.
function summarize(data: { results?: Record<string, { sent?: boolean; reason?: string; error?: string }>; enabled?: { sms: boolean; email: boolean } }): Outcome {
  const r = data.results || {}
  const sent = Object.entries(r).filter(([, v]) => v.sent).map(([ch]) => ch)
  if (sent.length) return { ok: true, text: `sent by ${sent.join(' & ')}.` }
  const reasons = Object.values(r).map(v => v.reason)
  if (reasons.includes('no-optin')) return { ok: false, text: 'customer hasn’t opted in — turn on SMS/email on their profile.' }
  if (reasons.includes('disabled')) return { ok: false, text: 'messaging is off — add Twilio/Resend keys in Settings.' }
  const err = Object.values(r).find(v => v.error)?.error
  if (err) return { ok: false, text: err }
  if (!data.results) return { ok: false, text: 'no channels selected.' }
  return { ok: false, text: 'nothing sent (no phone/email on file).' }
}
