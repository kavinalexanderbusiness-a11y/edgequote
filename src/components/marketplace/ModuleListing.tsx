'use client'

import { useState } from 'react'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { useModules } from '@/hooks/useModules'
import {
  MODULE_CATEGORIES, moduleByKey, uninstallBlockers, pendingUpdate, isEntitled,
  type FeatureModule,
} from '@/lib/modules'
import { toast } from '@/lib/toast'
import { formatDate, cn } from '@/lib/utils'
import { Star, Check, ArrowUpCircle, Shield, Link2 } from 'lucide-react'

// ── Marketplace listing pieces ────────────────────────────────────────────────
// A card (the grid) and a details modal (the listing page), both reading THE
// feature-module registry. Screenshots are registry-supplied URLs; until a
// module ships real ones, the listing renders a styled placeholder built from
// the module's own icon — honest, and it keeps the layout stable for the day
// real captures exist. Install/uninstall goes through the ONE workflow in
// useModules: dependencies install atomically, removal is refused by name
// while something installed needs it, and removal is undoable via toast.

// Deterministic placeholder "screenshot": a soft aurora surface with the
// module's icon and a few abstract content bars. Pure CSS — no images.
export function ModuleScreenshot({ m, className }: { m: FeatureModule; className?: string }) {
  return (
    <div aria-hidden className={cn('relative overflow-hidden rounded-xl border border-border hero-aurora', className)}>
      <div className="absolute inset-0 flex items-center justify-center opacity-[0.14]">
        <m.icon className="w-24 h-24" />
      </div>
      <div className="relative p-4 space-y-2">
        <div className="flex items-center gap-2">
          <span className="w-6 h-6 rounded-lg bg-accent/20 border border-accent/30 flex items-center justify-center">
            <m.icon className="w-3.5 h-3.5 text-accent-text" />
          </span>
          <div className="h-2 w-24 rounded bg-ink/15" />
        </div>
        <div className="h-2 w-3/4 rounded bg-ink/10" />
        <div className="h-2 w-1/2 rounded bg-ink/10" />
        <div className="grid grid-cols-3 gap-2 pt-1">
          {[0, 1, 2].map(i => <div key={i} className="h-8 rounded-lg bg-ink/[0.07] border border-border" />)}
        </div>
      </div>
    </div>
  )
}

function InstallControls({ m, compact }: { m: FeatureModule; compact?: boolean }) {
  const { installed, install, uninstall, wouldInstall } = useModules()
  const [busy, setBusy] = useState(false)
  const active = m.core || installed.includes(m.key)
  const blockers = active && !m.core ? uninstallBlockers(installed, m.key) : []

  async function doInstall() {
    setBusy(true)
    const extras = wouldInstall(m.key).map(k => moduleByKey(k)?.label).filter(Boolean)
    const err = await install(m.key)
    setBusy(false)
    if (err) { toast.error('Could not install: ' + err); return }
    toast.success(extras.length ? `${m.label} installed, along with ${extras.join(', ')} (required).` : `${m.label} installed.`)
  }

  async function doUninstall() {
    setBusy(true)
    const err = await uninstall(m.key)
    setBusy(false)
    if (err) { toast.error(err); return }
    // Removal is navigation-level and fully reversible — offer the way back.
    toast.undo(`${m.label} removed.`, async () => { await install(m.key) })
  }

  if (m.core) {
    return <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-ink-faint border border-border rounded-full px-2 py-0.5">Core</span>
  }
  if (!active) {
    return (
      <Button size={compact ? 'sm' : 'md'} onClick={doInstall} loading={busy} disabled={!isEntitled(m)}>
        Install
      </Button>
    )
  }
  return (
    <div className="flex items-center gap-2">
      <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-400"><Check className="w-3.5 h-3.5" /> Installed</span>
      <Button size="sm" variant="ghost" onClick={doUninstall} loading={busy}
        disabled={blockers.length > 0}
        title={blockers.length ? `Needed by ${blockers.map(b => b.label).join(', ')} — remove ${blockers.length === 1 ? 'it' : 'them'} first` : undefined}>
        Remove
      </Button>
    </div>
  )
}

