'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Card, CardHeader, CardBody } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Collapsible } from '@/components/ui/Collapsible'
import { Input } from '@/components/ui/Input'
import { MSG_LABELS, MsgType, DEFAULT_TEMPLATES, MSG_VARIABLES, renderMessage } from '@/lib/comms/templates'
import { SmsCost } from '@/components/comms/SmsCost'
import { toast } from '@/lib/toast'
import { MessageSquare, Check, RotateCcw } from 'lucide-react'
import { Skeleton } from '@/components/ui/Skeleton'

const TYPES: MsgType[] = [
  'booking_received', 'introduction',
  'confirm', 'reminder', 'eta', 'on_my_way', 'running_late', 'arrived', 'early_arrival',
  'rescheduled', 'rain_delay', 'job_complete', 'thanks', 'review_request', 'quote', 'invoice',
  'estimate_reminder', 'payment_reminder', 'estimate_followup',
]

// One plain-English line per template: when it fires / what it's for — so the owner
// isn't guessing what "Finished early" or "Estimate follow-up" actually sends.
const TEMPLATE_DESC: Partial<Record<MsgType, string>> = {
  booking_received: 'Sent automatically the moment someone books online — their confirmation number, in writing.',
  introduction: 'A first hello when you add a new customer.',
  confirm: 'Confirms an upcoming visit.',
  reminder: 'Reminds the customer the day before their visit.',
  eta: 'Shares your arrival window on the day of service.',
  on_my_way: 'Tells the customer you’re on your way.',
  running_late: 'Lets them know you’re running behind.',
  arrived: 'Notifies them you’ve arrived to start.',
  early_arrival: 'Offers an earlier arrival when your schedule opens up.',
  rescheduled: 'Confirms a new date after rescheduling.',
  rain_delay: 'Explains a weather delay and the new date.',
  job_complete: 'Thanks them after a completed visit.',
  thanks: 'A general thank-you note.',
  review_request: 'Asks a happy customer for a review (sent a day after service).',
  quote: 'Sends a quote with the secure portal link.',
  invoice: 'Sends an invoice with the secure pay link.',
  estimate_reminder: 'Reminds them of an upcoming estimate appointment.',
  payment_reminder: 'A gentle nudge about an outstanding invoice.',
  estimate_followup: 'Follows up on a quote you already sent.',
}

