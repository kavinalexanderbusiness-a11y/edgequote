'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Technician } from '@/types'
import { Button } from '@/components/ui/Button'
import { toast } from '@/lib/toast'
import { confirm } from '@/lib/confirm'
import { Smartphone, Copy, KeyRound, ShieldOff, Check } from 'lucide-react'

// ── App access, from the roster ──────────────────────────────────────────────
// Granting a worker a login is a roster decision, so it lives on the roster row
// next to the switches that already control them. Three states, and the copy
// says which one you are looking at:
//
//   records only  → no login. Every technician starts here.
//   code issued   → a one-time code is waiting to be redeemed (shown once,
//                   copyable, with its expiry).
//   signed in     → linked to an account.
//
// Everything is enforced in SQL (crew_issue_invite / crew_redeem_invite /
// crew_revoke_access are SECURITY DEFINER and re-check ownership themselves),
// so this component cannot grant anything by being wrong — it can only fail to
// display the truth, and it re-reads after every call.
export function CrewAccessControl({ tech, onChanged }: { tech: Technician; onChanged: () => void }) {
  const supabase = createClient()
  const [busy, setBusy] = useState(false)
  const [freshCode, setFreshCode] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const linked = !!tech.auth_user_id
  const pending = !linked && !!tech.invite_code
  const expired = pending && !!tech.invite_expires_at && new Date(tech.invite_expires_at) < new Date()
  const code = freshCode ?? tech.invite_code ?? null

  async function issue() {
    setBusy(true)
    const { data, error } = await supabase.rpc('crew_issue_invite', { p_technician_id: tech.id, p_hours: 72 })
    setBusy(false)
    if (error) { toast.error(error.message); return }
    const c = (data as { code?: string } | null)?.code ?? null
    setFreshCode(c)
    setCopied(false)
    onChanged()
  }

  async function revoke() {
    const ok = await confirm({
      title: `Turn off app access for ${tech.name}?`,
      message: 'They are signed out of the crew app immediately and stop seeing any work. Their roster record, hours and history are untouched.',
      confirmLabel: 'Turn off access',
      destructive: true,
      icon: ShieldOff,
    })
    if (!ok) return
    setBusy(true)
    const { error } = await supabase.rpc('crew_revoke_access', { p_technician_id: tech.id })
    setBusy(false)
    if (error) { toast.error(error.message); return }
    setFreshCode(null)
    toast.success(`${tech.name} no longer has app access.`)
    onChanged()
  }

  async function copy() {
    if (!code) return
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch { toast.error('Couldn’t copy — read the code out instead.') }
  }

  return (
    <div className="mt-2 rounded-lg border border-border bg-bg-tertiary/50 px-2.5 py-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint flex items-center gap-1">
          <Smartphone className="w-3 h-3" aria-hidden /> App access
        </span>

        {linked ? (
          <>
            <span className="text-[11px] font-semibold text-emerald-400 flex items-center gap-1">
              <Check className="w-3 h-3" aria-hidden /> Signed in
            </span>
            <Button variant="ghost" size="sm" type="button" onClick={revoke} loading={busy} className="ml-auto">
              <ShieldOff className="w-3.5 h-3.5" aria-hidden /> Turn off
            </Button>
          </>
        ) : pending && !expired ? (
          <>
            <code className="rounded border border-accent/30 bg-accent/10 px-1.5 py-0.5 text-xs font-bold tracking-[0.18em] text-accent-text">{code}</code>
            <button type="button" onClick={copy} className="text-[11px] font-medium text-ink-muted hover:text-ink flex items-center gap-1">
              {copied ? <><Check className="w-3 h-3" aria-hidden /> Copied</> : <><Copy className="w-3 h-3" aria-hidden /> Copy</>}
            </button>
            <Button variant="ghost" size="sm" type="button" onClick={issue} loading={busy} className="ml-auto">New code</Button>
          </>
        ) : (
          <>
            <span className="text-[11px] text-ink-faint">{expired ? 'Code expired' : 'Records only — no login'}</span>
            <Button variant="secondary" size="sm" type="button" onClick={issue} loading={busy} className="ml-auto">
              <KeyRound className="w-3.5 h-3.5" aria-hidden /> {expired ? 'New code' : 'Give app access'}
            </Button>
          </>
        )}
      </div>

      {!linked && code && !expired && (
        <p className="mt-1.5 text-[10px] leading-relaxed text-ink-faint">
          {tech.name} signs in at <span className="text-ink-muted">/login</span>, then enters this code once.
          It expires {tech.invite_expires_at ? new Date(tech.invite_expires_at).toLocaleString() : 'in 3 days'}.
          They will see their crew’s visits only — never prices, invoices, customers or settings.
        </p>
      )}
      {linked && (
        <p className="mt-1.5 text-[10px] leading-relaxed text-ink-faint">
          Switching them inactive or removing them from the roster also cuts access — checked on every request, not at sign-in.
        </p>
      )}
    </div>
  )
}
