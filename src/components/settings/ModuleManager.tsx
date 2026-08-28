'use client'

import { Card, CardHeader, CardBody } from '@/components/ui/Card'
import { Toggle } from '@/components/ui/Toggle'
import { Skeleton } from '@/components/ui/Skeleton'
import { Button } from '@/components/ui/Button'
import { useModules } from '@/hooks/useModules'
import {
  MODULE_CATEGORIES, CATEGORY_ORDER, pendingUpdate, isEntitled, moduleByKey,
  type FeatureModule,
} from '@/lib/modules'
import { toast } from '@/lib/toast'
import { LayoutGrid, Star, ArrowUpCircle } from 'lucide-react'

// ── Optional features — THE surface over the feature-module registry ──────────
// It used to be shaped like a marketplace, and it had a matching storefront page
// at /dashboard/marketplace. Both were describing fifteen first-party features
// that ship with every account, cost nothing, and arrive switched on — so the
// store shape was answering a question ("what should I install?") that no owner
// of this product has. It was also two surfaces over one registry, which is how
// they start disagreeing. The storefront is now a redirect here.
//
// What is left is the honest job: a list of what EdgeHQ can do, with a switch
// beside each one for the parts a given business doesn't want cluttering its
// menu. Dependencies come along atomically when something is switched ON, and a
// switch OFF is refused (by name) while something else still needs it. "Off"
// only tidies navigation — data, pages and deep links stay intact, so it is
// always reversible and always safe.
export function ModuleManager() {
  const { all, installed, meta, loaded, install, uninstall, acknowledgeUpdate, wouldInstall } = useModules()
  const on = new Set(installed)

  async function toggle(m: FeatureModule, next: boolean) {
    if (next) {
      const extra = wouldInstall(m.key).map(k => moduleByKey(k)?.label).filter(Boolean)
      const err = await install(m.key)
      if (err) toast.error('Could not turn that on: ' + err)
      else if (extra.length) toast.success(`${m.label} is on — ${extra.join(', ')} came with it, because it needs ${extra.length === 1 ? 'it' : 'them'}.`)
    } else {
      const err = await uninstall(m.key)
      if (err) toast.error(err)
    }
  }

  function Row({ m }: { m: FeatureModule }) {
    const active = m.core || on.has(m.key)
    const updated = active && pendingUpdate(m, meta)
    const requires = (m.requires ?? []).map(k => moduleByKey(k)?.label).filter(Boolean)
    return (
      <div className="py-2.5 first:pt-0 last:pb-0">
        <div className="flex items-center gap-3">
          <span className="w-8 h-8 rounded-lg bg-surface-raised border border-border flex items-center justify-center shrink-0">
            <m.icon className="w-4 h-4 text-ink-muted" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-ink flex items-center gap-1.5">
              {m.label}
            </p>
            <p className="text-xs text-ink-faint">{m.description}</p>
            <p className="text-[10px] text-ink-faint mt-0.5">
              {requires.length > 0 && <>Needs {requires.join(', ')} · </>}
              Uses your {m.permissions.map(p => p.split(':')[0]).filter((v, i, a) => a.indexOf(v) === i).join(', ')}
            </p>
          </div>
          {m.core ? (
            <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-ink-faint border border-border rounded-full px-2 py-0.5">Core</span>
          ) : (
            <Toggle checked={active} onChange={v => toggle(m, v)} ariaLabel={`${m.label} module`}
              disabled={!isEntitled(m)} />
          )}
        </div>
        {updated && (
          <div className="mt-1.5 ml-11 flex items-center gap-2 rounded-lg border border-accent/25 bg-accent/[0.06] px-2.5 py-1.5">
            <ArrowUpCircle className="w-3.5 h-3.5 text-accent-text shrink-0" aria-hidden="true" />
            <p className="text-xs text-ink flex-1 min-w-0">
              <span className="font-semibold">Updated.</span>{m.whatsNew ? ` ${m.whatsNew}` : ''}
            </p>
            <Button size="sm" variant="ghost" onClick={async () => {
              const err = await acknowledgeUpdate(m.key)
              if (err) toast.error('Could not save: ' + err)
            }}>Got it</Button>
          </div>
        )}
      </div>
    )
  }

  const featured = all.filter(m => m.featured && !m.core && !on.has(m.key))

  return (
    <Card>
      <CardHeader>
        <div>
          <h2 className="text-sm font-semibold text-ink flex items-center gap-2"><LayoutGrid className="w-4 h-4 text-accent-text" /> Optional features</h2>
          <p className="text-xs text-ink-faint mt-0.5">
            Everything below is included and already on. Switch off anything you don’t use and it leaves your
            menu — nothing is deleted, and you can switch it back on whenever you like.
          </p>
        </div>
      </CardHeader>
      <CardBody>
        {!loaded ? (
          <div className="space-y-2" aria-hidden>
            {[0, 1, 2, 3].map(i => (
              <div key={i} className="flex items-center justify-between gap-3 py-1.5">
                <div className="min-w-0 flex-1"><Skeleton className="h-3.5 w-32" /><Skeleton className="h-2.5 w-2/3 mt-1.5" /></div>
                <Skeleton className="w-10 h-6 rounded-full shrink-0" />
              </div>
            ))}
          </div>
        ) : (
          <div className="space-y-5">
            {featured.length > 0 && (
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint mb-1.5 flex items-center gap-1">
                  <Star className="w-3 h-3 text-amber-400" aria-hidden="true" /> Switched off — worth a look
                </p>
                <div className="divide-y divide-border rounded-xl border border-accent/20 bg-accent/[0.03] px-3">
                  {featured.map(m => <Row key={m.key} m={m} />)}
                </div>
              </div>
            )}
            {CATEGORY_ORDER.map(cat => {
              const mods = all.filter(m => m.category === cat)
              if (!mods.length) return null
              return (
                <div key={cat}>
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint mb-1.5">{MODULE_CATEGORIES[cat]}</p>
                  <div className="divide-y divide-border">
                    {mods.map(m => <Row key={m.key} m={m} />)}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </CardBody>
    </Card>
  )
}
