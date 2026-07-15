// ── Schedule item types (non-job calendar entries) ──────────────────────────────
// The ONE place each non-job schedule type is defined: its icon, colour, which
// fields it uses, and whether it joins the route. These live in a SEPARATE table
// (public.schedule_items) from jobs ON PURPOSE — labor, revenue, weather, routing
// and analytics keep reading jobs only, so a callback/task/reminder can never move
// those numbers. The calendar + Day Ops merge both at the view layer.

import { Ruler, Phone, CalendarClock, ListChecks, AlarmClock } from 'lucide-react'

export type ScheduleItemType = 'estimate' | 'callback' | 'appointment' | 'task' | 'reminder'
export type ScheduleItemStatus = 'scheduled' | 'completed' | 'cancelled'

export interface ScheduleItem {
  id: string
  type: ScheduleItemType
  title: string
  customer_id: string | null
  property_id: string | null
  scheduled_date: string          // yyyy-MM-dd
  start_time: string | null       // HH:mm[:ss]
  duration_minutes: number | null
  notes: string | null
  phone: string | null
  due_at: string | null           // ISO — tasks / reminders
  status: ScheduleItemStatus
  converted_quote_id: string | null
  completed_at: string | null
  // Joined for display + routing (read-only).
  customers?: { id: string; name: string; phone: string | null } | null
  properties?: { id: string; address: string | null; lat: number | null; lng: number | null } | null
}

export interface ItemFields { customer?: boolean; property?: boolean; duration?: boolean; phone?: boolean; due?: boolean }

export interface ItemTypeMeta {
  label: string
  emoji: string
  icon: typeof Ruler
  routable: boolean               // joins the day's route optimization (estimates only)
  fields: ItemFields              // which inputs the form shows
  chip: string                    // calendar chip classes (border/bg/text)
  dot: string                     // colour dot
  accent: string                  // text accent
}

export const ITEM_META: Record<ScheduleItemType, ItemTypeMeta> = {
  estimate: {
    label: 'Estimate', emoji: '📏', icon: Ruler, routable: true,
    fields: { customer: true, property: true, duration: true },
    chip: 'border-sky-400/40 bg-sky-400/10 text-sky-400', dot: 'bg-sky-400', accent: 'text-sky-400',
  },
  callback: {
    label: 'Callback', emoji: '📞', icon: Phone, routable: false,
    fields: { customer: true, phone: true },
    chip: 'border-amber-400/40 bg-amber-400/10 text-amber-400', dot: 'bg-amber-400', accent: 'text-amber-400',
  },
  appointment: {
    label: 'Appointment', emoji: '📅', icon: CalendarClock, routable: false,
    fields: { customer: true, property: true, duration: true },
    chip: 'border-violet-400/40 bg-violet-400/10 text-violet-400', dot: 'bg-violet-400', accent: 'text-violet-400',
  },
  task: {
    label: 'Task', emoji: '📋', icon: ListChecks, routable: false,
    fields: { due: true },
    chip: 'border-slate-400/40 bg-slate-400/10 text-slate-200', dot: 'bg-slate-400', accent: 'text-slate-200',
  },
  reminder: {
    label: 'Reminder', emoji: '⏰', icon: AlarmClock, routable: false,
    fields: { due: true },
    chip: 'border-rose-400/40 bg-rose-400/10 text-rose-300', dot: 'bg-rose-400', accent: 'text-rose-300',
  },
}

export const SCHEDULE_ITEM_TYPES = Object.keys(ITEM_META) as ScheduleItemType[]

// Columns to select (with the joins display + routing need).
export const ITEM_SELECT =
  'id, type, title, customer_id, property_id, scheduled_date, start_time, duration_minutes, notes, phone, due_at, status, converted_quote_id, completed_at, customers(id, name, phone), properties(id, address, lat, lng)'

export function isRoutable(item: ScheduleItem): boolean {
  return ITEM_META[item.type].routable
}

// A routable estimate that has somewhere to drive (located property).
export function isRoutableStop(item: ScheduleItem): boolean {
  return ITEM_META[item.type]?.routable === true
    && item.status === 'scheduled'
    && item.properties?.lat != null && item.properties?.lng != null
}
