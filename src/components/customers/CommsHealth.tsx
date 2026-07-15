'use client'

import { useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Customer } from '@/types'
import { Card, CardBody } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { AlertTriangle, Mail, Phone, MailX, PhoneOff } from 'lucide-react'

// Informational communications-health audit for the customer profile. Reads ONLY the
// single source of truth (customers.sms_opt_in / email_opt_in + email/phone) and
// surfaces actionable mismatches — e.g. "email opt-in on but no email saved" — with a
// one-tap inline fix so the owner doesn't have to open the edit form. Renders nothing
// when the customer is reachable (no clutter). Warnings, not errors.
export function CommsHealth({ customer, onChange }: {
  customer: Customer
  onChange?: (patch: Partial<Customer>) => void
}) {
  const supabase = useMemo(() => createClient(), [])
  const [adding, setAdding] = useState<null | 'email' | 'phone'>(null)
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const hasEmail = !!customer.email?.trim()
  const hasPhone = !!customer.phone?.trim()
  const emailOptIn = !!customer.email_opt_in
  const smsOptIn = !!customer.sms_opt_in

  type W = { key: string; icon: typeof Mail; text: string; add?: 'email' | 'phone' }
  const warnings: W[] = []
  if (emailOptIn && !hasEmail) warnings.push({ key: 'email-no-addr', icon: Mail, text: 'Email opt-in is on, but no email address is saved.', add: 'email' })
  if (smsOptIn && !hasPhone) warnings.push({ key: 'sms-no-phone', icon: Phone, text: 'SMS opt-in is on, but no phone number is saved.', add: 'phone' })
  if (!hasEmail && !hasPhone) warnings.push({ key: 'no-contact', icon: AlertTriangle, text: 'No contact method (email or phone) on file — automatic messages can’t reach this customer.' })
  else if (!emailOptIn && !smsOptIn) warnings.push({ key: 'both-off', icon: AlertTriangle, text: 'Both SMS and email are off — automatic messages won’t be sent to this customer.' })

  if (warnings.length === 0) return null

  async function save(field: 'email' | 'phone') {
    const v = value.trim()
    if (!v) return
    setSaving(true); setErr(null)
    const { error } = await supabase.from('customers').update({ [field]: v }).eq('id', customer.id)
    setSaving(false)
    if (error) { setErr('Could not save — please try again.'); return }
    onChange?.({ [field]: v } as Partial<Customer>)
    setAdding(null); setValue('')
  }

  function startAdd(field: 'email' | 'phone') { setAdding(field); setValue(''); setErr(null) }

  return (
    <Card className="border-amber-500/30">
      <CardBody className="space-y-2.5">
        <p className="text-xs font-semibold uppercase tracking-wide text-amber-400 flex items-center gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5" /> Communication health
        </p>
        {warnings.map(w => (
          <div key={w.key} className="flex items-start justify-between gap-3">
            <p className="text-sm text-ink flex items-start gap-2">
              <w.icon className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" /> {w.text}
            </p>
            {w.add && adding !== w.add && (
              <button onClick={() => startAdd(w.add!)} className="text-xs font-medium text-accent-text hover:underline shrink-0 whitespace-nowrap rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                {w.add === 'email' ? 'Add email →' : 'Add phone →'}
              </button>
            )}
          </div>
        ))}

        {adding && (
          <div className="flex items-center gap-2 pt-1">
            <input
              autoFocus
              type={adding === 'email' ? 'email' : 'tel'}
              aria-label={adding === 'email' ? 'New email address' : 'New phone number'}
              value={value}
              onChange={e => setValue(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') save(adding) }}
              placeholder={adding === 'email' ? 'name@example.com' : '(403) 555-0100'}
              className="flex-1 rounded-lg border border-border-strong bg-bg-tertiary px-3 py-1.5 text-sm text-ink outline-none transition-all focus:border-accent focus:ring-2 focus:ring-accent/20"
            />
            <Button size="sm" onClick={() => save(adding)} loading={saving} disabled={!value.trim()}>Save</Button>
            <Button size="sm" variant="ghost" onClick={() => { setAdding(null); setValue('') }}>Cancel</Button>
          </div>
        )}
        {err && <p className="text-xs text-red-400">{err}</p>}
        <p className="text-[11px] text-ink-faint flex items-center gap-1">
          {!hasEmail && <MailX className="w-3 h-3" />}{!hasPhone && <PhoneOff className="w-3 h-3" />}
          Consent stays the single source of truth — this only flags mismatches; it changes nothing automatically.
        </p>
      </CardBody>
    </Card>
  )
}
