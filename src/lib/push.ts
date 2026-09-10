'use client'

// Client helpers for the "Enable push notifications" flow. Permission is requested
// ONLY when the owner taps the button (never on load). On success the browser's
// PushSubscription is saved to our API so the server can deliver Web Push to this
// device. Web Push/VAPID works on Chrome/Edge/Firefox/Android and on iOS 16.4+
// — but on iOS ONLY when the app is installed to the Home Screen (standalone).

export type PushState = 'unsupported' | 'denied' | 'subscribed' | 'default'

const VAPID_PUBLIC = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || ''

function supported(): boolean {
  return typeof window !== 'undefined'
    && 'serviceWorker' in navigator
    && 'PushManager' in window
    && 'Notification' in window
}

// iOS only allows web push from an installed (standalone) PWA.
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false
  return window.matchMedia?.('(display-mode: standalone)').matches
    || (window.navigator as unknown as { standalone?: boolean }).standalone === true
}

export function isIos(): boolean {
  if (typeof navigator === 'undefined') return false
  return /iphone|ipad|ipod/i.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) // iPadOS
}

// Reflects the live state so the Settings toggle can render accurately.
export async function getPushState(): Promise<PushState> {
  if (!supported() || !VAPID_PUBLIC) return 'unsupported'
  if (Notification.permission === 'denied') return 'denied'
  try {
    const reg = await navigator.serviceWorker.ready
    const sub = await reg.pushManager.getSubscription()
    if (sub) return 'subscribed'
  } catch { /* fall through */ }
  return Notification.permission === 'granted' ? 'default' : 'default'
}

// Returns an ArrayBuffer (not a generic Uint8Array) so it satisfies the DOM
// applicationServerKey type cleanly across TS versions.
function urlBase64ToBuffer(base64: string): ArrayBuffer {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(b64)
  const buf = new ArrayBuffer(raw.length)
  const view = new Uint8Array(buf)
  for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i)
  return buf
}

// Request permission → subscribe → persist. Returns a state + a human reason on
// failure so the UI can explain what to do next.
export async function enablePush(): Promise<{ ok: boolean; state: PushState; reason?: string }> {
  if (!supported() || !VAPID_PUBLIC) return { ok: false, state: 'unsupported', reason: 'Push isn’t available on this browser.' }
  if (isIos() && !isStandalone()) {
    return { ok: false, state: 'unsupported', reason: 'On iPhone/iPad, first add EdgeQuote to your Home Screen, open it from there, then enable notifications.' }
  }
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') {
    return { ok: false, state: permission === 'denied' ? 'denied' : 'default', reason: 'Notifications were not allowed.' }
  }
  try {
    const reg = await navigator.serviceWorker.ready
    let sub = await reg.pushManager.getSubscription()
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToBuffer(VAPID_PUBLIC),
      })
    }
    const res = await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sub.toJSON()),
    })
    if (!res.ok) return { ok: false, state: 'default', reason: 'Could not save the subscription.' }
    return { ok: true, state: 'subscribed' }
  } catch (e) {
    return { ok: false, state: 'default', reason: (e as Error).message || 'Subscription failed.' }
  }
}

// Unsubscribe this device and tell the server to drop the row.
export async function disablePush(): Promise<{ ok: boolean }> {
  try {
    const reg = await navigator.serviceWorker.ready
    const sub = await reg.pushManager.getSubscription()
    const endpoint = sub?.endpoint
    if (sub) await sub.unsubscribe()
    await fetch('/api/push/unsubscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint }),
    })
    return { ok: true }
  } catch {
    return { ok: false }
  }
}
