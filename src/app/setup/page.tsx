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
import { REGISTRATION_CLOSED, hasRegisterIntent, parseProvisioningStatus, registrationNextStep, type ProvisioningStatus, type RegistrationStep } from '@/lib/registration'
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
  // What the database says this account may do here. 'setup' is the normal
  // case; the other three each get one honest screen instead of a refused write.
  const [gate, setGate] = useState<RegistrationStep>('setup')
  // The licence's NAME. A self-service licence is not consent (S110 §4.1–4.3):
  // a row-less account that merely signed in sees a clean "no business yet"
  // screen, and only an explicit act — arriving from sign-up with ?intent=
  // register, or pressing "Create a business" here — reveals the picker.
  const [status, setStatus] = useState<ProvisioningStatus | null>(null)
  const [consented, setConsented] = useState(false)
  const [email, setEmail] = useState('')
  const [loadPhase, setLoadPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loadAttempt, setLoadAttempt] = useState(0)

  useEffect(() => {
    let alive = true
    setLoadPhase('loading')
    setStatus(null)
    setConsented(false)
    setUid(null)
    setState(null)
    ;(async () => {
      try {
        const { data: { user } } = await supabase.auth.getUser()
        if (!alive) return
        if (!user) { router.replace('/login'); return }
        // Finish a pending beta redemption before anything is written (idempotent;
        // answers calmly for everyone: legacy owner → 'already-owner', crew →
        // 'no-invite'). Without this, an invited owner whose /signup/confirm tab
        // died between verification and redemption would hit the business_settings
        // INSERT policy below with no way through.
        await supabase.rpc('claim_beta_invite')
        if (!alive) return
        // Then ask whether this account may create a business at all — the same
        // function the business_settings INSERT policy derives from. A public
        // sign-up while the switch is closed, or a crew-linked account, is told so
        // HERE, calmly, instead of by a refused upsert. An unknown answer cannot
        // reveal creation controls: self-service still requires explicit consent.
        const { data: gateAnswer, error: gateErr } = await supabase.rpc('provisioning_status')
        if (!alive) return
        if (gateErr) throw new Error('Account check unavailable')
        const parsed = parseProvisioningStatus(gateAnswer)
        if (!parsed) throw new Error('Account check unavailable')
        setStatus(parsed)
        const step = registrationNextStep(parsed)
        if (step !== 'setup') { setGate(step); setLoadPhase('ready'); return }
        if (parsed === 'self-service' && hasRegisterIntent(window.location.search)) setConsented(true)
        setEmail(user.email ?? '')
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
        setLoadPhase('ready')
      } catch {
        if (alive) setLoadPhase('error')
      }
    })()
    return () => { alive = false }
  }, [supabase, router, loadAttempt])

  const pack: TradePack | null = picked ? tradePack(picked) : null
  const plan = state && pack ? seedPlan(state, pack) : null
  const configured = !!state && (state.serviceTemplateCount > 0 || state.seasonsConfigured)

  // A refused write is RE-ASKED, never echoed (S110 §4.4). The switch can close
  // between the page loading and the click, and a crew link can be made in
  // between too; the database's word is the one that is current, and each word
  // has its own screen. Only a transient fault falls through to a sentence —
  // ours, never the driver's.
  async function explainRefusal(fallback: string) {
    const { data, error: askErr } = await supabase.rpc('provisioning_status')
    if (!askErr) {
      const step = registrationNextStep(parseProvisioningStatus(data))
      if (step !== 'setup') { setGate(step); return }
    }
    setError(fallback)
  }

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
      if (nameErr) { await explainRefusal('Couldn’t save the business name — nothing was changed. Please try again.'); setApplying(false); return }
    }
    const res = await applyTradeSelection(supabase, uid, picked)
    setApplying(false)
    if (!res.ok) {
      // Seeding fills emptiness only, so trying again is always safe.
      await explainRefusal('Couldn’t finish setting up. Trying again is safe — seeding never overwrites what is already there.')
      setResult(res)
      return
    }
    setResult(res)
  }

  // Loading/retry never exposes a stale licence or consent from an earlier read.
  if (loadPhase === 'loading') {
    return <div className="min-h-screen bg-bg flex items-center justify-center" role="status" aria-label="Checking your account"><Zap className="w-6 h-6 text-accent animate-pulse" /></div>
  }
  if (loadPhase === 'error') {
    return (
      <Shell>
        <div className="text-center mb-6" role="alert">
          <h1 className="text-xl font-bold text-ink">Couldn’t check your account</h1>
          <p className="text-sm text-ink-muted mt-1">We couldn’t confirm the next step for this account. Try again to continue setup.</p>
        </div>
        <Button className="w-full" type="button" onClick={() => { setLoadPhase('loading'); setLoadAttempt(attempt => attempt + 1) }}>Try again</Button>
      </Shell>
    )
  }

  // ── Not licensed to set up a business — one honest screen each ──
  if (gate !== 'setup') {
    const signOut = async () => { await supabase.auth.signOut({ scope: 'local' }).catch(() => {}); router.replace('/login') }
    return (
      <Shell>
        <div className="text-center mb-6">
          <div className="w-12 h-12 rounded-2xl bg-bg-secondary border border-border flex items-center justify-center mx-auto mb-3"><ShieldCheck className="w-6 h-6 text-amber-300" /></div>
          <h1 className="text-xl font-bold text-ink">
            {gate === 'crew' ? 'This account belongs to a crew' : gate === 'unverified' ? 'Confirm your email first' : REGISTRATION_CLOSED.title}
          </h1>
          <p className="text-sm text-ink-muted mt-1">
            {gate === 'crew'
              ? 'This account is linked to an employer’s crew, so it can’t also own a business. Use your join code to reach your crew tools, or start a business with a different email.'
              : gate === 'unverified'
                ? 'Open the confirmation link we emailed you, then come back here.'
                : REGISTRATION_CLOSED.body}
          </p>
        </div>
        <div className="flex gap-2">
          {gate === 'crew' && <Link href="/crew/join" className="flex-1"><Button className="w-full" type="button">Enter your join code</Button></Link>}
          <Button variant="secondary" className="flex-1" type="button" onClick={signOut}>Sign out</Button>
        </div>
      </Shell>
    )
  }

  // ── Signed in, not registering — the clean row-less state ──
  // A self-service licence reached by a plain sign-in. Nothing is created until
  // this person says so; "Sign out" leaves no trace.
  if (status === 'self-service' && !consented) {
    const signOut = async () => { await supabase.auth.signOut({ scope: 'local' }).catch(() => {}); router.replace('/login') }
    return (
      <Shell>
        <div className="text-center mb-6">
          <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-accent to-emerald-700 flex items-center justify-center mx-auto mb-3 shadow-lg shadow-accent/20"><Zap className="w-6 h-6 text-black fill-black" /></div>
          <h1 className="text-xl font-bold text-ink">No business yet</h1>
          <p className="text-sm text-ink-muted mt-1">
            You’re signed in{email ? <> as <span className="text-ink font-medium">{email}</span></> : null}, and no business is set up for this account. Create one now, or sign out — nothing is created until you choose.
          </p>
        </div>
        <div className="flex gap-2">
          <Button className="flex-1" size="lg" type="button" onClick={() => setConsented(true)}>Create a business <ArrowRight className="w-4 h-4" /></Button>
          <Button variant="secondary" className="flex-1" type="button" onClick={signOut}>Sign out</Button>
        </div>
        <p className="mt-6 text-center text-xs text-ink-faint">
          Joining a crew instead?{' '}
          <Link href="/crew/join" className="font-medium text-accent-text underline-offset-2 hover:underline">Enter your code</Link>
        </p>
      </Shell>
    )
  }

  if (!state) {
    return <div className="min-h-screen bg-bg flex items-center justify-center"><Zap className="w-6 h-6 text-accent animate-pulse" /></div>
  }

  // ── Done ──
  if (result?.ok) {
    // A brand-new business — no settings row existed when this page loaded,
    // the same signal the dashboard gate uses — is sent to the one thing the
    // dashboard would ask for next anyway: its first quote. The customer, the
    // scheduled work and the invoice all follow from it, so nothing has to be
    // set up first. A configured business reseeding from Settings goes back to
    // its dashboard exactly as before.
    // A returning owner who previously skipped already has a settings row;
    // keep that existing owner's dashboard action even if no services were seeded.
    const firstRun = !state.hasSettingsRow
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
          {firstRun ? (
            <>
              <Button className="flex-1" onClick={() => { router.push('/dashboard/quotes/new'); router.refresh() }}>Create your first quote <ArrowRight className="w-4 h-4" /></Button>
              <Button variant="secondary" className="flex-1" type="button" onClick={() => { router.push('/dashboard'); router.refresh() }}>Go to your dashboard</Button>
            </>
          ) : (
            <>
              <Button className="flex-1" onClick={() => { router.push('/dashboard'); router.refresh() }}>Go to your dashboard <ArrowRight className="w-4 h-4" /></Button>
              <Link href="/dashboard/settings/templates" className="flex-1"><Button variant="secondary" className="w-full" type="button">Review services</Button></Link>
            </>
          )}
        </div>
        {/* The seeded prices stay one tap away for a first run, without a third
            button competing with the next step. */}
        {firstRun && result.seeded.services > 0 && (
          <p className="mt-4 text-center text-xs text-ink-faint">
            Want to check the starter prices first?{' '}
            <Link href="/dashboard/settings/templates" className="font-medium text-accent-text underline-offset-2 hover:underline">Review services</Link>
          </p>
        )}
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
        {/* Optional, and SAID so: the primary button waits on the trade alone,
            and nothing here told a first-time owner which of the two fields was
            holding it. The reseed surface keeps its unhinted field. */}
        <Input label="Business name" placeholder="e.g. Northside Plumbing Ltd." value={name} onChange={e => setName(e.target.value)}
          hint={configured ? undefined : 'Optional — add or change it any time in Settings.'} />
      </div>

      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint mb-2">What kind of work do you do?</p>
      {!configured && (
        <p className="text-xs text-ink-muted -mt-1 mb-3">Choose a trade to load starter services, or skip for now.</p>
      )}
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
            if (skipErr) { await explainRefusal('Couldn’t save — please try again.'); return }
            router.push('/dashboard'); router.refresh()
          }} className="text-sm text-ink-faint hover:text-ink transition-colors">
            {/* Under public registration this control creates the tenant, so it
                says so (S110 §4.2). An invited owner keeps the familiar label. */}
            {status === 'self-service' ? 'Create my business without a starter catalogue' : 'Skip for now'}
          </button>
        )}
      </div>
      {/* The escape hatch for an EMPLOYEE who landed here. This page is reached
          by any signed-in account with no business_settings row — which is a new
          owner, but also a new worker who signed in before redeeming their join
          code. Setting up a business is the one thing they must not do, and
          without this the only visible path does exactly that. */}
      {!configured && (
        <p className="mt-6 text-center text-xs text-ink-faint">
          Joining a crew instead?{' '}
          <Link href="/crew/join" className="font-medium text-accent-text underline-offset-2 hover:underline">
            Enter your code
          </Link>
        </p>
      )}
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
