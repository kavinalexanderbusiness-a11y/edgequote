'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { loadAccountingData, type AccountingData } from '@/lib/accounting/data'
import { resolvePeriod, PERIOD_OPTIONS, type Period, type PeriodKey } from '@/lib/accounting/period'
import { PageHeader } from '@/components/layout/PageHeader'
import { Select } from '@/components/ui/Select'
import { Input } from '@/components/ui/Input'
import { Banner } from '@/components/ui/Banner'
import { SkeletonTiles } from '@/components/ui/Skeleton'
import { localTodayISO } from '@/lib/utils'

// ── The shared shell for every financial surface ─────────────────────────────
// Loads once, resolves the period once, shows the load-failure banner once.
//
// It exists because the alternative is eleven pages each doing their own auth +
// fetch + period state, which is eleven chances for one report to quietly read
// different rows than the one next to it. Sharing the loader is what makes "these
// two statements agree" a structural fact rather than a coincidence.

export interface ReportChildProps {
  data: AccountingData
  period: Period
  todayISO: string
}

interface Props {
  title: string
  description: string
  /** Statements are AT A DATE, not over a range — they get an as-at picker instead. */
  mode?: 'period' | 'asOf'
  action?: (p: ReportChildProps) => React.ReactNode
  children: (p: ReportChildProps & { asOf: string }) => React.ReactNode
  defaultPeriod?: PeriodKey
}

export function ReportShell({ title, description, mode = 'period', action, children, defaultPeriod = 'this_year' }: Props) {
  const supabase = useMemo(() => createClient(), [])
  const todayISO = useMemo(() => localTodayISO(), [])

  const [data, setData] = useState<AccountingData | null>(null)
  const [loading, setLoading] = useState(true)
  const [authError, setAuthError] = useState(false)

  const [periodKey, setPeriodKey] = useState<PeriodKey>(defaultPeriod)
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [asOf, setAsOf] = useState(todayISO)

  const load = useCallback(async () => {
    const { data: auth } = await supabase.auth.getUser()
    const uid = auth.user?.id
    if (!uid) { setAuthError(true); setLoading(false); return }
    setData(await loadAccountingData(supabase, uid))
    setLoading(false)
  }, [supabase])

  useEffect(() => { load() }, [load])

  const period = useMemo(
    () => resolvePeriod(periodKey, todayISO, { from: customFrom, to: customTo }),
    [periodKey, todayISO, customFrom, customTo],
  )

  const childProps: ReportChildProps = { data: data!, period, todayISO }

  return (
    <div className="rise">
      <PageHeader
        title={title}
        description={description}
        crumb={{ label: 'Accounting', href: '/dashboard/accounting' }}
        action={data && !loading ? action?.(childProps) : undefined}
      />

      {authError && <Banner tone="danger" className="mb-4">You need to be signed in to see these figures.</Banner>}

      {/* A failed query renders as $0, which is indistinguishable from a business
          that earned nothing. Never silent. */}
      {data && data.errors.length > 0 && (
        <Banner tone="danger" className="mb-4">
          <strong>These figures are incomplete.</strong> Some data didn&apos;t load
          ({data.errors.join('; ')}), so anything below may be understated. Reload before
          trusting a total.
        </Banner>
      )}

      <div className="flex flex-wrap items-end gap-3 mb-5">
        {mode === 'period' ? (
          <>
            <Select
              label="Period"
              fieldSize="sm"
              options={PERIOD_OPTIONS}
              value={periodKey}
              onChange={e => setPeriodKey(e.target.value as PeriodKey)}
              className="w-44"
            />
            {periodKey === 'custom' && (
              <>
                <Input label="From" type="date" fieldSize="sm" value={customFrom} onChange={e => setCustomFrom(e.target.value)} />
                <Input label="To" type="date" fieldSize="sm" value={customTo} onChange={e => setCustomTo(e.target.value)} />
              </>
            )}
            <span className="text-sm text-ink-faint pb-2">{period.label}</span>
          </>
        ) : (
          <>
            <Input label="As at" type="date" fieldSize="sm" value={asOf} onChange={e => setAsOf(e.target.value || todayISO)} />
            <span className="text-sm text-ink-faint pb-2">
              A position on one date, not a total over a period.
            </span>
          </>
        )}
      </div>

      {loading || !data ? <SkeletonTiles count={4} /> : children({ ...childProps, asOf })}
    </div>
  )
}
