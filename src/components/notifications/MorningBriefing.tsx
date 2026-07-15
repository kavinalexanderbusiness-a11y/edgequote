'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { buildMorningBriefing, type BriefingJob, type MorningBriefing as Briefing } from '@/lib/briefing'
import { loadWeatherImpact } from '@/lib/weatherImpact'
import { needsFollowUp } from '@/lib/followup'
import type { Coord } from '@/lib/geo'
import type { Quote } from '@/types'
import { cn, localTodayISO } from '@/lib/utils'
import { Sunrise, ChevronRight } from 'lucide-react'

// Start-of-day digest — one calm card that answers "what matters today" from data
// EdgeQuote already has (scheduling, payments, CRM, weather). Reuses lib/briefing
// for the math and the existing engines for travel/finish/weather.
export function MorningBriefing() {
  const supabase = useMemo(() => createClient(), [])
  const [briefing, setBriefing] = useState<Briefing | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    ;(async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { if (active) setLoading(false); return }
      const today = localTodayISO()
      const [jobsRes, sRes, invRes, quotesRes, weather] = await Promise.all([
        supabase.from('jobs').select('id, status, price, duration_minutes, properties(lat, lng)').eq('user_id', user.id).eq('scheduled_date', today),
        supabase.from('business_settings').select('base_lat, base_lng, work_start_time').eq('user_id', user.id).maybeSingle(),
        supabase.from('invoices').select('amount, due_date, status').eq('user_id', user.id).in('status', ['unpaid', 'sent']),
        supabase.from('quotes').select('status, sent_at, follow_up_count, last_followed_up_at').eq('user_id', user.id).eq('status', 'sent'),
        loadWeatherImpact(supabase).catch(() => null),
      ])
      if (!active) return

      // The embedded to-one `properties` can arrive as an object or a 1-element
      // array depending on the typed-client shape — normalise both.
      type JobRow = { id: string; status: string; price: number | null; duration_minutes: number | null; properties: { lat: number | null; lng: number | null } | { lat: number | null; lng: number | null }[] | null }
      const jobsToday: BriefingJob[] = ((jobsRes.data as unknown as JobRow[]) || []).map(j => {
        const p = Array.isArray(j.properties) ? j.properties[0] : j.properties
        return { id: j.id, status: j.status, price: j.price, duration_minutes: j.duration_minutes, lat: p?.lat ?? null, lng: p?.lng ?? null }
      })
      const s = sRes.data as { base_lat: number | null; base_lng: number | null; work_start_time: string | null } | null
      const base: Coord | null = s?.base_lat != null && s?.base_lng != null ? { lat: s.base_lat, lng: s.base_lng } : null
      const unpaid = ((invRes.data as { amount: number | null; due_date: string | null }[]) || []).map(i => ({ amount: i.amount, due_date: i.due_date }))
      const followUpCount = ((quotesRes.data as unknown as Quote[]) || []).filter(q => needsFollowUp(q)).length
      const todayImpact = weather?.atRiskDays?.find(d => d.date === today) ?? null
      const weatherSig = todayImpact && (todayImpact.recommendation.action === 'delay' || todayImpact.recommendation.action === 'monitor')
        ? { affectsToday: true, text: todayImpact.recommendation.text }
        : null

      setBriefing(buildMorningBriefing({
        today, jobsToday, base, workStart: s?.work_start_time || '08:00',
        unpaid, followUpCount, weather: weatherSig,
      }))
      setLoading(false)
    })()
    return () => { active = false }
  }, [supabase])

  if (loading || !briefing) return null

  const toneClass = (tone?: string) =>
    tone === 'warn' ? 'border-amber-500/30 bg-amber-500/[0.06]' : 'border-border bg-bg-tertiary'

  return (
    <div className="rounded-card border border-accent/20 bg-gradient-to-br from-accent/[0.06] to-transparent p-4">
      <div className="flex items-center gap-2 mb-3">
        <div className="w-8 h-8 rounded-lg bg-accent/10 border border-accent/20 flex items-center justify-center shrink-0">
          <Sunrise className="w-4 h-4 text-accent-text" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-bold text-ink">Morning briefing</p>
          <p className="text-xs text-ink-muted truncate">{briefing.headline}</p>
        </div>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {briefing.stats.map(stat => {
          const inner = (
            <>
              <div className="flex items-center justify-between gap-1">
                <p className="text-[10px] uppercase tracking-wide text-ink-faint">{stat.label}</p>
                {stat.href && <ChevronRight className="w-3 h-3 text-ink-faint" />}
              </div>
              <p className={cn('text-lg font-bold leading-tight tabular-nums', stat.tone === 'warn' ? 'text-amber-300' : 'text-ink')}>{stat.value}</p>
              {stat.detail && <p className="text-[11px] text-ink-muted truncate">{stat.detail}</p>}
            </>
          )
          return stat.href ? (
            <Link key={stat.key} href={stat.href} className={cn('rounded-xl border px-3 py-2 transition-colors hover:border-border-strong', toneClass(stat.tone))}>
              {inner}
            </Link>
          ) : (
            <div key={stat.key} className={cn('rounded-xl border px-3 py-2', toneClass(stat.tone))}>{inner}</div>
          )
        })}
      </div>
    </div>
  )
}
