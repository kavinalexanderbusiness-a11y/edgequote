'use client'

import { ReactNode, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/Button'
import { Settings2, Check, ChevronUp, ChevronDown, EyeOff, Eye } from 'lucide-react'

export const SECTION_LABELS: Record<string, string> = {
  suggestions: 'Do this next',
  stats: 'Business stats',
  missed: 'Missed jobs',
  followups: 'Quote follow-ups',
  unscheduled: 'Accepted — not scheduled',
  weekend: 'Next work days',
  recent: 'Recent quotes',
  acquisition: 'Acquisition insights',
}
export const DEFAULT_ORDER = ['suggestions', 'stats', 'missed', 'followups', 'unscheduled', 'weekend', 'recent', 'acquisition']

export interface DashboardPrefs { order: string[]; hidden: string[] }

// Owner-customizable home: reorder (pin favourites to the top) and hide sections.
// Sections are server-rendered and passed in as slots; this only arranges them.
export function DashboardSections({ sections, initialPrefs }: {
  sections: Record<string, ReactNode>
  initialPrefs: DashboardPrefs | null
}) {
  const supabase = createClient()
  const [editing, setEditing] = useState(false)
  const [prefs, setPrefs] = useState<DashboardPrefs>(() => {
    const saved = initialPrefs?.order?.length ? initialPrefs.order.filter(k => DEFAULT_ORDER.includes(k)) : []
    const order = [...saved, ...DEFAULT_ORDER.filter(k => !saved.includes(k))] // new sections append
    return { order, hidden: (initialPrefs?.hidden || []).filter(k => DEFAULT_ORDER.includes(k)) }
  })

  async function persist(next: DashboardPrefs) {
    setPrefs(next)
    const { data: { user } } = await supabase.auth.getUser()
    if (user) await supabase.from('business_settings').update({ dashboard_cards: next }).eq('user_id', user.id)
  }

  function move(key: string, dir: -1 | 1) {
    const order = [...prefs.order]
    const i = order.indexOf(key)
    const j = i + dir
    if (i < 0 || j < 0 || j >= order.length) return
    ;[order[i], order[j]] = [order[j], order[i]]
    persist({ ...prefs, order })
  }
  function toggleHidden(key: string) {
    const hidden = prefs.hidden.includes(key) ? prefs.hidden.filter(k => k !== key) : [...prefs.hidden, key]
    persist({ ...prefs, hidden })
  }

  const visible = prefs.order.filter(k => !prefs.hidden.includes(k) && sections[k] != null)
  const hidden = prefs.order.filter(k => prefs.hidden.includes(k))

  return (
    <div className="space-y-6">
      <div className="flex justify-end -mb-3">
        <Button variant={editing ? 'primary' : 'ghost'} size="sm" onClick={() => setEditing(v => !v)}>
          {editing ? <><Check className="w-3.5 h-3.5" /> Done</> : <><Settings2 className="w-3.5 h-3.5" /> Customize</>}
        </Button>
      </div>

      {visible.map((key, idx) => (
        <section key={key}>
          {editing && (
            <div className="flex items-center gap-2 mb-1.5 rounded-lg border border-dashed border-border-strong bg-bg-secondary px-3 py-1.5">
              <span className="text-xs font-semibold text-ink flex-1">{SECTION_LABELS[key] || key}</span>
              <button onClick={() => move(key, -1)} disabled={idx === 0} title="Move up"
                className="w-9 h-9 flex items-center justify-center rounded-lg text-ink-muted hover:text-ink disabled:opacity-30">
                <ChevronUp className="w-4 h-4" />
              </button>
              <button onClick={() => move(key, 1)} disabled={idx === visible.length - 1} title="Move down"
                className="w-9 h-9 flex items-center justify-center rounded-lg text-ink-muted hover:text-ink disabled:opacity-30">
                <ChevronDown className="w-4 h-4" />
              </button>
              <button onClick={() => toggleHidden(key)} title="Hide section"
                className="w-9 h-9 flex items-center justify-center rounded-lg text-ink-muted hover:text-red-400">
                <EyeOff className="w-4 h-4" />
              </button>
            </div>
          )}
          {sections[key]}
        </section>
      ))}

      {editing && hidden.length > 0 && (
        <div className="rounded-xl border border-dashed border-border px-4 py-3">
          <p className="text-xs font-semibold text-ink-faint uppercase tracking-wide mb-2">Hidden sections</p>
          <div className="flex flex-wrap gap-2">
            {hidden.map(key => (
              <button key={key} onClick={() => toggleHidden(key)}
                className="flex items-center gap-1.5 text-xs font-medium px-3 py-2 rounded-lg border border-border-strong bg-surface text-ink-muted hover:text-ink">
                <Eye className="w-3.5 h-3.5" /> {SECTION_LABELS[key] || key}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
