'use client'

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
// See lib/dropdownPlacement. This list had no height bound AT ALL — the only
// one of the four — so it was the worst offender over the fixed Save bar.
import { useDropdownPlacement, dropdownStyle } from '@/hooks/useDropdownPlacement'
import { MapPin } from 'lucide-react'

export interface ParsedAddress {
  address: string   // street line (number + route), or formatted address as fallback
  city: string
  province: string
  postal: string
  formatted: string
  lat: number | null
  lng: number | null
}

interface AddressAutocompleteProps {
  label?: string
  value: string
  onChange: (v: string) => void
  onSelect?: (parsed: ParsedAddress) => void
  placeholder?: string
  maxLength?: number
  error?: string
  /** ReactNode to match Input/Select — the form primitives take the same shapes. */
  hint?: React.ReactNode
  /** Public /book/[token] funnel only: the owner's booking_token, which authorizes
   *  the Places proxy for an unauthenticated visitor. Dashboard callers omit it —
   *  their cookie session is the credential. */
  bookingToken?: string
}

interface SuggestionItem {
  text: string
  placeId: string
}

function newSession(): string {
  try { return crypto.randomUUID() } catch { return Math.random().toString(36).slice(2) + Date.now().toString(36) }
}

export function AddressAutocomplete({
  label, value, onChange, onSelect, placeholder, maxLength, error, hint, bookingToken,
}: AddressAutocompleteProps) {
  const [suggestions, setSuggestions] = useState<SuggestionItem[]>([])
  const [open, setOpen] = useState(false)
  const [loadError, setLoadError] = useState(false)
  // Highlighted suggestion for keyboard users. This control USED to be
  // mouse-only: no arrow-key movement and no Enter-to-select, so a keyboard or
  // screen-reader user could type an address but never choose a suggestion —
  // a WCAG 2.1.1 keyboard failure. `hi` + the combobox ARIA below fix that,
  // matching the pattern CustomerPicker/PropertySelect already use.
  const [hi, setHi] = useState(0)

  // One Places session token spans a type→select round trip (Google bills it as a
  // single session), then rotates once a selection resolves its details.
  const sessionRef = useRef<string | null>(null)
  // One generation covers both predictions and selected-place details. Aborting
  // saves work; the generation checks also protect against an already-read body.
  const seqRef = useRef(0)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const requestRef = useRef<AbortController | null>(null)
  const mountedRef = useRef(false)
  const acknowledgedRef = useRef({ value, bookingToken })
  const emittedValueRef = useRef<string | null>(null)
  const latestPropsRef = useRef({ value, bookingToken })
  latestPropsRef.current = { value, bookingToken }

  const invalidateRequests = useCallback(() => {
    seqRef.current++
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = null
    requestRef.current?.abort()
    requestRef.current = null
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false; invalidateRequests() }
  }, [invalidateRequests])

  useEffect(() => {
    const previous = acknowledgedRef.current
    // A normal controlled onChange acknowledgement belongs to the same intent.
    // Prefills/resets and public booking-context changes do not start a lookup.
    if (previous.bookingToken !== bookingToken ||
      (previous.value !== value && value !== emittedValueRef.current)) {
      invalidateRequests()
      setSuggestions([]); setOpen(false); setLoadError(false)
      sessionRef.current = null
      emittedValueRef.current = null
    }
    acknowledgedRef.current = { value, bookingToken }
    if (value === emittedValueRef.current) emittedValueRef.current = null
  }, [value, bookingToken, invalidateRequests])

  function isCurrent(seq: number, controller: AbortController) {
    const latest = latestPropsRef.current
    return mountedRef.current && seq === seqRef.current && !controller.signal.aborted &&
      latest.bookingToken === bookingToken &&
      (latest.value === acknowledgedRef.current.value || latest.value === emittedValueRef.current)
  }

  function emitValue(next: string) {
    emittedValueRef.current = next
    onChange(next)
  }

  const boxRef = useRef<HTMLDivElement>(null)
  // The input's wrapper — boxRef also holds the label.
  const anchorRef = useRef<HTMLDivElement>(null)
  const place = useDropdownPlacement(anchorRef, open && suggestions.length > 0)

  const inputId = label ? label.toLowerCase().replace(/\s+/g, '-') : undefined
  // Combobox a11y ids: the input points at the listbox (aria-controls) and, as
  // the user arrows, at the active option (aria-activedescendant) — focus stays
  // in the input throughout (ARIA 1.2 combobox + listbox-popup).
  const baseId = useId()
  const listId = `${baseId}-listbox`
  const optId = (i: number) => `${baseId}-opt-${i}`

  // Escape is CAPTURED while suggestions are open — same fix as PropertySelect:
  // inside a Modal, the bubble-phase Escape raced the Modal's listener, so
  // dismissing a suggestion closed the whole dialog. Capture + stopPropagation
  // only while open; a closed dropdown leaves Escape to the Modal.
  const openRef = useRef(open); openRef.current = open
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape' || !openRef.current) return
      e.stopPropagation()
      setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey, { capture: true })
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey, { capture: true }) }
  }, [])

  function handleInput(v: string) {
    invalidateRequests()
    setSuggestions([]); setOpen(false); setLoadError(false)
    emitValue(v)
    if (!v || v.trim().length < 3 || !mountedRef.current) return
    if (!sessionRef.current) sessionRef.current = newSession()
    const sessionToken = sessionRef.current
    const seq = seqRef.current
    const controller = new AbortController()
    requestRef.current = controller
    debounceRef.current = setTimeout(async () => {
      debounceRef.current = null
      if (!isCurrent(seq, controller)) return
      try {
        const res = await fetch('/api/places/autocomplete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ input: v, sessionToken, bookingToken }),
          signal: controller.signal,
        })
        if (!isCurrent(seq, controller)) return
        if (!res.ok) {
          setSuggestions([]); setOpen(false)
          if (res.status >= 500) setLoadError(true) // real misconfig, not a miss
          return
        }
        const { suggestions: list } = await res.json()
        if (!isCurrent(seq, controller)) return
        const mapped: SuggestionItem[] = (list || [])
          .map((s: any) => ({ text: s.text || '', placeId: s.placeId || '' }))
          .filter((s: SuggestionItem) => s.text && s.placeId)
        setSuggestions(mapped)
        setOpen(mapped.length > 0)
        setHi(0) // reset the highlight to the top on every fresh result set
      } catch {
        if (isCurrent(seq, controller)) { setSuggestions([]); setOpen(false) }
      } finally {
        if (requestRef.current === controller) requestRef.current = null
      }
    }, 250)
  }

  // Keyboard operation of the suggestion list (the whole point of this fix):
  // arrows move the highlight, Enter picks it, Escape closes. Enter is only
  // intercepted while the list is open with a highlight — otherwise it falls
  // through to the form so a plain typed address still submits.
  function onKeyDown(e: React.KeyboardEvent) {
    if (!open || suggestions.length === 0) {
      if (e.key === 'ArrowDown' && suggestions.length > 0) { e.preventDefault(); setOpen(true); setHi(0) }
      return
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi(h => Math.min(h + 1, suggestions.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi(h => Math.max(h - 1, 0)) }
    else if (e.key === 'Enter') { const s = suggestions[hi]; if (s) { e.preventDefault(); choose(s) } }
    else if (e.key === 'Escape') { setOpen(false) }
  }

  async function choose(s: SuggestionItem) {
    invalidateRequests()
    const seq = seqRef.current
    const controller = new AbortController()
    requestRef.current = controller
    setSuggestions([]); setOpen(false)
    emitValue(s.text)
    try {
      if (!isCurrent(seq, controller)) return
      const res = await fetch('/api/places/details', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ placeId: s.placeId, sessionToken: sessionRef.current, bookingToken }),
        signal: controller.signal,
      })
      if (!isCurrent(seq, controller)) return
      if (!res.ok) throw new Error('details')
      const { place } = await res.json() as { place: ParsedAddress }
      if (!isCurrent(seq, controller)) return
      const street = place.address || place.formatted || s.text
      emitValue(street)
      onSelect?.({
        address: street,
        city: place.city || '',
        province: place.province || '',
        postal: place.postal || '',
        formatted: place.formatted || s.text,
        lat: place.lat ?? null,
        lng: place.lng ?? null,
      })
      sessionRef.current = newSession() // a resolved selection closes the billing session
    } catch {
      if (isCurrent(seq, controller)) {
        onSelect?.({ address: s.text, city: '', province: '', postal: '', formatted: s.text, lat: null, lng: null })
      }
    } finally {
      if (requestRef.current === controller) requestRef.current = null
    }
  }

  return (
    <div className="flex flex-col gap-1.5" ref={boxRef}>
      {label && (
        <label htmlFor={inputId} className="text-xs font-semibold text-ink-muted uppercase tracking-wide">
          {label}
        </label>
      )}
      <div className="relative" ref={anchorRef}>
        <input
          id={inputId}
          autoComplete="off"
          role="combobox"
          aria-expanded={open && suggestions.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && suggestions.length > 0 ? optId(hi) : undefined}
          value={value}
          placeholder={placeholder}
          maxLength={maxLength}
          onChange={(e) => handleInput(e.target.value)}
          onFocus={() => { if (suggestions.length) { setOpen(true); setHi(0) } }}
          onKeyDown={onKeyDown}
          className={cn(
         'w-full bg-bg-tertiary border rounded-xl px-3.5 py-3 text-base sm:text-sm text-ink placeholder:text-ink-faint outline-none transition-all',
            error
              ? 'border-red-500/50 focus:border-red-500 focus:ring-2 focus:ring-red-500/20'
              : 'border-border-strong focus:border-accent focus:ring-2 focus:ring-accent/20'
          )}
        />
        {open && suggestions.length > 0 && (
          <div data-eq-dropdown
            style={dropdownStyle(place)}
            className="absolute z-overlay w-full bg-bg-secondary border border-border-strong rounded-xl shadow-xl origin-top animate-pop flex flex-col overflow-hidden">
            <div id={listId} role="listbox" aria-label={label || 'Address suggestions'} className="min-h-0 overflow-y-auto overscroll-contain">
            {suggestions.map((s, i) => (
              <button
                key={i}
                type="button"
                role="option"
                id={optId(i)}
                aria-selected={i === hi}
                tabIndex={-1}
                onMouseEnter={() => setHi(i)}
                onClick={() => choose(s)}
                className={cn('w-full text-left px-3.5 py-2.5 text-sm text-ink flex items-center gap-2 transition-colors', i === hi ? 'bg-surface' : 'hover:bg-surface-raised')}
              >
                <MapPin className="w-3.5 h-3.5 text-ink-faint shrink-0" />
                <span className="truncate">{s.text}</span>
              </button>
            ))}
            </div>
            {/* Compact attribution stays visible while the predictions scroll. */}
            <div className="shrink-0 border-t border-border px-3.5 py-1.5 text-right">
              <span translate="no" className="font-body text-xs font-normal not-italic tracking-normal whitespace-nowrap text-white [[data-theme=light]_&]:text-[#1f1f1f]">Google Maps</span>
            </div>
          </div>
        )}
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
      {hint && !error && <p className="text-xs text-ink-faint">{hint}</p>}
      {loadError && (
        <p className="text-xs text-amber-400">Address suggestions unavailable — you can still type the address manually.</p>
      )}
    </div>
  )
}
