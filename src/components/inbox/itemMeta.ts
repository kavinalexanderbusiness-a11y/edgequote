// Presentation map for Owner Inbox items — kind → icon + tone. Data stays in
// lib/inbox; this file exists so the inbox page and the dashboard preview render
// one item the same way. Keyed on the FULL union (Record, not partial): adding a
// kind without deciding how it looks is a compile error, not a grey fallback.

import {
  DollarSign, UserPlus, CalendarPlus, AlertTriangle, FileText, Bell, PhoneOff,
  Repeat, HeartPulse, MessageSquare, MessageSquarePlus, FilePen, FilePenLine,
  MessagesSquare, CalendarX2, CreditCard, type LucideIcon,
} from 'lucide-react'
import type { InboxItemKind } from '@/lib/inbox'

export const ITEM_META: Record<InboxItemKind, { icon: LucideIcon; tone: string }> = {
  // The Session-13 queue kinds — same glyph and tone the dashboard card has
  // always used, so a row keeps its identity when it moves between surfaces.
  unpaid:       { icon: DollarSign,    tone: 'text-red-400 bg-red-500/10 border-red-500/20' },
  leads:        { icon: UserPlus,      tone: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20' },
  unscheduled:  { icon: CalendarPlus,  tone: 'text-amber-400 bg-amber-500/10 border-amber-500/20' },
  missed:       { icon: AlertTriangle, tone: 'text-red-400 bg-red-500/10 border-red-500/20' },
  drafts:       { icon: FileText,      tone: 'text-sky-400 bg-sky-500/10 border-sky-500/20' },
  followups:    { icon: Bell,          tone: 'text-amber-400 bg-amber-500/10 border-amber-500/20' },
  followups_blocked: { icon: PhoneOff, tone: 'text-ink-muted bg-bg-tertiary border-border' },
  reactivation: { icon: Repeat,        tone: 'text-accent-text bg-accent/10 border-accent/20' },
  lapsed:       { icon: HeartPulse,    tone: 'text-violet-400 bg-violet-500/10 border-violet-500/20' },
  messages:     { icon: MessageSquare, tone: 'text-sky-400 bg-sky-500/10 border-sky-500/20' },
  requests:     { icon: MessageSquarePlus, tone: 'text-accent-text bg-accent/10 border-accent/20' },
  // A quote the owner started writing — pen on paper, sky like the other
  // unfinished-document row so "drafted, not sent" reads as one family.
  quote_drafts: { icon: FilePenLine,   tone: 'text-sky-400 bg-sky-500/10 border-sky-500/20' },
  // Priced extra work nobody has seen yet — the same family as quote drafts,
  // amber because customer-approved money is waiting on the owner to ask.
  change_orders: { icon: FilePen,      tone: 'text-amber-400 bg-amber-500/10 border-amber-500/20' },
  // Crew words, not customer words — deliberately the same distinction the
  // notifications page draws (MessagesSquare vs MessageSquare).
  crew:         { icon: MessagesSquare, tone: 'text-sky-400 bg-sky-500/10 border-sky-500/20' },
  // A booked day that cannot run as promised.
  day_conflict: { icon: CalendarX2,    tone: 'text-red-400 bg-red-500/10 border-red-500/20' },
  // Failed payments, disputes, autopay holds — money/trust repairs.
  payment_event: { icon: CreditCard,   tone: 'text-red-400 bg-red-500/10 border-red-500/20' },
}