export function MessageTemplateEditor() {
  const supabase = useMemo(() => createClient(), [])
  const [templates, setTemplates] = useState<Partial<Record<MsgType, string>>>({})
  const [reviewUrl, setReviewUrl] = useState('')
  const [company, setCompany] = useState('')
  const [bizPhone, setBizPhone] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  async function load() {
    const { data: { session } } = await supabase.auth.getSession()
    const user = session?.user
    if (!user) { setLoading(false); return }
    const { data } = await supabase.from('business_settings').select('message_templates, review_url, company_name, phone').eq('user_id', user.id).maybeSingle()
    const d = data as { message_templates: Partial<Record<MsgType, string>> | null; review_url: string | null; company_name: string | null; phone: string | null } | null
    setTemplates(d?.message_templates || {})
    setReviewUrl(d?.review_url || '')
    setCompany(d?.company_name || '')
    setBizPhone(d?.phone || '')
    setLoading(false)
  }
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // What the customer actually receives — the SAME render engine the sends use, with
  // friendly sample data. Turns raw {{tokens}} + **bold** into the real message.
  function previewOf(t: MsgType): string {
    return renderMessage(t, templates, {
      firstName: 'Sarah', businessName: company || 'Your business', eta: '15',
      reviewLink: reviewUrl || 'https://g.page/your-business/review',
      portalLink: 'https://portal.yourbusiness.com/…',
      dateLabel: 'Mon, Jul 20', timeWindow: '9–11 AM', oldDateLabel: 'Fri, Jul 18',
      address: '123 Main St', amount: '$150.00', directPhone: bizPhone || undefined,
    }).sms
  }

  async function save() {
    setSaving(true)
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { setSaving(false); return }
    const clean: Record<string, string> = {}
    for (const t of TYPES) { const v = templates[t]?.trim(); if (v) clean[t] = v } // drop empties → use defaults
    // upsert (not update) so a missing settings row can't silently no-op; check the error
    // so we never flash "Saved" on a write that didn't land.
    const { error } = await supabase.from('business_settings')
      .upsert({ user_id: user.id, message_templates: clean, review_url: reviewUrl.trim() || null }, { onConflict: 'user_id' })
    setSaving(false)
    if (error) { toast.error('Couldn’t save your templates — please try again.'); return }
    toast.success('Message templates saved.')
    setSaved(true); setTimeout(() => setSaved(false), 2000)
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-ink flex items-center gap-2"><MessageSquare className="w-4 h-4 text-accent-text" /> Message templates</h2>
            <p className="text-xs text-ink-faint mt-0.5">Customise your appointment, quote and invoice messages. Leave a box blank to use our default wording.</p>
          </div>
          <Button size="sm" onClick={save} loading={saving}>{saved ? <><Check className="w-3.5 h-3.5" /> Saved</> : 'Save templates'}</Button>
        </div>
      </CardHeader>
      <CardBody className="space-y-4">
        {loading ? (
          // Shimmer in the shape of the loaded editor (input + variables + rows) —
          // the shared skeleton language, not a lone spinner.
          <div className="space-y-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-14 w-full" />
            {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-9 w-full" />)}
          </div>
        ) : (
          <>
            <Input label="Google review link" placeholder="https://g.page/r/…/review" value={reviewUrl} onChange={e => setReviewUrl(e.target.value)} hint="Used by the {{review_link}} variable in the review request." />

            <div className="rounded-lg border border-border bg-bg-tertiary px-3 py-2.5">
              <p className="text-[10px] uppercase tracking-wide text-ink-faint mb-2">Variables you can use — they fill in automatically for each customer</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
                {MSG_VARIABLES.map(v => (
                  <span key={v.key} className="text-[11px] text-ink-muted flex items-baseline gap-1.5 min-w-0">
                    <code className="font-mono text-ink border border-border rounded px-1 py-0.5 shrink-0">{`{{${v.key}}}`}</code>
                    <span className="text-ink-faint truncate">{v.hint}</span>
                  </span>
                ))}
              </div>
              <p className="text-[10px] text-ink-faint mt-2">Tip: wrap words in <span className="font-mono text-ink-muted">**double asterisks**</span> to <strong>bold</strong> them in emails (ignored in texts).</p>
            </div>

            {/* One collapsed row per template — 17 always-open 6-row textareas were a
                wall that buried everything below. The closed row still says whether
                it's customised and previews the first line. */}
            <div className="space-y-2">
              {TYPES.map(t => {
                const val = templates[t] ?? ''
                const usingDefault = !val.trim()
                return (
                  <Collapsible key={t} title={MSG_LABELS[t]}
                    badge={!usingDefault ? <span className="text-[10px] font-semibold uppercase tracking-wide text-accent-text border border-accent/30 bg-accent/10 rounded px-1.5 py-0.5">Customised</span> : undefined}
                    summary={usingDefault ? 'Using default' : (val.split('\n').find(l => l.trim()) || '').slice(0, 60)}>
                    <div>
                      <div className="flex items-start justify-between gap-3 mb-1.5">
                        {TEMPLATE_DESC[t] && <p className="text-xs text-ink-muted">{TEMPLATE_DESC[t]}</p>}
                        {!usingDefault && (
                          <button type="button" title="Restores our default wording — save to apply."
                            onClick={() => {
                              const prevVal = templates[t]
                              setTemplates(prev => ({ ...prev, [t]: '' }))
                              toast.undo('Reset to the default wording.', () => setTemplates(p => ({ ...p, [t]: prevVal || '' })))
                            }}
                            className="shrink-0 text-[11px] text-ink-faint hover:text-ink flex items-center gap-1 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"><RotateCcw className="w-3 h-3" /> Reset to default</button>
                        )}
                      </div>
                      <textarea rows={6} value={val} placeholder={DEFAULT_TEMPLATES[t]}
                        onChange={e => setTemplates(prev => ({ ...prev, [t]: e.target.value }))}
                        className="w-full bg-bg-tertiary border border-border-strong rounded-lg px-3 py-2 text-sm text-ink outline-none transition-all focus:border-accent focus:ring-2 focus:ring-accent/20 placeholder:text-ink-faint resize-y leading-relaxed" />
                      <SmsCost text={val || DEFAULT_TEMPLATES[t]} className="mt-1.5" />
                      <div className="mt-2 rounded-lg border border-border bg-bg-secondary px-3 py-2.5">
                        <p className="text-[10px] uppercase tracking-wide text-ink-faint mb-1">Preview · what Sarah receives{usingDefault ? ' (our default)' : ''}</p>
                        <p className="text-sm text-ink whitespace-pre-wrap leading-relaxed">{previewOf(t)}</p>
                      </div>
                    </div>
                  </Collapsible>
                )
              })}
            </div>

            {/* Save repeated at the bottom — the header button is off-screen by
                the time you're editing the lower rows of 17 templates. */}
            <div className="flex justify-end pt-1">
              <Button size="sm" onClick={save} loading={saving}>{saved ? <><Check className="w-3.5 h-3.5" /> Saved</> : 'Save templates'}</Button>
            </div>
          </>
        )}
      </CardBody>
    </Card>
  )
}
