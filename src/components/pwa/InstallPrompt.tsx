'use client'

import { useEffect, useRef, useState } from 'react'
import { Download, Share, X, Plus } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { isIos, isStandalone } from '@/lib/push'

// Chrome/Android fire this before showing their own install UI; we capture it so
// we can offer install at a calmer moment from our own button.
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

const DISMISS_KEY = 'eq-install-dismissed'
const SNOOZE_MS = 30 * 24 * 60 * 60 * 1000   // re-ask at most monthly
const SHOW_DELAY_MS = 18_000                  // let the owner settle in first

function recentlyDismissed(): boolean {
  try {
    const v = Number(localStorage.getItem(DISMISS_KEY) || 0)
    return v > 0 && Date.now() - v < SNOOZE_MS
  } catch { return false }
}

// Gentle, dismissible "Install EdgeQuote" banner. Never shows when already
// installed, recently dismissed, or before the owner has had a moment to use the
// app. Android gets a one-tap install; iOS gets the Share → Add to Home Screen
// hint (Safari has no programmatic install).
export function InstallPrompt() {
  const [show, setShow] = useState(false)
  const [iosHint, setIosHint] = useState(false)
  const deferred = useRef<BeforeInstallPromptEvent | null>(null)

  useEffect(() => {
    if (isStandalone() || recentlyDismissed()) return
    let timer: ReturnType<typeof setTimeout> | null = null

    const onBeforeInstall = (e: Event) => {
      e.preventDefault()
      deferred.current = e as BeforeInstallPromptEvent
      timer = setTimeout(() => setShow(true), SHOW_DELAY_MS)
    }
    const onInstalled = () => { setShow(false); try { localStorage.setItem(DISMISS_KEY, String(Date.now())) } catch { /* ignore */ } }

    window.addEventListener('beforeinstallprompt', onBeforeInstall)
    window.addEventListener('appinstalled', onInstalled)

    // iOS never fires beforeinstallprompt — offer the manual hint instead.
    if (isIos() && !isStandalone()) {
      timer = setTimeout(() => { setIosHint(true); setShow(true) }, SHOW_DELAY_MS)
    }

    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall)
      window.removeEventListener('appinstalled', onInstalled)
      if (timer) clearTimeout(timer)
    }
  }, [])

  function dismiss() {
    setShow(false)
    try { localStorage.setItem(DISMISS_KEY, String(Date.now())) } catch { /* ignore */ }
  }

  async function install() {
    const e = deferred.current
    if (!e) return
    await e.prompt()
    await e.userChoice.catch(() => null)
    deferred.current = null
    setShow(false)
  }

  if (!show) return null

  return (
    <div className="fixed inset-x-0 bottom-0 z-[90] flex justify-center px-3 pb-[calc(12px+env(safe-area-inset-bottom))] pointer-events-none">
      <div className="pointer-events-auto w-full max-w-md rounded-2xl border border-border bg-bg-secondary/95 backdrop-blur shadow-2xl p-3.5 flex items-start gap-3">
        <div className="w-10 h-10 rounded-xl bg-accent/10 border border-accent/30 text-accent-text flex items-center justify-center shrink-0">
          <Download className="w-5 h-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-ink">Install EdgeQuote</p>
          {iosHint ? (
            <p className="text-xs text-ink-muted mt-0.5 leading-relaxed">
              Tap <Share className="inline w-3.5 h-3.5 -mt-0.5" /> <span className="font-medium text-ink">Share</span>, then
              {' '}<span className="font-medium text-ink">Add to Home Screen</span> <Plus className="inline w-3.5 h-3.5 -mt-0.5" />
              {' '}for a faster, full-screen app with notifications.
            </p>
          ) : (
            <p className="text-xs text-ink-muted mt-0.5 leading-relaxed">
              Add it to your home screen for a faster, full-screen app with push notifications.
            </p>
          )}
          {!iosHint && (
            <div className="mt-2.5 flex items-center gap-2">
              <Button size="sm" onClick={install}>Install</Button>
              <Button size="sm" variant="ghost" onClick={dismiss}>Not now</Button>
            </div>
          )}
        </div>
        {/* Corner X only where there's no action row — the iOS hint has no
            buttons of its own; Android dismisses via "Not now". */}
        {iosHint && (
          <button onClick={dismiss} aria-label="Dismiss" className="shrink-0 text-ink-faint hover:text-ink transition-colors">
            <X className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  )
}
