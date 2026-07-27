'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { loadGoogleMaps } from '@/lib/googleMaps'
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
  error?: string
  /** ReactNode to match Input/Select — the form primitives take the same shapes. */
  hint?: React.ReactNode
}

interface SuggestionItem {
  text: string
  placePrediction: any
}

export function AddressAutocomplete({
  label, value, onChange, onSelect, placeholder, error, hint,
}: AddressAutocompleteProps) {
  const [suggestions, setSuggestions] = useState<SuggestionItem[]>([])
  const [open, setOpen] = useState(false)
  const [ready, setReady] = useState(false)
  const [loadError, setLoadError] = useState(false)
  // Highlighted suggestion for keyboard users. This control USED to be
  // mouse-only: no arrow-key movement and no Enter-to-select, so a keyboard or
  // screen-reader user could type an address but never choose a suggestion —
  // a WCAG 2.1.1 keyboard failure. `hi` + the combobox ARIA below fix that,
  // matching the pattern CustomerPicker/PropertySelect already use.
  const [hi, setHi] = useState(0)

  const placesRef = useRef<any>(null)
  const tokenRef = useRef<any>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)

  const inputId = label ? label.toLowerCase().replace(/\s+/g, '-') : undefined
  // Combobox a11y ids: the input points at the listbox (aria-controls) and, as
  // the user arrows, at the active option (aria-activedescendant) — focus stays
  // in the input throughout (ARIA 1.2 combobox + listbox-popup).
  const baseId = useId()
  const listId = `${baseId}-listbox`
  const optId = (i: number) => `${baseId}-opt-${i}`

  useEffect(() => {
    let cancelled = false
    loadGoogleMaps()
      .then(async () => {
        const places = await window.google.maps.importLibrary('places')
        if (cancelled) return
        placesRef.current = places
        tokenRef.current = new places.AutocompleteSessionToken()
        setReady(true)
      })
      .catch(() => { if (!cancelled) setLoadError(true) })
    return () => { cancelled = true }
  }, [])

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
    onChange(v)
    if (!ready || !placesRef.current) return
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (!v || v.trim().length < 3) { setSuggestions([]); setOpen(false); return }
    debounceRef.current = setTimeout(async () => {
      try {
        const { AutocompleteSuggestion } = placesRef.current
        const { suggestions: list } = await AutocompleteSuggestion.fetchAutocompleteSuggestions({
          input: v,
          sessionToken: tokenRef.current,
          includedRegionCodes: ['ca'],
        })
        const mapped: SuggestionItem[] = (list || [])
          .filter((s: any) => s.placePrediction)
          .map((s: any) => ({
            text: s.placePrediction?.text?.text || '',
            placePrediction: s.placePrediction,
          }))
        setSuggestions(mapped)
        setOpen(mapped.length > 0)
        setHi(0) // reset the highlight to the top on every fresh result set
      } catch {
        setSuggestions([]); setOpen(false)
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
    setOpen(false)
    onChange(s.text)
    try {
      const place = s.placePrediction.toPlace()
      await place.fetchFields({ fields: ['formattedAddress', 'addressComponents', 'location'] })
      const comps: any[] = place.addressComponents || []
      const get = (type: string) => comps.find(x => (x.types || []).includes(type)) || null
      const streetNum = get('street_number')?.longText || ''
      const route = get('route')?.longText || ''
      const city = get('locality')?.longText || get('postal_town')?.longText || get('sublocality')?.longText || ''
      const province = get('administrative_area_level_1')?.shortText || ''
      const postal = get('postal_code')?.longText || ''
      const street = [streetNum, route].filter(Boolean).join(' ')
      const formatted = place.formattedAddress || s.text
      const loc = place.location
      const lat = loc ? (typeof loc.lat === 'function' ? loc.lat() : loc.lat) : null
      const lng = loc ? (typeof loc.lng === 'function' ? loc.lng() : loc.lng) : null

      onChange(street || formatted)
      onSelect?.({ address: street || formatted, city, province, postal, formatted, lat, lng })

      tokenRef.current = new placesRef.current.AutocompleteSessionToken()
    } catch {
      onSelect?.({ address: s.text, city: '', province: '', postal: '', formatted: s.text, lat: null, lng: null })
    }
  }

  return (
    <div className="flex flex-col gap-1.5" ref={boxRef}>
      {label && (
        <label htmlFor={inputId} className="text-xs font-semibold text-ink-muted uppercase tracking-wide">
          {label}
        </label>
      )}
      <div className="relative">
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
          <div id={listId} role="listbox" aria-label={label || 'Address suggestions'}
            className="absolute z-overlay mt-1 w-full bg-bg-secondary border border-border-strong rounded-xl shadow-xl overflow-hidden origin-top animate-pop">
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
                className={cn('w-full text-left px-3.5 py-2.5 text-sm text-ink flex items-center gap-2 transition-colors', i === hi ? 'bg-surface' : 'hover:bg-surface')}
              >
                <MapPin className="w-3.5 h-3.5 text-ink-faint shrink-0" />
                <span className="truncate">{s.text}</span>
              </button>
            ))}
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