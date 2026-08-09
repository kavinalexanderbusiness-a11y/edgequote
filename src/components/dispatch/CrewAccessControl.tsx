'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Technician } from '@/types'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { toast } from '@/lib/toast'
import { confirm } from '@/lib/confirm'
import { cn } from '@/lib/utils'
import {
  crewAccessState, accessFacts, CREW_ACCESS_LABEL,
  type CrewAccessState, type CrewAccessRow, type CrewInviteResponse,
} from '@/lib/crewInvite'
import { Smartphone, Copy, KeyRound, ShieldOff, Check, Link2, Mail } from 'lucide-react'

// ── App access, from the roster ──────────────────────────────────────────────
// Giving somebody a login is a roster decision, so it lives on the roster row
// beside the switches that already control them. One badge says which of four
// states you are looking at (lib/crewInvite.crewAccessState is the ONE state
// machine — the roster and the guard read the same function), and one primary
// action moves it forward:
//
//   No access      → Invite: type their email, get a one-time setup link
//   Invite pending → Copy the link again, or make a new one
//   Active         → Turn off
//   Disabled       → nothing to do here; the roster switch above is the cause
//
// TWO WAYS IN, because they fail differently. Inviting by email creates the
// account server-side, in /api/crew/invite, which is the only code in EdgeQuote
// holding an admin credential — and it needs one env var set on the deployment,
// which its own error message names. A join code needs nothing, but only works
// for somebody who already HAS an EdgeQuote login. So when provisioning is not
// configured, the invite panel offers the code path by name rather than dead-ending.
//
// Nothing here is trusted: crew_issue_invite / crew_revoke_access are SECURITY
// DEFINER and re-check ownership in SQL, and /api/crew/invite re-checks the role
// against the database before it touches the admin client. This component can
// only fail to DISPLAY the truth, and it re-reads after every call.

const STATE_TONE: Record<CrewAccessState, string> = {
  active: 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10',
  invited: 'text-accent-text border-accent/30 bg-accent/10',
  disabled: 'text-amber-400 border-amber-500/30 bg-amber-500/10',
  none: 'text-ink-faint border-border bg-bg-tertiary',
}

