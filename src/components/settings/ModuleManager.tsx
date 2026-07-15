'use client'

import { Card, CardHeader, CardBody } from '@/components/ui/Card'
import { Toggle } from '@/components/ui/Toggle'
import { Skeleton } from '@/components/ui/Skeleton'
import { useModules } from '@/hooks/useModules'
import { FEATURE_MODULES } from '@/lib/modules'
import { toast } from '@/lib/toast'
import { LayoutGrid } from 'lucide-react'

// ── Modules — the management surface over THE feature-module registry ─────────
// Each business composes its own EdgeQuote: the registry (lib/modules.ts) is
// the catalogue, this screen is where an owner turns modules on and off, and
// the sidebar + command palette render the result. This is deliberately shaped
// like a marketplace listing (icon, name, one-line pitch, switch) — a future
// marketplace lists new entries here; custom modules append to the registry.
// No runtime plugins: every module is first-party code, composed by config.
//
// Turning a module off hides it from navigation only — its data, pages and
// deep links stay fully intact, so "off" is always reversible and always safe.
export function ModuleManager() {
  const { all, enabled, loaded, setEnabled } = useModules()
  const nonCoreKeys = FEATURE_MODULES.filter(m => !m.core).map(m => m.key)

  // The set of non-core modules currently ON. null = all (including future ones).
  const on = new Set(Array.isArray(enabled)
    ? (enabled as unknown[]).filter((k): k is string => typeof k === 'string')
    : nonCoreKeys)

  async function toggle(key: string, next: boolean) {
    const nextOn = new Set(on)
    if (next) nextOn.add(key); else nextOn.delete(key)
    // Everything back on → store NULL, not the full list: NULL keeps future
    // modules auto-enabled; a frozen list would silently hide next year's module.
    const keys = nonCoreKeys.every(k => nextOn.has(k)) ? null : nonCoreKeys.filter(k => nextOn.has(k))
    const err = await setEnabled(keys)
    if (err) toast.error('Could not save modules: ' + err)
  }

  return (
    <Card>
      <CardHeader>
        <h2 className="text-sm font-semibold text-ink flex items-center gap-2"><LayoutGrid className="w-4 h-4 text-accent-text" /> Modules</h2>
        <p className="text-xs text-ink-faint mt-0.5">
          Compose your EdgeQuote — hide the parts your business doesn&rsquo;t use. Turning a module off only
          tidies navigation: its data and links stay intact, and you can turn it back on any time.
        </p>
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
          <div className="divide-y divide-border">
            {all.map(m => (
              <div key={m.key} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                <span className="w-8 h-8 rounded-lg bg-surface-raised border border-border flex items-center justify-center shrink-0">
                  <m.icon className="w-4 h-4 text-ink-muted" aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-ink">{m.label}</p>
                  <p className="text-xs text-ink-faint">{m.description}</p>
                </div>
                {m.core ? (
                  <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-ink-faint border border-border rounded-full px-2 py-0.5">Core</span>
                ) : (
                  <Toggle checked={on.has(m.key)} onChange={v => toggle(m.key, v)} ariaLabel={`${m.label} module`} />
                )}
              </div>
            ))}
          </div>
        )}
      </CardBody>
    </Card>
  )
}
