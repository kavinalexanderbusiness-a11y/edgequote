'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'
import { ensurePropertyForCustomer } from '@/lib/customers'
import { AddressAutocomplete, type ParsedAddress } from '@/components/ui/AddressAutocomplete'
import { Button } from '@/components/ui/Button'
import type { Property } from '@/types'
import { Home, Plus, ChevronDown, X, Check, Star } from 'lucide-react'

// ── THE property picker ──────────────────────────────────────────────────────
// "Which of this customer's addresses is this for?" — asked the same way
// everywhere. This existed twice as a plain <Select> built inline (JobForm and
// NewInvoiceDialog) and had already drifted: one labelled the primary
// " (primary)", the other " · primary". A third copy was about to be written for
// the quote builder, which is what made this worth extracting.
//
// A <select> is the wrong control past a handful of options, which is exactly the
// case this has to serve: a homeowner has two addresses, a landlord has forty, an
// HOA has hundreds. So it's the same combobox as CustomerPicker — type to filter,
// keyboard-navigable, DOM capped — and the two controls sit next to each other in
// the same forms, which is why they must feel identical rather than merely similar.
//
// Creating inline is the point, not a convenience: the customer standing in front
// of you has a second house, and leaving the quote to go add it loses the quote.
// It calls ensurePropertyForCustomer — THE find-or-create seam the quote-save path
// already uses — so a property typed here and a property typed into a quote can
// never become two rows for one address.

interface PropertySelectProps {
  properties: Property[]
  /** Selected property id, or '' for none. */
  value: string
  onChange: (value: string) => void
  /** The owner of these properties. Required to create one inline; without it the
   *  "Add a new property" row is hidden rather than offered and then failing. */
  customerId?: string | null
  /** Fires with the created property so the parent can add it to its own list and
   *  select it. Without it, inline creation is not offered. */
  onCreated?: (property: Property) => void
  label?: string
  /** Label for the empty option. Omit `allowNone` to require a choice. */
  noneLabel?: string
  allowNone?: boolean
  placeholder?: string
  error?: string
  hint?: string
  autoFocus?: boolean
}

