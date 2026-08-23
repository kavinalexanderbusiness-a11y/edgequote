'use client'

import { CheckCircle2 } from 'lucide-react'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { SmsCost } from '@/components/comms/SmsCost'

// ── The completion message, shown BEFORE it is sent ──────────────────────────
// Completing a visit is two things: the state change (status + invoice draft)
// and, when the owner's automation is on, a customer text saying the work is
// done. The second half used to be invisible — the Complete button fired it
// with no preview, no wording, no way out short of turning the automation off.
// This dialog is the separation: it appears ONLY when a message would actually
// go out (the plan in lib/dayActions decides that), shows the exact text, lets
// the owner edit it, and makes "complete without sending" a first-class choice
// rather than a settings excavation.
//
// Pure presentation: the parent owns the completion itself, the plan, and the
// text. Nothing here reads or writes anything.
interface Props {
  open: boolean
  customerName: string
  /** Channels the message will attempt, from completionMessagePlan. */
  channels: ('sms' | 'email')[]
  /** False when consent facts weren't on the row — the copy hedges to "attempt". */
  contactKnown: boolean
  text: string
  onText: (t: string) => void
  busy: boolean
  /** true = complete & send the shown text · false = complete, send nothing. */
  onConfirm: (send: boolean) => void
  onCancel: () => void
}

const CHANNEL_WORDS: Record<'sms' | 'email', string> = { sms: 'text', email: 'email' }

export function CompleteConfirm({ open, customerName, channels, contactKnown, text, onText, busy, onConfirm, onCancel }: Props) {
  const firstName = customerName.split(' ')[0] || 'the customer'
  const how = channels.map(c => CHANNEL_WORDS[c]).join(' & ')
  return (
    <Modal open={open} onClose={() => { if (!busy) onCancel() }} title="Complete visit" icon={CheckCircle2} size="md"
      onSubmit={() => { if (!busy) onConfirm(true) }}
      footer={
        <>
          <Button variant="secondary" disabled={busy} onClick={() => onConfirm(false)}>Complete without sending</Button>
          <Button loading={busy} disabled={busy} onClick={() => onConfirm(true)}>Complete &amp; send</Button>
        </>
      }>
      <div className="space-y-2.5">
        <p className="text-sm text-ink">
          {contactKnown
            ? <>This will also {how ? <span className="font-semibold">{how}</span> : 'message'} {firstName} that the work is done:</>
            : <>This will also message {firstName} that the work is done (if they&apos;ve opted in):</>}
        </p>
        <textarea value={text} onChange={e => onText(e.target.value)} rows={5} aria-label="Completion message"
          className="w-full bg-bg-tertiary border border-border-strong rounded-lg px-3 py-2 text-sm text-ink outline-none transition-all focus:border-accent focus:ring-2 focus:ring-accent/20 resize-none" />
        {channels.includes('sms')
          ? <SmsCost text={text} />
          : <p className="text-[10px] text-ink-faint">{text.length} characters · edit freely before sending</p>}
        <p className="text-[10px] text-ink-faint">
          Sent because “Job-complete message” is on in Settings → Automations. The invoice draft happens either way.
        </p>
      </div>
    </Modal>
  )
}
