'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import {
  type ContractRecord, type ContractView, type ContractDisplayStatus,
  STATUS_LABEL, listContracts, contractSignatures, toView, renewalLabel,
} from '@/lib/contracts'
import { cn } from '@/lib/utils'
import { PageContainer } from '@/components/layout/PageContainer'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card, CardBody } from '@/components/ui/Card'
import { ButtonLink } from '@/components/ui/Button'
import { StatTile } from '@/components/ui/StatTile'
import { FilterPill } from '@/components/ui/FilterPill'
import { EmptyState } from '@/components/ui/EmptyState'
import { SkeletonRows } from '@/components/ui/Skeleton'
import { Banner } from '@/components/ui/Banner'
import { FileSignature, Plus, AlertTriangle, CheckCircle2, Clock, FileText } from 'lucide-react'

// ── Contracts ────────────────────────────────────────────────────────────────
// The commercial agreements the business is standing behind. Every judgement
// shown here — whether a contract has expired, whether it is coming up for
// renewal — is read from THE contracts engine (lib/contracts); this page only
// renders it, so it can never disagree with the database or another surface.
//
// ⛔ This page shows no schedule. A contract may govern a recurring series, but
// when visits happen is the Schedule's answer, not this one's.

type Filter = 'all' | ContractDisplayStatus

const TONE: Record<ContractDisplayStatus, string> = {
  draft: 'bg-surface-2 text-ink-soft',
  sent: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
  active: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  expired: 'bg-surface-2 text-ink-faint',
  terminated: 'bg-surface-2 text-ink-faint',
  superseded: 'bg-surface-2 text-ink-faint',
}

export default function ContractsPage() {
  const supabase = useMemo(() => createClient(), [])
  const [rows, setRows] = useState<ContractView[]>([])
  const [names, setNames] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('all')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return
      const records: ContractRecord[] = await listContracts(supabase, user.id)
      const sigs = await contractSignatures(
        supabase, records.map(r => r.signature_request_id).filter(Boolean) as string[])
      setRows(records.map(r => toView(r, sigs)))

      const ids = [...new Set(records.map(r => r.customer_id))]
      if (ids.length) {
        const { data } = await supabase.from('customers').select('id, name').in('id', ids)
        setNames(Object.fromEntries(((data as { id: string; name: string }[]) || [])
          .map(c => [c.id, c.name])))
      }
      setLoadError(null)
    } catch (e) {
      // ⭐ A failed read is NOT "no contracts". Saying so would tell an owner
      // they have no agreements when in fact we could not look.
      setLoadError(e instanceof Error ? e.message : 'Could not load contracts.')
    } finally {
      setLoading(false)
    }
  }, [supabase])

  useEffect(() => { void load() }, [load])

  const counts = useMemo(() => {
    const c = { active: 0, sent: 0, attention: 0 }
    for (const r of rows) {
      if (r.display === 'active') c.active++
      if (r.display === 'sent') c.sent++
      if (r.display === 'expired' || r.renewal.state === 'expiring_soon') c.attention++
    }
    return c
  }, [rows])

  const shown = useMemo(
    () => filter === 'all' ? rows : rows.filter(r => r.display === filter),
    [rows, filter])

  return (
    <PageContainer>
      <PageHeader
        title="Contracts"
        description="Service agreements and contracts, and where each one stands."
        action={
          <ButtonLink href="/dashboard/contracts/new">
            <Plus className="w-4 h-4" /> New contract
          </ButtonLink>
        }
      />

      {loadError && (
        <Banner tone="danger" className="mb-4">
          {loadError} <button onClick={() => void load()} className="underline">Try again</button>
        </Banner>
      )}

      {/* Wraps rather than scrolls: three tiles must fit a 375px phone. */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
        <StatTile label="Active" value={String(counts.active)} icon={CheckCircle2} />
        <StatTile label="Awaiting signature" value={String(counts.sent)} icon={Clock} />
        <StatTile label="Needs attention" value={String(counts.attention)} icon={AlertTriangle} />
      </div>

      <div className="flex flex-wrap gap-2 mb-4">
        {(['all', 'draft', 'sent', 'active', 'expired', 'terminated', 'superseded'] as Filter[]).map(f => (
          <FilterPill key={f} active={filter === f} onClick={() => setFilter(f)}>
            {f === 'all' ? 'All' : STATUS_LABEL[f as ContractDisplayStatus]}
          </FilterPill>
        ))}
      </div>

      {loading ? <SkeletonRows count={4} /> : shown.length === 0 ? (
        <EmptyState
          icon={FileSignature}
          title={rows.length === 0 ? 'No contracts yet' : 'Nothing in this view'}
          description={rows.length === 0
            ? 'Create an agreement from a template, or start blank. It becomes a signed record once the customer signs.'
            : 'Try another filter.'}
          action={rows.length === 0 ? { label: 'New contract', href: '/dashboard/contracts/new' } : undefined}
        />
      ) : (
        <div className="space-y-2">
          {shown.map(c => {
            const note = renewalLabel(c.renewal)
            return (
              <Card key={c.id}>
                {/* The whole row is the tap target — a phone should not require
                    hitting a small link. */}
                <Link href={`/dashboard/contracts/${c.id}`} className="block">
                  <CardBody className="py-3">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium text-ink truncate">{c.title}</span>
                          <span className={cn('px-2 py-0.5 rounded-full text-[11px] font-medium', TONE[c.display])}>
                            {STATUS_LABEL[c.display]}
                          </span>
                          {c.signed && (
                            <span className="inline-flex items-center gap-1 text-[11px] text-emerald-700 dark:text-emerald-400">
                              <CheckCircle2 className="w-3 h-3" /> Signed
                            </span>
                          )}
                        </div>
                        <div className="text-sm text-ink-soft truncate mt-0.5">
                          {names[c.customer_id] ?? 'Customer'}
                          {c.contract_type ? ` · ${c.contract_type}` : ''}
                        </div>
                      </div>
                      <div className="text-sm text-ink-soft sm:text-right shrink-0">
                        <div>{c.termLabel}</div>
                        {note && (
                          <div className={cn('text-[12px]',
                            c.renewal.state === 'expired'
                              ? 'text-ink-faint'
                              : 'text-amber-700 dark:text-amber-400')}>
                            {note}
                          </div>
                        )}
                      </div>
                    </div>
                  </CardBody>
                </Link>
              </Card>
            )
          })}
        </div>
      )}

      <p className="mt-6 text-xs text-ink-faint flex items-start gap-1.5">
        <FileText className="w-3.5 h-3.5 mt-0.5 shrink-0" />
        {/* ⛔ LEGAL HONESTY. EdgeHQ provides the infrastructure; it does not
            claim the result is binding anywhere in particular, and it gives no
            legal advice. */}
        EdgeHQ records who signed, when, and exactly which version they agreed to.
        It does not provide legal advice, and whether an agreement is enforceable
        depends on your jurisdiction.
      </p>
    </PageContainer>
  )
}
