import { Check, CheckCheck, MailOpen, MousePointerClick, Clock, RotateCw, AlertTriangle, X, Ban, Reply, type LucideIcon } from 'lucide-react'

// ── Timeline status model (future-proof) ─────────────────────────────────────
// THE single mapping from a notification_log/message status → its timeline badge.
// Today we write: sent · skipped · disabled · error · sending. Later, delivery
// webhooks (Twilio/Resend) can set delivered · opened · clicked · bounced · spam ·
// unsubscribed · reply and they render correctly with NO UI change — add a row here.
export type StatusTone = 'ok' | 'pending' | 'warn' | 'fail'
export interface StatusMeta { key: string; label: string; Icon: LucideIcon; tone: StatusTone }

const META: Record<string, StatusMeta> = {
  sent:         { key: 'sent',         label: 'Sent',         Icon: Check,             tone: 'ok' },
  delivered:    { key: 'delivered',    label: 'Delivered',    Icon: CheckCheck,        tone: 'ok' },
  opened:       { key: 'opened',       label: 'Opened',       Icon: MailOpen,          tone: 'ok' },
  clicked:      { key: 'clicked',      label: 'Clicked',      Icon: MousePointerClick, tone: 'ok' },
  reply:        { key: 'reply',        label: 'Replied',      Icon: Reply,             tone: 'ok' },
  queued:       { key: 'queued',       label: 'Queued',       Icon: Clock,             tone: 'pending' },
  sending:      { key: 'sending',      label: 'Sending',      Icon: Clock,             tone: 'pending' },
  retrying:     { key: 'retrying',     label: 'Retrying',     Icon: RotateCw,          tone: 'pending' },
  skipped:      { key: 'skipped',      label: 'Skipped',      Icon: AlertTriangle,     tone: 'warn' },
  disabled:     { key: 'disabled',     label: 'Skipped',      Icon: AlertTriangle,     tone: 'warn' },
  unsubscribed: { key: 'unsubscribed', label: 'Unsubscribed', Icon: Ban,               tone: 'warn' },
  error:        { key: 'error',        label: 'Failed',       Icon: X,                 tone: 'fail' },
  failed:       { key: 'failed',       label: 'Failed',       Icon: X,                 tone: 'fail' },
  bounced:      { key: 'bounced',      label: 'Bounced',      Icon: X,                 tone: 'fail' },
  spam:         { key: 'spam',         label: 'Spam report',  Icon: Ban,               tone: 'fail' },
}

// Unknown/legacy statuses default to a neutral "Sent" only when explicitly 'sent';
// anything else unrecognized is treated as a non-delivery so we never falsely claim Sent.
export function statusMeta(status: string | null | undefined): StatusMeta {
  const s = (status || '').toLowerCase()
  return META[s] || (s === '' ? META.sent : { key: s, label: s.charAt(0).toUpperCase() + s.slice(1), Icon: AlertTriangle, tone: 'warn' })
}

export const TONE_CLASS: Record<StatusTone, string> = {
  ok:      'text-emerald-400 bg-emerald-500/10 border-emerald-500/25',
  pending: 'text-ink-faint bg-bg-tertiary border-border',
  warn:    'text-amber-400 bg-amber-500/10 border-amber-500/25',
  fail:    'text-red-400 bg-red-500/10 border-red-500/25',
}
