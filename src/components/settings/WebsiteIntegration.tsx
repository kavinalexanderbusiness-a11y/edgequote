'use client'

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { toast } from '@/lib/toast'
import { ensureBookingToken } from '@/lib/booking'
import { Card, CardHeader, CardBody } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Toggle } from '@/components/ui/Toggle'
import { Collapsible } from '@/components/ui/Collapsible'
import { cn } from '@/lib/utils'
import { formatDistanceToNow } from 'date-fns'
import {
  Globe, Copy, Check, ExternalLink, Code2, Send, Loader2, CheckCircle2, AlertTriangle, XCircle,
  ShieldCheck, Inbox, Link as LinkIcon, Server, Activity, RefreshCw, Terminal, MessageSquare, MinusCircle,
} from 'lucide-react'

// ── Online Booking & Website Integration ─────────────────────────────────────────
// The ONE place to connect any external website to EdgeQuote, and to see at a glance
// whether that connection is healthy. Reuses the existing booking_token + the public
// intake pipeline (/api/website-lead → submit_website_lead). No new lead system, no
// new tables — health is derived from booking_settings + website_leads + a live probe.

const STALE_DAYS = 10            // no lead in this many days → "your form may be broken"
const LAST_TEST_KEY = 'eq-wi-last-test'

interface LastLead { id: string; created_at: string; contact_name: string | null; requested_services: string | null; status: string | null }
interface LastTest { ok: boolean; at: string; error?: string }
type Reach = 'checking' | 'ok' | 'down'
type TestState =
  | { status: 'idle' }
  | { status: 'sending' }
  | { status: 'ok'; leadId: string; customerId: string; checks: { lead: boolean; customer: boolean; property: boolean } }
  | { status: 'err'; error: string; http: number; debug: string }

