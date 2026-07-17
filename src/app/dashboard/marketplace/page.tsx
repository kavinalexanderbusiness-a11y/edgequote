'use client'

import { useMemo, useState } from 'react'
import { PageHeader } from '@/components/layout/PageHeader'
import { FilterPill } from '@/components/ui/FilterPill'
import { EmptyState } from '@/components/ui/EmptyState'
import { ModuleCard, ModuleDetails, ModuleScreenshot } from '@/components/marketplace/ModuleListing'
import { useModules } from '@/hooks/useModules'
import {
  MODULE_CATEGORIES, CATEGORY_ORDER, recentlyUpdated, searchModules,
  type FeatureModule, type ModuleCategory,
} from '@/lib/modules'
import { formatDate } from '@/lib/utils'
import { Search, Star, Clock, PackageSearch } from 'lucide-react'

// ── The App Marketplace ───────────────────────────────────────────────────────
// A browsing surface over THE feature-module registry — the same catalogue,
// dependency engine, update system and licensing hook that power Settings →
// Modules; this page just gives them an app-store shape: featured rail,
// recently updated, search, categories, and a details view per module.
// Everything here is first-party code composed by config (no runtime plugins);
// installing simply turns a module on for THIS business.
export default function MarketplacePage() {
  const { all, loaded } = useModules()
  const [q, setQ] = useState('')
  const [cat, setCat] = useState<ModuleCategory | 'all'>('all')
  const [openKey, setOpenKey] = useState<string | null>(null)

  const browsing = !q.trim() && cat === 'all'
  const results = useMemo(() => {
    const bySearch = searchModules(q)
    return cat === 'all' ? bySearch : bySearch.filter(m => m.category === cat)
  }, [q, cat])

  const featured = all.filter(m => m.featured)
  const recent = recentlyUpdated(4)
  const detail: FeatureModule | null = all.find(m => m.key === openKey) ?? null

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <PageHeader title="Marketplace"
        description="Compose your EdgeQuote — every module is built in, free, and safe to try: removing one never touches your data." />

      {/* Search + categories */}
      <div className="space-y-3 animate-rise">
        <div className="relative">
          <Search className="w-4 h-4 text-ink-faint absolute left-3.5 top-1/2 -translate-y-1/2" aria-hidden="true" />
          <input value={q} onChange={e => setQ(e.target.value)} aria-label="Search modules"
            placeholder="Search modules — try “invoice”, “sms”, “routes”…"
            className="w-full h-11 pl-10 pr-4 rounded-xl bg-bg-tertiary border border-border-strong text-base sm:text-sm text-ink placeholder:text-ink-faint outline-none transition-all focus:border-accent focus:ring-2 focus:ring-accent/20" />
        </div>
        <div className="flex flex-wrap gap-1.5">
          <FilterPill active={cat === 'all'} onClick={() => setCat('all')}>All</FilterPill>
          {CATEGORY_ORDER.map(c => (
            <FilterPill key={c} active={cat === c} onClick={() => setCat(c)}>{MODULE_CATEGORIES[c]}</FilterPill>
          ))}
        </div>
      </div>

      {/* Featured — the hero rail (browse mode only) */}
      {browsing && featured.length > 0 && (
        <section aria-label="Featured modules" className="animate-rise stagger-2">
          <h2 className="text-sm font-semibold text-ink flex items-center gap-1.5 mb-2">
            <Star className="w-4 h-4 text-amber-400" aria-hidden="true" /> Featured
          </h2>
          <div className="grid sm:grid-cols-2 gap-4">
            {featured.map(m => (
              <button key={m.key} type="button" onClick={() => setOpenKey(m.key)}
                className="text-left rounded-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 card-lift"
                aria-label={`${m.label} — view details`}>
                <div className="rounded-card border border-accent/25 overflow-hidden">
                  <ModuleScreenshot m={m} className="h-28 rounded-none border-0 border-b border-border" />
                  <div className="p-4 hero-aurora">
                    <p className="text-sm font-bold tracking-tight text-ink flex items-center gap-1.5">
                      {m.label} <Star className="w-3 h-3 text-amber-400 fill-amber-400" aria-hidden="true" />
                    </p>
                    <p className="text-xs text-ink-muted mt-0.5">{m.description}</p>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </section>
      )}

      {/* Recently updated (browse mode only) */}
      {browsing && (
        <section aria-label="Recently updated" className="animate-rise stagger-3">
          <h2 className="text-sm font-semibold text-ink flex items-center gap-1.5 mb-2">
            <Clock className="w-4 h-4 text-ink-muted" aria-hidden="true" /> Recently updated
          </h2>
          <div className="rounded-card border border-border bg-bg-secondary divide-y divide-border overflow-hidden">
            {recent.map(m => (
              <button key={m.key} type="button" onClick={() => setOpenKey(m.key)}
                className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-surface transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40">
                <span className="w-8 h-8 rounded-lg bg-surface-raised border border-border flex items-center justify-center shrink-0">
                  <m.icon className="w-4 h-4 text-ink-muted" aria-hidden="true" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-ink">{m.label}</span>
                  <span className="block text-[11px] text-ink-faint truncate">{m.whatsNew || m.description}</span>
                </span>
                <span className="shrink-0 text-[11px] text-ink-faint tabular-nums">{formatDate(m.updatedAt)}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {/* The catalogue */}
      <section aria-label="All modules" className="animate-rise stagger-4">
        <h2 className="text-sm font-semibold text-ink mb-2">
          {browsing ? 'All modules' : `${results.length} result${results.length !== 1 ? 's' : ''}`}
        </h2>
        {loaded && results.length === 0 ? (
          <EmptyState icon={PackageSearch} className="py-12" title="No modules match"
            description="Try a different word — search also matches what a module does and the data it uses." />
        ) : (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {results.map((m, i) => <ModuleCard key={m.key} m={m} index={i} onOpen={() => setOpenKey(m.key)} />)}
          </div>
        )}
      </section>

      <ModuleDetails m={detail} open={openKey !== null} onClose={() => setOpenKey(null)} />
    </div>
  )
}
