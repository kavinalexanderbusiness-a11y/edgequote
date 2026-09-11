'use client'

import { InputHTMLAttributes, ReactNode, forwardRef, useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { fieldBorder } from './fieldStyles'
import { useFieldIds } from './useFieldIds'
import { formatServicePrice } from '@/lib/servicePricing'
// WHAT the menu offers and in what order lives in lib/servicePicker — a pure
// function, so the search, the ranking, the Recent block and the grouping rule
// can be asserted on directly instead of inferred from this file's JSX.
import { buildServiceMenu, type ServicePickerTemplate } from '@/lib/servicePicker'
// WHERE the menu is allowed to be. A 288px list opening downward from a field
// in the lower half of a phone form covered the fixed Save bar and swallowed
// the tap — see lib/dropdownPlacement for the measurement.
import { useDropdownPlacement, dropdownStyle } from '@/hooks/useDropdownPlacement'
import { Wrench, ChevronDown, Check, Star, Search } from 'lucide-react'

// ── Type-to-search service picker ────────────────────────────────────────────
// A catalogue of 23 services in a native <select> is 23 rows of OS chrome over
// the form on a phone, and a list that covers most of the viewport on a desktop
// — for a control the owner uses on every single quote. It also cost a SECOND
// field: the <select> could only offer catalogue services, so free-text work
// needed its own "Service Name *" input underneath, and picking from the list
// auto-filled it. Two fields, one question, and the required one looked unanswered.
//
// THE IDEA THAT REMOVES BOTH PROBLEMS: this is a text input for the service NAME
// — the thing the customer reads — that happens to know your catalogue. Type and
// it filters; pick a row and you adopt that service (its price, rate and canned
// description come with it); type something that isn't in the catalogue and
// that's a custom service, already named, with nothing more to do. The escape
// hatch is the default state rather than a second control.
//
// Built on CustomerPicker's interaction and styling on purpose — it solved the
// same problem for a list of every customer, and two comboboxes on one form must
// not behave differently. Input's own classes (fieldBorder, useFieldIds, the
// text-base→sm step that stops iOS zooming) are reused rather than restated.

interface ServicePickerProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value'> {
  label?: string
  error?: string
  hint?: ReactNode
  /** The services on offer. The caller decides what belongs here (active only,
      plus whichever retired one a saved row still points at). */
  templates: ServicePickerTemplate[]
  /** The adopted catalogue service, or '' when the name is the owner's own text. */
  templateId?: string
  /** A row was chosen — the caller owns what that fills in. */
  onPick: (t: ServicePickerTemplate) => void
  /** Drop the catalogue link and keep the typed name as one-off work. The old
      <select> had this as its "Select a service…" placeholder option; without it
      an adopted service could only ever be swapped for another one. Editing the
      NAME deliberately does not do this — renaming a catalogue service for one
      quote is a feature, and the template id is what tells the pricing seam
      which engine may recommend. */
  onDetach?: () => void
  /** Template ids the owner quoted most recently, newest first. Read from quotes
      they already saved; this component never records anything. */
  recentIds?: string[]
  fieldSize?: 'sm' | 'md'
}

