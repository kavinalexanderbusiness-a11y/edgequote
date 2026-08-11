'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Card, CardHeader, CardBody } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Textarea } from '@/components/ui/Textarea'
import { Modal } from '@/components/ui/Modal'
import { Banner } from '@/components/ui/Banner'
import { InlineEmpty } from '@/components/ui/EmptyState'
import { SkeletonRows } from '@/components/ui/Skeleton'
import { toast } from '@/lib/toast'
import { confirm } from '@/lib/confirm'
import { formatCurrency } from '@/lib/utils'
import { serviceLineTotals } from '@/lib/quoteServices'
import {
  bundleSummary, bundleTotal, cleanBundleName, priceBasis, resolveUnitPrice, templateIndex,
} from '@/lib/serviceBundles'
import type { ServiceBundle, ServiceBundleItem, ServiceBundleWithItems, ServiceTemplate } from '@/types'
import { Layers, Pencil, Trash2, ChevronDown, ChevronRight } from 'lucide-react'

// ── Bundle management ────────────────────────────────────────────────────────
// Rename, re-describe, delete, and SEE what each bundle will lay down. It is
// deliberately not a builder: bundles are created from a real quote ("Save this
// scope as a bundle"), because a screen where an owner assembles one from
// nothing is the configuration chore this feature exists to avoid.
//
// ⭐ V2 SEAM, left open on purpose: editing the LINES belongs here eventually.
// V1 stops at the header because the workflow that replaces it — save a fresh
// bundle off a corrected quote, delete the old one — costs two taps and needs
// no form engine. Adding one before anybody has asked is how a "template
// system" becomes a custom-form product.
//
// It shares the Settings › Service Templates page with the CATALOGUE for one
// reason: those two things are constantly confused, and the fastest way to keep
// them apart is to let an owner see, in one scroll, that a service is one row
// with one price and a bundle is a named set of them.