export function WebsiteIntegration() {
  const supabase = createClient()
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [enabled, setEnabled] = useState(false)
  const [token, setToken] = useState<string | null>(null)
  const [hourlyLimit, setHourlyLimit] = useState(30)
  const [lastLead, setLastLead] = useState<LastLead | null>(null)
  const [lastTest, setLastTest] = useState<LastTest | null>(null)
  const [appBase, setAppBase] = useState('')
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const [reach, setReach] = useState<Reach>('checking')
  const [test, setTest] = useState<TestState>({ status: 'idle' })

  useEffect(() => {
    setAppBase((process.env.NEXT_PUBLIC_APP_URL || window.location.origin).replace(/\/$/, ''))
    try { const raw = localStorage.getItem(LAST_TEST_KEY); if (raw) setLastTest(JSON.parse(raw)) } catch { /* ignore */ }
  }, [])

  const loadLastLead = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession()
    const user = session?.user
    if (!user) return
    const { data } = await supabase.from('website_leads')
      .select('id, created_at, contact_name, requested_services, status')
      .eq('user_id', user.id).order('created_at', { ascending: false }).limit(1).maybeSingle()
    setLastLead((data as LastLead | null) ?? null)
  }, [supabase])

  // Liveness probe — OPTIONS hits the route's CORS handler (no DB write, no error
  // log). Any HTTP response = the endpoint is deployed and responding.
  const probe = useCallback(async () => {
    setReach('checking')
    try { await fetch('/api/website-lead', { method: 'OPTIONS' }); setReach('ok') } catch { setReach('down') }
  }, [])

  useEffect(() => {
    let active = true
    ;(async () => {
      const { data: { session } } = await supabase.auth.getSession()
      const user = session?.user
      if (!user) { if (active) setLoaded(true); return }
      const { data } = await supabase.from('business_settings')
        .select('booking_enabled, booking_token, website_lead_hourly_limit').eq('user_id', user.id).maybeSingle()
      const s = data as { booking_enabled?: boolean; booking_token?: string | null; website_lead_hourly_limit?: number | null } | null
      if (!active) return
      setEnabled(!!s?.booking_enabled)
      setToken(s?.booking_token ?? null)
      setHourlyLimit(s?.website_lead_hourly_limit ?? 30)
      setLoaded(true)
      loadLastLead()
      probe()
    })()
    return () => { active = false }
  }, [supabase, loadLastLead, probe])

  async function toggleBooking(v: boolean) {
    setBusy(true); setEnabled(v)
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { setEnabled(!v); setBusy(false); return }
    let t = token
    if (v && !t) {
      t = await ensureBookingToken(supabase, user.id)
      if (!t) { setEnabled(!v); setBusy(false); return }   // token mint failed — don't claim enabled
      setToken(t)
    }
    const { error } = await supabase.from('business_settings').update({ booking_enabled: v }).eq('user_id', user.id)
    if (error) setEnabled(!v)   // revert — the Health card + endpoint gate read this
    setBusy(false)
  }

  async function saveLimit(v: number) {
    const prev = hourlyLimit
    const n = Number.isFinite(v) && v >= 0 ? Math.round(v) : 30
    setHourlyLimit(n)
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return
    // This is the rate limit gating the PUBLIC lead endpoint — an input that keeps
    // showing a limit the server never accepted is a security control that lies.
    // (toggleBooking above already reverts on error; this just missed the pattern.)
    const { error } = await supabase.from('business_settings').update({ website_lead_hourly_limit: n }).eq('user_id', user.id)
    if (error) { setHourlyLimit(prev); toast.error('Could not save the hourly limit — please try again.') }
  }

  async function copy(key: string, text: string) {
    try { await navigator.clipboard.writeText(text); setCopiedKey(key); setTimeout(() => setCopiedKey(null), 1600) } catch { /* clipboard optional */ }
  }

  function rememberTest(t: LastTest) {
    setLastTest(t)
    try { localStorage.setItem(LAST_TEST_KEY, JSON.stringify(t)) } catch { /* ignore */ }
  }

  // The live end-to-end test: posts to the REAL endpoint the website uses, then
  // reads back the rows it should have created (RLS-scoped to the owner) so we can
  // confirm customer + property + lead — not just a 200.
  async function sendTest() {
    if (!token) return
    setTest({ status: 'sending' })
    const payload = {
      token,
      name: 'EdgeQuote test submission',
      email: 'test@edgequote.example',
      phone: '5875550000',
      address: 'Test — sent from Settings → Online Booking',
      requestedServices: 'Connection test',
      message: 'Automated test to verify the website connection. Safe to delete.',
    }
    try {
      const res = await fetch('/api/website-lead', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      const body = await res.json().catch(() => ({})) as { ok?: boolean; error?: string; lead_id?: string; customer_id?: string }
      if (res.ok && body.ok && body.lead_id && body.customer_id) {
        const checks = await verifyCreation(body.lead_id, body.customer_id)
        setTest({ status: 'ok', leadId: body.lead_id, customerId: body.customer_id, checks })
        rememberTest({ ok: true, at: new Date().toISOString() })
        loadLastLead()
        if (reach !== 'ok') setReach('ok')
      } else {
        const debug = JSON.stringify({ endpoint: `${appBase}/api/website-lead`, httpStatus: res.status, request: { ...payload, token: '••• (your token)' }, response: body }, null, 2)
        const error = body.error || `Request failed (HTTP ${res.status}).`
        setTest({ status: 'err', error, http: res.status, debug })
        rememberTest({ ok: false, at: new Date().toISOString(), error })
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Network error'
      const debug = JSON.stringify({ endpoint: `${appBase}/api/website-lead`, networkError: msg, request: { ...payload, token: '••• (your token)' } }, null, 2)
      setTest({ status: 'err', error: msg, http: 0, debug })
      rememberTest({ ok: false, at: new Date().toISOString(), error: msg })
    }
  }

  async function verifyCreation(leadId: string, customerId: string) {
    try {
      const [lead, customer, prop] = await Promise.all([
        supabase.from('website_leads').select('id').eq('id', leadId).maybeSingle(),
        supabase.from('customers').select('id').eq('id', customerId).maybeSingle(),
        supabase.from('properties').select('id').eq('customer_id', customerId).limit(1),
      ])
      return { lead: !!lead.data, customer: !!customer.data, property: ((prop.data as unknown[] | null)?.length ?? 0) > 0 }
    } catch { return { lead: true, customer: true, property: false } }
  }

  if (!loaded) return null

  const bookingLink = token ? `${appBase}/book/${token}` : ''
  const endpoint = `${appBase}/api/website-lead`
  const snippet = buildSnippet(endpoint, token || 'YOUR_BOOKING_TOKEN')
  const curl = buildCurl(endpoint, token || 'YOUR_BOOKING_TOKEN')
  const connected = enabled && !!token

  // ── Overall health verdict ──
  const ageDays = lastLead ? (Date.now() - new Date(lastLead.created_at).getTime()) / 86_400_000 : null
  const stale = ageDays != null && ageDays > STALE_DAYS
  const verdict: 'off' | 'notoken' | 'down' | 'stale' | 'ready' | 'healthy' =
    !enabled ? 'off' : !token ? 'notoken' : reach === 'down' ? 'down' : !lastLead ? 'ready' : stale ? 'stale' : 'healthy'

  return (
    <div className="space-y-4">
      {/* ── Website Health ── */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-ink flex items-center gap-2"><Activity className="w-4 h-4 text-accent-text" /> Website Health</h2>
            <Button size="sm" variant="ghost" onClick={() => { probe(); loadLastLead() }} disabled={reach === 'checking'}>
              <RefreshCw className={cn('w-3.5 h-3.5', reach === 'checking' && 'animate-spin')} /> Recheck
            </Button>
          </div>
        </CardHeader>
        <CardBody className="space-y-3">
          <VerdictBanner verdict={verdict} ageDays={ageDays} lastLeadAt={lastLead?.created_at} />
          <div className="rounded-card border border-border divide-y divide-border">
            <CheckRow ok={enabled} label="Online booking enabled" detail={enabled ? 'Accepting submissions' : 'Turned off below'} />
            <CheckRow ok={!!token} label="Booking token exists" detail={token ? 'Present' : 'None — enable booking to mint one'} />
            <CheckRow ok={reach === 'ok' ? true : reach === 'down' ? false : 'checking'} label="Endpoint responding" detail={reach === 'ok' ? '/api/website-lead is live' : reach === 'down' ? 'No response — check the deployment' : 'Checking…'} />
            <CheckRow ok={lastLead ? (stale ? 'warn' : true) : 'none'} label="Last successful submission"
              detail={lastLead ? `${formatDistanceToNow(new Date(lastLead.created_at), { addSuffix: true })}${lastLead.contact_name ? ` — ${lastLead.contact_name}` : ''}` : 'None received yet'} />
            <CheckRow ok={lastTest ? (lastTest.ok ? true : false) : 'none'} label="Last failed test"
              detail={!lastTest ? 'None' : lastTest.ok ? `None since last success (${formatDistanceToNow(new Date(lastTest.at), { addSuffix: true })})` : `${lastTest.error} · ${formatDistanceToNow(new Date(lastTest.at), { addSuffix: true })}`} />
          </div>
          <p className="text-[11px] text-ink-faint">Successful submissions are read from your leads. A visitor whose browser never reaches the endpoint can’t be logged here — the “endpoint responding” check and the stale-submission warning are what catch a broken site. Want server-side logging of every failed attempt? I can add it.</p>
        </CardBody>
      </Card>

      {/* ── Integration controls ── */}
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-ink flex items-center gap-2"><Globe className="w-4 h-4 text-accent-text" /> Online Booking & Website Integration</h2>
              <p className="text-xs text-ink-faint mt-0.5">Connect any website — Netlify, WordPress, Wix, Squarespace — straight to EdgeQuote. One token, no code on our side to change.</p>
            </div>
            <StatusPill connected={connected} enabled={enabled} />
          </div>
        </CardHeader>
        <CardBody className="space-y-5">
          {/* Master switch (the old "accept automatic quotes", reframed with explanations) */}
          <div className="rounded-card border border-border bg-bg-tertiary p-3.5">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink">Accept online bookings & website leads</p>
                <p className="text-xs text-ink-faint mt-0.5">The master switch for everything below.</p>
              </div>
              <Toggle checked={enabled} disabled={busy} onChange={toggleBooking} ariaLabel="Enable online booking" />
            </div>
            <ul className="mt-3 pt-3 border-t border-border space-y-1.5 text-xs text-ink-muted">
              <li className="flex gap-2"><LinkIcon className="w-3.5 h-3.5 text-accent-text shrink-0 mt-0.5" /><span><b className="text-ink">Booking link</b> — visitors get an instant quote from your pricing and book themselves; a <b>“sent” quote</b> is created automatically.</span></li>
              <li className="flex gap-2"><Inbox className="w-3.5 h-3.5 text-accent-text shrink-0 mt-0.5" /><span><b className="text-ink">Website forms</b> — submissions become a customer + property + lead in <b>Messages → Website Leads</b> for you to quote.</span></li>
              <li className="flex gap-2"><AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" /><span>Turned off, every public submission is rejected — your link and forms stop accepting anything.</span></li>
            </ul>
          </div>

          {connected && (
            <>
              {/* Test panel */}
              <div className="rounded-card border border-border p-3.5 space-y-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <Button size="sm" variant="secondary" onClick={sendTest} loading={test.status === 'sending'}>
                    {test.status === 'sending' ? 'Sending…' : <><Send className="w-3.5 h-3.5" /> Send test submission</>}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => copy('curl', curl)}>
                    {copiedKey === 'curl' ? <><Check className="w-3.5 h-3.5" /> Copied</> : <><Terminal className="w-3.5 h-3.5" /> Copy cURL test</>}
                  </Button>
                  <span className="text-[11px] text-ink-faint ml-auto">Creates a real lead through your live endpoint.</span>
                </div>

                {test.status === 'ok' && (
                  <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/5 p-3 space-y-1.5">
                    <p className="text-xs font-semibold text-emerald-400 flex items-center gap-1.5"><CheckCircle2 className="w-3.5 h-3.5" /> Submission reached EdgeQuote</p>
                    <ResultLine ok={test.checks.lead} label="Lead created" />
                    <ResultLine ok={test.checks.customer} label="Customer created / matched" />
                    <ResultLine ok={test.checks.property} label="Property created" />
                    <Link href="/dashboard/messages" className="inline-flex items-center gap-1.5 text-xs font-semibold text-accent-text hover:underline pt-1">
                      <MessageSquare className="w-3.5 h-3.5" /> Open Messages → Website Leads
                    </Link>
                  </div>
                )}

                {test.status === 'err' && (
                  <div className="rounded-lg border border-red-500/25 bg-red-500/5 p-3 space-y-2">
                    <p className="text-xs font-semibold text-red-400 flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5" /> {test.error}</p>
                    <pre className="bg-bg-tertiary border border-border-strong rounded-lg p-2.5 text-[10px] leading-relaxed font-mono text-ink-muted overflow-x-auto max-h-44 whitespace-pre">{test.debug}</pre>
                    <Button size="sm" variant="ghost" onClick={() => copy('debug', test.debug)}>
                      {copiedKey === 'debug' ? <><Check className="w-3.5 h-3.5" /> Copied</> : <><Copy className="w-3.5 h-3.5" /> Copy payload &amp; response</>}
                    </Button>
                  </div>
                )}
              </div>

              {/* Connection details */}
              <div className="space-y-3">
                <CopyRow label="Booking token" value={token!} copied={copiedKey === 'token'} onCopy={() => copy('token', token!)}
                  hint={<span className="inline-flex items-center gap-1 text-ink-faint"><ShieldCheck className="w-3 h-3" /> Submit-only — safe to embed publicly. It can create leads but cannot read your customers, quotes or any other data.</span>} icon={ShieldCheck} />
                <CopyRow label="Booking link (share anywhere)" value={bookingLink} copied={copiedKey === 'link'} onCopy={() => copy('link', bookingLink)} icon={LinkIcon} openHref={bookingLink} />
                <CopyRow label="Website endpoint (point your form here)" value={endpoint} copied={copiedKey === 'endpoint'} onCopy={() => copy('endpoint', endpoint)} icon={Server} />
              </div>

              {/* Snippet */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <p className="text-xs font-semibold text-ink-muted uppercase tracking-wide flex items-center gap-1.5"><Code2 className="w-3.5 h-3.5" /> Website form snippet</p>
                  <Button size="sm" variant="ghost" onClick={() => copy('snippet', snippet)}>
                    {copiedKey === 'snippet' ? <><Check className="w-3.5 h-3.5" /> Copied</> : <><Copy className="w-3.5 h-3.5" /> Copy</>}
                  </Button>
                </div>
                <pre className="bg-bg-tertiary border border-border-strong rounded-lg p-3 text-[11px] leading-relaxed font-mono text-ink-muted overflow-x-auto max-h-72 whitespace-pre">{snippet}</pre>
                <p className="text-[11px] text-ink-faint mt-1.5">Token and endpoint are already filled in. It keeps your <code className="text-ink-muted">thank-you.html</code> redirect (so GA4 / Meta conversions still fire) and includes a hidden <code className="text-ink-muted">_gotcha</code> honeypot to drop bots.</p>
              </div>

              {/* Per-platform setup */}
              <Collapsible title="Setup instructions" icon={Globe} summary="Netlify · WordPress · Wix · Squarespace">
                <div className="space-y-3 text-xs text-ink-muted">
                  {PLATFORMS.map(p => (
                    <div key={p.name}>
                      <p className="font-semibold text-ink">{p.name}</p>
                      <p className="text-ink-muted mt-0.5">{p.steps}</p>
                    </div>
                  ))}
                  <p className="text-ink-faint pt-1 border-t border-border">Already using Formspree? Replace its <code className="text-ink-muted">action</code> with the snippet above and drop the Formspree endpoint entirely. Keep your existing <code className="text-ink-muted">thank-you.html</code> as the redirect target.</p>
                </div>
              </Collapsible>

              {/* Advanced — reuses website_lead_hourly_limit */}
              <Collapsible title="Advanced" summary={`Spam cap: ${hourlyLimit === 0 ? 'off' : `${hourlyLimit}/hr`}`}>
                <Input
                  label="Max submissions per hour"
                  hint={<>Caps how many leads can be created in any hour (abuse protection if your token leaks). <b>0 = unlimited.</b></>}
                  fieldSize="sm" className="w-32"
                  type="number" min={0} max={1000} value={hourlyLimit}
                  onChange={e => setHourlyLimit(Math.max(0, Math.round(Number(e.target.value) || 0)))}
                  onBlur={e => saveLimit(Number(e.target.value))} />
              </Collapsible>
            </>
          )}
        </CardBody>
      </Card>
    </div>
  )
}

// ── Sub-components ──

function VerdictBanner({ verdict, ageDays, lastLeadAt }: { verdict: string; ageDays: number | null; lastLeadAt?: string }) {
  const map: Record<string, { cls: string; icon: typeof CheckCircle2; text: string }> = {
    off: { cls: 'border-red-500/25 bg-red-500/5 text-red-300', icon: XCircle, text: 'Online booking is OFF — your website can’t submit anything. Turn it on below.' },
    notoken: { cls: 'border-red-500/25 bg-red-500/5 text-red-300', icon: XCircle, text: 'No booking token yet — turn the toggle on to generate one.' },
    down: { cls: 'border-red-500/25 bg-red-500/5 text-red-300', icon: XCircle, text: 'The endpoint isn’t responding. Your deploy may be down — Recheck after it’s live.' },
    stale: { cls: 'border-amber-500/20 bg-amber-500/5 text-amber-300', icon: AlertTriangle, text: `No website submissions in ${ageDays != null ? Math.floor(ageDays) : STALE_DAYS} days — your form may be broken. Send a test to confirm the connection.` },
    ready: { cls: 'border-amber-500/20 bg-amber-500/5 text-amber-300', icon: AlertTriangle, text: 'Connected and ready — no website submissions yet. Add the form to your site and send a test.' },
    healthy: { cls: 'border-emerald-500/25 bg-emerald-500/5 text-emerald-300', icon: CheckCircle2, text: lastLeadAt ? `Working — last submission ${formatDistanceToNow(new Date(lastLeadAt), { addSuffix: true })}.` : 'Working.' },
  }
  const m = map[verdict] ?? map.ready
  const Icon = m.icon
  return (
    <div className={cn('flex items-center gap-2.5 rounded-card border px-3.5 py-2.5 text-sm', m.cls)}>
      <Icon className="w-4 h-4 shrink-0" />
      <span className="min-w-0">{m.text}</span>
    </div>
  )
}

function CheckRow({ ok, label, detail }: { ok: boolean | 'warn' | 'checking' | 'none'; label: string; detail: string }) {
  const icon = ok === true ? <CheckCircle2 className="w-4 h-4 text-emerald-400" />
    : ok === false ? <XCircle className="w-4 h-4 text-red-400" />
    : ok === 'warn' ? <AlertTriangle className="w-4 h-4 text-amber-400" />
    : ok === 'checking' ? <Loader2 className="w-4 h-4 text-ink-faint animate-spin" />
    : <MinusCircle className="w-4 h-4 text-ink-faint" />
  return (
    <div className="flex items-center gap-2.5 px-3 py-2.5">
      <span className="shrink-0">{icon}</span>
      <span className="text-sm text-ink min-w-0 flex-1 truncate">{label}</span>
      <span className="text-xs text-ink-muted shrink-0 text-right max-w-[55%] truncate">{detail}</span>
    </div>
  )
}

function ResultLine({ ok, label }: { ok: boolean; label: string }) {
  return (
    <p className="text-xs text-ink-muted flex items-center gap-1.5">
      {ok ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> : <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />}
      {label}{!ok && <span className="text-ink-faint">— not confirmed</span>}
    </p>
  )
}

function StatusPill({ connected, enabled }: { connected: boolean; enabled: boolean }) {
  const cls = connected ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/25'
    : enabled ? 'bg-amber-500/10 text-amber-400 border-amber-500/20'
    : 'bg-ink-faint/10 text-ink-faint border-border'
  const label = connected ? 'Connected' : enabled ? 'Generating link…' : 'Disabled'
  return (
    <span className={cn('shrink-0 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold', cls)}>
      <span className={cn('w-1.5 h-1.5 rounded-full', connected ? 'bg-emerald-400' : enabled ? 'bg-amber-400' : 'bg-ink-faint')} />
      {label}
    </span>
  )
}

function CopyRow({ label, value, copied, onCopy, hint, icon: Icon, openHref }: {
  label: string; value: string; copied: boolean; onCopy: () => void
  hint?: React.ReactNode; icon?: typeof Globe; openHref?: string
}) {
  return (
    <div>
      <p className="text-xs font-semibold text-ink-muted uppercase tracking-wide mb-1 flex items-center gap-1.5">{Icon && <Icon className="w-3.5 h-3.5" />}{label}</p>
      <div className="flex items-center gap-2">
        <input readOnly value={value} onFocus={e => e.currentTarget.select()}
          className="flex-1 min-w-0 bg-bg-tertiary border border-border-strong rounded-lg px-3 py-2 text-xs text-ink-muted font-mono outline-none" />
        <Button size="sm" variant="ghost" onClick={onCopy}>{copied ? <><Check className="w-3.5 h-3.5" /> Copied</> : <><Copy className="w-3.5 h-3.5" /> Copy</>}</Button>
        {openHref && (
          <a href={openHref} target="_blank" rel="noopener noreferrer" aria-label="Open booking link in new tab"
            className="inline-flex items-center justify-center rounded-xl text-ink-muted hover:text-ink hover:bg-surface px-3.5 py-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
        )}
      </div>
      {hint && <p className="text-[11px] mt-1">{hint}</p>}
    </div>
  )
}

const PLATFORMS = [
  { name: 'Netlify', steps: 'Paste the snippet into your page’s HTML (or a custom-code block). If you used Netlify Forms or Formspree, remove that form handler so it posts to EdgeQuote instead. Your thank-you.html keeps working as the redirect.' },
  { name: 'WordPress', steps: 'Add a “Custom HTML” block (or use a code-snippet plugin like WPCode) and paste the snippet. Don’t wrap it in a contact-form plugin that hijacks the submit.' },
  { name: 'Wix', steps: 'Add → Embed Code → Custom Embed → “Embed HTML”, paste the snippet, and publish. The fetch still posts to EdgeQuote from inside the embed.' },
  { name: 'Squarespace', steps: 'Add a “Code Block” (Business plan or higher allows custom code) and paste the snippet. Save and publish.' },
]

function buildCurl(endpoint: string, token: string): string {
  // Sample data, like every other field here ('cURL test', 'test@example.com',
  // '123 Test St'). It used to name a trade, which read as a required value.
  const payload = { token, name: 'cURL test', email: 'test@example.com', phone: '5875550000', address: '123 Test St', requestedServices: 'Test service' }
  return `curl -X POST ${JSON.stringify(endpoint)} \\\n  -H "Content-Type: application/json" \\\n  -d '${JSON.stringify(payload)}'`
}

// The dependency-free form + handler. Token and endpoint are baked in; the handler
// posts JSON with the token in the body (the field people forget), drops honeypot
// hits, and redirects to the site’s existing conversion page on success.
function buildSnippet(endpoint: string, token: string): string {
  return `<!-- EdgeQuote website form — posts leads straight into EdgeQuote -->
<form id="eq-quote-form">
  <input name="name" required placeholder="Your name">
  <input name="email" type="email" placeholder="Email">
  <input name="phone" placeholder="Phone">
  <input name="address" placeholder="Service address">
  <input name="requestedServices" placeholder="Service you want">
  <textarea name="message" placeholder="Tell us about your property"></textarea>
  <!-- Honeypot: real people leave this empty; bots fill it -->
  <input type="text" name="_gotcha" tabindex="-1" autocomplete="off" aria-hidden="true" style="position:absolute;left:-9999px">
  <button type="submit">Request a quote</button>
</form>
<script>
(function () {
  var ENDPOINT = ${JSON.stringify(endpoint)};
  var TOKEN = ${JSON.stringify(token)};            // submit-only booking token
  var THANK_YOU = "/thank-you.html";               // your GA4 / Meta conversion page
  var form = document.getElementById("eq-quote-form");
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    if (form._gotcha.value) { window.location.href = THANK_YOU; return; } // drop bots
    var payload = { token: TOKEN };
    new FormData(form).forEach(function (v, k) { if (k !== "_gotcha") payload[k] = v; });
    fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok && d.ok, data: d }; }); })
      .then(function (res) {
        if (res.ok) { window.location.href = THANK_YOU; }
        else { alert((res.data && res.data.error) || "Something went wrong. Please call us."); }
      })
      .catch(function () { alert("Network error — please try again."); });
  });
})();
</script>`
}
