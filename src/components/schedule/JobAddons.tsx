'use client'

import { useState } from 'react'
import { JobLineItem, RecurrenceScope, AddonTemplate } from '@/types'
import { addonsTotal, isRecurringProgramService, normalizeServiceKey } from '@/lib/jobPricing'
import { formatCurrency, cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { Plus, Trash2, Sparkles, Repeat, Copy } from 'lucide-react'

export interface PrevAddon { description: string; amount: number; serviceKey: string }

interface Props {
  baseValue: number            // base visit value (job price > quote), before add-ons
  items: JobLineItem[]         // current add-ons on this visit
  isRecurring: boolean         // show the This/Future/Entire-plan scope chooser
  onAdd: (input: { description: string; amount: number; serviceKey: string; scope: RecurrenceScope }) => Promise<void>
  onDelete: (item: JobLineItem) => Promise<void>
  // The previous visit's add-ons (if any) — one-tap copy onto THIS visit. Respects
  // the scope rules (copies to this visit only; never auto-recurs).
  previousAddons?: PrevAddon[]
  onCopyPrevious?: () => Promise<void>
  // The quick-add chips, resolved from the business's trade pack by the page
  // (required so no consumer can silently fall back to a trade's chips). Must
  // include the 'custom' key — it is special-cased to a free-text description.
  addonTemplates: AddonTemplate[]
}

const SCOPES: { scope: RecurrenceScope; label: string }[] = [
  { scope: 'this', label: 'This visit' },
  { scope: 'future', label: 'Future visits' },
  { scope: 'all', label: 'Entire plan' },
]

export function JobAddons({ baseValue, items, isRecurring, onAdd, onDelete, previousAddons, onCopyPrevious, addonTemplates }: Props) {
  const [picked, setPicked] = useState<AddonTemplate | null>(null)
  const [desc, setDesc] = useState('')      // used when Custom is picked
  const [amount, setAmount] = useState('')
  const [scope, setScope] = useState<RecurrenceScope>('this')
  const [busy, setBusy] = useState(false)
  const [copyBusy, setCopyBusy] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  // Offer "copy previous" only when the last visit had add-ons none of which are
  // already on this visit (so the button never duplicates what's here).
  const haveKeys = new Set(items.map(i => (i.service_key || i.description).toLowerCase()))
  const copyable = (previousAddons || []).filter(p => !haveKeys.has((p.serviceKey || p.description).toLowerCase()))

  async function copyPrev() {
    if (!onCopyPrevious) return
    setCopyBusy(true)
    await onCopyPrevious()
    setCopyBusy(false)
  }

  const total = baseValue + addonsTotal(items)
  const effectiveDesc = picked ? (picked.key === 'custom' ? desc.trim() : picked.label) : desc.trim()
  const recommendRecurring = isRecurring && (!!picked?.recurringByDefault || isRecurringProgramService(effectiveDesc))

  function choose(t: AddonTemplate) {
    setPicked(t)
    if (t.key !== 'custom') setDesc('')
    // Smart default: program services suggest recurring; everything else this-visit.
    setScope(isRecurring && t.recurringByDefault ? 'future' : 'this')
  }

  async function submit() {
    const d = effectiveDesc
    const amt = Number(amount)
    if (!d || !(amt > 0)) return
    setBusy(true)
    await onAdd({ description: d, amount: amt, serviceKey: picked && picked.key !== 'custom' ? picked.key : normalizeServiceKey(d), scope: isRecurring ? scope : 'this' })
    setBusy(false)
    setPicked(null); setDesc(''); setAmount(''); setScope('this')
  }

  async function remove(item: JobLineItem) {
    setDeletingId(item.id)
    await onDelete(item)
    setDeletingId(null)
  }

  return (
    <div className="space-y-2.5">
      {/* Current add-ons */}
      {items.length > 0 && (
        <div className="space-y-1">
          {items.map(it => (
            <div key={it.id} className="flex items-center gap-2 text-sm">
              <span className="flex-1 min-w-0 truncate text-ink flex items-center gap-1.5">
                {it.recurring && <Repeat className="w-3 h-3 shrink-0 text-accent-text" />}{it.description}
              </span>
              <span className="font-semibold text-ink shrink-0">{formatCurrency(Number(it.amount))}</span>
              <button type="button" onClick={() => remove(it)} disabled={deletingId === it.id} title="Remove add-on"
                className="h-8 w-8 rounded-md border border-red-500/30 bg-red-500/10 text-red-400 hover:bg-red-500/20 flex items-center justify-center shrink-0 disabled:opacity-50">
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* One-tap: copy the previous visit's add-ons onto this visit */}
      {copyable.length > 0 && onCopyPrevious && (
        <button type="button" onClick={copyPrev} disabled={copyBusy}
          className="w-full flex items-center gap-2 rounded-lg border border-accent/30 bg-accent/5 px-2.5 py-1.5 text-left hover:bg-accent/10 transition-colors disabled:opacity-50">
          <Copy className="w-3.5 h-3.5 text-accent-text shrink-0" />
          <span className="text-xs text-ink min-w-0 flex-1">
            <span className="font-semibold">Copy previous add-ons</span>
            <span className="text-ink-muted"> · {copyable.map(p => p.description).join(' + ')}</span>
          </span>
          <span className="text-xs font-bold text-accent-text shrink-0">{formatCurrency(copyable.reduce((s, p) => s + (Number(p.amount) || 0), 0))}</span>
        </button>
      )}

      {/* Quick-add template chips */}
      <div className="flex flex-wrap gap-1.5">
        {addonTemplates.map(t => (
          <button key={t.key} type="button" onClick={() => choose(t)}
            className={cn('text-[11px] font-medium rounded-full px-2.5 py-1 border transition-colors',
              picked?.key === t.key ? 'bg-accent text-black border-accent' : 'border-border text-ink-muted hover:text-ink hover:border-border-strong')}>
            {t.label}
            {t.recurringByDefault && <Sparkles className="w-2.5 h-2.5 inline ml-1 -mt-0.5 opacity-70" />}
          </button>
        ))}
      </div>

      {/* Add row — appears once a chip is picked */}
      {picked && (
        <div className="rounded-lg border border-border bg-bg-secondary p-2.5 space-y-2">
          <div className="flex items-center gap-2">
            {picked.key === 'custom' ? (
              <input autoFocus value={desc} onChange={e => setDesc(e.target.value)} placeholder="Service name"
                className="flex-1 min-w-0 bg-bg-tertiary border border-border-strong rounded-lg px-2 py-1.5 text-sm text-ink outline-none transition-all focus:border-accent focus:ring-2 focus:ring-accent/20" />
            ) : (
              <span className="flex-1 min-w-0 text-sm font-medium text-ink truncate">{picked.label}</span>
            )}
            <div className="relative shrink-0">
              <span className="absolute left-2 top-1/2 -translate-y-1/2 text-ink-faint text-sm">$</span>
              <input type="number" min="0" step="5" autoFocus={picked.key !== 'custom'} value={amount} onChange={e => setAmount(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') submit() }} placeholder="0"
                className="w-24 bg-bg-tertiary border border-border-strong rounded-lg pl-5 pr-2 py-1.5 text-sm text-ink outline-none transition-all focus:border-accent focus:ring-2 focus:ring-accent/20" />
            </div>
          </div>

          {/* Scope chooser (recurring jobs only) — inline, no modal */}
          {isRecurring && (
            <div className="flex items-center gap-1.5 flex-wrap">
              {SCOPES.map(s => (
                <button key={s.scope} type="button" onClick={() => setScope(s.scope)}
                  className={cn('text-[11px] font-medium rounded-lg px-2 py-1 border transition-colors',
                    scope === s.scope ? 'bg-accent/15 text-accent-text border-accent/40' : 'border-border text-ink-muted hover:text-ink')}>
                  {s.label}
                </button>
              ))}
              {recommendRecurring && (
                <span className="text-[10px] font-semibold uppercase tracking-wide text-accent-text flex items-center gap-1">
                  <Sparkles className="w-3 h-3" /> Recommended: recurring
                </span>
              )}
            </div>
          )}

          <div className="flex items-center gap-2">
            <Button size="sm" onClick={submit} loading={busy} disabled={!effectiveDesc || !(Number(amount) > 0)}>
              <Plus className="w-3.5 h-3.5" /> Add service
            </Button>
            <Button size="sm" variant="ghost" onClick={() => { setPicked(null); setDesc(''); setAmount('') }}>Cancel</Button>
          </div>
        </div>
      )}

      {/* Total Job Value — always visible */}
      <div className="flex items-center justify-between border-t border-border pt-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Total job value</span>
        <span className="text-base font-bold text-accent-text">{formatCurrency(total)}</span>
      </div>
    </div>
  )
}