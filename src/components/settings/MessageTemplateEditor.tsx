'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Card, CardHeader, CardBody } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Collapsible } from '@/components/ui/Collapsible'
import { Input } from '@/components/ui/Input'
import { MSG_LABELS, MsgType, DEFAULT_TEMPLATES, MSG_VARIABLES } from '@/lib/comms/templates'
import { SmsCost } from '@/components/comms/SmsCost'
import { MessageSquare, Check, RotateCcw } from 'lucide-react'
import { Skeleton } from '@/components/ui/Skeleton'

const TYPES: MsgType[] = [
  'introduction',
  'confirm', 'reminder', 'eta', 'on_my_way', 'running_late', 'arrived', 'early_arrival',
  'rescheduled', 'rain_delay', 'job_complete', 'thanks', 'review_request', 'quote', 'invoice',
  'estimate_reminder', 'payment_reminder', 'estimate_followup',
]

export function MessageTemplateEditor() {
  const supabase = useMemo(() => createClient(), [])
  const [templates, setTemplates] = useState<Partial<Record<MsgType, string>>>({})
  const [reviewUrl, setReviewUrl] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  async function load() {
    const { data: { session } } = await supabase.auth.getSession()
    const user = session?.user
    if (!user) { setLoading(false); return }
    const { data } = await supabase.from('business_settings').select('message_templates, review_url').eq('user_id', user.id).maybeSingle()
    const d = data as { message_templates: Partial<Record<MsgType, string>> | null; review_url: string | null } | null
    setTemplates(d?.message_templates || {})
    setReviewUrl(d?.review_url || '')
    setLoading(false)
  }
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

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
    if (error) return
    setSaved(true); setTimeout(() => setSaved(false), 2000)
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-ink flex items-center gap-2"><MessageSquare className="w-4 h-4 text-accent" /> Message templates</h2>
            <p className="text-xs text-ink-faint mt-0.5">Customise the wording of every SMS/email. Leave a box blank to use the default.</p>
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
            {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-9 w-full" />)}
          </div>
        ) : (
          <>
            <Input label="Google review link" placeholder="https://g.page/r/…/review" value={reviewUrl} onChange={e => setReviewUrl(e.target.value)} hint="Used by the {{review_link}} variable in the review request." />

            <div className="rounded-lg border border-border bg-bg-tertiary px-3 py-2">
              <p className="text-[10px] uppercase tracking-wide text-ink-faint mb-1.5">Variables you can use</p>
              <div className="flex flex-wrap gap-1.5">
                {MSG_VARIABLES.map(v => (
                  <span key={v.key} className="text-[11px] font-mono rounded border border-border px-1.5 py-0.5 text-ink-muted" title={v.hint}>{`{{${v.key}}}`}</span>
                ))}
              </div>
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
                    badge={!usingDefault ? <span className="text-[10px] font-semibold uppercase tracking-wide text-accent border border-accent/30 bg-accent/10 rounded px-1.5 py-0.5">Customised</span> : undefined}
                    summary={usingDefault ? 'Using default' : (val.split('\n').find(l => l.trim()) || '').slice(0, 60)}>
                    <div>
                      {!usingDefault && (
                        <div className="flex justify-end mb-1">
                          <button type="button" onClick={() => setTemplates(prev => ({ ...prev, [t]: '' }))} className="text-[11px] text-ink-faint hover:text-ink flex items-center gap-1 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"><RotateCcw className="w-3 h-3" /> Reset to default</button>
                        </div>
                      )}
                      <textarea rows={6} value={val} placeholder={DEFAULT_TEMPLATES[t]}
                        onChange={e => setTemplates(prev => ({ ...prev, [t]: e.target.value }))}
                        className="w-full bg-bg-tertiary border border-border-strong rounded-lg px-3 py-2 text-sm text-ink outline-none transition-all focus:border-accent focus:ring-2 focus:ring-accent/20 placeholder:text-ink-faint resize-y leading-relaxed" />
                      <SmsCost text={val || DEFAULT_TEMPLATES[t]} className="mt-1.5" />
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
