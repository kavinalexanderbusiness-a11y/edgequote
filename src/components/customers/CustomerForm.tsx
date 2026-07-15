'use client'

import { useMemo } from 'react'
import Link from 'next/link'
import { useForm, Controller } from 'react-hook-form'
import { Input } from '@/components/ui/Input'
import { Textarea } from '@/components/ui/Textarea'
import { Select } from '@/components/ui/Select'
import { Button } from '@/components/ui/Button'
import { AddressAutocomplete } from '@/components/ui/AddressAutocomplete'
import { Toggle } from '@/components/ui/Toggle'
import { useAutosave } from '@/hooks/useAutosave'
import { AutosaveStatus, DraftRestoreBanner } from '@/components/ui/Autosave'
import { Banner } from '@/components/ui/Banner'
import { findCustomerMatch } from '@/lib/customers'
import { SMS_CONSENT_WARNING } from '@/lib/consent'
import { cn } from '@/lib/utils'
import { Customer, CustomerFormValues, ACQUISITION_SOURCES } from '@/types'
import { Users, MessageSquare, Mail, ShieldCheck, Info } from 'lucide-react'

interface CustomerFormProps {
  defaultValues?: Partial<CustomerFormValues>
  customers?: Customer[]
  onSubmit: (values: CustomerFormValues) => Promise<void>
  onCancel: () => void
  isEdit?: boolean
  /** Autosave key — defaults per add/edit; pass a precise one (e.g. `customer:${id}`). */
  autosaveKey?: string
}

const PROVINCES = ['AB','BC','MB','NB','NL','NS','NT','NU','ON','PE','QC','SK','YT']

