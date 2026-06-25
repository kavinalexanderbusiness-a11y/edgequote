import { NextRequest, NextResponse } from 'next/server'
import webpush from 'web-push'
import { createAdminClient } from '@/lib/supabase/admin'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Web Push fan-out for ONE existing notification. Called server-to-server by the
// `trg_push_dispatch` DB trigger (pg_net) right after a notification row is
// inserted — so EVERY notification the app already creates (quote accepted,
// invoice paid, inbound SMS, portal request, review, …) is delivered to the
// owner's installed PWAs without a second notification system. The DB trigger
// signs the call with a shared secret; we verify it before doing any work.
//
// Honors per-type preferences (business_settings.notif_prefs, opt-out model) and
// prunes dead subscriptions (HTTP 404/410) so the list self-heals.

// notification.type → preference key shown in Settings. Unmapped types fall back
// to their own type string (ON unless the owner explicitly turned it off).
const PREF_KEY: Record<string, string> = {
  new_message: 'sms',
  quote_accepted: 'quote_accepted',
  invoice_paid: 'invoice_paid',
  portal_request: 'portal_request',
  review_received: 'review_received',
  weather_alert: 'weather',
  weather: 'weather',
  daily_reminder: 'daily_reminder',
  schedule_change: 'schedule_change',
  schedule_changed: 'schedule_change',
}

function vapidReady(): boolean {
  const pub = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
  const priv = process.env.VAPID_PRIVATE_KEY
  if (!pub || !priv) return false
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:notifications@edgepropertyservices.ca', pub, priv)
  return true
}

export async function POST(req: NextRequest) {
  // 1) Only the DB trigger (which knows the shared secret) may call this.
  const secret = process.env.PUSH_SEND_SECRET
  if (!secret || req.headers.get('x-push-secret') !== secret) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  if (!vapidReady()) return NextResponse.json({ skipped: 'vapid-not-configured' })

  const admin = createAdminClient()
  if (!admin) return NextResponse.json({ error: 'admin-unavailable' }, { status: 500 })

  const body = await req.json().catch(() => null) as { id?: string } | null
  if (!body?.id) return NextResponse.json({ error: 'missing id' }, { status: 400 })

  // 2) Load the notification (service role — the trigger fires for any owner).
  const { data: n } = await admin.from('notifications')
    .select('id, user_id, type, title, body, href, read').eq('id', body.id).maybeSingle()
  if (!n) return NextResponse.json({ skipped: 'not-found' })
  const note = n as { id: string; user_id: string; type: string; title: string; body: string | null; href: string | null; read: boolean }

  // 3) Respect the owner's per-type preference (absent/anything-but-false = ON).
  const { data: bs } = await admin.from('business_settings')
    .select('notif_prefs').eq('user_id', note.user_id).maybeSingle()
  const prefs = ((bs as { notif_prefs?: Record<string, unknown> } | null)?.notif_prefs) || {}
  const prefKey = PREF_KEY[note.type] || note.type
  if (prefs[prefKey] === false) return NextResponse.json({ skipped: 'pref-off' })

  // 4) Current unread count → drives the app-icon badge on the device.
  const { count: unread } = await admin.from('notifications')
    .select('id', { count: 'exact', head: true }).eq('user_id', note.user_id).eq('read', false)

  // 5) Send to every registered device; prune the ones the browser dropped.
  const { data: subs } = await admin.from('push_subscriptions')
    .select('id, endpoint, p256dh, auth').eq('user_id', note.user_id)
  if (!subs || !subs.length) return NextResponse.json({ sent: 0, badge: unread ?? 0 })

  const payload = JSON.stringify({
    title: note.title,
    body: note.body || '',
    url: note.href || '/dashboard',
    tag: note.type,
    badge: unread ?? 0,
  })

  let sent = 0
  const dead: string[] = []
  await Promise.all((subs as { id: string; endpoint: string; p256dh: string; auth: string }[]).map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload)
      sent++
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode
      if (status === 404 || status === 410) dead.push(s.id)   // gone/expired → remove
    }
  }))
  if (dead.length) await admin.from('push_subscriptions').delete().in('id', dead)

  return NextResponse.json({ sent, pruned: dead.length, badge: unread ?? 0 })
}
