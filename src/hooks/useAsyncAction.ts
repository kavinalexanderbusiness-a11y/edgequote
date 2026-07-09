'use client'

import { useCallback, useRef, useState } from 'react'
import { toast } from '@/lib/toast'

// ── useAsyncAction ────────────────────────────────────────────────────────────
// ONE way to run an async action so every button behaves identically: a `loading`
// flag (for <Button loading>) + standardized success/error feedback through the
// shared toast system + double-click protection. Replaces the per-handler
// try/catch/setLoading/toast boilerplate copied across the app.
//
//   const save = useAsyncAction(() => persist(), { success: 'Saved', error: 'Couldn’t save' })
//   <Button loading={save.loading} onClick={save.run}>Save</Button>
//
// Pass `loading:` to route the whole thing through toast.promise (sticky spinner
// → success/error in one toast) instead of a plain success toast at the end.
interface AsyncActionOpts {
  success?: string
  error?: string
  loading?: string
  onError?: (e: unknown) => void
}

export function useAsyncAction<TArgs extends unknown[]>(
  fn: (...args: TArgs) => unknown | Promise<unknown>,
  opts: AsyncActionOpts = {},
) {
  const [loading, setLoading] = useState(false)
  const running = useRef(false)
  // Latest fn/opts via refs so `run` stays stable (no churn) yet never goes stale.
  const fnRef = useRef(fn); fnRef.current = fn
  const optsRef = useRef(opts); optsRef.current = opts

  const run = useCallback(async (...args: TArgs) => {
    if (running.current) return // ignore re-clicks while in flight
    running.current = true
    setLoading(true)
    const o = optsRef.current
    try {
      if (o.loading) {
        await toast.promise(Promise.resolve(fnRef.current(...args)), {
          loading: o.loading,
          success: o.success ?? 'Done',
          error: o.error ?? 'Something went wrong.',
        })
      } else {
        await fnRef.current(...args)
        if (o.success) toast.success(o.success)
      }
    } catch (e) {
      if (!o.loading) toast.error(o.error ?? 'Something went wrong.')
      o.onError?.(e)
    } finally {
      running.current = false
      setLoading(false)
    }
  }, [])

  return { run, loading }
}
