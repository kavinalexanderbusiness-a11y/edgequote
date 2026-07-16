'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import {
  WIDGETS, DEFAULT_LAYOUT, normalizeLayout, reorder, toggleHidden, isCustomised, step, canStep,
  type AnalyticsLayout, type WidgetId,
} from '@/lib/analytics/layout'
import { GripVertical, Eye, EyeOff, SlidersHorizontal, Check, RotateCcw, X, ChevronUp, ChevronDown } from 'lucide-react'

// ── The analytics workspace shell ────────────────────────────────────────────
// Order + visibility for the Business Intelligence widgets, persisted per user.
//
// Deliberately NOT a widget canvas: the widgets are the page's existing BI
// sections, rendered from the same BIReport, so nothing here can compute or
// claim a number the page didn't already stand behind. This only decides what
// you see and in what order.
//
// Reordering rides CSS `order` on a flex column rather than moving DOM nodes, so
// each section's markup stays exactly where it is in the file — the sections
// don't know they're arrangeable. The drag language (grip, dragging opacity,
// drop ring) is the one the Schedule day board already uses.

interface Ctx {
  editing: boolean
  layout: AnalyticsLayout
  indexOf: (id: WidgetId) => number
  isHidden: (id: WidgetId) => boolean
  onToggle: (id: WidgetId) => void
  dragging: WidgetId | null
  dragOver: WidgetId | null
  onDragStart: (id: WidgetId) => void
  onDragOver: (id: WidgetId) => void
  onDrop: () => void
  onDragEnd: () => void
  onStep: (id: WidgetId, dir: -1 | 1) => void
  canStep: (id: WidgetId, dir: -1 | 1) => boolean
}

const WorkspaceCtx = createContext<Ctx | null>(null)
export const useWorkspace = () => useContext(WorkspaceCtx)

