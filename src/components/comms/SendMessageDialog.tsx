'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { MsgType, MSG_LABELS, renderMessage, toDisplayBody, fromDisplayBody, PORTAL_LINK_DISPLAY } from '@/lib/comms/templates'
import { summarizeSendOutcome, type SendOutcome } from '@/lib/comms/sendOutcome'
import { SmsCost } from '@/components/comms/SmsCost'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { FilterPill } from '@/components/ui/FilterPill'
import { AssistButton } from '@/components/ai/AssistButton'
import { useAiAssist } from '@/hooks/useAiAssist'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { MessageSquare, Mail, Send, Check, AlertTriangle } from 'lucide-react'

// ── THE Send Message dialog — one composer for one OR many recipients ─────────
// Every entry point (Customer List, Customer page, Schedule Day View, Quotes,
// Invoices, CRM) opens THIS dialog; every send goes through the ONE
// /api/comms/send route (opt-in-gated, disabled-safe, threaded + logged).
// • One recipient  → today's composer: template pills, editable body, SmsCost.
// • Many           → adds the recipient checklist (Select all / Clear / toggles).
// The body is rendered by the SAME engine the automations use (owner overrides
// included) — what you read is what sends. If you DON'T edit it, each customer
// gets their own personalized rendering; if you DO edit it, your exact text goes
// to everyone selected (flagged in the UI so "Hi Dave" never reaches Sarah).

export interface MessageRecipient { customerId: string; name: string; phone?: string | null; service?: string | null }

interface Props {
  open: boolean
  onClose: (sent?: number) => void
  /** Many recipients (bulk mode) — or use customerId/customerName for one. */
  recipients?: MessageRecipient[]
  /** Single-recipient convenience (Customer page, Quote, Invoice). */
  customerId?: string
  customerName?: string
  /** Which recipients start checked (bulk mode). Omit = all. */
  initialSelectedIds?: string[]
  // Optional context: link the send to a job (dedupe/logging) and pre-fill vars.
  jobId?: string | null
  defaultTemplate?: MsgType
  /** Which templates to offer (defaults to the general-purpose set below). */
  templates?: MsgType[]
  vars?: { dateLabel?: string; timeWindow?: string; address?: string; amount?: string }
  title?: string
  onSent?: () => void
}

// The general-purpose picker set (job-timing composers add their own extras).
const DEFAULT_SET: MsgType[] = [
  'introduction', 'confirm', 'on_my_way', 'running_late', 'rain_delay',
  'rescheduled', 'job_complete', 'review_request', 'reminder', 'thanks', 'custom',
]

