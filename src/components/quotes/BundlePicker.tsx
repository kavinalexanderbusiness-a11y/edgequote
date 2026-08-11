'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Banner } from '@/components/ui/Banner'
import { InlineEmpty } from '@/components/ui/EmptyState'
import { SkeletonRows } from '@/components/ui/Skeleton'
import { formatCurrency } from '@/lib/utils'
import {
  bundleSummary, bundleTotal, templateIndex,
} from '@/lib/serviceBundles'
import type { ServiceBundle, ServiceBundleItem, ServiceBundleWithItems, ServiceTemplate } from '@/types'
import { Layers, ChevronRight } from 'lucide-react'

// ── "Start from a bundle" ────────────────────────────────────────────────────
// The USE door. A short list, one tap, and it closes — deliberately not a
// browser. The quote builder is already the longest form in the product and
// turning part of it into a catalogue explorer would cost more time than the
// bundle saves.
//
// It fetches its own bundles instead of taking them as a prop so that neither
// quote page has to grow a loader for a feature the owner may never open. The
// read happens when the sheet opens, not on every quote.
//
// PRICES SHOWN HERE ARE RESOLVED, not stored: a line with no price of its own
// is quoted at the CATALOGUE's current rate, so the figure on this row is the
// figure the quote will actually receive. Showing anything else would make the
// preview a second, disagreeing sum.

interface Props {
  /** The catalogue, for resolving each line's price. Passed in because the
   *  builder already holds it — a second fetch would be a second answer. */
  templates: ServiceTemplate[]
  /** Blocked, with the reason said out loud. Used for an options quote, where
   *  the database refuses line items outright. */
  blockedReason?: string | null
  onApply: (bundle: ServiceBundleWithItems) => void
}

export function BundlePicker({ templates, blockedReason, onApply }: Props) {
  const supabase = createClient()
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [bundles, setBundles] = useState<ServiceBundleWithItems[]>([])

  const tIndex = useMemo(() => templateIndex(templates), [templates])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    async function load() {
      setLoading(true); setError(null)
      const { data: { session } } = await supabase.auth.getSession()
      const uid = session?.user?.id
      if (!uid) { if (!cancelled) { setError('Could not confirm who you are.'); setLoading(false) } return }
      const [bRes, iRes] = await Promise.all([
        supabase.from('service_bundles').select('*').eq('user_id', uid).order('sort_order').order('name'),
        supabase.from('service_bundle_items').select('*').eq('user_id', uid).order('sort_order'),
      ])
      if (cancelled) return
      // A failed read must not render an EMPTY list as fact — an owner would
      // reasonably conclude their bundles are gone and start rebuilding them.
      if (bRes.error || iRes.error) {
        setError((bRes.error || iRes.error)!.message)
        setLoading(false)
        return
      }
      const items = (iRes.data as ServiceBundleItem[]) || []
      setBundles(((bRes.data as ServiceBundle[]) || []).map(b => ({
        ...b, items: items.filter(i => i.bundle_id === b.id),
      })))
      setLoading(false)
    }
    load()
    return () => { cancelled = true }
  }, [open, supabase])

  return (
    <>
      <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(true)}>
        <Layers className="w-3.5 h-3.5" /> Start from a bundle
      </Button>

      <Modal open={open} onClose={() => setOpen(false)} icon={Layers} size="md" title="Start from a bundle">
        <div className="space-y-3">
          {blockedReason ? (
            <Banner tone="warn">{blockedReason}</Banner>
          ) : loading ? (
            <SkeletonRows count={3} />
          ) : error ? (
            <Banner tone="danger">
              Could not load your bundles — they are still there, this list just couldn’t reach them. ({error})
            </Banner>
          ) : bundles.length === 0 ? (
            <InlineEmpty icon={Layers}>
              No bundles yet. Build a quote the way you like it, then open it and choose
              <span className="text-ink"> Save this scope as a bundle</span>.
            </InlineEmpty>
          ) : (
            <>
              <p className="text-xs text-ink-muted">
                This fills in the scope. Everything stays editable, and the bundle is not
                changed by anything you do to this quote.
              </p>
              <ul className="divide-y divide-border rounded-xl border border-border overflow-hidden">
                {bundles.map(b => (
                  <li key={b.id}>
                    {/* min-h-[52px] — a thumb target, not a text link. This list is
                        used one-handed on a phone more often than at a desk. */}
                    <button
                      type="button"
                      onClick={() => { onApply(b); setOpen(false) }}
                      className="w-full text-left flex items-center gap-3 px-4 py-3 min-h-[52px] hover:bg-surface-raised/40 transition-colors"
                    >
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-ink truncate">{b.name}</p>
                        <p className="text-xs text-ink-muted truncate">{bundleSummary(b.items)}</p>
                      </div>
                      <span className="text-sm font-semibold text-accent-text shrink-0 tabular-nums">
                        {formatCurrency(bundleTotal(b.items, tIndex))}
                      </span>
                      <ChevronRight className="w-4 h-4 text-ink-faint shrink-0" aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </Modal>
    </>
  )
}
