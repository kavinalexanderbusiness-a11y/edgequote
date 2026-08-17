// ── Estimate appointments: the one data door ─────────────────────────────────
//
// Every surface that schedules, moves, completes or cancels an estimate visit
// goes through this hook. There is exactly one reason for that: an estimate
// appointment's whole purpose is to be NOT a job, and the fastest way to lose
// that is for the fifth caller to write its own `.from('schedule_items')` and
// quietly re-invent a rule (which statuses are terminal, what completing stamps,
// whether a cancel keeps its reason) slightly differently.
//
// The rules themselves live in lib/estimateAppointments — pure and testable.
// This file is only the I/O around them.

'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { ITEM_SELECT, type ScheduleItem, type ScheduleItemStatus } from '@/lib/scheduleItems'
import {
  type EstimateAppointment, type EstimateInput,
  canTransition, isEstimateAppointment, statusPatch, validateEstimate,
} from '@/lib/estimateAppointments'

export interface UseEstimateAppointments {
  items: EstimateAppointment[]
  loading: boolean
  /** A READ that failed. Never silently an empty day — see below. */
  error: string | null
  reload: () => Promise<void>
  create: (input: EstimateInput) => Promise<{ id: string | null; error: string | null }>
  update: (id: string, patch: Partial<EstimateInput>) => Promise<string | null>
  setStatus: (id: string, to: ScheduleItemStatus, reason?: string | null) => Promise<string | null>
  linkQuote: (id: string, quoteId: string | null) => Promise<string | null>
  remove: (id: string) => Promise<string | null>
}

/**
 * @param fromISO/@param toISO  inclusive date window, or omit for "everything".
 *
 * ⚠️ A FAILED READ IS AN ERROR, NEVER AN EMPTY DAY. The same rule the day-status
 * and location surfaces had to learn: returning [] on failure tells the owner
 * "you have no estimates today", which is a claim, and it is the one claim that
 * makes them drive past a customer who is expecting them.
 */
export function useEstimateAppointments(fromISO?: string, toISO?: string): UseEstimateAppointments {
  const supabase = useMemo(() => createClient(), [])
  const [items, setItems] = useState<EstimateAppointment[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession()
    const uid = session?.user?.id
    if (!uid) { setLoading(false); return }
    let q = supabase
      .from('schedule_items')
      .select(ITEM_SELECT)
      .eq('user_id', uid)
      .eq('type', 'estimate')
      .order('scheduled_date')
      .order('start_time', { nullsFirst: false })
    if (fromISO) q = q.gte('scheduled_date', fromISO)
    if (toISO) q = q.lte('scheduled_date', toISO)
    const { data, error: err } = await q
    if (err) { setError(err.message); setLoading(false); return }
    setError(null)
    setItems(((data || []) as unknown as ScheduleItem[]).filter(isEstimateAppointment))
    setLoading(false)
  }, [supabase, fromISO, toISO])

  useEffect(() => { void reload() }, [reload])

  const create = useCallback<UseEstimateAppointments['create']>(async (input) => {
    const invalid = validateEstimate(input)
    if (invalid) return { id: null, error: invalid }
    const { data: { session } } = await supabase.auth.getSession()
    const uid = session?.user?.id
    if (!uid) return { id: null, error: 'You are signed out.' }
    const { data, error: err } = await supabase.from('schedule_items').insert({
      ...input,
      user_id: uid,
      type: 'estimate',
      status: 'scheduled',
    }).select('id').single()
    if (err) return { id: null, error: err.message }
    await reload()
    return { id: (data as { id: string }).id, error: null }
  }, [supabase, reload])

  const update = useCallback<UseEstimateAppointments['update']>(async (id, patch) => {
    // Validate the MERGED row, not the patch: a patch that only moves the date
    // is legal on its own but must still leave a row the constraints accept.
    const current = items.find(i => i.id === id)
    const invalid = validateEstimate({ ...current, ...patch } as Partial<EstimateInput>)
    if (invalid) return invalid
    const { error: err } = await supabase.from('schedule_items').update(patch).eq('id', id)
    if (err) return err.message
    await reload()
    return null
  }, [supabase, reload, items])

  const setStatus = useCallback<UseEstimateAppointments['setStatus']>(async (id, to, reason) => {
    const current = items.find(i => i.id === id)
    if (current && !canTransition(current.status, to)) {
      return `An estimate that is ${current.status.replace('_', ' ')} can only be reopened.`
    }
    const { error: err } = await supabase.from('schedule_items').update(statusPatch(to, reason)).eq('id', id)
    if (err) return err.message
    await reload()
    return null
  }, [supabase, reload, items])

  const linkQuote = useCallback<UseEstimateAppointments['linkQuote']>(async (id, quoteId) => {
    const { error: err } = await supabase.from('schedule_items').update({ converted_quote_id: quoteId }).eq('id', id)
    if (err) return err.message
    await reload()
    return null
  }, [supabase, reload])

  const remove = useCallback<UseEstimateAppointments['remove']>(async (id) => {
    const { error: err } = await supabase.from('schedule_items').delete().eq('id', id)
    if (err) return err.message
    await reload()
    return null
  }, [supabase, reload])

  return { items, loading, error, reload, create, update, setStatus, linkQuote, remove }
}
