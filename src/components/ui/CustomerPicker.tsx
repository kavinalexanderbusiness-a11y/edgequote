'use client'

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { displayAddress } from '@/lib/customers'
// See lib/dropdownPlacement — an unbounded downward list covered the fixed
// mobile Save bar and ate the tap.
import { useDropdownPlacement, dropdownStyle } from '@/hooks/useDropdownPlacement'
import type { Customer } from '@/types'
import { User, Plus, ChevronDown, X, Check } from 'lucide-react'

// Type-to-search customer picker — a combobox replacement for a <select> of every
// customer (which is painful past ~50 names). Filters by name / phone / email /
// address, supports keyboard navigation, and keeps the "+ Enter manually" escape
// hatch the quote builder relies on. Built on the same interaction + styling as
// AddressAutocomplete so the two controls feel identical.
const MANUAL = '__manual'

export type CustomerPickerCustomer = Pick<Customer, 'id' | 'name' | 'phone' | 'email' | 'address' | 'city' | 'province'> & {
  properties?: { id?: string; address: string | null; city: string | null; province?: string | null; is_primary: boolean | null }[]
}

interface CustomerPickerProps {
  label?: string
  customers: CustomerPickerCustomer[]
  value: string                 // selected customer id, '' (none), or '__manual'
  onChange: (value: string) => void
  allowManual?: boolean         // show the "+ Enter manually" row (default true)
  /** Fires when the manual row is chosen, carrying whatever the owner had TYPED
      into the search — the name they searched, found nobody by, and were then
      forced to retype. Callers use it to seed their own name field (fill-when-
      empty). Optional and additive: existing callers change nothing. */
  onManual?: (typedQuery: string) => void
  placeholder?: string
  error?: string
  hint?: string
  autoFocus?: boolean           // land the cursor in search on mount (compose flows)
}

