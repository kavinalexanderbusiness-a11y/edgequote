'use client'

import { useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Banner } from '@/components/ui/Banner'
import { toast } from '@/lib/toast'
import { formatCurrency } from '@/lib/utils'
import {
  captureBundleItems, cleanBundleName, templateIndex, type BundleSourceLine,
} from '@/lib/serviceBundles'
import { serviceLineTotals } from '@/lib/quoteServices'
import type { Quote, QuoteService, ServiceTemplate } from '@/types'
import { Layers } from 'lucide-react'

// ── "Save this scope as a bundle" ────────────────────────────────────────────
// THE CREATION DOOR, and deliberately the only one in V1. The alternative — a
// Settings screen where an owner builds bundles from nothing — asks them to
// configure the product before it has done anything for them. This asks at the
// one moment the scope already exists and is known to be right: they have just
// quoted it for a real job.
//
// It lives on the quote DETAIL page rather than in the builder because the
// scope here is SAVED. Capturing half-typed form state would let a bundle
// record a line the owner was still in the middle of changing their mind about.

interface Props {
  open: boolean
  onClose: () => void
  quote: Quote
  /** The quote's line rows. Empty on a legacy single-service quote, which is
   *  still a perfectly good one-line bundle — see `sourceLines` below. */
  services: QuoteService[]
  templates: ServiceTemplate[]
  /** Bundle names this business already has, lower-cased. The database refuses
   *  a duplicate (unique index); this catches it before the owner types a
   *  description they would then lose. */
  existingNames: string[]
}

export function SaveAsBundleDialog({ open, onClose, quote, services, templates, existingNames }: Props) {
  const supabase = createClient()
  const [name, setName] = useState(() => quote.service_type || '')
  const [saving, setSaving] = useState(false)

  const tIndex = useMemo(() => templateIndex(templates), [templates])

  // What this quote's scope IS. A multi-service quote keeps it in child rows; a
  // single-service one keeps it in the quote's own flat fields. Both are real
  // scopes, so both can become a bundle — reading only the child rows would
  // have made "Save as bundle" silently impossible on the commonest quote in
  // the database (81 of 95 live quotes carry no child rows at all).
  const sourceLines: BundleSourceLine[] = useMemo(() => {
    if (services.length) {
      return [...services]
        .sort((a, b) => a.sort_order - b.sort_order)
        .map(s => ({
          service_type: s.service_type,
          service_template_id: s.service_template_id,
          quantity: Number(s.quantity) || 1,
          unit: s.unit,
          unit_price: Number(s.unit_price) || 0,
          est_minutes: s.est_minutes,
          notes: s.notes,
          kind: s.kind,
        }))
    }
    if (!(quote.service_type || '').trim()) return []
    return [{
      service_type: quote.service_type,
      service_template_id: quote.service_template_id,
      quantity: 1,
      unit: 'each',
      unit_price: Number(quote.initial_price) || 0,
      est_minutes: Number(quote.hours) > 0 ? Math.round(Number(quote.hours) * 60) : null,
      notes: null,
      kind: 'service' as const,
    }]
  }, [services, quote])

  const items = useMemo(() => captureBundleItems(sourceLines, tIndex), [sourceLines, tIndex])

  const cleaned = cleanBundleName(name)
  const duplicate = !!cleaned && existingNames.includes(cleaned.toLowerCase())
  const nothingToSave = items.length === 0

  async function save() {
    if (!cleaned || duplicate || nothingToSave || saving) return
    setSaving(true)
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { toast.error('Could not confirm who you are — nothing was saved.'); setSaving(false); return }

    const { data: bundle, error } = await supabase
      .from('service_bundles')
      .insert({ user_id: user.id, name: cleaned, sort_order: 0 })
      .select('id')
      .single()
    // A Supabase insert RESOLVES on failure. Branch on the error or the owner
    // believes they have a bundle they do not have.
    if (error || !bundle) {
      toast.error('Could not save the bundle: ' + (error?.message ?? 'no row came back') + ' — nothing was saved.')
      setSaving(false)
      return
    }

    const { error: itemErr } = await supabase
      .from('service_bundle_items')
      .insert(items.map(it => ({ ...it, bundle_id: bundle.id, user_id: user.id })))
    if (itemErr) {
      // A bundle with a name and no lines is worse than no bundle: it would sit
      // in the picker offering nothing. Take the header back out so the owner
      // is left exactly where they started, and say so.
      await supabase.from('service_bundles').delete().eq('id', bundle.id)
      toast.error('Could not save the bundle’s lines: ' + itemErr.message + ' — nothing was saved.')
      setSaving(false)
      return
    }

    toast.success(`Saved “${cleaned}” — you can start a quote from it.`)
    setSaving(false)
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={() => !saving && onClose()}
      icon={Layers}
      size="md"
      title="Save this scope as a bundle"
      onSubmit={save}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={save} loading={saving} disabled={!cleaned || duplicate || nothingToSave}>
            Save bundle
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <p className="text-xs text-ink-muted">
          A bundle is a starting point for future quotes — the work, not this customer.
          Applying it later creates a fresh, independent scope you can change freely.
        </p>

        {nothingToSave ? (
          <Banner tone="warn">
            This quote has no service lines to save yet.
          </Banner>
        ) : (
          <>
            <Input
              label="Bundle name *"
              autoFocus
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. Spring Cleanup"
              error={duplicate ? 'You already have a bundle with this name.' : undefined}
            />

            <div className="rounded-xl border border-border bg-surface/30 p-4 space-y-2">
              <h3 className="text-xs font-semibold text-ink">
                What gets saved <span className="font-normal text-ink-faint">· {items.length} line{items.length === 1 ? '' : 's'}</span>
              </h3>
              <ul className="space-y-1.5">
                {items.map((it, i) => {
                  // The price shown is the one this bundle will actually lay
                  // down — including "follows the catalogue", which is what a
                  // null captured price MEANS. Showing the quote's number here
                  // would promise a figure the bundle does not store.
                  const t = it.service_template_id ? tIndex.get(it.service_template_id) : null
                  const resolved = it.unit_price ?? (t ? Number(t.default_rate) : 0)
                  const net = serviceLineTotals({
                    quantity: it.quantity, unit_price: resolved,
                    discount_type: null, discount_value: null,
                  }).net
                  return (
                    <li key={i} className="flex items-baseline justify-between gap-3 text-xs">
                      <span className="text-ink truncate">
                        {it.name}
                        {it.quantity !== 1 && <span className="text-ink-faint"> ×{it.quantity}</span>}
                        {it.kind === 'material' && <span className="text-ink-faint"> · material</span>}
                      </span>
                      <span className="shrink-0 text-ink-muted tabular-nums">
                        {formatCurrency(net)}
                        {it.unit_price == null && t && (
                          <span className="text-ink-faint"> · follows catalogue</span>
                        )}
                      </span>
                    </li>
                  )
                })}
              </ul>
              <p className="text-[11px] text-ink-faint pt-1 border-t border-border">
                Not saved: the customer, address, measurements, travel, recurring prices and
                quote notes. A price that matched your catalogue is stored as “follow the
                catalogue”, so re-pricing that service in Settings still reaches future quotes.
              </p>
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}