export function CrewAccessControl({ tech, access, onChanged }: {
  tech: Technician
  /** Live row from crew_access_states() — whether they have ever signed in is
   *  in auth.users, which no owner client can read. Undefined while loading. */
  access?: CrewAccessRow | null
  onChanged: () => void
}) {
  const supabase = createClient()
  const [busy, setBusy] = useState<'invite' | 'code' | 'revoke' | null>(null)
  const [emailing, setEmailing] = useState(false)
  const [email, setEmail] = useState(tech.email ?? '')
  const [setupUrl, setSetupUrl] = useState<string | null>(null)
  const [freshCode, setFreshCode] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  const code = freshCode ?? tech.invite_code ?? null
  const codeLive = !!code && (!tech.invite_expires_at || new Date(tech.invite_expires_at) > new Date())
  const facts = accessFacts(tech, access)
  const state = crewAccessState({ ...facts, hasCode: facts.hasCode || codeLive })

  async function invite() {
    setBusy('invite')
    setSetupUrl(null)
    try {
      const res = await fetch('/api/crew/invite', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ technicianId: tech.id, email }),
      })
      const data = (await res.json().catch(() => null)) as CrewInviteResponse | null
      if (!data) { toast.error('Couldn’t reach the server. Try again.'); return }
      if (!data.ok) { toast.error(data.message); return }
      setSetupUrl(data.setupUrl)
      setEmailing(false)
      setCopied(null)
      toast.success(data.created ? `Login created for ${tech.name}.` : `Existing login connected to ${tech.name}.`)
      onChanged()
    } catch {
      toast.error('Couldn’t reach the server. Try again.')
    } finally { setBusy(null) }
  }

  async function issueCode() {
    setBusy('code')
    const { data, error } = await supabase.rpc('crew_issue_invite', { p_technician_id: tech.id, p_hours: 72 })
    setBusy(null)
    if (error) { toast.error(error.message); return }
    setFreshCode((data as { code?: string } | null)?.code ?? null)
    setCopied(null)
    onChanged()
  }

  async function revoke() {
    const ok = await confirm({
      title: `Turn off app access for ${tech.name}?`,
      message: 'They lose the crew app immediately — on the phone in their pocket, not at their next sign-in. Their roster record, hours and history are untouched.',
      confirmLabel: 'Turn off access',
      destructive: true,
      icon: ShieldOff,
    })
    if (!ok) return
    setBusy('revoke')
    const { error } = await supabase.rpc('crew_revoke_access', { p_technician_id: tech.id })
    setBusy(null)
    if (error) { toast.error(error.message); return }
    setFreshCode(null); setSetupUrl(null); setEmailing(false)
    toast.success(`${tech.name} no longer has app access.`)
    onChanged()
  }

  async function copy(value: string, key: string) {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(key)
      setTimeout(() => setCopied(c => (c === key ? null : c)), 2000)
    } catch { toast.error('Couldn’t copy — select it and copy by hand.') }
  }

  return (
    <div className="mt-2 rounded-lg border border-border bg-bg-tertiary/50 px-2.5 py-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint flex items-center gap-1">
          <Smartphone className="w-3 h-3" aria-hidden /> App access
        </span>
        <span className={cn('text-[10px] font-semibold uppercase tracking-wide rounded px-1.5 py-0.5 border', STATE_TONE[state])}>
          {CREW_ACCESS_LABEL[state]}
        </span>
        {access?.email && state !== 'none' && (
          <span className="text-[11px] text-ink-muted truncate max-w-[16rem]">{access.email}</span>
        )}

        <span className="ml-auto flex items-center gap-1.5">
          {state === 'active' || state === 'invited' ? (
            <Button variant="ghost" size="sm" type="button" onClick={revoke} loading={busy === 'revoke'}>
              <ShieldOff className="w-3.5 h-3.5" aria-hidden /> Turn off
            </Button>
          ) : state === 'none' ? (
            <Button variant="secondary" size="sm" type="button" onClick={() => setEmailing(v => !v)} aria-expanded={emailing}>
              <Mail className="w-3.5 h-3.5" aria-hidden /> Invite
            </Button>
          ) : null}
        </span>
      </div>

      {/* Disabled overrides everything, so say WHY rather than offering actions
          that would not take effect. */}
      {state === 'disabled' && (
        <p className="mt-1.5 text-[10px] leading-relaxed text-ink-faint">
          {tech.archived_at ? 'Removed from the roster' : 'Switched inactive'} — the crew app is closed to them.
          {tech.auth_user_id ? ' Their login is still connected and starts working again the moment you switch them back on.' : ''}
        </p>
      )}

      {/* No access → invite by email. */}
      {state === 'none' && emailing && (
        <div className="mt-2 space-y-2" onClick={e => e.stopPropagation()}>
          <Input
            label="Their email" type="email" fieldSize="sm" value={email} autoComplete="off"
            onChange={e => setEmail(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); invite() } }}
            hint="We create the login — they never need to sign up or wait for an email."
          />
          <div className="flex items-center gap-2 flex-wrap">
            <Button size="sm" type="button" onClick={invite} loading={busy === 'invite'} disabled={!email.trim()}>
              <Link2 className="w-3.5 h-3.5" aria-hidden /> Create login &amp; link
            </Button>
            <Button size="sm" variant="ghost" type="button" onClick={() => setEmailing(false)}>Cancel</Button>
            {/* The fallback, named up front rather than only after a failure. */}
            <Button size="sm" variant="ghost" type="button" onClick={issueCode} loading={busy === 'code'} className="ml-auto"
              title="For someone who already has an EdgeQuote login">
              <KeyRound className="w-3.5 h-3.5" aria-hidden /> Join code instead
            </Button>
          </div>
        </div>
      )}

      {/* The one-time setup link, shown once, copyable. */}
      {setupUrl && (
        <div className="mt-2 rounded-md border border-accent/30 bg-accent/5 p-2">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-accent-text">Send {tech.name} this link</p>
          <div className="mt-1 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-bg-tertiary px-1.5 py-1 text-[11px] text-ink-muted">{setupUrl}</code>
            <button type="button" onClick={() => copy(setupUrl, 'url')}
              className="shrink-0 text-[11px] font-medium text-ink-muted hover:text-ink flex items-center gap-1">
              {copied === 'url' ? <><Check className="w-3 h-3" aria-hidden /> Copied</> : <><Copy className="w-3 h-3" aria-hidden /> Copy</>}
            </button>
          </div>
          <p className="mt-1 text-[10px] leading-relaxed text-ink-faint">
            One use, and not for long. They set a password and land straight in the crew app —
            no sign-up, no confirmation email. Lost it? Tap New link.
          </p>
        </div>
      )}

      {/* Invite pending → get the link (or the code) in front of them again. */}
      {state === 'invited' && !setupUrl && (
        <div className="mt-1.5 flex items-center gap-2 flex-wrap">
          {codeLive ? (
            <>
              <span className="text-[10px] text-ink-faint">Join code</span>
              <code className="rounded border border-accent/30 bg-accent/10 px-1.5 py-0.5 text-xs font-bold tracking-[0.18em] text-accent-text">{code}</code>
              <button type="button" onClick={() => copy(code!, 'code')} className="text-[11px] font-medium text-ink-muted hover:text-ink flex items-center gap-1">
                {copied === 'code' ? <><Check className="w-3 h-3" aria-hidden /> Copied</> : <><Copy className="w-3 h-3" aria-hidden /> Copy</>}
              </button>
              <Button variant="ghost" size="sm" type="button" onClick={issueCode} loading={busy === 'code'} className="ml-auto">New code</Button>
            </>
          ) : (
            <>
              <span className="text-[10px] text-ink-faint">
                Invited{facts.inviteSentAt ? ` ${new Date(facts.inviteSentAt).toLocaleDateString()}` : ''} — they haven’t signed in yet.
              </span>
              <Button variant="ghost" size="sm" type="button" onClick={invite} loading={busy === 'invite'} className="ml-auto"
                title="Make a fresh one-time setup link">
                <Link2 className="w-3.5 h-3.5" aria-hidden /> New link
              </Button>
            </>
          )}
        </div>
      )}

      {state === 'active' && (
        <p className="mt-1.5 text-[10px] leading-relaxed text-ink-faint">
          Signed in{facts.lastSignInAt ? ` — last on ${new Date(facts.lastSignInAt).toLocaleDateString()}` : ''}.
          Switching them inactive or removing them from the roster also cuts access, checked on every request rather than at sign-in.
        </p>
      )}
    </div>
  )
}
