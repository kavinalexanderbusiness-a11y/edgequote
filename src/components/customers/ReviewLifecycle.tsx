'use client'

import { useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Card, CardHeader, CardBody } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Customer } from '@/types'
import { reviewStatus, REVIEW_STATUS_META, REVIEW_SOURCES } from '@/lib/crm/reviews'
import { formatDate } from '@/lib/utils'
import { Star, Send, ThumbsDown, RotateCcw, Loader2, Check } from 'lucide-react'

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
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const today = new Date().toISOString().slice(0, 10)
  const [date, setDate] = useState(customer.reviewed_at?.slice(0, 10) || today)
  const [source, setSource] = useState<string>(customer.review_source || 'Google')
  const [rating, setRating] = useState<number>(customer.review_rating || 0)

  async function sendRequest() {
    setSending(true); setSendNote(null)
    try {
      const res = await fetch('/api/comms/send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customerId: customer.id, template: 'review_request', channels: ['sms', 'email'] }),
      })
      const data = await res.json().catch(() => ({}))
      const sent = data?.results && Object.values(data.results).some((r) => (r as { sent?: boolean })?.sent)
      if (sent) {
        setSendNote('Review request sent.')
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
    if (error) { alert('Could not save: ' + error.message); return }
    onChange(patch); setEditing(false)
  }

  async function markDeclined() {
    const patch = { review_declined_at: new Date().toISOString() }
    const { error } = await supabase.from('customers').update(patch).eq('id', customer.id)
    if (error) { alert('Could not save: ' + error.message); return }
    onChange(patch)
  }

  async function reset() {
    const patch = { reviewed_at: null, review_requested_at: null, review_declined_at: null, review_source: null, review_rating: null }
    const { error } = await supabase.from('customers').update(patch).eq('id', customer.id)
    if (error) { alert('Could not reset: ' + error.message); return }
    onChange(patch); setEditing(false); setRating(0); setSource('Google'); setDate(today)
  }

  return (
    <Card>
      <CardHeader className="flex items-center gap-2">
        <Star className="w-4 h-4 text-accent" />
        <h2 className="text-sm font-semibold text-ink">Review</h2>
        <span className={`ml-auto text-[10px] uppercase tracking-wide font-semibold rounded px-1.5 py-0.5 border ${meta.tone}`}>{meta.label}</span>
      </CardHeader>
      <CardBody className="space-y-3">
        {/* Reviewed — show the captured details */}
        {status === 'reviewed' && !editing && (
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                {[1, 2, 3, 4, 5].map(n => (
                  <Star key={n} className={`w-4 h-4 ${customer.review_rating && n <= customer.review_rating ? 'text-amber-400 fill-amber-400' : 'text-ink-faint'}`} />
                ))}
              </div>
              <p className="text-xs text-ink-muted mt-1">
                {customer.review_source || 'Review'}{customer.reviewed_at ? ` · ${formatDate(customer.reviewed_at)}` : ''}
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>Edit</Button>
            </div>
          </div>
        )}

        {/* Declined */}
        {status === 'declined' && (
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-ink-muted">Opted out of review requests{customer.review_declined_at ? ` · ${formatDate(customer.review_declined_at)}` : ''}.</p>
            <Button size="sm" variant="ghost" onClick={reset}><RotateCcw className="w-3.5 h-3.5" /> Reset</Button>
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
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={sendRequest} loading={sending}>
                <Send className="w-3.5 h-3.5" /> {status === 'requested' ? 'Send again' : 'Send review request'}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => { setEditing(true); setRating(5) }}>
                <Check className="w-3.5 h-3.5" /> Mark reviewed
              </Button>
              <Button size="sm" variant="ghost" onClick={markDeclined}><ThumbsDown className="w-3.5 h-3.5" /> Declined</Button>
            </div>
            {sendNote && <p className="text-xs text-ink-faint flex items-center gap-1.5">{sending && <Loader2 className="w-3 h-3 animate-spin" />}{sendNote}</p>}
          </>
        )}

        {/* Record / edit a left review */}
        {editing && (
          <div className="space-y-3">
            <div className="flex items-center gap-1.5">
              {[1, 2, 3, 4, 5].map(n => (
                <button key={n} type="button" onClick={() => setRating(n)} aria-label={`${n} star${n > 1 ? 's' : ''}`}>
                  <Star className={`w-6 h-6 ${n <= rating ? 'text-amber-400 fill-amber-400' : 'text-ink-faint hover:text-amber-400/60'}`} />
                </button>
              ))}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-semibold text-ink-muted uppercase tracking-wide">Source</label>
                <select value={source} onChange={e => setSource(e.target.value)}
                  className="w-full bg-bg-tertiary border border-border-strong rounded-xl px-3.5 py-2.5 text-sm text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/20">
                  {REVIEW_SOURCES.map(s => <option key={s} value={s} className="bg-bg-secondary">{s}</option>)}
                </select>
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-semibold text-ink-muted uppercase tracking-wide">Date</label>
                <input type="date" value={date} max={today} onChange={e => setDate(e.target.value)}
                  className="w-full bg-bg-tertiary border border-border-strong rounded-xl px-3.5 py-2.5 text-sm text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/20" />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={saveReviewed} loading={saving}>Save review</Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
              {status === 'reviewed' && <Button size="sm" variant="ghost" className="ml-auto hover:text-red-400" onClick={reset}>Clear</Button>}
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  )
}
