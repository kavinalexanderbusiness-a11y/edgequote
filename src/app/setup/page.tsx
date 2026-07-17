'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Banner } from '@/components/ui/Banner'
import { TRADE_PACKS, tradePack, type TradePack } from '@/lib/trades'
import { loadSeedState, seedPlan, applyTradeSelection, type SeedState, type SeedResult } from '@/lib/onboarding/seed'
import { cn } from '@/lib/utils'
import { Zap, Check, ArrowRight, Sparkles, Wrench, ShieldCheck } from 'lucide-react'

// ── First-run setup ───────────────────────────────────────────────────────────
// The screen a brand-new business lands on (dashboard/layout redirects here when
// no business_settings row exists): name the business, say what trade it is, and
// get a useful catalogue on day one — seeded from lib/trades through the ONE
// seeding path, which only ever fills emptiness.
//
// The same screen doubles as the safe reseed surface for a configured business:
// every gate that closes is SHOWN with its reason ("keeping your 27 existing
// services"), so what a reseed would and wouldn't touch is never a mystery. An
// existing business can adopt a business_type here and nothing else moves.

export default function SetupPage() {
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const [uid, setUid] = useState<string | null>(null)
  const [state, setState] = useState<SeedState | null>(null)
  const [name, setName] = useState('')
  const [picked, setPicked] = useState<string | null>(null)
  const [applying, setApplying] = useState(false)
  const [result, setResult] = useState<SeedResult | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    ;(async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.replace('/login'); return }
      if (!alive) return
      setUid(user.id)
      const [st, biz] = await Promise.all([
        loadSeedState(supabase, user.id),
        supabase.from('business_settings').select('company_name').eq('user_id', user.id).maybeSingle(),
      ])
      if (!alive) return
      setState(st)
      setName(((biz.data as { company_name: string | null } | null)?.company_name || '').trim())
      // Pre-select the recorded type; a fresh account starts unpicked on purpose —
      // the choice should be made, not defaulted past.
      if (st.hasSettingsRow && st.businessType) setPicked(st.businessType)
    })()
    return () => { alive = false }
  }, [supabase, router])

  const pack: TradePack | null = picked ? tradePack(picked) : null
  const plan = state && pack ? seedPlan(state, pack) : null
  const configured = !!state && (state.serviceTemplateCount > 0 || state.seasonsConfigured)

  async function apply() {
    if (!uid || !picked) return
    setApplying(true); setError('')
    // The name is part of setup, not of seeding: written only when the owner
    // actually typed one, so applying a trade can never blank an existing name.
    // business_type rides along on THIS write so a brand-new row is born with the
    // owner's pick — never the lawn_landscaping column default that a name-only
    // insert would leave until applyTradeSelection's second write corrects it.
    const trimmed = name.trim()
    if (trimmed) {
      const { error: nameErr } = await supabase.from('business_settings')
        .upsert({ user_id: uid, company_name: trimmed, business_type: picked }, { onConflict: 'user_id' })
      if (nameErr) { setError(`Could not save the business name: ${nameErr.message}`); setApplying(false); return }
    }
    const res = await applyTradeSelection(supabase, uid, picked)
    setApplying(false)
    if (!res.ok) { setError(res.error || 'Something went wrong.'); setResult(res); return }
    setResult(res)
  }

  if (!state) {
    return <div className="min-h-screen bg-bg flex items-center justify-center"><Zap className="w-6 h-6 text-accent animate-pulse" /></div>
  }

  // ── Done ──
  if (result?.ok) {
    return (
      <Shell>
        <div className="text-center mb-6">
          <div className="w-12 h-12 rounded-2xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center mx-auto mb-3"><Check className="w-6 h-6 text-emerald-400" /></div>
          <h1 className="text-xl font-bold text-ink">You’re set up</h1>
          <p className="text-sm text-ink-muted mt-1">{tradePack(picked).label} — ready to quote.</p>
        </div>
        <div className="rounded-card border border-border bg-bg-secondary p-4 space-y-2 text-sm">
          <p className="text-ink flex items-center gap-2"><Sparkles className="w-4 h-4 text-accent-text" />
            {result.seeded.services > 0 ? `${result.seeded.services} starter services added — edit names and prices any time.` : 'Your existing services were kept exactly as they are.'}</p>
          {result.seeded.seasons > 0 && <p className="text-ink flex items-center gap-2"><Sparkles className="w-4 h-4 text-accent-text" /> Season windows set — adjust the dates in Settings.</p>}
          {result.plan.skipped.map(s => (
            <p key={s.surface} className="text-ink-faint flex items-center gap-2"><ShieldCheck className="w-4 h-4 shrink-0" /> {s.reason}</p>
          ))}
        </div>
        <div className="flex gap-2 mt-6">
          <Button className="flex-1" onClick={() => { router.push('/dashboard'); router.refresh() }}>Go to your dashboard <ArrowRight className="w-4 h-4" /></Button>
          <Link href="/dashboard/settings/templates" className="flex-1"><Button variant="secondary" className="w-full" type="button">Review services</Button></Link>
        </div>
      </Shell>
    )
  }

  // ── Pick ──
  return (
    <Shell wide>
      <div className="text-center mb-6">
        <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-accent to-emerald-700 flex items-center justify-center mx-auto mb-3 shadow-lg shadow-accent/20"><Zap className="w-6 h-6 text-black fill-black" /></div>
        <h1 className="text-xl font-bold text-ink">{configured ? 'Your business type' : 'Set up your business'}</h1>
        <p className="text-sm text-ink-muted mt-1">
          {configured
            ? 'Everything you’ve configured stays exactly as it is — this only records what trade you are.'
            : 'Pick your trade and start with a working catalogue — every name and price stays yours to change.'}
        </p>
      </div>

      <div className="mb-5">
        <Input label="Business name" placeholder="e.g. Northside Plumbing Ltd." value={name} onChange={e => setName(e.target.value)} />
      </div>

      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint mb-2">What kind of work do you do?</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-5">
        {TRADE_PACKS.map(p => {
          const active = picked === p.key
          return (
            <button key={p.key} type="button" onClick={() => setPicked(p.key)}
              className={cn('text-left rounded-card border p-3.5 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
                active ? 'border-accent/60 bg-accent/10' : 'border-border bg-bg-secondary hover:border-accent/30')}>
              <p className="text-sm font-semibold text-ink flex items-center gap-1.5">
                <Wrench className={cn('w-3.5 h-3.5', active ? 'text-accent-text' : 'text-ink-faint')} /> {p.label}
                {active && <Check className="w-3.5 h-3.5 text-accent-text ml-auto" />}
              </p>
              <p className="text-xs text-ink-muted mt-0.5">{p.blurb}</p>
            </button>
          )
        })}
      </div>

      {plan && pack && (
        <div className="rounded-card border border-border bg-bg-secondary p-4 mb-5 text-sm space-y-1.5">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint mb-1">What this will do</p>
          {plan.seedServices && <p className="text-ink flex items-center gap-2"><Sparkles className="w-4 h-4 text-accent-text shrink-0" /> Add {pack.services.length} starter services ({pack.label})</p>}
          {plan.seedSeasons && <p className="text-ink flex items-center gap-2"><Sparkles className="w-4 h-4 text-accent-text shrink-0" /> Set default season windows — dates are yours to adjust</p>}
          {plan.seedModules && <p className="text-ink flex items-center gap-2"><Sparkles className="w-4 h-4 text-accent-text shrink-0" /> Apply this trade’s recommended modules</p>}
          {plan.skipped.map(s => (
            <p key={s.surface} className="text-ink-faint flex items-start gap-2"><ShieldCheck className="w-4 h-4 shrink-0 mt-0.5" /> <span>{s.reason}</span></p>
          ))}
        </div>
      )}

      {error && <Banner tone="danger" className="mb-4">{error}</Banner>}

      <div className="flex items-center gap-3">
        <Button className="flex-1" size="lg" loading={applying} disabled={!picked} onClick={apply} type="button">
          {configured ? 'Save business type' : 'Set up my business'}
        </Button>
        {!configured && (
          <button type="button" onClick={async () => {
            // Skip = create the row so the first-run redirect stands down, and
            // record the NEUTRAL type explicitly — leaving it to the column
            // default would silently brand a plumber 'lawn_landscaping'. If they
            // did pick or type before skipping, honour both. Reachable again from
            // Settings any time.
            if (!uid) return
            const trimmed = name.trim()
            const row: Record<string, unknown> = { user_id: uid, business_type: picked || 'general' }
            if (trimmed) row.company_name = trimmed
            // Check the write: if the row wasn't created, the dashboard's first-run
            // gate would bounce them straight back here. Surface the error and stay
            // put rather than navigate into a redirect loop.
            const { error: skipErr } = await supabase.from('business_settings').upsert(row, { onConflict: 'user_id' })
            if (skipErr) { setError(`Couldn’t save — please try again. (${skipErr.message})`); return }
            router.push('/dashboard'); router.refresh()
          }} className="text-sm text-ink-faint hover:text-ink transition-colors">Skip for now</button>
        )}
      </div>
    </Shell>
  )
}

function Shell({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="min-h-screen bg-bg flex items-center justify-center px-4 py-10">
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div className="absolute w-[500px] h-[500px] rounded-full bg-accent opacity-[0.06] blur-[120px] -top-40 -left-20" />
        <div className="absolute w-[400px] h-[400px] rounded-full bg-blue-500 opacity-[0.04] blur-[120px] -top-20 -right-20" />
      </div>
      <main className={cn('w-full relative', wide ? 'max-w-xl' : 'max-w-md')}>{children}</main>
    </div>
  )
}