export function AnalyticsWorkspace({ children }: { children: React.ReactNode }) {
  const supabase = useMemo(() => createClient(), [])
  const [layout, setLayout] = useState<AnalyticsLayout>(DEFAULT_LAYOUT)
  const [saved, setSaved] = useState<AnalyticsLayout>(DEFAULT_LAYOUT)
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [ready, setReady] = useState(false)
  const [dragging, setDragging] = useState<WidgetId | null>(null)
  const [dragOver, setDragOver] = useState<WidgetId | null>(null)
  const uid = useRef<string | null>(null)

  useEffect(() => {
    let active = true
    ;(async () => {
      const { data: { session } } = await supabase.auth.getSession()
      const user = session?.user
      if (!user) { if (active) setReady(true); return }
      uid.current = user.id
      const { data } = await supabase.from('business_settings')
        .select('analytics_layout').eq('user_id', user.id).maybeSingle()
      if (!active) return
      // normalizeLayout drops widgets that no longer exist and APPENDS ones added
      // since the layout was saved — a stored layout can never hide a new widget.
      const next = normalizeLayout((data as { analytics_layout: unknown } | null)?.analytics_layout)
      setLayout(next); setSaved(next); setReady(true)
    })()
    return () => { active = false }
  }, [supabase])

  const dirty = useMemo(
    () => layout.order.join() !== saved.order.join() || layout.hidden.join() !== saved.hidden.join(),
    [layout, saved],
  )

  const persist = useCallback(async (next: AnalyticsLayout) => {
    if (!uid.current) return
    setBusy(true)
    // upsert, not update: a user whose settings row doesn't exist yet would
    // otherwise no-op and lose the layout silently.
    const { error } = await supabase.from('business_settings')
      .upsert({ user_id: uid.current, analytics_layout: next }, { onConflict: 'user_id' })
    setBusy(false)
    if (error) { toast.error('Could not save your layout — please try again.'); return }
    setSaved(next); setEditing(false)
    toast.success('Layout saved.')
  }, [supabase])

  const ctx: Ctx = {
    editing,
    layout,
    indexOf: (id) => layout.order.indexOf(id),
    isHidden: (id) => layout.hidden.includes(id),
    onToggle: (id) => setLayout(l => toggleHidden(l, id)),
    dragging,
    dragOver,
    onDragStart: (id) => setDragging(id),
    onDragOver: (id) => { if (dragging && id !== dragOver) setDragOver(id) },
    onDrop: () => {
      if (dragging && dragOver) setLayout(l => ({ ...l, order: reorder(l.order, dragging, dragOver) }))
      setDragging(null); setDragOver(null)
    },
    onDragEnd: () => { setDragging(null); setDragOver(null) },
    onStep: (id, dir) => setLayout(l => step(l, id, dir)),
    canStep: (id, dir) => canStep(layout, id, dir),
  }

  const hiddenCount = layout.hidden.length

  return (
    <WorkspaceCtx.Provider value={ctx}>
      <div className="flex items-center gap-2 flex-wrap">
        {!editing ? (
          <>
            <Button variant="secondary" size="sm" onClick={() => setEditing(true)} disabled={!ready}>
              <SlidersHorizontal className="w-3.5 h-3.5" /> Customise
            </Button>
            {hiddenCount > 0 && (
              // Never let a hidden section become an invisible mystery — say so,
              // and make saying so the way to get it back.
              <button onClick={() => setEditing(true)}
                className="text-[11px] font-medium text-ink-muted hover:text-ink rounded px-1.5 py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                {hiddenCount} section{hiddenCount !== 1 ? 's' : ''} hidden
              </button>
            )}
          </>
        ) : (
          <>
            {/* Two hints, because drag only exists on pointer devices — telling a
                phone user to drag would be telling them to do the one thing they
                can't. */}
            <span className="text-[11px] text-ink-muted mr-1">
              <span className="hidden sm:inline">Drag, or use the arrows, to reorder</span>
              <span className="sm:hidden">Use the arrows to reorder</span>
              {' · '}the eye hides a section
            </span>
            <Button size="sm" onClick={() => persist(layout)} loading={busy} disabled={!dirty}>
              <Check className="w-3.5 h-3.5" /> Save layout
            </Button>
            <Button variant="ghost" size="sm" onClick={() => { setLayout(saved); setEditing(false) }}>
              <X className="w-3.5 h-3.5" /> Cancel
            </Button>
            {isCustomised(layout) && (
              <Button variant="ghost" size="sm" onClick={() => setLayout(DEFAULT_LAYOUT)} title="Back to the default order, nothing hidden">
                <RotateCcw className="w-3.5 h-3.5" /> Reset
              </Button>
            )}
          </>
        )}
      </div>

      {/* flex + CSS `order` — gap, not space-y, because space-y keys off DOM
          order and would put the margin on the wrong section once reordered. */}
      <div className="flex flex-col gap-6">{children}</div>

      {editing && hiddenCount > 0 && (
        <div className="rounded-card border border-border bg-bg-secondary p-4">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint mb-2.5">Hidden sections</p>
          <div className="flex flex-wrap gap-1.5">
            {layout.hidden.map(id => {
              const meta = WIDGETS.find(w => w.id === id)
              if (!meta) return null
              return (
                <button key={id} onClick={() => ctx.onToggle(id)} title={meta.blurb}
                  className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1.5 text-xs font-medium text-ink-muted hover:text-ink hover:border-border-strong transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                  <Eye className="w-3 h-3" /> {meta.title}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </WorkspaceCtx.Provider>
  )
}

/**
 * Chrome a section wears while the workspace is in edit mode. Outside edit mode
 * it renders nothing at all, so the page reads exactly as it always has.
 */
export function WidgetChrome({ id }: { id: WidgetId }) {
  const ws = useWorkspace()
  if (!ws?.editing) return null
  const hidden = ws.isHidden(id)
  const btn = 'w-8 h-8 rounded-md flex items-center justify-center text-ink-faint hover:text-ink hover:bg-surface transition-colors disabled:opacity-30 disabled:hover:text-ink-faint disabled:hover:bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40'
  return (
    <span className="flex items-center gap-0.5 shrink-0">
      <button onClick={() => ws.onToggle(id)} aria-label={hidden ? 'Show section' : 'Hide section'} className={btn}>
        {hidden ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
      </button>
      {/* Up/down are not a nicety — they're the ONLY way to reorder on a phone or
          a keyboard. HTML5 drag fires no touch events and can't be tabbed to. */}
      <button onClick={() => ws.onStep(id, -1)} disabled={hidden || !ws.canStep(id, -1)}
        aria-label="Move section up" className={btn}>
        <ChevronUp className="w-4 h-4" />
      </button>
      <button onClick={() => ws.onStep(id, 1)} disabled={hidden || !ws.canStep(id, 1)}
        aria-label="Move section down" className={btn}>
        <ChevronDown className="w-4 h-4" />
      </button>
      {/* Pointer-only affordance, so it stays hidden where it wouldn't work. */}
      <span className="hidden sm:flex w-7 h-7 rounded-md items-center justify-center text-ink-faint cursor-grab active:cursor-grabbing" title="Drag to reorder">
        <GripVertical className="w-3.5 h-3.5" />
      </span>
    </span>
  )
}

/** Props a section spreads onto its wrapper to join the workspace. */
export function useWidget(id: WidgetId) {
  const ws = useWorkspace()
  if (!ws) return { style: undefined, className: undefined, dragProps: {} }
  const hidden = ws.isHidden(id)
  return {
    style: { order: ws.indexOf(id) },
    className: cn(
      !ws.editing && hidden && 'hidden',
      ws.editing && hidden && 'opacity-40',
      ws.editing && 'rounded-card border border-dashed border-border p-3 -m-0.5 transition-colors',
      ws.editing && ws.dragging === id && 'opacity-50',
      ws.editing && ws.dragOver === id && ws.dragging !== id && 'ring-2 ring-accent border-transparent',
    ),
    dragProps: ws.editing ? {
      draggable: true,
      onDragStart: () => ws.onDragStart(id),
      onDragOver: (e: React.DragEvent) => { e.preventDefault(); ws.onDragOver(id) },
      onDrop: () => ws.onDrop(),
      onDragEnd: () => ws.onDragEnd(),
    } : {},
  }
}
