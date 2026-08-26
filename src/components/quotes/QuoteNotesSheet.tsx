'use client'

// ── Quick notes editor — the light door into the ONE quote-note system ───────
// Opened from the quotes list so annotating a quote never requires mounting the
// full builder. Renders the same two scoped fields the builder has, labelled by
// lib/noteScope's AUDIENCE_COPY (who will read this is part of the field's
// meaning), and saves through lib/quoteNotes — the narrow writer that cannot
// touch money, status or measurement.

import { useState } from 'react'
import { StickyNote } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import type { Quote } from '@/types'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Textarea } from '@/components/ui/Textarea'
import { AUDIENCE_COPY } from '@/lib/noteScope'
import { saveQuoteNotes } from '@/lib/quoteNotes'
import { toast } from '@/lib/toast'

export function QuoteNotesSheet({ quote, onClose, onSaved }: {
  quote: Pick<Quote, 'id' | 'quote_number' | 'notes' | 'internal_notes'>
  onClose: () => void
  /** Hands the saved values back so the list's copy of the row stays current
   *  (the CSV export reads it) without a refetch. */
  onSaved?: (patch: { notes: string | null; internal_notes: string | null }) => void
}) {
  const supabase = createClient()
  const [customer, setCustomer] = useState(quote.notes ?? '')
  const [internal, setInternal] = useState(quote.internal_notes ?? '')
  const [saving, setSaving] = useState(false)

  const save = async () => {
    if (saving) return
    setSaving(true)
    const res = await saveQuoteNotes(supabase, quote, {
      notes: customer, internalNotes: internal,
    })
    setSaving(false)
    if (!res.ok) { toast.error(res.error || 'Could not save the notes — try again.'); return }
    if (!res.unchanged) toast.success('Notes saved')
    onSaved?.({
      notes: customer.trim() ? customer.trim() : null,
      internal_notes: internal.trim() ? internal.trim() : null,
    })
    onClose()
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Notes — ${quote.quote_number}`}
      icon={StickyNote}
      size="md"
      onSubmit={save}
      footer={
        <div className="flex items-center justify-end gap-2 w-full">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="button" onClick={save} loading={saving}>Save notes</Button>
        </div>
      }
    >
      <div className="space-y-4">
        <Textarea
          label={AUDIENCE_COPY.customer.label}
          hint={AUDIENCE_COPY.customer.help}
          rows={3}
          value={customer}
          onChange={e => setCustomer(e.target.value)}
        />
        <Textarea
          label={AUDIENCE_COPY.internal.label}
          hint={AUDIENCE_COPY.internal.help}
          rows={3}
          value={internal}
          onChange={e => setInternal(e.target.value)}
        />
      </div>
    </Modal>
  )
}