export function ServiceBundles({ templates }: { templates: ServiceTemplate[] }) {
  const supabase = createClient()
  const [bundles, setBundles] = useState<ServiceBundleWithItems[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [editing, setEditing] = useState<ServiceBundleWithItems | null>(null)

  const tIndex = useMemo(() => templateIndex(templates), [templates])

  const load = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession()
    const uid = session?.user?.id
    if (!uid) { setError('Could not confirm who you are.'); setLoading(false); return }
    const [bRes, iRes] = await Promise.all([
      supabase.from('service_bundles').select('*').eq('user_id', uid).order('sort_order').order('name'),
      supabase.from('service_bundle_items').select('*').eq('user_id', uid).order('sort_order'),
    ])
    // A failed read must not render an EMPTY list as fact.
    if (bRes.error || iRes.error) {
      setError((bRes.error || iRes.error)!.message)
      setLoading(false)
      return
    }
    const items = (iRes.data as ServiceBundleItem[]) || []
    setBundles(((bRes.data as ServiceBundle[]) || []).map(b => ({
      ...b, items: items.filter(i => i.bundle_id === b.id),
    })))
    setError(null)
    setLoading(false)
  }, [supabase])

  useEffect(() => { load() }, [load])

  async function remove(b: ServiceBundleWithItems) {
    const ok = await confirm({
      title: `Delete “${b.name}”?`,
      // The one thing an owner is right to worry about, answered before they
      // have to ask. It is true by construction: no quote references a bundle.
      message: 'Quotes you already built from it are not affected — they hold their own copy of the scope.',
      confirmLabel: 'Delete bundle',
      destructive: true,
      icon: Trash2,
    })
    if (!ok) return
    // Verify the delete BEFORE announcing it. A failed delete with a cheery
    // toast leaves the row alive while the owner believes it is gone.
    const { error: delErr } = await supabase.from('service_bundles').delete().eq('id', b.id)
    if (delErr) { toast.error(`Could not delete “${b.name}”: ` + delErr.message); return }
    setBundles(prev => prev.filter(x => x.id !== b.id))
    toast.undo(`Deleted “${b.name}”`, async () => {
      // Same ids back, header first (the items' composite FK names it).
      const { items, ...header } = b
      const { error: hErr } = await supabase.from('service_bundles').insert(header)
      if (hErr) { toast.error(`Could not restore “${b.name}”.`); return }
      if (items.length) {
        const { error: iErr } = await supabase.from('service_bundle_items').insert(items)
        if (iErr) {
          await supabase.from('service_bundles').delete().eq('id', b.id)
          toast.error(`Could not restore “${b.name}” — its lines came back empty, so nothing was restored.`)
          return
        }
      }
      load()
    })
  }

  return (
    <div className="mt-8">
      <div className="mb-2 px-1">
        <h3 className="text-[10px] font-semibold text-ink-faint uppercase tracking-[0.14em]">Bundles</h3>
      </div>
      <Card>
        <CardHeader>
          <div>
            <h2 className="text-sm font-semibold text-ink">Reusable scopes</h2>
            <p className="text-xs text-ink-muted mt-0.5">
              A bundle is several of the services above, saved together — “Spring Cleanup”,
              “Move-out clean”. Starting a quote from one fills in the scope; changing a
              bundle never changes a quote you already made.
            </p>
          </div>
        </CardHeader>
        <CardBody className="p-0">
          {loading ? (
            <div className="p-2"><SkeletonRows count={2} /></div>
          ) : error ? (
            <div className="p-4">
              <Banner tone="danger" action={<Button size="sm" variant="secondary" onClick={() => { setLoading(true); load() }}>Retry</Button>}>
                Could not load your bundles — they are still there, this list just couldn’t reach them. ({error})
              </Banner>
            </div>
          ) : bundles.length === 0 ? (
            <InlineEmpty icon={Layers}>
              No bundles yet. Build a quote the way you like it, open it, and choose
              <span className="text-ink"> Save this scope as a bundle</span>.
            </InlineEmpty>
          ) : (
            <div className="divide-y divide-border">
              {bundles.map(b => {
                const open = expanded === b.id
                return (
                  <div key={b.id}>
                    <div className="flex items-center gap-2 sm:gap-3 px-4 sm:px-5 py-3">
                      <button type="button"
                        onClick={() => setExpanded(open ? null : b.id)}
                        aria-expanded={open}
                        aria-label={open ? `Hide what ${b.name} contains` : `Show what ${b.name} contains`}
                        className="flex-1 min-w-0 flex items-center gap-2 text-left min-h-[44px]">
                        {open
                          ? <ChevronDown className="w-4 h-4 text-ink-faint shrink-0" aria-hidden />
                          : <ChevronRight className="w-4 h-4 text-ink-faint shrink-0" aria-hidden />}
                        <span className="min-w-0">
                          <span className="block text-sm font-medium text-ink truncate">{b.name}</span>
                          <span className="block text-xs text-ink-muted truncate">{bundleSummary(b.items)}</span>
                        </span>
                      </button>
                      <span className="text-sm font-semibold text-accent-text shrink-0 tabular-nums">
                        {formatCurrency(bundleTotal(b.items, tIndex))}
                      </span>
                      <Button variant="ghost" size="sm" aria-label={`Rename ${b.name}`} title="Rename"
                        onClick={() => setEditing(b)}>
                        <Pencil className="w-4 h-4" />
                      </Button>
                      <Button variant="ghost" size="sm" aria-label={`Delete ${b.name}`} title="Delete"
                        onClick={() => remove(b)} className="text-red-400/70 hover:text-red-400">
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                    {open && (
                      <div className="px-4 sm:px-5 pb-4 -mt-1">
                        {b.description && <p className="text-xs text-ink-muted mb-2">{b.description}</p>}
                        <ul className="space-y-1.5">
                          {[...b.items].sort((x, y) => x.sort_order - y.sort_order).map(it => {
                            // Every line says where its price comes from. A
                            // bundle that silently froze a copy of the catalogue
                            // would be a second price list nobody knew they had.
                            const basis = priceBasis(it, tIndex)
                            const net = serviceLineTotals({
                              quantity: it.quantity, unit_price: resolveUnitPrice(it, tIndex),
                              discount_type: null, discount_value: null,
                            }).net
                            return (
                              <li key={it.id} className="flex items-baseline justify-between gap-3 text-xs">
                                <span className="text-ink-muted truncate">
                                  {it.name}
                                  {Number(it.quantity) !== 1 && <span className="text-ink-faint"> ×{it.quantity}</span>}
                                  {it.kind === 'material' && <span className="text-ink-faint"> · material</span>}
                                </span>
                                <span className="shrink-0 tabular-nums text-ink-muted">
                                  {basis === 'unpriced'
                                    ? <span className="text-ink-faint">No price set</span>
                                    : <>{formatCurrency(net)}{basis === 'catalogue' && <span className="text-ink-faint"> · from catalogue</span>}</>}
                                </span>
                              </li>
                            )
                          })}
                        </ul>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </CardBody>
      </Card>

      {editing && (
        <RenameBundleDialog
          bundle={editing}
          otherNames={bundles.filter(b => b.id !== editing.id).map(b => b.name.toLowerCase())}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load() }}
        />
      )}
    </div>
  )
}

function RenameBundleDialog({ bundle, otherNames, onClose, onSaved }: {
  bundle: ServiceBundle
  otherNames: string[]
  onClose: () => void
  onSaved: () => void
}) {
  const supabase = createClient()
  const [name, setName] = useState(bundle.name)
  const [description, setDescription] = useState(bundle.description || '')
  const [saving, setSaving] = useState(false)

  const cleaned = cleanBundleName(name)
  const duplicate = !!cleaned && otherNames.includes(cleaned.toLowerCase())

  async function save() {
    if (!cleaned || duplicate || saving) return
    setSaving(true)
    const { error } = await supabase.from('service_bundles')
      .update({ name: cleaned, description: description.trim() || null })
      .eq('id', bundle.id)
    // A failed save must not close the form as if it succeeded.
    if (error) { toast.error('Could not save the bundle: ' + error.message); setSaving(false); return }
    setSaving(false)
    onSaved()
  }

  return (
    <Modal open onClose={() => !saving && onClose()} icon={Pencil} size="md" title="Edit bundle"
      onSubmit={save}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={save} loading={saving} disabled={!cleaned || duplicate}>Save</Button>
        </div>
      }>
      <div className="space-y-4">
        <Input label="Name *" autoFocus value={name} onChange={e => setName(e.target.value)}
          error={duplicate ? 'You already have a bundle with this name.' : undefined} />
        <Textarea label="What it covers" value={description} onChange={e => setDescription(e.target.value)}
          placeholder="For you, not the customer." />
        <p className="text-xs text-ink-faint">
          The lines in this bundle are not editable yet. To change them, save a new bundle
          from a quote with the scope you want and delete this one.
        </p>
      </div>
    </Modal>
  )
}