export function ModuleDetails({ m, open, onClose }: { m: FeatureModule | null; open: boolean; onClose: () => void }) {
  const { installed, meta, acknowledgeUpdate } = useModules()
  if (!m) return null
  const requires = (m.requires ?? []).map(k => moduleByKey(k)).filter((x): x is FeatureModule => !!x)
  const updated = (m.core || installed.includes(m.key)) && pendingUpdate(m, meta)
  return (
    <Modal open={open} onClose={onClose} icon={m.icon} title={m.label} size="lg">
      <div className="space-y-4">
        <div className="flex items-center gap-2 flex-wrap text-[11px]">
          <span className="font-semibold uppercase tracking-wide text-ink-faint border border-border rounded-full px-2 py-0.5">{MODULE_CATEGORIES[m.category]}</span>
          {m.featured && <span className="inline-flex items-center gap-1 font-semibold text-amber-400"><Star className="w-3 h-3 fill-amber-400" /> Featured</span>}
          <span className="text-ink-faint tabular-nums">v{m.version} · updated {formatDate(m.updatedAt)}</span>
          <span className="text-ink-faint">· Included with EdgeQuote</span>
        </div>

        <p className="text-sm text-ink">{m.description}</p>

        {/* Screenshots — real captures when the registry has them, placeholder art until then. */}
        {m.screenshots?.length ? (
          <div className="grid sm:grid-cols-2 gap-3">
            {m.screenshots.slice(0, 4).map((src, i) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={i} src={src} alt={`${m.label} screenshot ${i + 1}`} className="rounded-xl border border-border w-full" />
            ))}
          </div>
        ) : (
          <ModuleScreenshot m={m} className="h-40" />
        )}

        {updated && (
          <div className="flex items-center gap-2 rounded-lg border border-accent/25 bg-accent/[0.06] px-2.5 py-1.5">
            <ArrowUpCircle className="w-3.5 h-3.5 text-accent-text shrink-0" aria-hidden="true" />
            <p className="text-xs text-ink flex-1 min-w-0"><span className="font-semibold">Updated.</span>{m.whatsNew ? ` ${m.whatsNew}` : ''}</p>
            <Button size="sm" variant="ghost" onClick={async () => {
              const err = await acknowledgeUpdate(m.key)
              if (err) toast.error('Could not save: ' + err)
            }}>Got it</Button>
          </div>
        )}

        <div className="grid sm:grid-cols-2 gap-3">
          <div className="rounded-xl border border-border bg-bg-secondary p-3">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint mb-1.5 flex items-center gap-1"><Link2 className="w-3 h-3" /> Works with</p>
            {requires.length ? (
              <ul className="space-y-1">
                {requires.map(r => (
                  <li key={r.key} className="text-xs text-ink flex items-center gap-1.5">
                    <r.icon className="w-3.5 h-3.5 text-ink-muted" aria-hidden="true" /> {r.label}
                    <span className="text-ink-faint">{installed.includes(r.key) || r.core ? '· installed' : '· installs with it'}</span>
                  </li>
                ))}
              </ul>
            ) : <p className="text-xs text-ink-faint">Stands on its own — no dependencies.</p>}
          </div>
          <div className="rounded-xl border border-border bg-bg-secondary p-3">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint mb-1.5 flex items-center gap-1"><Shield className="w-3 h-3" /> Uses your data</p>
            <p className="text-xs text-ink">
              {m.permissions.map(p => p.split(':')[0]).filter((v, i, a) => a.indexOf(v) === i).join(', ')}
            </p>
            <p className="text-[10px] text-ink-faint mt-1">Declared by the module — reads and writes stay inside your account.</p>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 pt-1">
          <p className="text-[11px] text-ink-faint">Removing a module only tidies navigation — data and links stay intact.</p>
          <InstallControls m={m} />
        </div>
      </div>
    </Modal>
  )
}

export function ModuleCard({ m, onOpen, index }: { m: FeatureModule; onOpen: () => void; index: number }) {
  const { installed, meta } = useModules()
  const active = m.core || installed.includes(m.key)
  const updated = active && pendingUpdate(m, meta)
  return (
    <Card className={cn('p-0 overflow-hidden card-lift animate-rise', index < 6 && `stagger-${index + 1}`)}>
      <button type="button" onClick={onOpen} className="w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 rounded-card"
        aria-label={`${m.label} — view details`}>
        <ModuleScreenshot m={m} className="h-24 rounded-none border-0 border-b border-border" />
        <div className="p-3.5">
          <div className="flex items-center gap-1.5">
            <p className="text-sm font-semibold text-ink truncate">{m.label}</p>
            {m.featured && <Star className="w-3 h-3 text-amber-400 fill-amber-400 shrink-0" aria-label="Featured" />}
            {updated && <ArrowUpCircle className="w-3.5 h-3.5 text-accent-text shrink-0" aria-label="Update available" />}
            <span className="ml-auto shrink-0">
              {active
                ? <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-400"><Check className="w-3 h-3" /> Installed</span>
                : <span className="text-[10px] font-semibold text-accent-text">Install</span>}
            </span>
          </div>
          <p className="text-xs text-ink-faint mt-1 line-clamp-2">{m.description}</p>
          <p className="text-[10px] text-ink-faint mt-1.5 tabular-nums">{MODULE_CATEGORIES[m.category]} · v{m.version} · {formatDate(m.updatedAt)}</p>
        </div>
      </button>
    </Card>
  )
}
