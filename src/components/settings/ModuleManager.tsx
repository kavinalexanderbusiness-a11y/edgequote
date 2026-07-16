'use client'

import Link from 'next/link'
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

// ── Modules — the management surface over THE feature-module registry ─────────
// Shaped like a marketplace on purpose: featured modules up top, the catalogue
// grouped by category, and each listing carrying its pitch, version, what it
// depends on, and the data it declares it touches. Install pulls dependencies
// in atomically; uninstall is refused (with names) while other installed
// modules need it. Everything is first-party code composed by config — no
// runtime plugins. "Off" only tidies navigation: data, pages and deep links
// stay intact, so it's always reversible and always safe.
export function ModuleManager() {
  const { all, installed, meta, loaded, install, uninstall, acknowledgeUpdate, wouldInstall } = useModules()
  const on = new Set(installed)

  async function toggle(m: FeatureModule, next: boolean) {
    if (next) {
      const extra = wouldInstall(m.key).map(k => moduleByKey(k)?.label).filter(Boolean)
      const err = await install(m.key)
      if (err) toast.error('Could not install: ' + err)
      else if (extra.length) toast.success(`${m.label} installed — brought along ${extra.join(', ')} (required).`)
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
              {m.featured && <Star className="w-3 h-3 text-amber-400 fill-amber-400" aria-label="Featured" />}
            </p>
            <p className="text-xs text-ink-faint">{m.description}</p>
            <p className="text-[10px] text-ink-faint mt-0.5 tabular-nums">
              v{m.version}
              {requires.length > 0 && <> · needs {requires.join(', ')}</>}
              {' '}· uses {m.permissions.map(p => p.split(':')[0]).filter((v, i, a) => a.indexOf(v) === i).join(', ')}
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
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-ink flex items-center gap-2"><LayoutGrid className="w-4 h-4 text-accent-text" /> Modules</h2>
            <p className="text-xs text-ink-faint mt-0.5">
              Compose your EdgeQuote — install the parts your business uses. Removing a module only
              tidies navigation: its data and links stay intact, and you can bring it back any time.
            </p>
          </div>
          <Link href="/dashboard/marketplace"
            className="shrink-0 text-xs font-semibold text-accent-text hover:underline rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
            Browse the marketplace →
          </Link>
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
                  <Star className="w-3 h-3 text-amber-400" aria-hidden="true" /> Featured — not installed
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
