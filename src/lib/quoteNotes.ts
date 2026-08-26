// ── THE narrow quote-notes writer ────────────────────────────────────────────
// One update path for editing a quote's two note fields WITHOUT the full
// builder save. The builder keeps its own form payload (notes ride the whole
// quotes.update there); this writer exists for every OTHER door — the quotes
// list's "Edit notes", and any future surface that wants to annotate a quote
// without walking through pricing.
//
// Scope is the point: this touches `notes` and `internal_notes` and NOTHING
// else. No money column, no status, no measurement — so it can never trip the
// ADR-002 pricing-provenance rules or reprice anything, and editing a note on
// an accepted quote cannot rewrite what was accepted.
//
// The audience split is lib/noteScope's law: `notes` is the CUSTOMER field
// (PDF + portal render it), `internal_notes` never leaves the business. This
// writer preserves whichever field the caller does not pass.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Quote } from '@/types'

const QUOTE_NOTE_MAX = 2000

/** Whitespace is not a note: '' and '   ' both land as NULL, or the PDF prints
 *  an empty Notes box and the list claims a note that says nothing. */
export function normalizeQuoteNote(v: string | null | undefined): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  if (!t) return null
  return t.length > QUOTE_NOTE_MAX ? t.slice(0, QUOTE_NOTE_MAX).trimEnd() : t
}

export interface QuoteNotesInput {
  /** CUSTOMER-facing (PDF + portal). Omit to leave untouched. */
  notes?: string | null
  /** INTERNAL — never rendered outside the business. Omit to leave untouched. */
  internalNotes?: string | null
}

export interface QuoteNotesSaveResult {
  ok: boolean
  error?: string
  /** true when the input matched the row and no write was needed. */
  unchanged?: boolean
}

export async function saveQuoteNotes(
  supabase: SupabaseClient,
  quote: Pick<Quote, 'id'> & Partial<Pick<Quote, 'notes' | 'internal_notes'>>,
  input: QuoteNotesInput,
): Promise<QuoteNotesSaveResult> {
  const patch: Record<string, string | null> = {}
  if ('notes' in input) {
    const next = normalizeQuoteNote(input.notes)
    if (next !== (quote.notes ?? null)) patch.notes = next
  }
  if ('internalNotes' in input) {
    const next = normalizeQuoteNote(input.internalNotes)
    if (next !== (quote.internal_notes ?? null)) patch.internal_notes = next
  }
  // A save that changes nothing must not be sent — it would bump updated_at
  // for a write that says nothing (the completion-record rule).
  if (Object.keys(patch).length === 0) return { ok: true, unchanged: true }

  // `.select('id')`: a PostgREST update matching ZERO rows returns success with
  // no error, so an RLS-dropped write would report "Saved" for nothing — the
  // false-Saved shape the settings seam was bitten by.
  const { data, error } = await supabase
    .from('quotes').update(patch).eq('id', quote.id).select('id')
  if (error) return { ok: false, error: error.message }
  if (!data || data.length === 0) {
    return { ok: false, error: 'That quote could not be found — refresh and try again.' }
  }
  return { ok: true }
}
