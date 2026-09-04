'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { Toggle } from '@/components/ui/Toggle'
import {
  DASHBOARD_CARDS, DEFAULT_DASHBOARD_LAYOUT, canStepCard, isDashboardCustomised,
  stepCard, toggleCardHidden, type DashboardLayout,
} from '@/lib/dashboard/layout'
import { Check, ChevronDown, ChevronUp, RotateCcw, SlidersHorizontal, X } from 'lucide-react'

// ── Customize dashboard — a checklist, not a canvas ──────────────────────────
// Six rows, a switch and two arrows each. V1 is deliberately drag-free: arrows
// work identically on touch, keyboard and mouse, and a fixed small registry
// doesn't earn a drag surface (the analytics workspace's own arrows exist
// because HTML5 drag can't be tabbed to or touched — here they're the whole
// interface). All state is a local DRAFT until Save: the layout engine
// (lib/dashboard/layout) owns every rule — required card, hidden-skip
// stepping — so this component contains no layout logic to drift.
//
// Save persists the draft to business_settings.dashboard_cards and refreshes
// the route so the SERVER re-renders the bands in the new order — rendering
// stays server-side, the one-batch data path untouched. UPSERT, never update:
// on an account with no settings row yet, .update() matches zero rows with no
// error and the "saved" layout would evaporate on the next load.

export function CustomizeDashboard({ initial, defaultOpen = false }: {
  initial: DashboardLayout
  /** Fixture-only: render the sheet already open so static markup (no React
   *  runtime, so no click) can be tabbed through and measured. The app never
   *  passes it. */
  defaultOpen?: boolean
}) {
  const router = useRouter()
  const [open, setOpen] = useState(defaultOpen)
  const [draft, setDraft] = useState<DashboardLayout>(initial)
  const [busy, setBusy] = useState(false)

  const dirty = draft.order.join() !== initial.order.join()
    || [...draft.hidden].sort().join() !== [...initial.hidden].sort().join()

  const openSheet = () => { setDraft(initial); setOpen(true) }

  const save = async () => {
    if (busy) return
    setBusy(true)
    const supabase = createClient()
    const { data: { session } } = await supabase.auth.getSession()
    const uid = session?.user?.id
    if (!uid) {
      setBusy(false)
      toast.error('Not signed in — your layout wasn’t saved.')
      return
    }
    const { error } = await supabase.from('business_settings')
      .upsert({ user_id: uid, dashboard_cards: draft }, { onConflict: 'user_id' })
    setBusy(false)
    if (error) {
      // The truth, not a shrug: the dashboard on screen still shows the OLD
      // layout (nothing was applied optimistically), so failing loudly here
      // leaves everything consistent.
      toast.error('Could not save your layout — ' + error.message)
      return
    }
    setOpen(false)
    toast.success('Dashboard updated.')
    router.refresh()
  }

  // tap-target: w-8 h-8 is 32px — measured in the S97 a11y fixture at 375/390/430,
  // below the 44px floor a gloved thumb needs. The shell's opt-in class grows
  // the hit area only under (pointer: coarse); desktop density is untouched.
  const arrowBtn = 'tap-target w-8 h-8 rounded-md flex items-center justify-center text-ink-faint hover:text-ink hover:bg-surface-raised transition-colors disabled:opacity-30 disabled:hover:text-ink-faint disabled:hover:bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40'

  return (
    <>
      {/* tap-target: below sm the label hides and the sm Button's 44px promise
          rests on a text line box that is no longer there — a bare icon leaves
          the box 40px tall (the phone proof measured exactly this). The shell's
          opt-in class restores the floor only where a thumb acts. */}
      <Button variant="secondary" size="sm" onClick={openSheet} aria-label="Customize dashboard" title="Customize dashboard" className="tap-target">
        <SlidersHorizontal className="w-3.5 h-3.5" />
        <span className="hidden sm:inline">Customize</span>
      </Button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Customize dashboard"
        icon={SlidersHorizontal}
        size="sm"
        onSubmit={save}
        footer={
          <>
            {isDashboardCustomised(draft) && (
              <Button variant="ghost" size="sm" onClick={() => setDraft(DEFAULT_DASHBOARD_LAYOUT)}
                title="Back to the default order, nothing hidden" className="mr-auto">
                <RotateCcw className="w-3.5 h-3.5" /> Reset
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
              <X className="w-3.5 h-3.5" /> Cancel
            </Button>
            <Button size="sm" onClick={save} loading={busy} disabled={!dirty}>
              <Check className="w-3.5 h-3.5" /> Save
            </Button>
          </>
        }
      >
        <p className="text-xs text-ink-muted mb-3">
          Choose the sections your dashboard shows, and use the arrows to order them.
        </p>
        <ol className="divide-y divide-border rounded-xl border border-border overflow-hidden">
          {draft.order.map(id => {
            const meta = DASHBOARD_CARDS.find(c => c.id === id)
            if (!meta) return null
            const hidden = draft.hidden.includes(id)
            return (
              <li key={id} className={cn('flex items-center gap-3 px-3 py-2.5 bg-surface', hidden && 'opacity-55')}>
                {/* tap-target: with no label the switch's button IS its 40×24
                    track — measured 40×24 at 375/390/430 in the S97 a11y
                    fixture. The class grows the hit area to 44×44 only under
                    (pointer: coarse); the track and its on/off stay as they are. */}
                <Toggle
                  checked={!hidden}
                  disabled={meta.required}
                  onChange={() => setDraft(l => toggleCardHidden(l, id))}
                  ariaLabel={`${hidden ? 'Show' : 'Hide'} ${meta.title}`}
                  className="tap-target"
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold tracking-tight text-ink">
                    {meta.title}
                    {meta.required && <span className="ml-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">Always shown</span>}
                  </span>
                  <span className="block text-xs text-ink-muted truncate">{meta.blurb}</span>
                </span>
                <span className="flex items-center gap-0.5 shrink-0">
                  <button type="button" onClick={() => setDraft(l => stepCard(l, id, -1))}
                    disabled={hidden || !canStepCard(draft, id, -1)}
                    aria-label={`Move ${meta.title} up`} className={arrowBtn}>
                    <ChevronUp className="w-4 h-4" />
                  </button>
                  <button type="button" onClick={() => setDraft(l => stepCard(l, id, 1))}
                    disabled={hidden || !canStepCard(draft, id, 1)}
                    aria-label={`Move ${meta.title} down`} className={arrowBtn}>
                    <ChevronDown className="w-4 h-4" />
                  </button>
                </span>
              </li>
            )
          })}
        </ol>
      </Modal>
    </>
  )
}