const ServicePicker = forwardRef<HTMLInputElement, ServicePickerProps>(
  ({ className, label, error, hint, templates, templateId, onPick, onDetach, recentIds, fieldSize = 'md',
     placeholder = 'Search or type a service…', onChange, onFocus, onClick, onKeyDown, id, ...props }, ref) => {
    const { id: inputId, errorId, hintId } = useFieldIds(id)
    const listId = `${inputId}-services`
    const [open, setOpen] = useState(false)
    // What the owner has typed SINCE focusing. Held separately from the field
    // value because the field arrives pre-filled (a picked service, a lead's
    // stated service, a saved quote) and filtering a list down to the one row it
    // already holds is not a search — it's a dead end. Focus shows everything;
    // the first keystroke starts filtering.
    const [query, setQuery] = useState('')
    const [filtering, setFiltering] = useState(false)
    // null = nothing highlighted, and that is the DEFAULT even while filtering.
    // Auto-highlighting the first match would make Enter adopt a catalogue
    // service — with its price — from an owner who was typing a custom name that
    // merely shares a word with one. Arrow keys (or the mouse) are consent.
    const [activeTemplateId, setActiveTemplateId] = useState<string | null>(null)
    const boxRef = useRef<HTMLDivElement>(null)
    const listRef = useRef<HTMLDivElement>(null)
    // The INPUT's wrapper, not boxRef — boxRef includes the label, and the list
    // is anchored to the box you can see, not to the words above it.
    const anchorRef = useRef<HTMLDivElement>(null)
    const place = useDropdownPlacement(anchorRef, open, { clipToAncestors: true })

    useEffect(() => {
      function onDoc(e: MouseEvent) { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false) }
      document.addEventListener('mousedown', onDoc)
      return () => document.removeEventListener('mousedown', onDoc)
    }, [])

    const selected = templateId ? templates.find(t => t.id === templateId) ?? null : null
    const { rows } = useMemo(
      () => buildServiceMenu(templates, { query, filtering, recentIds }),
      [templates, query, filtering, recentIds],
    )

    const pickable = rows.map((r, i) => (r.type === 'template' ? i : -1)).filter(i => i >= 0)
    // Recent/category changes can move a service or replace its menu row key.
    // Follow its identity; a removed service leaves nothing for Enter to adopt.
    const hi = activeTemplateId === null ? -1 : rows.findIndex(r => r.type === 'template' && r.t.id === activeTemplateId)
    const optionId = (templateId: string) => `${listId}-${encodeURIComponent(templateId)}`
    const activeRow = rows[hi]
    const activeId = open && activeRow?.type === 'template' ? optionId(activeRow.t.id) : undefined

    useEffect(() => {
      // Removal withdraws the old navigation choice. Reintroducing that service
      // later must not restore consent without fresh pointer/arrow movement.
      if (activeTemplateId !== null && hi < 0) setActiveTemplateId(null)
    }, [activeTemplateId, hi])

    useEffect(() => {
      const list = listRef.current
      const active = activeId ? document.getElementById(activeId) : null
      if (!list || !active || !list.contains(active)) return
      // Scroll only the suggestion list, keeping the surrounding draft/Save in
      // place. scrollIntoView also scrolls the enclosing modal and page.
      const top = active.offsetTop
      const bottom = top + active.offsetHeight
      if (top < list.scrollTop) list.scrollTop = top
      else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight
    }, [activeId, hi, rows.length, place.maxHeight, place.side])

    // Opening always shows the WHOLE catalogue and selects what's in the field.
    // Filtering a list down to the one row it already holds is a dead end, and
    // selecting means the next keystroke switches service instead of appending
    // to the name of the last one. Choosing is the primary act here; renaming is
    // secondary and still reachable — a second tap drops the caret in the text.
    function openMenu(el: HTMLInputElement) {
      setOpen(true); setFiltering(false); setQuery(''); setActiveTemplateId(null)
      el.select()
    }

    function choose(i: number) {
      const r = rows[i]
      if (!r || r.type !== 'template') return
      onPick(r.t)
      setOpen(false); setFiltering(false); setQuery(''); setActiveTemplateId(null)
    }

    function move(dir: 1 | -1) {
      if (!pickable.length) return
      const at = pickable.indexOf(hi)
      const next = at < 0 ? (dir === 1 ? pickable[0] : pickable[pickable.length - 1])
        : pickable[Math.min(Math.max(at + dir, 0), pickable.length - 1)]
      const row = rows[next]
      if (row.type === 'template') setActiveTemplateId(row.t.id)
    }

    return (
      <div className="flex flex-col gap-1.5" ref={boxRef}>
        {label && (
          <label htmlFor={inputId} className="text-xs font-semibold text-ink-muted uppercase tracking-wide">{label}</label>
        )}
        <div className="relative" ref={anchorRef}>
          {open ? <Search className="w-4 h-4 text-ink-faint absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                : <Wrench className="w-4 h-4 text-ink-faint absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />}
          <input
            {...props}
            ref={ref}
            id={inputId}
            role="combobox"
            aria-expanded={open}
            aria-controls={open ? listId : undefined}
            aria-activedescendant={activeId}
            aria-autocomplete="list"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : hint ? hintId : undefined}
            autoComplete="off"
            placeholder={placeholder}
            onChange={e => { setQuery(e.target.value); setFiltering(true); setOpen(true); setActiveTemplateId(null); onChange?.(e) }}
            onFocus={e => { openMenu(e.currentTarget); onFocus?.(e) }}
            // A tap on an ALREADY-FOCUSED field fires no focus event, so after
            // picking a service (which closes the menu but keeps focus) tapping
            // the control again did nothing at all — measured in a real browser,
            // and it is the second thing anyone does. Guarded on `open` so a
            // click INSIDE an open menu's input still just places the caret.
            onClick={e => { if (!open) openMenu(e.currentTarget); onClick?.(e) }}
            onKeyDown={e => {
              onKeyDown?.(e)
              if (e.key === 'Escape') { if (open) e.stopPropagation(); setOpen(false); return }
              if (e.key === 'ArrowDown') { e.preventDefault(); if (!open) setOpen(true); move(1); return }
              if (e.key === 'ArrowUp') { e.preventDefault(); if (open) move(-1); return }
              // A combobox owns Enter while its menu is open — the same rule
              // CustomerPicker documents, and for the same reason: this form's
              // implicit submit would otherwise save a half-built quote from the
              // service field. With nothing highlighted, Enter just closes the
              // menu and the typed name stands as a custom service.
              if (e.key === 'Enter' && open) { e.preventDefault(); if (hi >= 0) choose(hi); else setOpen(false) }
            }}
            className={cn(
              'w-full bg-bg-tertiary border text-ink placeholder:text-ink-faint outline-none transition-all',
              fieldSize === 'sm' ? 'rounded-lg pl-9 pr-8 py-2 text-sm' : 'rounded-xl pl-9 pr-9 py-3 text-base sm:text-sm',
              fieldBorder(error),
              className,
            )}
          />
          <ChevronDown className={cn('w-4 h-4 text-ink-faint absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none transition-transform', open && 'rotate-180')} />
          {open && (
            <div ref={listRef} id={listId} role="listbox" aria-label={label ? `${label} options` : 'Services'}
              data-eq-dropdown
              style={dropdownStyle(place)}
              className="absolute z-overlay w-full bg-bg-secondary border border-border-strong rounded-xl shadow-xl origin-top animate-pop overflow-y-auto overscroll-contain">
              {rows.length === 0 && (
                // Not an error state — the name they typed IS the service name,
                // so there is nothing else to do here. But say the right thing:
                // while a catalogue service is still attached this is a RENAME,
                // not a custom service, and claiming otherwise would be the UI
                // describing a save that isn't the one about to happen.
                <p className="px-3.5 py-2.5 text-sm text-ink-faint">
                  {selected
                    ? <>Nothing else matches — this stays your <span className="text-ink-muted">{selected.name}</span> service, renamed on the quote.</>
                    : 'Nothing in your catalogue matches — this saves as a custom service.'}
                </p>
              )}
              {rows.map((r, i) => r.type === 'header' ? (
                <p key={r.key} className="px-3.5 pt-2.5 pb-1 text-[10px] font-semibold uppercase tracking-wide text-ink-faint">{r.label}</p>
              ) : (
                <button key={r.key} type="button" data-hi={i === hi ? '1' : undefined}
                  id={optionId(r.t.id)} role="option" aria-selected={i === hi}
                  onPointerMove={() => setActiveTemplateId(r.t.id)} onClick={() => choose(i)}
                  className={cn('w-full text-left px-3.5 py-2.5 flex items-center gap-2 transition-colors',
                    // -raised, not `surface`: this popover's own fill IS the card
                    // rung, so highlighting a row with `surface` painted it the
                    // colour it already was. The inset marker distinguishes the
                    // active choice from a stationary pointer over another row.
                    i === hi ? 'bg-surface-raised ring-2 ring-inset ring-accent/60' : 'hover:bg-surface-raised')}>
                  <span className="min-w-0 flex-1">
                    {/* The NAME carries the row. Price is the supporting fact, one
                        step down in size and colour, so a scan reads services
                        rather than a rate card. */}
                    <span className="flex items-center gap-1.5 text-sm text-ink truncate">
                      {r.t.is_favorite && <Star className="w-3 h-3 text-accent-text shrink-0 fill-current" />}
                      {r.t.name}
                    </span>
                    <span className="block text-[11px] text-ink-faint truncate">{formatServicePrice(r.t)}</span>
                  </span>
                  {templateId === r.t.id && <Check className="w-4 h-4 text-accent-text shrink-0" />}
                </button>
              ))}
              {/* The way back OUT of the catalogue. The old <select> had it as
                  its "Select a service…" option; without it an adopted service
                  could only ever be swapped for another one, and a quote that
                  had become genuinely one-off would keep carrying a template id
                  that decides which pricing engine speaks. Last row, so it never
                  competes with the list it follows. */}
              {selected && onDetach && (
                <button type="button"
                  onClick={() => { onDetach(); setOpen(false); setFiltering(false); setQuery(''); setActiveTemplateId(null) }}
                  className="w-full text-left px-3.5 py-2.5 text-xs text-accent-text border-t border-border hover:bg-surface-raised transition-colors">
                  This isn’t “{selected.name}” — save it as one-off work
                </button>
              )}
            </div>
          )}
        </div>
        {error && <p id={errorId} className="text-xs text-red-400 animate-fade">{error}</p>}
        {hint && !error && <p id={hintId} className="text-xs text-ink-faint animate-fade">{hint}</p>}
      </div>
    )
  },
)

ServicePicker.displayName = 'ServicePicker'
export { ServicePicker }
