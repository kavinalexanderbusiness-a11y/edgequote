// ── Shared toast + undo store ────────────────────────────────────────────────
// ONE non-blocking notification system for the whole app, replacing scattered
// native alert()/confirm()/prompt() and the per-page toast/undo copies. A tiny
// external store (subscribe/emit) consumed by <Toaster/> (mounted once in the
// dashboard layout). Destructive actions use toast.undo(msg, revert) — act now,
// offer a few seconds to undo — instead of an up-front blocking confirm.

export type ToastTone = 'info' | 'success' | 'error' | 'warning' | 'loading'

export interface ToastItem {
  id: number
  message: string
  tone: ToastTone
  undo?: () => void | Promise<void>
  duration: number
}

let items: ToastItem[] = []
let seq = 0
const listeners = new Set<() => void>()
function emit() { for (const l of Array.from(listeners)) l() }

export function subscribeToasts(cb: () => void) { listeners.add(cb); return () => { listeners.delete(cb) } }
export function getToasts(): ToastItem[] { return items }

export function dismissToast(id: number) {
  if (!items.some(t => t.id === id)) return
  items = items.filter(t => t.id !== id)
  emit()
}

// Mutate a live toast in place — drives loading→success/error and progress
// updates (e.g. "Saving 3/5…") without stacking new toasts.
export function updateToast(id: number, patch: Partial<Pick<ToastItem, 'message' | 'tone' | 'undo' | 'duration'>>) {
  if (!items.some(t => t.id === id)) return
  items = items.map(t => (t.id === id ? { ...t, ...patch } : t))
  emit()
  if (patch.duration && patch.duration > 0 && typeof window !== 'undefined') {
    window.setTimeout(() => dismissToast(id), patch.duration)
  }
}

interface ToastOpts { tone?: ToastTone; undo?: () => void | Promise<void>; duration?: number }

function push(message: string, opts: ToastOpts = {}): number {
  const id = ++seq
  const duration = opts.duration ?? (opts.undo ? 7000 : opts.tone === 'error' ? 6000 : 4000)
  items = [...items, { id, message, tone: opts.tone ?? 'info', undo: opts.undo, duration }]
  emit()
  if (duration > 0 && typeof window !== 'undefined') {
    window.setTimeout(() => dismissToast(id), duration)
  }
  return id
}

// toast('…') for a neutral note; toast.error/success/info for tone; toast.undo
// for a reversible action (shows an Undo button that runs `onUndo`).
export const toast = Object.assign(
  (message: string, opts?: ToastOpts) => push(message, opts),
  {
    info: (m: string) => push(m, { tone: 'info' }),
    success: (m: string) => push(m, { tone: 'success' }),
    warning: (m: string) => push(m, { tone: 'warning' }),
    error: (m: string) => push(m, { tone: 'error' }),
    undo: (m: string, onUndo: () => void | Promise<void>) => push(m, { tone: 'info', undo: onUndo }),
    // A sticky spinner toast; returns its id. Update it (progress) or resolve it
    // with toast.update(id, …) / toast.dismiss(id), or use toast.promise.
    loading: (m: string) => push(m, { tone: 'loading', duration: 0 }),
    update: updateToast,
    dismiss: dismissToast,
    // Drive a whole async action's feedback from one toast: spinner → success/error.
    promise: async <T>(p: Promise<T>, msgs: { loading: string; success: string | ((v: T) => string); error: string | ((e: unknown) => string) }): Promise<T> => {
      const id = push(msgs.loading, { tone: 'loading', duration: 0 })
      try {
        const v = await p
        updateToast(id, { tone: 'success', message: typeof msgs.success === 'function' ? msgs.success(v) : msgs.success, duration: 4000 })
        return v
      } catch (e) {
        updateToast(id, { tone: 'error', message: typeof msgs.error === 'function' ? msgs.error(e) : msgs.error, duration: 6000 })
        throw e
      }
    },
  },
)