export function PropertySelect({
  properties, value, onChange, customerId, onCreated,
  label, noneLabel = 'No specific property', allowNone = false,
  placeholder = 'Search addresses…', error, hint, autoFocus,
}: PropertySelectProps) {
  const supabase = useMemo(() => createClient(), [])
  const selected = value ? properties.find(p => p.id === value) ?? null : null
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [hi, setHi] = useState(0)
  const [adding, setAdding] = useState(false)
  const [newAddr, setNewAddr] = useState('')
  const [parsed, setParsed] = useState<ParsedAddress | null>(null)
  const [saving, setSaving] = useState(false)
  const [addErr, setAddErr] = useState<string | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const inputId = label ? `prop-${label.toLowerCase().replace(/\s+/g, '-')}` : undefined

  const canAdd = !!customerId && !!onCreated

  // Keep the input text in sync with a selection made elsewhere (a parent that sets
  // the property from a deep link, or auto-selects the primary).
  useEffect(() => {
    if (open) return
    setQuery(selected ? selected.address : '')
  }, [value, open, properties]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    function onDoc(e: MouseEvent) { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false) }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey) }
  }, [])

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    // Address, city, postal and neighbourhood — the four things someone actually
    // types when they mean "the Elm Street one". (Properties have no nickname
    // field; if landlords ever need one, that's a column, not a guess here.)
    const list = !q ? properties : properties.filter(p =>
      p.address?.toLowerCase().includes(q) ||
      p.city?.toLowerCase().includes(q) ||
      p.postal_code?.toLowerCase().includes(q) ||
      p.neighborhood?.toLowerCase().includes(q))
    // Cap the DOM — the search narrows the rest. Same bound CustomerPicker uses, and
    // the reason this scales to an HOA's hundreds of addresses.
    return list.slice(0, 50)
  }, [properties, query])

  type Row = { type: 'none' } | { type: 'property'; p: Property } | { type: 'add' }
  const rows: Row[] = [
    ...(allowNone ? [{ type: 'none' as const }] : []),
    ...matches.map(p => ({ type: 'property' as const, p })),
    ...(canAdd ? [{ type: 'add' as const }] : []),
  ]

  function choose(i: number) {
    const r = rows[i]
    if (!r) return
    if (r.type === 'add') { setAdding(true); setOpen(false); setNewAddr(query.trim()); setAddErr(null); return }
    if (r.type === 'none') { onChange(''); setQuery('') }
    else { onChange(r.p.id); setQuery(r.p.address) }
    setOpen(false)
  }
  function clear() { onChange(''); setQuery(''); setOpen(false) }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open && (e.key === 'ArrowDown' || e.key === 'Enter')) { setOpen(true); setHi(0); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi(h => Math.min(h + 1, rows.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi(h => Math.max(h - 1, 0)) }
    else if (e.key === 'Enter' && open) { e.preventDefault(); choose(hi) }
  }

  async function saveNew() {
    const address = (parsed?.address || newAddr).trim()
    if (!address || !customerId || !onCreated) return
    setSaving(true); setAddErr(null)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const uid = session?.user?.id
      if (!uid) { setAddErr('You’re signed out — sign in and try again.'); return }
      // THE find-or-create seam. If this address already exists for the customer it
      // returns the existing row rather than making a second one for the same house.
      const { propertyId } = await ensurePropertyForCustomer(supabase, uid, customerId, {
        address, city: parsed?.city || null, province: parsed?.province || null, postal_code: parsed?.postal || null,
      })
      if (!propertyId) { setAddErr('Could not save that address — please try again.'); return }
      const { data } = await supabase.from('properties').select('*').eq('id', propertyId).maybeSingle()
      if (!data) { setAddErr('Saved, but could not read it back — reload and try again.'); return }
      onCreated(data as Property)
      onChange(propertyId)
      setAdding(false); setNewAddr(''); setParsed(null); setQuery((data as Property).address)
    } catch {
      setAddErr('Could not save that address — please try again.')
    } finally { setSaving(false) }
  }

  if (adding) {
    return (
      <div className="flex flex-col gap-1.5">
        {label && <span className="text-xs font-semibold text-ink-muted uppercase tracking-wide">{label}</span>}
        <div className="rounded-xl border border-accent/30 bg-accent/[0.04] p-3 space-y-2.5">
          <AddressAutocomplete
            label="New property address"
            value={newAddr}
            onChange={v => { setNewAddr(v); setParsed(null) }}
            onSelect={p => { setParsed(p); setNewAddr(p.address || p.formatted) }}
            placeholder="Start typing the address…"
            hint="Added to this customer. Their first address becomes the primary one."
          />
          {addErr && <p className="text-xs text-red-400">{addErr}</p>}
          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => { setAdding(false); setAddErr(null) }} disabled={saving}>Cancel</Button>
            <Button type="button" size="sm" onClick={saveNew} loading={saving} disabled={!newAddr.trim()}>Add property</Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-1.5" ref={boxRef}>
      {label && <label htmlFor={inputId} className="text-xs font-semibold text-ink-muted uppercase tracking-wide">{label}</label>}
      <div className="relative">
        <Home className="w-4 h-4 text-ink-faint absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
        <input
          id={inputId}
          autoComplete="off"
          autoFocus={autoFocus}
          role="combobox"
          aria-expanded={open}
          value={query}
          placeholder={properties.length ? placeholder : canAdd ? 'No properties yet — add one' : 'No properties on file'}
          onChange={e => { setQuery(e.target.value); setOpen(true); setHi(0) }}
          onFocus={e => { setOpen(true); setHi(0); e.currentTarget.select() }}
          onKeyDown={onKeyDown}
          className={cn(
            // text-base on mobile stops iOS zooming the page on focus — same as CustomerPicker.
            'w-full bg-bg-tertiary border rounded-xl pl-9 pr-9 py-3 text-base sm:text-sm text-ink placeholder:text-ink-faint outline-none transition-all',
            error ? 'border-red-500/50 focus:border-red-500 focus:ring-2 focus:ring-red-500/20'
                  : 'border-border-strong focus:border-accent focus:ring-2 focus:ring-accent/20',
          )}
        />
        {selected ? (
          <button type="button" onClick={clear} aria-label="Clear property"
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-faint hover:text-ink p-1 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
            <X className="w-4 h-4" />
          </button>
        ) : (
          <ChevronDown className="w-4 h-4 text-ink-faint absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
        )}
        {open && (
          <div className="absolute z-overlay mt-1 w-full bg-bg-secondary border border-border-strong rounded-xl shadow-xl overflow-hidden origin-top animate-pop max-h-72 overflow-y-auto">
            {rows.length === 0 ? (
              <p className="px-3.5 py-2.5 text-sm text-ink-faint">
                {query.trim() ? `No addresses match “${query.trim()}”.` : 'This customer has no properties yet.'}
              </p>
            ) : rows.map((r, i) => (
              r.type === 'property' ? (
                <button key={r.p.id} type="button" onMouseEnter={() => setHi(i)} onClick={() => choose(i)}
                  className={cn('w-full text-left px-3.5 py-2.5 text-sm flex items-center gap-2 transition-colors', i === hi ? 'bg-surface' : 'hover:bg-surface')}>
                  <Home className="w-3.5 h-3.5 text-ink-faint shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-ink truncate">{r.p.address}</span>
                    {(r.p.city || r.p.neighborhood) && (
                      <span className="block text-[11px] text-ink-faint truncate">
                        {[r.p.neighborhood, r.p.city].filter(Boolean).join(' · ')}
                      </span>
                    )}
                  </span>
                  {r.p.is_primary && <Star className="w-3 h-3 text-accent-text shrink-0" aria-label="Primary" />}
                  {value === r.p.id && <Check className="w-4 h-4 text-accent-text shrink-0" />}
                </button>
              ) : r.type === 'none' ? (
                <button key="none" type="button" onMouseEnter={() => setHi(i)} onClick={() => choose(i)}
                  className={cn('w-full text-left px-3.5 py-2.5 text-sm flex items-center gap-2 transition-colors text-ink-muted', i === hi ? 'bg-surface' : 'hover:bg-surface')}>
                  {noneLabel}
                  {value === '' && <Check className="w-4 h-4 text-accent-text shrink-0 ml-auto" />}
                </button>
              ) : (
                <button key="add" type="button" onMouseEnter={() => setHi(i)} onClick={() => choose(i)}
                  className={cn('w-full text-left px-3.5 py-2.5 text-sm flex items-center gap-2 border-t border-border text-accent-text transition-colors', i === hi ? 'bg-surface' : 'hover:bg-surface')}>
                  <Plus className="w-3.5 h-3.5 shrink-0" /> Add a new property
                </button>
              )
            ))}
          </div>
        )}
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
      {hint && !error && <p className="text-xs text-ink-faint">{hint}</p>}
    </div>
  )
}