export function CustomerForm({ defaultValues, customers = [], onSubmit, onCancel, isEdit, autosaveKey }: CustomerFormProps) {
  const { register, handleSubmit, control, watch, setValue, reset, formState: { errors, isSubmitting } } = useForm<CustomerFormValues>({
    defaultValues: {
      province: 'AB',
      acquisition_source: '',
      referred_by_customer_id: '',
      birthday: '',
      anniversary: '',
      // Consent defaults OFF — compliant opt-in is an explicit owner choice, never
      // pre-checked. The profile's Communication card owns consent after creation.
      sms_opt_in: false,
      email_opt_in: false,
      ...defaultValues,
    },
  })

  // Autosave the whole form — survives refresh / crash / accidental close. Shared engine.
  const formValues = watch()
  const autosave = useAutosave<CustomerFormValues>({
    key: autosaveKey || `customer:${isEdit ? 'edit' : 'new'}`,
    value: formValues,
    isEmpty: v => !v.name?.trim() && !v.email?.trim() && !v.phone?.trim() && !v.address?.trim(),
  })
  const submit = handleSubmit(async v => { await onSubmit(v); autosave.clear() })

  // Live duplicate detection — reuses the ONE matching engine (phone/email/address
  // confident, name not). Only when creating, so we never warn a customer about
  // themselves. Surfaces the existing record instead of creating a duplicate.
  const name = watch('name'); const email = watch('email'); const phone = watch('phone'); const addr = watch('address')
  const smsOptIn = watch('sms_opt_in'); const emailOptIn = watch('email_opt_in')
  const dupMatch = useMemo(
    () => (isEdit ? null : findCustomerMatch(customers, { name, phone, email, address: addr })),
    [isEdit, customers, name, phone, email, addr],
  )

  // "Guide, don't silently create" — when a contact method is entered but its
  // channel is left off, name it so the owner makes a deliberate choice.
  const firstName = (name || '').trim().split(/\s+/)[0]
  const who = firstName || 'this customer'
  const hasPhone = !!phone?.trim(); const hasEmail = !!email?.trim()
  const consentHints: string[] = []
  if (hasPhone && !smsOptIn) consentHints.push(`You added a phone number — turn on texts if ${who} agreed to receive them.`)
  if (hasEmail && !emailOptIn) consentHints.push(`You added an email — turn on email if ${who} agreed to receive it.`)

  const source = watch('acquisition_source')
  const sourceOptions = [
    { value: '', label: 'How did they find you?' },
    ...ACQUISITION_SOURCES.map(s => ({ value: s, label: s })),
  ]
  // Memoized: at 8k customers this array (and the form's watch()-driven re-renders)
  // would otherwise rebuild the whole option list on every keystroke/field change.
  const referrerOptions = useMemo(() => [
    { value: '', label: 'Select referring customer...' },
    ...customers.map(c => ({ value: c.id, label: c.name })),
  ], [customers])

  return (
    <form onSubmit={submit} className="space-y-5">
      {autosave.draft && (
        <DraftRestoreBanner
          savedAt={autosave.savedAt}
          label="unsaved customer"
          onRestore={() => { const v = autosave.restore(); if (v) reset(v) }}
          onDiscard={autosave.discard}
        />
      )}
      <Input
        label="Full Name *" autoFocus
        placeholder="Jane Smith"
        error={errors.name?.message}
        {...register('name', { required: 'Name is required' })}
      />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Input
          label="Email"
          type="email"
          placeholder="jane@example.com"
          {...register('email')}
        />
        <Input
          label="Phone"
          type="tel"
          placeholder="(403) 555-0100"
          {...register('phone')}
        />
      </div>

      {/* ── Contact permissions ─────────────────────────────────────────────────
          Capture consent AT creation so messaging eligibility is set from day one
          — and never silently create a reachable-looking customer with texts/email
          off. Create-only: an existing customer's consent lives on their profile's
          Communication card (the one canonical manager). Persisted via the shared
          consent engine (applyConsent) so the audit trail is written. */}
      {!isEdit && (
        <div className="rounded-xl border border-border bg-surface/40 p-4 space-y-3">
          <div className="flex items-start gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-accent/10 border border-accent/20 flex items-center justify-center shrink-0">
              <ShieldCheck className="w-4 h-4 text-accent" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-ink">Contact permissions</p>
              <p className="text-xs text-ink-muted mt-0.5">Turn these on only for a customer who’s agreed to be contacted. You can change it anytime on their profile.</p>
            </div>
          </div>

          <Controller name="sms_opt_in" control={control} render={({ field }) => (
            <ConsentRow
              icon={MessageSquare} title="Text messages"
              desc="Reminders, “on my way” alerts, rescheduling and receipts by text."
              on={!!field.value} onChange={field.onChange}
              contactPresent={hasPhone} addHint="Add a phone number above to enable texts."
            />
          )} />
          <Controller name="email_opt_in" control={control} render={({ field }) => (
            <ConsentRow
              icon={Mail} title="Email"
              desc="Quotes, invoices, receipts and confirmations by email."
              on={!!field.value} onChange={field.onChange}
              contactPresent={hasEmail} addHint="Add an email address above to enable email."
            />
          )} />

          {smsOptIn && hasPhone && (
            <p className="text-[11px] text-ink-faint flex items-start gap-1.5 leading-snug">
              <Info className="w-3 h-3 shrink-0 mt-0.5" /> {SMS_CONSENT_WARNING}
            </p>
          )}
          {consentHints.length > 0 && (
            <div className="space-y-1 pt-0.5">
              {consentHints.map(h => (
                <p key={h} className="text-[11px] text-amber-400/90 flex items-start gap-1.5 leading-snug">
                  <Info className="w-3 h-3 shrink-0 mt-0.5" /> {h}
                </p>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Duplicate guard — link to the existing record instead of creating a copy */}
      {dupMatch && (
        <Banner tone="warn" icon={Users} className="items-start text-xs">
          <p>
            {dupMatch.confident
              ? <>Looks like this customer already exists — <span className="font-semibold">{dupMatch.customer.name}</span> (same {dupMatch.reason}).</>
              : <>Possible existing customer — <span className="font-semibold">{dupMatch.customer.name}</span> (same name).</>}
          </p>
          <Link href={`/dashboard/customers/${dupMatch.customer.id}`} className="inline-flex items-center gap-1 mt-1 text-accent font-medium hover:underline">
            Open {dupMatch.customer.name.split(' ')[0]} instead →
          </Link>
        </Banner>
      )}

      <Controller
        name="address"
        control={control}
        render={({ field }) => (
          <AddressAutocomplete
            label="Street Address"
            placeholder="123 Main Street"
            value={field.value || ''}
            onChange={field.onChange}
            onSelect={(p) => {
              field.onChange(p.address)
              if (p.city) setValue('city', p.city)
              if (p.province) setValue('province', p.province)
              if (p.postal) setValue('postal_code', p.postal)
            }}
          />
        )}
      />
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="col-span-2">
          <Input
            label="City"
            placeholder="Calgary"
            {...register('city')}
          />
        </div>
        <Select
          label="Province"
          options={PROVINCES.map(p => ({ value: p, label: p }))}
          {...register('province')}
        />
      </div>
      <Input
        label="Postal Code"
        placeholder="T2P 1G1"
        {...register('postal_code')}
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Controller
          name="acquisition_source"
          control={control}
          render={({ field }) => (
            <Select label="How they found you" options={sourceOptions} {...field} />
          )}
        />
        {source === 'Referral' && (
          <Controller
            name="referred_by_customer_id"
            control={control}
            render={({ field }) => (
              <Select label="Referred by" options={referrerOptions} {...field} />
            )}
          />
        )}
      </div>

      {/* Optional dates that power birthday / anniversary campaigns (Grow → Customer
          automation). Month + day are used; the year is fine to leave approximate. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Input
          label="Birthday"
          type="date"
          hint="Powers birthday campaigns — the year can be approximate"
          {...register('birthday')}
        />
        <Input
          label="Customer anniversary"
          type="date"
          hint="First service date — powers anniversary campaigns"
          {...register('anniversary')}
        />
      </div>

      <Textarea
        label="Notes"
        placeholder="Property details, gate codes, preferred contact times..."
        {...register('notes')}
      />
      <div className="flex items-center justify-end gap-3 pt-2">
        <AutosaveStatus status={autosave.status} savedAt={autosave.savedAt} className="mr-auto" />
        <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button type="submit" loading={isSubmitting}>
          {isEdit ? 'Save changes' : 'Add customer'}
        </Button>
      </div>
    </form>
  )
}

// One consent line: a switch + what turning it on actually sends. When the
// matching contact field is empty the switch is inert and says why — messaging
// eligibility is never a mystery.
function ConsentRow({ icon: Icon, title, desc, on, onChange, contactPresent, addHint }: {
  icon: typeof MessageSquare; title: string; desc: string
  on: boolean; onChange: (v: boolean) => void; contactPresent: boolean; addHint: string
}) {
  return (
    <div className={cn('flex items-start gap-3 rounded-lg border px-3 py-2.5 transition-colors',
      on && contactPresent ? 'border-accent/30 bg-accent/[0.04]' : 'border-border bg-bg-tertiary/40')}>
      <Icon className={cn('w-4 h-4 shrink-0 mt-0.5', on && contactPresent ? 'text-accent' : 'text-ink-faint')} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-ink">{title}</p>
        <p className="text-xs text-ink-muted mt-0.5 leading-snug">{desc}</p>
        {!contactPresent && <p className="text-[11px] text-ink-faint mt-1">{addHint}</p>}
      </div>
      <Toggle checked={on && contactPresent} onChange={onChange} disabled={!contactPresent} ariaLabel={`Allow ${title.toLowerCase()}`} />
    </div>
  )
}