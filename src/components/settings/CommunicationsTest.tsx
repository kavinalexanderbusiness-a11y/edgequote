'use client'

import { useEffect, useState } from 'react'
import { Card, CardHeader, CardBody } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Skeleton } from '@/components/ui/Skeleton'
import { cn } from '@/lib/utils'
import { MessageSquare, CheckCircle2, XCircle, RefreshCw, ShieldCheck, ShieldAlert } from 'lucide-react'

interface Diag {
  enabled: { sms: boolean; email: boolean }
  vars: Record<string, boolean>
  twilioFrom: string | null
  resendFrom: string | null
  twilioCreds: { valid: boolean; detail: string } | null
  appUrl: string | null
}
interface SendResult { sent?: boolean; reason?: string; id?: string; error?: string; channel?: string }

const VAR_LABELS: Record<string, string> = {
  TWILIO_ACCOUNT_SID: 'TWILIO_ACCOUNT_SID',
  TWILIO_AUTH_TOKEN: 'TWILIO_AUTH_TOKEN',
  TWILIO_FROM: 'TWILIO_FROM',
  RESEND_API_KEY: 'RESEND_API_KEY',
  RESEND_FROM: 'RESEND_FROM',
}

export function CommunicationsTest() {
  const [diag, setDiag] = useState<Diag | null>(null)
  const [loadingDiag, setLoadingDiag] = useState(true)
  const [to, setTo] = useState('')
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState<SendResult | null>(null)
  const [emailTo, setEmailTo] = useState('')
  const [emailSending, setEmailSending] = useState(false)
  const [emailResult, setEmailResult] = useState<SendResult | null>(null)

  async function loadDiag() {
    setLoadingDiag(true)
    try { const r = await fetch('/api/comms/test'); setDiag(await r.json()) } catch { setDiag(null) }
    setLoadingDiag(false)
  }
  useEffect(() => { loadDiag() }, [])

  async function runTest(channel: 'sms' | 'email', recipient: string): Promise<SendResult> {
    try {
      const r = await fetch('/api/comms/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: recipient.trim(), channel }) })
      return await r.json()
    } catch (e) {
      return { sent: false, error: e instanceof Error ? e.message : 'Request failed' }
    }
  }
  async function sendTest() {
    if (!to.trim()) return
    setSending(true); setResult(null)
    setResult(await runTest('sms', to))
    setSending(false)
  }
  async function sendTestEmail() {
    if (!emailTo.trim()) return
    setEmailSending(true); setEmailResult(null)
    setEmailResult(await runTest('email', emailTo))
    setEmailSending(false)
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-ink flex items-center gap-2"><MessageSquare className="w-4 h-4 text-accent-text" /> Communications test</h2>
            <p className="text-xs text-ink-faint mt-0.5">Verify Twilio/Resend setup. Test messages go ONLY to the number you enter — customers are never messaged here.</p>
          </div>
          <Button size="sm" variant="ghost" onClick={loadDiag} disabled={loadingDiag} title="Refresh diagnostics" aria-label="Refresh diagnostics"><RefreshCw className={cn('w-3.5 h-3.5', loadingDiag && 'animate-spin')} /></Button>
        </div>
      </CardHeader>
      <CardBody className="space-y-4">
        {loadingDiag ? (
          <div className="space-y-2.5" aria-hidden>
            <div className="flex gap-2"><Skeleton className="h-6 w-16 rounded-full" /><Skeleton className="h-6 w-16 rounded-full" /></div>
            <Skeleton className="h-3 w-1/2" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        ) : !diag ? (
          <p className="text-xs text-red-400">Could not load diagnostics.</p>
        ) : (
          <>
            {/* Channel status */}
            <div className="flex flex-wrap gap-2">
              <StatusBadge label="SMS" on={diag.enabled.sms} />
              <StatusBadge label="Email" on={diag.enabled.email} />
            </div>

            {/* Detected env vars */}
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint mb-1.5">Environment variables detected</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
                {Object.keys(VAR_LABELS).map(k => (
                  <div key={k} className="flex items-center gap-1.5 text-xs">
                    {diag.vars[k] ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" /> : <XCircle className="w-3.5 h-3.5 text-ink-faint shrink-0" />}
                    <span className={diag.vars[k] ? 'text-ink' : 'text-ink-faint'}>{VAR_LABELS[k]}</span>
                  </div>
                ))}
              </div>
              {diag.twilioFrom && <p className="text-[11px] text-ink-faint mt-1.5">From number: {diag.twilioFrom}</p>}
            </div>

            {/* Twilio credential validation */}
            {diag.twilioCreds ? (
              <div className={`flex items-start gap-2 text-xs rounded-lg px-3 py-2 border ${diag.twilioCreds.valid ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10' : 'text-red-400 border-red-500/30 bg-red-500/10'}`}>
                {diag.twilioCreds.valid ? <ShieldCheck className="w-4 h-4 shrink-0 mt-0.5" /> : <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />}
                <span><span className="font-semibold">{diag.twilioCreds.valid ? 'Twilio credentials valid' : 'Twilio credentials invalid'}</span> — {diag.twilioCreds.detail}</span>
              </div>
            ) : (
              <p className="text-xs text-ink-muted">Twilio credentials not set — add them in your environment, then refresh.</p>
            )}

            {/* Test sender */}
            <div className="border-t border-border pt-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint mb-1.5">Send a test SMS</p>
              <form onSubmit={e => { e.preventDefault(); if (to.trim() && !sending) sendTest() }}
                className="flex flex-col sm:flex-row gap-2 sm:items-start">
                <div className="flex-1">
                  <Input label="Your phone number" type="tel" placeholder="+15875551234" value={to} onChange={e => setTo(e.target.value)}
                    hint="Use E.164 format (e.g. +1 then the 10-digit number)." />
                </div>
                <Button type="submit" variant="secondary" className="sm:mt-6" loading={sending} disabled={!to.trim()}>Send test SMS</Button>
              </form>

              {result && (
                result.sent ? (
                  <div className="mt-3 flex items-start gap-2 text-xs text-emerald-400 rounded-lg px-3 py-2 border border-emerald-500/30 bg-emerald-500/10">
                    <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
                    <span><span className="font-semibold">Test SMS sent.</span>{result.id ? ` Twilio SID ${result.id}.` : ''} Check the phone.</span>
                  </div>
                ) : (
                  <div className="mt-3 flex items-start gap-2 text-xs text-red-400 rounded-lg px-3 py-2 border border-red-500/30 bg-red-500/10">
                    <XCircle className="w-4 h-4 shrink-0 mt-0.5" />
                    <span><span className="font-semibold">{result.reason === 'disabled' ? 'Disabled' : 'Failed'}.</span> {result.error || 'Unknown error.'}</span>
                  </div>
                )
              )}
            </div>

            {/* Test email */}
            <div className="border-t border-border pt-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint mb-1.5">Send a test email</p>
              <form onSubmit={e => { e.preventDefault(); if (emailTo.trim() && !emailSending) sendTestEmail() }}
                className="flex flex-col sm:flex-row gap-2 sm:items-start">
                <div className="flex-1">
                  <Input label="Your email address" type="email" placeholder="you@example.com" value={emailTo} onChange={e => setEmailTo(e.target.value)}
                    hint={`Sent from ${diag.resendFrom || 'your RESEND_FROM address'} — must be on a domain verified in Resend.`} />
                </div>
                <Button type="submit" variant="secondary" className="sm:mt-6" loading={emailSending} disabled={!emailTo.trim()}>Send test email</Button>
              </form>

              {emailResult && (
                emailResult.sent ? (
                  <div className="mt-3 flex items-start gap-2 text-xs text-emerald-400 rounded-lg px-3 py-2 border border-emerald-500/30 bg-emerald-500/10">
                    <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
                    <span><span className="font-semibold">Test email sent.</span>{emailResult.id ? ` Resend ID ${emailResult.id}.` : ''} Check the inbox (and spam).</span>
                  </div>
                ) : (
                  <div className="mt-3 flex items-start gap-2 text-xs text-red-400 rounded-lg px-3 py-2 border border-red-500/30 bg-red-500/10">
                    <XCircle className="w-4 h-4 shrink-0 mt-0.5" />
                    <span><span className="font-semibold">{emailResult.reason === 'disabled' ? 'Disabled' : 'Failed'}.</span> {emailResult.error || 'Unknown error.'}</span>
                  </div>
                )
              )}
            </div>
          </>
        )}
      </CardBody>
    </Card>
  )
}

function StatusBadge({ label, on }: { label: string; on: boolean }) {
  return (
    <span className={`text-xs font-semibold rounded-full px-2.5 py-1 border ${on ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10' : 'text-ink-muted border-border bg-bg-tertiary'}`}>
      {label}: {on ? 'Enabled' : 'Disabled'}
    </span>
  )
}
