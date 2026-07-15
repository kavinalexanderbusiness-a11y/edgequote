'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import type { Customer } from '@/types'
import { User, Plus, ChevronDown, X, Check } from 'lucide-react'

// Type-to-search customer picker — a combobox replacement for a <select> of every
// customer (which is painful past ~50 names). Filters by name / phone / email /
// address, supports keyboard navigation, and keeps the "+ Enter manually" escape
// hatch the quote builder relies on. Built on the same interaction + styling as
// AddressAutocomplete so the two controls feel identical.
const MANUAL = '__manual'

interface CustomerPickerProps {
  label?: string
  customers: Customer[]
  value: string                 // selected customer id, '' (none), or '__manual'
  onChange: (value: string) => void
  allowManual?: boolean         // show the "+ Enter manually" row (default true)
  placeholder?: string
  error?: string
  hint?: string
  autoFocus?: boolean           // land the cursor in search on mount (compose flows)
}

export function CustomerPicker({
  label, customers, value, onChange, allowManual = true, placeholder = 'Search customers…', error, hint, autoFocus,
}: CustomerPickerProps) {
  const selected = value && value !== MANUAL ? customers.find(c => c.id === value) ?? null : null
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [hi, setHi] = useState(0)
  const boxRef = useRef<HTMLDivElement>(null)
  const inputId = label ? label.toLowerCase().replace(/\s+/g, '-') : undefined

  // Keep the input text in sync with the externally-selected customer while the menu
  // is closed (e.g. the "likely match — Use them" button sets customer_id directly).
  useEffect(() => {
    if (open) return
    const sel = value && value !== MANUAL ? customers.find(c => c.id === value) : null
    setQuery(sel ? sel.name : '')
  }, [value, open, customers])

  useEffect(() => {
    function onDoc(e: MouseEvent) { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false) }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey) }
  }, [])

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = !q ? customers : customers.filter(c =>
      c.name?.toLowerCase().includes(q) ||
      c.phone?.toLowerCase().includes(q) ||
      c.email?.toLowerCase().includes(q) ||
      c.address?.toLowerCase().includes(q))
    return list.slice(0, 50)   // cap the DOM — the search narrows the rest
  }, [customers, query])

  // Menu rows = matched customers, then the manual escape hatch.
  const rows: ({ type: 'customer'; c: Customer } | { type: 'manual' })[] = [
    ...matches.map(c => ({ type: 'customer' as const, c })),
    ...(allowManual ? [{ type: 'manual' as const }] : []),
  ]

  function choose(i: number) {
    const r = rows[i]
    if (!r) return
    if (r.type === 'manual') { onChange(MANUAL); setQuery('') }
    else { onChange(r.c.id); setQuery(r.c.name) }
    setOpen(false)
  }
  function clear() { onChange(''); setQuery(''); setOpen(false) }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open && (e.key === 'ArrowDown' || e.key === 'Enter')) { setOpen(true); setHi(0); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi(h => Math.min(h + 1, rows.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi(h => Math.max(h - 1, 0)) }
    else if (e.key === 'Enter' && open) { e.preventDefault(); choose(hi) }
  }

  const showClear = !!selected || value === MANUAL

  return (
    <div className="flex flex-col gap-1.5" ref={boxRef}>
      {label && <label htmlFor={inputId} className="text-xs font-semibold text-ink-muted uppercase tracking-wide">{label}</label>}
      <div className="relative">
        <User className="w-4 h-4 text-ink-faint absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
        <input
          id={inputId}
          autoComplete="off"
          autoFocus={autoFocus}
          role="combobox"
          aria-expanded={open}
          value={query}
          placeholder={value === MANUAL ? 'Entering details manually below' : placeholder}
          onChange={e => { setQuery(e.target.value); setOpen(true); setHi(0) }}
          onFocus={e => { setOpen(true); setHi(0); e.currentTarget.select() }}
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
          <div className="absolute z-50 mt-1 w-full bg-bg-secondary border border-border-strong rounded-xl shadow-xl overflow-hidden origin-top animate-pop max-h-72 overflow-y-auto">
            {rows.length === 0 ? (
              <p className="px-3.5 py-2.5 text-sm text-ink-faint">{query.trim() ? `No customers match “${query.trim()}”.` : 'No customers yet — add one to start a conversation.'}</p>
            ) : rows.map((r, i) => (
              r.type === 'customer' ? (
                <button key={r.c.id} type="button" onMouseEnter={() => setHi(i)} onClick={() => choose(i)}
                  className={cn('w-full text-left px-3.5 py-2.5 text-sm flex items-center gap-2 transition-colors', i === hi ? 'bg-surface' : 'hover:bg-surface')}>
                  <User className="w-3.5 h-3.5 text-ink-faint shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-ink truncate">{r.c.name}</span>
                    {(r.c.phone || r.c.address) && <span className="block text-[11px] text-ink-faint truncate">{[r.c.phone, r.c.address].filter(Boolean).join(' · ')}</span>}
                  </span>
                  {value === r.c.id && <Check className="w-4 h-4 text-accent-text shrink-0" />}
                </button>
              ) : (
                <button key="manual" type="button" onMouseEnter={() => setHi(i)} onClick={() => choose(i)}
                  className={cn('w-full text-left px-3.5 py-2.5 text-sm flex items-center gap-2 border-t border-border text-accent-text transition-colors', i === hi ? 'bg-surface' : 'hover:bg-surface')}>
                  <Plus className="w-3.5 h-3.5 shrink-0" /> Enter manually
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
