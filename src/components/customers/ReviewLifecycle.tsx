'use client'
import { toast } from '@/lib/toast'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { Card, CardHeader, CardBody } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Customer } from '@/types'
import { reviewStatus, REVIEW_STATUS_META, REVIEW_SOURCES } from '@/lib/crm/reviews'
import { newClientMessageId } from '@/lib/comms/idempotency'
import { AssistButton } from '@/components/ai/AssistButton'
import { useAiAssist } from '@/hooks/useAiAssist'
import { formatDate } from '@/lib/utils'
import { Star, Send, ThumbsDown, RotateCcw, Loader2, Check, Copy } from 'lucide-react'

// Per-customer review lifecycle on the profile. Reuses the existing review flag
// (customers.reviewed_at) — these controls just layer the
// Not-requested → Requested → Reviewed / Declined states + source/rating on top,
// and "Send review request" goes through the SAME /api/comms/send path the rest
// of the app uses (so it threads + stamps Requested via the notification_log
// trigger). Never asks again once reviewed or declined.
export function ReviewLifecycle({ customer, onChange }: {
  customer: Customer
  onChange: (patch: Partial<Customer>) => void
}) {
  const supabase = useMemo(() => createClient(), [])
  const status = reviewStatus(customer)
  const meta = REVIEW_STATUS_META[status]

  const [sending, setSending] = useState(false)
  const [sendNote, setSendNote] = useState<string | null>(null)
  // The review request's whole point is the link. Without one configured the message
  // goes out with a blank line where the link should be — so we check FIRST and never
  // spend this customer's one ask on a dead request.
  const [reviewUrl, setReviewUrl] = useState<string | null>(null)
  const [urlChecked, setUrlChecked] = useState(false)
  useEffect(() => {
    let alive = true
    ;(async () => {
      const { data: { session } } = await supabase.auth.getSession()
      const uid = session?.user?.id
      if (!uid) { if (alive) setUrlChecked(true); return }
      const { data } = await supabase.from('business_settings').select('review_url').eq('user_id', uid).maybeSingle()
      if (alive) { setReviewUrl(((data as { review_url?: string | null } | null)?.review_url || '').trim() || null); setUrlChecked(true) }
    })()
    return () => { alive = false }
  }, [supabase])
  const missingLink = urlChecked && !reviewUrl
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const today = new Date().toISOString().slice(0, 10)
  const [date, setDate] = useState(customer.reviewed_at?.slice(0, 10) || today)
  const [source, setSource] = useState<string>(customer.review_source || 'Google')
  const [rating, setRating] = useState<number>(customer.review_rating || 0)

  async function sendRequest() {
    // Guard: an ask with nowhere to go is worse than no ask — it burns the request.
    if (!reviewUrl) { setSendNote('Add your review link in Settings first — otherwise the request goes out with no link to follow.'); return }
    setSending(true); setSendNote(null)
    // One id per click → a double-tap can't fire two review requests.
    const clientMessageId = newClientMessageId()
    try {
      const res = await fetch('/api/comms/send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customerId: customer.id, template: 'review_request', channels: ['sms', 'email'], clientMessageId }),
      })
      const data = await res.json().catch(() => ({}))
      const sent = data?.results && Object.values(data.results).some((r) => (r as { sent?: boolean })?.sent)
      if (sent) {
        // "Asked {date}" always shows the FIRST ask — say so explicitly on a re-send
        // so the owner can tell a fresh nudge from a six-week-old request.
        setSendNote(status === 'requested' ? 'Reminder sent today.' : 'Review request sent.')
        onChange({ review_requested_at: customer.review_requested_at || new Date().toISOString() })
      } else if (data?.enabled && !data.enabled.sms && !data.enabled.email) {
        setSendNote('Messaging isn’t connected yet — set up Twilio/Resend in Settings to send.')
      } else {
        setSendNote('Not sent — check this customer has SMS/email consent and contact info.')
      }
    } catch {
      setSendNote('Could not send right now. Please try again.')
    } finally { setSending(false) }
  }

  async function saveReviewed() {
    setSaving(true)
    const patch = {
      reviewed_at: new Date(date + 'T12:00:00').toISOString(),
      review_source: source || null,
      review_rating: rating || null,
      review_declined_at: null,
    }
    const { error } = await supabase.from('customers').update(patch).eq('id', customer.id)
    setSaving(false)
    if (error) { toast.error('Could not save: ' + error.message); return }
    onChange(patch); setEditing(false)
  }

  async function markDeclined() {
    const patch = { review_declined_at: new Date().toISOString() }
    const { error } = await supabase.from('customers').update(patch).eq('id', customer.id)
    if (error) { toast.error('Could not save: ' + error.message); return }
    onChange(patch)
  }

  async function reset() {
    const patch = { reviewed_at: null, review_requested_at: null, review_declined_at: null, review_source: null, review_rating: null }
    const { error } = await supabase.from('customers').update(patch).eq('id', customer.id)
    if (error) { toast.error('Could not reset: ' + error.message); return }
    onChange(patch); setEditing(false); setRating(0); setSource('Google'); setDate(today)
  }

  // AI reply drafter — writes the owner's PUBLIC response to this review; the
  // owner copies it to Google/Facebook themselves. Nothing is posted or stored.
  const ai = useAiAssist()
  const [reply, setReply] = useState('')
  const [replyOpen, setReplyOpen] = useState(false)
  async function draftReply() {
    setReplyOpen(true)
    setReply('')
    ai.clearError()
    await ai.run({
      task: 'review_response',
      customerId: customer.id,
      rating: customer.review_rating || 5,
      source: customer.review_source || 'Google',
    }, { onDelta: d => setReply(prev => prev + d) })
  }
  async function copyReply() {
    try { await navigator.clipboard.writeText(reply); toast.success('Reply copied — paste it on ' + (customer.review_source || 'Google') + '.') }
    catch { toast.error('Could not copy — select the text and copy manually.') }
  }

  return (
    <Card>
      <CardHeader className="flex items-center gap-2">
        <Star className="w-4 h-4 text-accent-text" />
        <h2 className="text-sm font-semibold text-ink">Review</h2>
        <span className={`ml-auto text-[10px] uppercase tracking-wide font-semibold rounded px-1.5 py-0.5 border ${meta.tone}`}>{meta.label}</span>
      </CardHeader>
      <CardBody className="space-y-3">
        {/* Reviewed — show the captured details */}
        {status === 'reviewed' && !editing && (
          <>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5" role="img" aria-label={`${customer.review_rating || 0} out of 5 stars`}>
                  {[1, 2, 3, 4, 5].map(n => (
                    <Star key={n} className={`w-4 h-4 ${customer.review_rating && n <= customer.review_rating ? 'text-amber-400 fill-amber-400' : 'text-ink-faint'}`} />
                  ))}
                </div>
                <p className="text-xs text-ink-muted mt-1">
                  {customer.review_source || 'Review'}{customer.reviewed_at ? ` · ${formatDate(customer.reviewed_at)}` : ''}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {ai.enabled === true && !replyOpen && (
                  <AssistButton label="Draft a reply" onClick={draftReply} busy={ai.running}
                    title={`Write a public response to post on ${customer.review_source || 'Google'}`} />
                )}
                <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>Edit</Button>
              </div>
            </div>
            {replyOpen && (
              <div className="rounded-xl border border-accent/20 bg-accent/[0.04] p-3 space-y-2">
                <p className="text-[10px] uppercase tracking-wide text-ink-faint">Suggested public reply · edit before posting</p>
                <textarea value={reply} onChange={e => setReply(e.target.value)} rows={3} aria-label="Suggested review reply"
                  readOnly={ai.running}
                  className="w-full bg-bg-tertiary border border-border-strong rounded-xl px-3 py-2.5 text-sm text-ink outline-none transition-all focus:border-accent focus:ring-2 focus:ring-accent/20 resize-none" />
                {ai.error && <p className="text-xs text-amber-400" role="alert">{ai.error}</p>}
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="secondary" onClick={copyReply} disabled={ai.running || !reply.trim()}>
                    <Copy className="w-3.5 h-3.5" /> Copy reply
                  </Button>
                  <Button size="sm" variant="ghost" onClick={draftReply} loading={ai.running}>Try again</Button>
                  <Button size="sm" variant="ghost" onClick={() => setReplyOpen(false)} disabled={ai.running}>Close</Button>
                </div>
              </div>
            )}
          </>
        )}

        {/* Declined */}
        {status === 'declined' && (
          <div className="flex items-center justify-between gap-3">
            {/* "Marked declined" is the owner's own note — never claim the customer
                formally opted out, which is a much stronger (and unverified) claim. */}
            <p className="text-sm text-ink-muted">Marked declined{customer.review_declined_at ? ` · ${formatDate(customer.review_declined_at)}` : ''} — won&rsquo;t be asked again.</p>
            <Button size="sm" variant="ghost" onClick={reset}><RotateCcw className="w-3.5 h-3.5" /> Clear review status</Button>
          </div>
        )}

        {/* Not requested / requested — offer to ask + the manual outcome controls */}
        {(status === 'not_requested' || status === 'requested') && !editing && (
          <>
            <p className="text-sm text-ink-muted">
              {status === 'requested'
                ? `Asked${customer.review_requested_at ? ` ${formatDate(customer.review_requested_at)}` : ''}. Send a reminder or record the outcome.`
                : 'Ask this customer for a review, then record the outcome here.'}
            </p>
            {missingLink && (
              <p className="text-xs text-amber-400">
                Add your review link in <Link href="/dashboard/settings" className="underline font-medium">Settings → Messaging</Link> first — without it the request goes out with no link to follow.
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={sendRequest} loading={sending} disabled={missingLink}
                title={missingLink ? 'Add your review link in Settings first' : undefined}>
                <Send className="w-3.5 h-3.5" /> {status === 'requested' ? 'Send again' : 'Send review request'}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => { setEditing(true); setRating(5) }}>
                <Check className="w-3.5 h-3.5" /> Mark reviewed
              </Button>
              <Button size="sm" variant="ghost" onClick={markDeclined}><ThumbsDown className="w-3.5 h-3.5" /> Mark declined</Button>
            </div>
            <p role="status" aria-live="polite" className="min-h-0 text-xs text-ink-faint empty:hidden flex items-center gap-1.5">
              {sending && <Loader2 className="w-3 h-3 animate-spin" />}{sendNote}
            </p>
          </>
        )}

        {/* Record / edit a left review */}
        {editing && (
          <div className="space-y-3">
            <div className="flex items-center gap-1.5" role="radiogroup" aria-label="Star rating">
              {[1, 2, 3, 4, 5].map(n => (
                <button key={n} type="button" role="radio" aria-checked={n === rating} aria-label={`${n} star${n > 1 ? 's' : ''}`} onClick={() => setRating(n)}
                  className="rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                  <Star className={`w-6 h-6 ${n <= rating ? 'text-amber-400 fill-amber-400' : 'text-ink-faint hover:text-amber-400/60'}`} />
                </button>
              ))}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Select label="Source" value={source} onChange={e => setSource(e.target.value)} options={REVIEW_SOURCES.map(s => ({ value: s, label: s }))} />
              <Input label="Date" type="date" value={date} max={today} onChange={e => setDate(e.target.value)} />
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={saveReviewed} loading={saving}>Save review</Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
              {status === 'reviewed' && <Button size="sm" variant="danger" className="ml-auto" onClick={reset}>Clear review status</Button>}
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  )
}