export function SendMessageDialog({
  open, onClose, recipients, customerId, customerName, initialSelectedIds,
  jobId, defaultTemplate, templates, vars, title, onSent,
}: Props) {
  const supabase = useMemo(() => createClient(), [])
  const all: MessageRecipient[] = useMemo(
    () => recipients ?? (customerId ? [{ customerId, name: customerName || 'Customer' }] : []),
    [recipients, customerId, customerName],
  )
  const bulk = all.length > 1

  const [custom, setCustom] = useState<Partial<Record<MsgType, string>> | null>(null)
  const [company, setCompany] = useState('Your service provider')
  const [reviewUrl, setReviewUrl] = useState('')
  const [bizPhone, setBizPhone] = useState('')

  const [active, setActive] = useState<MsgType>(defaultTemplate ?? 'custom')
  const [selected, setSelected] = useState<Set<string>>(() => new Set(initialSelectedIds ?? all.map(r => r.customerId)))
  const [eta, setEta] = useState('15')
  const [text, setText] = useState('')
  const [edited, setEdited] = useState(false)
  const [ch, setCh] = useState<{ sms: boolean; email: boolean }>({ sms: true, email: true })
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(0)
  const [outcome, setOutcome] = useState<SendOutcome | null>(null)
  // Bulk sends cost money and reach many people — require a deliberate second click.
  const [armed, setArmed] = useState(false)

  const chosen = useMemo(() => all.filter(r => selected.has(r.customerId)), [all, selected])
  const toggle = (id: string) => setSelected(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })

  // AI writer — drafts/rewrites INTO the editable box; sending still goes
  // through the same consent-gated route, so the model never sends anything.
  const ai = useAiAssist()
  async function aiWrite(mode: 'draft' | 'rewrite') {
    if (busy || ai.running) return
    const prior = text
    ai.clearError()
    setText('')
    const full = await ai.run({
      task: 'draft_message',
      customerId: !bulk ? (chosen[0]?.customerId ?? all[0]?.customerId) : undefined,
      template: active,
      channels: (['sms', 'email'] as const).filter(c => ch[c]),
      currentText: mode === 'rewrite' ? prior : '',
      bulk,
    }, { onDelta: d => setText(prev => prev + d) })
    if (full === null) { setText(prior); return }   // error — restore, message shows below
    setEdited(true)
    setOutcome(null)
    if (prior.trim()) toast.undo('Replaced your message.', () => { setText(prior); setEdited(true) })
  }

  const offered = useMemo(() => {
    const base = templates ?? DEFAULT_SET
    return defaultTemplate && !base.includes(defaultTemplate) ? [defaultTemplate, ...base] : base
  }, [templates, defaultTemplate])

  // Load the owner's template overrides + business name once per open, so the
  // editable preview is exactly what would be sent (same engine, same overrides).
  useEffect(() => {
    if (!open) return
    let alive = true
    ;(async () => {
      const { data: { session } } = await supabase.auth.getSession()
      const uid = session?.user?.id
      if (!uid) return
      const { data } = await supabase.from('business_settings')
        .select('company_name, phone, review_url, message_templates').eq('user_id', uid).maybeSingle()
      const d = data as { company_name: string | null; phone: string | null; review_url: string | null; message_templates: Partial<Record<MsgType, string>> | null } | null
      if (!alive) return
      if (d?.company_name) setCompany(d.company_name)
      setBizPhone(d?.phone || '')
      setReviewUrl(d?.review_url || '')
      setCustom(d?.message_templates || {})
    })()
    return () => { alive = false }
  }, [open, supabase])

  const sampleName = chosen[0]?.name || all[0]?.name || 'there'

  // The email subject line the customer will see (email channel only shows it).
  const emailSubject = useMemo(
    () => renderMessage(active, custom, { firstName: sampleName, businessName: company }).subject,
    [active, custom, sampleName, company],
  )

  // Any change to the message, channels, or recipients disarms a pending bulk confirm.
  useEffect(() => { setArmed(false) }, [text, ch.sms, ch.email, selected])

  function compose(type: MsgType, opts?: { eta?: string }): string {
    // Only the server knows each customer's portal token — the composer shows a
    // friendly [Customer Portal Link] placeholder; send() converts it back to the
    // {{portal_link}} token so the route injects the real URL.
    return toDisplayBody(renderMessage(type, custom, {
      firstName: sampleName,
      businessName: company,
      eta: opts?.eta ?? eta,
      reviewLink: reviewUrl || undefined,
      portalLink: '{{portal_link}}',
      dateLabel: vars?.dateLabel,
      timeWindow: vars?.timeWindow,
      address: vars?.address,
      amount: vars?.amount,
      directPhone: bizPhone || undefined,
    }).sms)
  }

  // (Re)compose whenever the dialog opens or the template/overrides change —
  // owner edits persist until they pick a different template.
  useEffect(() => {
    if (!open || custom === null) return
    setText(compose(active))
    setEdited(false)
    setOutcome(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, active, custom, company, bizPhone])

  const needsEta = active === 'on_my_way' || active === 'running_late'

  async function send() {
    const channels = (['sms', 'email'] as const).filter(c => ch[c])
    if (!channels.length) { setOutcome({ ok: false, text: 'Pick at least one channel.' }); return }
    if (!chosen.length) { setOutcome({ ok: false, text: 'Select at least one recipient.' }); return }
    if (!text.trim()) { setOutcome({ ok: false, text: 'Write a message first.' }); return }
    setBusy(true); setOutcome(null); setProgress(0)
    // Untouched template → let the server render per customer (each gets their
    // own name + REAL portal link). Edited text → send as written; any remaining
    // {{tokens}} (e.g. {{portal_link}}) still resolve server-side.
    const sendBodyOverride = edited
    let sent = 0, skipped = 0
    let single: SendOutcome | null = null
    for (let i = 0; i < chosen.length; i++) {
      try {
        const res = await fetch('/api/comms/send', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            customerId: chosen[i].customerId, template: active, jobId: jobId ?? undefined, channels,
            ...(sendBodyOverride ? { bodyOverride: fromDisplayBody(text) } : {}),
            vars: { eta, dateLabel: vars?.dateLabel, timeWindow: vars?.timeWindow, address: vars?.address, amount: vars?.amount },
          }),
        })
        const out = summarizeSendOutcome(await res.json())
        if (!bulk) single = out
        if (out.ok) sent++; else skipped++
      } catch (e) {
        skipped++
        if (!bulk) single = { ok: false, text: e instanceof Error ? e.message : 'Could not send the message.' }
      }
      setProgress(i + 1)
    }
    setBusy(false)
    const out: SendOutcome = bulk
      // Never hardcode "no opt-in" — `skipped` also counts provider errors and
      // messaging-disabled. Blaming consent during a Twilio outage tells the owner
      // 40 customers withheld permission they actually gave. (skipReasons.ts exists
      // for exactly this; the bulk path used to bypass it.)
      ? { ok: sent > 0, text: `Sent to ${sent} customer${sent !== 1 ? 's' : ''}${skipped ? ` · ${skipped} couldn’t be sent — see each customer’s timeline for the reason` : ''}.` }
      : (single ?? { ok: sent > 0, text: sent ? 'Sent.' : 'Not sent.' })
    setOutcome(out)
    if (sent > 0) onSent?.()
  }

  return (
    <Modal open={open} onClose={() => !busy && onClose()} icon={MessageSquare} size="lg"
      onSubmit={() => { if (busy || outcome?.ok || !chosen.length || !text.trim()) return; if (bulk && !armed) setArmed(true); else send() }}
      title={title ?? (bulk ? `Message ${all.length} customers` : `Message ${(all[0]?.name || 'customer').split(' ')[0]}`)}>
      <div className="space-y-4">
        {/* Recipients — only when there's a real choice to make */}
        {bulk && (
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <p className="text-[10px] uppercase tracking-wide text-ink-faint">Recipients · <span className="text-ink-muted font-semibold">{chosen.length} of {all.length}</span></p>
              <div className="flex items-center gap-2 text-[11px]">
                <button type="button" onClick={() => setSelected(new Set(all.map(r => r.customerId)))} className="text-accent-text hover:underline font-medium">Select all</button>
                <span className="text-ink-faint">·</span>
                <button type="button" onClick={() => setSelected(new Set())} className="text-ink-muted hover:text-ink">Clear</button>
              </div>
            </div>
            <div className="max-h-44 overflow-y-auto rounded-xl border border-border divide-y divide-border">
              {all.map(r => (
                <label key={r.customerId} className="flex items-center gap-2.5 px-3 py-2 cursor-pointer hover:bg-surface/40">
                  <input type="checkbox" checked={selected.has(r.customerId)} onChange={() => toggle(r.customerId)} className="w-4 h-4 rounded border-border-strong accent-accent shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm text-ink truncate">{r.name}</span>
                    {(r.phone || r.service) && <span className="block text-[11px] text-ink-faint truncate">{[r.phone, r.service].filter(Boolean).join(' · ')}</span>}
                  </span>
                </label>
              ))}
            </div>
          </div>
        )}

        {/* Template picker */}
        <div className="flex flex-wrap gap-2">
          {offered.map(t => (
            <FilterPill key={t} active={active === t} onClick={() => setActive(t)}>{MSG_LABELS[t]}</FilterPill>
          ))}
        </div>

        {needsEta && (
          <label className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-ink-faint">
            ETA (min)
            <input type="number" min="1" step="5" value={eta}
              onChange={e => { setEta(e.target.value); if (!edited) setText(compose(active, { eta: e.target.value })) }}
              className="w-16 bg-bg-tertiary border border-border-strong rounded-lg px-2 py-1 text-sm text-ink outline-none focus:border-accent" />
          </label>
        )}

        {/* Editable message — starts from the owner's template, edit freely. */}
        <div>
          <div className="flex items-end justify-between gap-2 mb-1">
            {bulk
              ? <p className="text-[10px] uppercase tracking-wide text-ink-faint">Preview · as {sampleName.split(' ')[0]} will see it</p>
              : <span />}
            {ai.enabled === true && (
              <div className="flex items-center gap-1.5 shrink-0">
                <AssistButton label={ai.running ? 'Writing…' : 'Write with AI'} onClick={() => aiWrite('draft')} busy={ai.running} disabled={busy} />
                {text.trim() !== '' && !ai.running && (
                  <AssistButton label="Polish" onClick={() => aiWrite('rewrite')} disabled={busy} title="Rewrite the current draft — keeps every fact, improves the wording" />
                )}
              </div>
            )}
          </div>
          <textarea value={text} onChange={e => { setText(e.target.value); setEdited(true); setOutcome(null) }} rows={6} aria-label="Message"
            placeholder="Write your message…"
            className="w-full bg-bg-tertiary border border-border-strong rounded-xl px-3.5 py-3 text-base sm:text-sm text-ink outline-none focus:border-accent resize-none" />
          {ai.error && <p className="text-[11px] text-amber-400 mt-1" role="alert">{ai.error}</p>}
          {ch.sms && <SmsCost text={text} recipients={chosen.length || 1} className="mt-1" />}
          {ch.email && custom !== null && (
            <p className="text-[11px] text-ink-muted mt-1 flex items-center gap-1.5">
              <Mail className="w-3 h-3 text-ink-faint shrink-0" /> Email subject: <span className="text-ink font-medium truncate">{emailSubject}</span>
            </p>
          )}
          {bulk && (
            <p className="text-[10px] text-ink-faint mt-1">
              {edited
                ? `Edited — this exact text goes to all ${chosen.length} (names aren't swapped).`
                : 'Each customer receives their own personalized version.'}
            </p>
          )}
          {text.includes(PORTAL_LINK_DISPLAY) && (
            <p className="text-[10px] text-ink-faint mt-1">
              “{PORTAL_LINK_DISPLAY}” becomes {bulk ? 'each customer’s' : 'this customer’s'} private, secure link when sent.
            </p>
          )}
        </div>

        {/* Channels + send. After a successful send the primary action becomes
            Done (closes) — no accidental double-send, no dead end. */}
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] uppercase tracking-wide text-ink-faint">Send via</span>
            <FilterPill active={ch.sms} onClick={() => setCh(c => ({ ...c, sms: !c.sms }))}>
              <MessageSquare className="w-3 h-3" /> SMS
            </FilterPill>
            <FilterPill active={ch.email} onClick={() => setCh(c => ({ ...c, email: !c.email }))}>
              <Mail className="w-3 h-3" /> Email
            </FilterPill>
            {outcome?.ok ? (
              <Button onClick={() => onClose(1)} className="ml-auto"><Check className="w-4 h-4" /> Done</Button>
            ) : (
              <Button onClick={bulk && !armed ? () => setArmed(true) : send} loading={busy}
                disabled={!chosen.length || !text.trim() || (!ch.sms && !ch.email)}
                title={!chosen.length ? 'Select at least one recipient to send.' : !text.trim() ? 'Write a message to send.' : (!ch.sms && !ch.email) ? 'Pick at least one channel (SMS or email).' : undefined} className="ml-auto">
                <Send className="w-4 h-4" /> {busy && bulk ? `Sending ${progress}/${chosen.length}…` : bulk ? (armed ? `Confirm — send to ${chosen.length}` : `Send to ${chosen.length}`) : 'Send'}
              </Button>
            )}
          </div>
          {bulk && armed && !busy && !outcome?.ok
            ? <p className="text-[11px] text-amber-400 mt-1.5">You’re about to message {chosen.length} customer{chosen.length !== 1 ? 's' : ''} — click “Confirm” to send.</p>
            : <p className="text-[11px] text-ink-faint mt-1.5">{bulk ? 'Customers without consent or contact info are skipped automatically.' : 'We only send on channels this customer has opted into.'}</p>}
        </div>

        {/* Bulk send progress, announced without stealing focus. */}
        {busy && bulk && <span className="sr-only" role="status" aria-live="polite">Sending {progress} of {chosen.length}.</span>}

        {outcome && (
          <div role={outcome.ok ? 'status' : 'alert'} aria-live={outcome.ok ? 'polite' : 'assertive'}
            className={cn('flex items-start gap-1.5 text-xs rounded-lg px-3 py-2 border',
            outcome.ok ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10' : 'text-amber-400 border-amber-500/30 bg-amber-500/10')}>
            {outcome.ok ? <Check className="w-3.5 h-3.5 shrink-0 mt-px" aria-hidden="true" /> : <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" aria-hidden="true" />}
            <span>{outcome.text}</span>
          </div>
        )}
      </div>
    </Modal>
  )
}
