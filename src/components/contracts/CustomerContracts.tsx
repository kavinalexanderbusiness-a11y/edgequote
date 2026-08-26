'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import {
  STATUS_LABEL, contractSignatures, listContracts, renewalLabel, toView,
  type ContractView,
} from '@/lib/contracts'
import { cn } from '@/lib/utils'
import { ButtonLink } from '@/components/ui/Button'
import { InlineEmpty } from '@/components/ui/EmptyState'
import { SkeletonRows } from '@/components/ui/Skeleton'
import { SectionHeading } from '@/components/ui/SectionHeading'
import { FileSignature, Plus, CheckCircle2 } from 'lucide-react'

// ── Contracts on the customer record ─────────────────────────────────────────
// The other half of "contracts are easy to find": Contracts → customer is the
// list page; this is customer → Contracts.
//
// ⭐ It renders the SAME view objects the list page does (lib/contracts.toView),
// so a contract cannot read "active" here and "expired" there.

export function CustomerContracts({ userId, customerId }: { userId: string; customerId: string }) {
  const supabase = useMemo(() => createClient(), [])
  const [rows, setRows] = useState<ContractView[]>([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const records = await listContracts(supabase, userId, { customerId })
      const sigs = await contractSignatures(
        supabase, records.map(r => r.signature_request_id).filter(Boolean) as string[])
      setRows(records.map(r => toView(r, sigs)))
      setFailed(false)
    } catch {
      // ⭐ "Couldn't load" is not "none". Telling an owner a customer has no
      // agreements when we simply could not look is the false-all-clear this
      // codebase has been bitten by before.
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }, [supabase, userId, customerId])

  useEffect(() => { void load() }, [load])

  return (
    <div className="space-y-3">
      <SectionHeading
        icon={FileSignature}
        title="Contracts"
        action={
          <ButtonLink href={`/dashboard/contracts/new?customer=${customerId}`} variant="ghost" size="sm">
            <Plus className="w-4 h-4" /> New
          </ButtonLink>
        }
      />

      {loading ? <SkeletonRows count={2} />
        : failed ? (
          <InlineEmpty icon={FileSignature}>
            Couldn’t load contracts.{' '}
            <button type="button" onClick={() => void load()} className="underline">Try again</button>
          </InlineEmpty>
        ) : rows.length === 0 ? (
          <InlineEmpty icon={FileSignature}>No contracts with this customer yet.</InlineEmpty>
        ) : (
          <ul className="space-y-1.5">
            {rows.map(c => {
              const note = renewalLabel(c.renewal)
              return (
                <li key={c.id}>
                  {/* The whole row is the tap target. */}
                  <Link href={`/dashboard/contracts/${c.id}`}
                    className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between rounded-lg px-3 py-2 hover:bg-surface-2 transition-colors">
                    <span className="min-w-0">
                      <span className="font-medium text-ink truncate block">{c.title}</span>
                      <span className="text-xs text-ink-soft">
                        {STATUS_LABEL[c.display]}
                        {c.signed && ' · signed'}
                      </span>
                    </span>
                    <span className="text-xs text-ink-soft sm:text-right shrink-0">
                      <span className="block">{c.termLabel}</span>
                      {note && (
                        <span className={cn('block',
                          c.renewal.state === 'expired' ? 'text-ink-faint' : 'text-amber-700 dark:text-amber-400')}>
                          {note}
                        </span>
                      )}
                    </span>
                    {c.signed && <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 hidden sm:block" />}
                  </Link>
                </li>
              )
            })}
          </ul>
        )}
    </div>
  )
}
