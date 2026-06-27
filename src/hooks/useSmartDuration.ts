'use client'

// ── Learned-duration hook (the ONE client seam for default on-site minutes) ──────
// Loads the Smart Labor model once (lib/labor) and produces the on-site-minutes
// estimate for the job being created. When `autoFill` + `onApply` are supplied it
// fills the duration field whenever it's still UNTOUCHED (empty / zero / the exact
// value we last applied) — never clobbering a number you typed — so EVERY job-
// creation surface defaults to the learned duration instead of a flat 60. Wraps
// the same estimateLabor/loadLaborModel engine SmartLaborField uses, so the form's
// quick-add path and the advanced Smart Labor card always agree on one number.

import { useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { loadLaborModel, estimateLabor, LaborModel, LaborEstimate } from '@/lib/labor'

export interface SmartDurationInput {
  sqft: number
  serviceType: string | null
  crewSize: number
  propertyId?: string | null
  isInitialVisit?: boolean
  overgrowth?: number
}

export interface SmartDuration {
  est: LaborEstimate | null
  model: LaborModel | null
  crewCost: number
  enabled: boolean
  setEnabled: (v: boolean) => void
  ready: boolean
}

export function useSmartDuration(
  input: SmartDurationInput,
  opts?: {
    value?: number | null              // the form's current duration (minutes)
    onApply?: (minutes: number) => void
    autoFill?: boolean                 // fill the field when untouched
    skip?: boolean                     // caller already owns an engine — do nothing
  },
): SmartDuration {
  const supabase = useMemo(() => createClient(), [])
  const [model, setModel] = useState<LaborModel | null>(null)
  const [enabled, setEnabled] = useState(true)
  const [crewCost, setCrewCost] = useState(40)
  const [ready, setReady] = useState(false)
  const lastApplied = useRef<number | null>(null)
  const skip = !!opts?.skip

  useEffect(() => {
    if (skip) return
    let active = true
    loadLaborModel(supabase).then(r => {
      if (!active) return
      if (r) { setModel(r.model); setEnabled(r.enabled); setCrewCost(r.crewCost) }
      setReady(true)
    })
    return () => { active = false }
  }, [supabase, skip])

  const est = useMemo<LaborEstimate | null>(() => {
    if (skip) return null
    if (input.sqft <= 0 && !input.propertyId) return null
    return estimateLabor(
      { sqft: input.sqft, serviceType: input.serviceType, crewSize: input.crewSize, propertyId: input.propertyId, isInitialVisit: input.isInitialVisit, overgrowth: input.overgrowth },
      model,
    )
  }, [skip, input.sqft, input.serviceType, input.crewSize, input.propertyId, input.isInitialVisit, input.overgrowth, model])

  // Auto-fill: only when ON and the field is untouched (empty / zero / the last
  // value we applied). Live-recalcs when crew/sqft/property change.
  useEffect(() => {
    if (skip || !opts?.autoFill || !opts.onApply || !enabled || !est) return
    const value = opts.value
    const untouched = value == null || value === 0 || value === lastApplied.current
    if (untouched && est.minutes !== value) {
      lastApplied.current = est.minutes
      opts.onApply(est.minutes)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skip, opts?.autoFill, opts?.value, enabled, est])

  return { est, model, crewCost, enabled, setEnabled, ready }
}