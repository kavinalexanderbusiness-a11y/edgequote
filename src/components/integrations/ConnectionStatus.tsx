'use client'

import { useEffect, useState } from 'react'
import { CreditCard, Mail, MessageSquare } from 'lucide-react'
import { Button, ButtonLink } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'

type Status = { email: boolean; sms: boolean; payments: boolean }
const channels = [
  { key: 'email', label: 'Email sending', icon: Mail, href: '/dashboard/settings#messaging', action: 'Message settings' },
  { key: 'sms', label: 'Text messaging', icon: MessageSquare, href: '/dashboard/settings#messaging', action: 'Message settings' },
  { key: 'payments', label: 'Online customer payments', icon: CreditCard, href: '/dashboard/invoices', action: 'View invoices' },
] as const

export function ConnectionStatus() {
  const [status, setStatus] = useState<Status | null>(null)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let alive = true
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15_000)
    setStatus(null)
    setFailed(false)
    ;(async () => {
      try {
        const response = await fetch('/api/integrations/status', { cache: 'no-store', signal: controller.signal })
        if (!response.ok) throw new Error('Connection status unavailable')
        const body: unknown = await response.json()
        if (!body || typeof body !== 'object' || !channels.every(({ key }) => typeof (body as Record<string, unknown>)[key] === 'boolean')) {
          throw new Error('Invalid connection status')
        }
        if (alive) setStatus(body as Status)
      } catch {
        if (alive) setFailed(true)
      } finally {
        clearTimeout(timeout)
      }
    })()
    return () => { alive = false; controller.abort(); clearTimeout(timeout) }
  }, [attempt])

  return (
    <Card>
      <CardHeader>
        <h2 className="font-semibold text-ink">Email, texts &amp; payments</h2>
        <p className="mt-1 text-sm text-ink-muted">Availability for this business based on current setup and access. This check doesn’t test message delivery or process a payment.</p>
      </CardHeader>
      <CardBody className="space-y-4">
        <div className="divide-y divide-border" aria-live="polite">
          {channels.map(({ key, label, icon: Icon, href, action }) => (
            <div key={key} className="flex flex-wrap items-center gap-3 py-3 first:pt-0">
              <Icon className="w-5 h-5 text-ink-muted shrink-0" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-ink">{label}</p>
                <p className="mt-0.5 text-sm text-ink-muted">{failed ? 'Couldn’t check' : !status ? 'Checking…' : status[key] ? 'Available' : 'Unavailable for this business'}</p>
              </div>
              {status?.[key] && <ButtonLink href={href} variant="ghost" size="sm">{action}</ButtonLink>}
            </div>
          ))}
        </div>
        <p className="text-xs text-ink-muted">If something is unavailable or couldn’t be checked, retry or get help reviewing your business access and setup.</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" disabled={!status && !failed} onClick={() => setAttempt(value => value + 1)}>{failed ? 'Retry' : 'Refresh status'}</Button>
          <ButtonLink href="/dashboard/help" variant="ghost" size="sm">Get help</ButtonLink>
        </div>
      </CardBody>
    </Card>
  )
}
