'use client'

import { useEffect, useRef, useState } from 'react'
import type { Part } from '@/lib/parts'
import { findBySku, searchParts, normalizeSku } from '@/lib/inventory/analytics'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'
import { X } from 'lucide-react'

// ── Barcode scanning ─────────────────────────────────────────────────────────
// Reads the EXISTING parts.sku field. No barcode column, no barcode table, no
// camera library: a USB/Bluetooth barcode gun IS a keyboard — it types the SKU
// and presses Enter. That is the hardware crews actually have, it works offline,
// and it costs nothing to support. Typing the SKU by hand goes down the same
// path, so this is never a dead end when the gun's flat.
//
// ⚠️ AN AMBIGUOUS SCAN NEVER PICKS A PART. findBySku returns null when a scan
// matches more than one thing; we show the candidates and let a human choose.
// Guessing here would move stock on the wrong shelf — silently, and at speed.

export function ScanInput({ parts, onPick, autoFocus, placeholder, className }: {
  parts: Part[]
  onPick: (part: Part) => void
  autoFocus?: boolean
  placeholder?: string
  className?: string
}) {
  const [scan, setScan] = useState('')
  const [candidates, setCandidates] = useState<Part[]>([])
  const [miss, setMiss] = useState<string | null>(null)
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => { if (autoFocus) ref.current?.focus() }, [autoFocus])

  function submit(raw: string) {
    const q = normalizeSku(raw)
    if (!q) return
    const hit = findBySku(raw, parts)
    if (hit) { onPick(hit); reset(); return }
    // No single answer — show what it could be rather than guess or just fail.
    const near = searchParts(raw, parts)
    if (near.length) { setCandidates(near); setMiss(null) }
    else { setCandidates([]); setMiss(raw.trim()) }
  }

  function reset() {
    setScan(''); setCandidates([]); setMiss(null)
    ref.current?.focus() // keep the gun live for the next scan
  }

  return (
    <div className={cn('space-y-2', className)}>
      <form onSubmit={e => { e.preventDefault(); submit(scan) }}>
        <Input
          ref={ref}
          label="Scan or type a SKU"
          value={scan}
          onChange={e => { setScan(e.target.value); setMiss(null); setCandidates([]) }}
          placeholder={placeholder ?? 'Scan a barcode, or type a SKU or name'}
          autoComplete="off"
          // A barcode gun ends with Enter — this is the whole integration.
          enterKeyHint="search"
          hint="A barcode scanner types the SKU and presses Enter."
        />
      </form>

      {candidates.length > 0 && (
        <div className="rounded-xl border border-border overflow-hidden">
          <div className="flex items-center justify-between px-3 py-1.5 bg-surface-2">
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
              {candidates.length} possible match{candidates.length !== 1 ? 'es' : ''} — pick one
            </p>
            <Button variant="ghost" size="sm" onClick={reset} aria-label="Clear"><X className="w-3.5 h-3.5" /></Button>
          </div>
          <ul className="divide-y divide-border max-h-56 overflow-y-auto">
            {candidates.map(p => (
              <li key={p.id}>
                <button type="button" onClick={() => { onPick(p); reset() }}
                  className="w-full text-left px-3 py-2 hover:bg-surface-2 transition-colors">
                  <p className="text-sm text-ink">{p.name}</p>
                  {p.sku && <p className="text-[11px] text-ink-faint tabular-nums">SKU {p.sku}</p>}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {miss && (
        <div className="rounded-xl border border-border px-3 py-2">
          {/* Not an error — a part that hasn't been given its SKU yet. Say the
              fix, since the owner is standing at the shelf holding the box. */}
          <p className="text-xs text-ink-muted">
            Nothing matches <span className="text-ink font-medium tabular-nums">{miss}</span>.
            Add it as the part&apos;s SKU and the next scan will find it.
          </p>
        </div>
      )}
    </div>
  )
}
