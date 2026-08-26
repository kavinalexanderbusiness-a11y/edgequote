'use client'

import { useEffect, useState } from 'react'
import { MapPinOff, ChevronDown } from 'lucide-react'
import type { MapsUnavailable } from '@/lib/googleMaps'

// ── THE "there is no map" panel ──────────────────────────────────────────────
// Every surface that shows a Google map renders THIS when it can't. One panel,
// so a broken Maps configuration reads the same everywhere and no component
// invents its own wording (or, as before, shows Google's grey "Oops!" box and
// leaves it there).
//
// ⭐ THE AUDIENCE IS A PROP, AND IT IS THE WHOLE POINT.
// `owner` gets the actionable sentence plus a collapsed technical detail — which
// origin Google refused, and what to change in the Cloud Console.
// `customer` gets ONE neutral sentence and NOTHING else: the public booking
// funnel must never tell a stranger that this business's API key is misconfigured,
// nor print the origin, the key's project, or the words "Maps configuration".
//
// ⛔ `detail` is never rendered for `customer`. verify:measure-price asserts that
// this component is the only reader of MapsUnavailable.detail and that the
// customer branch cannot reach it.

export type MapAudience = 'owner' | 'customer'

/** What a stranger on the public funnel sees. Says the map is missing, nothing more. */
const CUSTOMER_MESSAGE = 'The map isn’t available right now.'

export function MapUnavailable({
  unavailable,
  audience = 'owner',
  className = '',
}: {
  unavailable: MapsUnavailable
  audience?: MapAudience
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const owner = audience === 'owner'

  // The diagnostic belongs in logs regardless of who is looking — that is the
  // half a customer must not see but an owner reading a support ticket needs.
  useEffect(() => {
    console.error(`[maps:${unavailable.reason}] ${unavailable.detail}`)
  }, [unavailable.reason, unavailable.detail])

  return (
    <div
      role="status"
      className={`rounded-card border border-amber-500/20 bg-amber-500/[0.06] px-4 py-5 text-center ${className}`}
    >
      <MapPinOff className="w-6 h-6 mx-auto text-amber-400" aria-hidden="true" />
      <p className="mt-2 text-sm font-medium text-ink">
        {owner ? unavailable.message : CUSTOMER_MESSAGE}
      </p>

      {owner ? (
        <>
          <p className="mt-1 text-xs text-ink-muted">
            Everything else on this page still works — you can enter measurements by hand.
          </p>
          {/* Collapsed by default: the owner needs to know the map is broken, not
              to read a paragraph about referrer allowlists every time. */}
          <button
            type="button"
            onClick={() => setOpen(o => !o)}
            aria-expanded={open}
            className="mt-3 inline-flex items-center gap-1 text-[11px] font-medium text-ink-muted hover:text-ink transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 rounded"
          >
            <ChevronDown className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
            {open ? 'Hide details' : 'Show details'}
          </button>
          {open && (
            <p className="mt-2 text-left text-[11px] leading-relaxed text-ink-muted font-mono break-words">
              {unavailable.detail}
            </p>
          )}
        </>
      ) : (
        <p className="mt-1 text-xs text-ink-muted">
          You can still continue — just type your address below.
        </p>
      )}
    </div>
  )
}