export function CustomerPicker({
  label, customers, value, onChange, allowManual = true, onManual, placeholder = 'Search customers…', error, hint, autoFocus,
}: CustomerPickerProps) {
  const selected = value && value !== MANUAL ? customers.find(c => c.id === value) ?? null : null
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [hiKey, setHiKey] = useState<string | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // The input's wrapper — boxRef also holds the label, which the list is not
  // anchored to.
  const anchorRef = useRef<HTMLDivElement>(null)
  const place = useDropdownPlacement(anchorRef, open)
  const inputId = useId()
  const listId = `${inputId}-list`

  // Keep the input text in sync with the externally-selected customer while the menu
  // is closed (e.g. the "likely match — Use them" button sets customer_id directly).
  useEffect(() => {
    if (open) return
    const sel = value && value !== MANUAL ? customers.find(c => c.id === value) : null
    setQuery(sel ? sel.name : '')
  }, [value, open, customers])

  // A suggestion list owns its first Escape. Capture it before the enclosing
  // dialog's listener, as PropertySelect and AddressAutocomplete already do.
  const openRef = useRef(open); openRef.current = open
  useEffect(() => {
    function onDoc(e: MouseEvent) { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false) }
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape' || !openRef.current) return
      e.stopPropagation()
      setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey, { capture: true })
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey, { capture: true }) }
  }, [])

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    // displayAddress = primary property first, legacy customers.address fallback —
    // callers that don't join properties keep exactly the old behaviour.
    const list = !q ? customers : customers.filter(c =>
      c.name?.toLowerCase().includes(q) ||
      c.phone?.toLowerCase().includes(q) ||
      c.email?.toLowerCase().includes(q) ||
      displayAddress(c).address.toLowerCase().includes(q))
    return list.slice(0, 50)   // cap the DOM — the search narrows the rest
  }, [customers, query])

  // Menu rows = matched customers, then the manual escape hatch.
  const rows: ({ type: 'customer'; c: CustomerPickerCustomer } | { type: 'manual' })[] = [
    ...matches.map(c => ({ type: 'customer' as const, c })),
    ...(allowManual ? [{ type: 'manual' as const }] : []),
  ]
  const rowKey = (r: (typeof rows)[number]) => r.type === 'customer' ? `customer-${r.c.id}` : 'manual'
  const optionId = (r: (typeof rows)[number]) => `${listId}-${encodeURIComponent(rowKey(r))}`
  // Keep the same entity active if a background refresh reorders the list. If
  // it disappears, Enter must not silently pick its replacement at that index.
  const hi = hiKey === null ? (rows.length ? 0 : -1) : rows.findIndex(r => rowKey(r) === hiKey)
  const activeId = open && hi >= 0 ? optionId(rows[hi]) : undefined
  const firstKey = rows.length ? rowKey(rows[0]) : null
  useEffect(() => {
    // Pin the first highlighted row too, before any arrow or pointer movement.
    if (open && hiKey === null && firstKey !== null) setHiKey(firstKey)
  }, [open, hiKey, firstKey])

  useEffect(() => {
    const list = listRef.current
    const active = activeId ? document.getElementById(activeId) : null
    if (!list || !active || !list.contains(active)) return
    // Scroll only the suggestion list: scrollIntoView also moves the surrounding
    // form/modal and can pull its Save action out of view.
    const top = active.offsetTop
    const bottom = top + active.offsetHeight
    if (top < list.scrollTop) list.scrollTop = top
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight
  }, [activeId, hi, rows.length, place.maxHeight, place.side])

  function move(direction: 1 | -1) {
    if (!rows.length) return
    const next = hi < 0 ? 0 : Math.min(Math.max(hi + direction, 0), rows.length - 1)
    setHiKey(rowKey(rows[next]))
  }

  function choose(i: number) {
    const r = rows[i]
    if (!r) return
    // Hand the typed search text to the caller BEFORE clearing it — it's the
    // name they searched, found nobody by, and would otherwise retype verbatim
    // into the manual Name field two lines below.
    if (r.type === 'manual') { onChange(MANUAL); onManual?.(query.trim()); setQuery('') }
    else { onChange(r.c.id); setQuery(r.c.name) }
    setOpen(false)
  }
  function clear() { onChange(''); setQuery(''); setOpen(false) }

  function onKeyDown(e: React.KeyboardEvent) {
    // preventDefault on BOTH keys: with the menu closed this branch opened it but
    // let the key keep going, so Enter also triggered the form's implicit submit —
    // in the quote builder that saved a half-built quote from the customer field.
    // A combobox owns Enter; the form gets it from the Save button.
    if (!open && (e.key === 'ArrowDown' || e.key === 'Enter')) { e.preventDefault(); setOpen(true); setHiKey(null); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1) }
    else if (e.key === 'Enter' && open) { e.preventDefault(); choose(hi) }
  }

  const showClear = !!selected || value === MANUAL

  return (
    <div className="flex flex-col gap-1.5" ref={boxRef}>
      {label && <label htmlFor={inputId} className="text-xs font-semibold text-ink-muted uppercase tracking-wide">{label}</label>}
      <div className="relative" ref={anchorRef}>
        <User className="w-4 h-4 text-ink-faint absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
        <input
          id={inputId}
          autoComplete="off"
          autoFocus={autoFocus}
          role="combobox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={activeId}
          aria-autocomplete="list"
          aria-label={label ? undefined : 'Customer'}
          value={query}
          placeholder={value === MANUAL ? 'Entering details manually below' : placeholder}
          onChange={e => { setQuery(e.target.value); setOpen(true); setHiKey(null) }}
          onFocus={e => { setOpen(true); setHiKey(null); e.currentTarget.select() }}
          onClick={e => { if (!open) { setOpen(true); setHiKey(null); e.currentTarget.select() } }}
          onKeyDown={onKeyDown}
          className={cn(
            'w-full bg-bg-tertiary border rounded-xl pl-9 pr-9 py-3 text-base sm:text-sm text-ink placeholder:text-ink-faint outline-none transition-all',
            error ? 'border-red-500/50 focus:border-red-500 focus:ring-2 focus:ring-red-500/20'
                  : 'border-border-strong focus:border-accent focus:ring-2 focus:ring-accent/20',
          )}
        />
        {showClear ? (
          <button type="button" onClick={clear} aria-label="Clear customer"
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-faint hover:text-ink p-1 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
            <X className="w-4 h-4" />
          </button>
        ) : (
          <ChevronDown className="w-4 h-4 text-ink-faint absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
        )}
        {open && (
          <div ref={listRef} id={listId} role="listbox" aria-label={label ? `${label} options` : 'Customers'}
            data-eq-dropdown
            style={dropdownStyle(place)}
            className="absolute z-overlay w-full bg-bg-secondary border border-border-strong rounded-xl shadow-xl origin-top animate-pop overflow-y-auto overscroll-contain">
            {rows.length === 0 ? (
              <p className="px-3.5 py-2.5 text-sm text-ink-faint">{query.trim() ? `No customers match “${query.trim()}”.` : 'No customers yet — add one to start a conversation.'}</p>
            ) : rows.map((r, i) => (
              r.type === 'customer' ? (
                <button key={r.c.id} type="button" id={optionId(r)} role="option" aria-selected={i === hi} tabIndex={-1}
                  onMouseDown={e => e.preventDefault()} onPointerMove={() => setHiKey(rowKey(r))} onClick={() => choose(i)}
                  className={cn('w-full text-left px-3.5 py-2.5 text-sm flex items-center gap-2 transition-colors', i === hi ? 'bg-surface-raised ring-2 ring-inset ring-accent/60' : 'hover:bg-surface-raised')}>
                  <User className="w-3.5 h-3.5 text-ink-faint shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-ink truncate">{r.c.name}</span>
                    {(r.c.phone || displayAddress(r.c).address) && <span className="block text-[11px] text-ink-faint truncate">{[r.c.phone, displayAddress(r.c).address].filter(Boolean).join(' · ')}</span>}
                  </span>
                  {value === r.c.id && <Check className="w-4 h-4 text-accent-text shrink-0" />}
                </button>
              ) : (
                <button key="manual" type="button" id={optionId(r)} role="option" aria-selected={i === hi} tabIndex={-1}
                  onMouseDown={e => e.preventDefault()} onPointerMove={() => setHiKey(rowKey(r))} onClick={() => choose(i)}
                  className={cn('w-full text-left px-3.5 py-2.5 text-sm flex items-center gap-2 border-t border-border text-accent-text transition-colors', i === hi ? 'bg-surface-raised ring-2 ring-inset ring-accent/60' : 'hover:bg-surface-raised')}>
                  {/* Name the action after what they typed — "Add 'Jane Smith' as a
                      new customer" says the typed name is KEPT, not thrown away. */}
                  <Plus className="w-3.5 h-3.5 shrink-0" /> {query.trim() ? <>Add &ldquo;{query.trim()}&rdquo; as a new customer</> : 'Enter manually'}
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
