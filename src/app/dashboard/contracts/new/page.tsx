'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import {
  CONTRACT_TYPES, DEFAULT_RENEWAL_NOTICE_DAYS,
  createContract, endDateFromTerm, listTemplates, supersedeContract, toISODate,
  type ContractTemplate,
} from '@/lib/contracts'
import type { Customer } from '@/types'
import { toast } from '@/lib/toast'
import { PageContainer } from '@/components/layout/PageContainer'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card, CardBody } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { CustomerPicker } from '@/components/ui/CustomerPicker'
import { Banner } from '@/components/ui/Banner'
import { SectionHeading } from '@/components/ui/SectionHeading'

// ── New contract ─────────────────────────────────────────────────────────────
// Template or blank → customer → optional links → term → draft.
//
// ⭐ This creates a DRAFT ONLY. No document is minted and nothing is sent, so an
// owner can change their mind freely. The artifact is created at SEND, which is
// the moment it becomes immutable.

interface Named { id: string; name?: string | null; address?: string | null }

export default function NewContractPage() {
  const supabase = useMemo(() => createClient(), [])
  const router = useRouter()
  const params = useSearchParams()

  const [uid, setUid] = useState<string | null>(null)
  const [templates, setTemplates] = useState<ContractTemplate[]>([])
  const [customers, setCustomers] = useState<Customer[]>([])
  const [templateId, setTemplateId] = useState('')
  const [customerId, setCustomerId] = useState(params.get('customer') ?? '')
  const [properties, setProperties] = useState<Named[]>([])
  const [recurrences, setRecurrences] = useState<{ id: string; label: string }[]>([])
  const [propertyId, setPropertyId] = useState('')
  const [recurrenceId, setRecurrenceId] = useState('')
  const [quoteId] = useState(params.get('quote') ?? '')
  const supersedesId = params.get('supersedes')
  const [jobId] = useState(params.get('job') ?? '')

  const [title, setTitle] = useState('')
  const [contractType, setContractType] = useState<string>('Service Agreement')
  const [effective, setEffective] = useState(toISODate(new Date()))
  const [termMode, setTermMode] = useState<'months' | 'until' | 'open'>('months')
  const [termMonths, setTermMonths] = useState('12')
  const [endDate, setEndDate] = useState('')
  const [notice, setNotice] = useState(String(DEFAULT_RENEWAL_NOTICE_DAYS))
  const [signatureRequired, setSignatureRequired] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return
      setUid(user.id)
      setTemplates(await listTemplates(supabase, user.id).catch(() => []))
      const { data: cs } = await supabase.from('customers')
        .select('*').eq('user_id', user.id).order('name')
      setCustomers((cs as Customer[]) || [])
    })()
  }, [supabase])

  // Optional links are scoped to the chosen customer, so the picker can never
  // offer a site or a series that belongs to somebody else.
  useEffect(() => {
    if (!uid || !customerId) { setProperties([]); setRecurrences([]); return }
    void (async () => {
      const { data: props } = await supabase.from('properties')
        .select('id, address').eq('user_id', uid).eq('customer_id', customerId)
      setProperties((props as Named[]) || [])
      const { data: recs } = await supabase.from('job_recurrences')
        .select('id, freq, start_date').eq('user_id', uid).eq('customer_id', customerId)
      setRecurrences(((recs as { id: string; freq: string | null; start_date: string }[]) || [])
        .map(r => ({ id: r.id, label: `${r.freq || 'recurring'} · from ${r.start_date}` })))
    })()
  }, [supabase, uid, customerId])

  const template = templates.find(t => t.id === templateId) || null

  // Choosing a template seeds the defaults it exists to carry — and never
  // silently overwrites a title the owner already typed.
  useEffect(() => {
    if (!template) return
    setContractType(template.contract_type || 'Service Agreement')
    setSignatureRequired(template.signature_required)
    setNotice(String(template.renewal_notice_days ?? DEFAULT_RENEWAL_NOTICE_DAYS))
    if (template.open_ended) setTermMode('open')
    else if (template.term_months) { setTermMode('months'); setTermMonths(String(template.term_months)) }
    setTitle(prev => prev || template.name)
  }, [template])

  const computedEnd = termMode === 'open' ? null
    : termMode === 'until' ? (endDate || null)
    : endDateFromTerm(effective, Number(termMonths) || null, false)

  const submit = async () => {
    setError(null)
    if (!uid) return
    if (!customerId) { setError('Choose a customer — an agreement needs someone to be with.'); return }
    if (!title.trim()) { setError('Give the contract a title.'); return }
    setBusy(true)
    const res = await createContract(supabase, {
      userId: uid,
      template,
      customerId,
      propertyId: propertyId || null,
      jobId: jobId || null,
      quoteId: quoteId || null,
      jobRecurrenceId: recurrenceId || null,
      serviceTemplateId: null,
      title,
      contractType: contractType || null,
      effectiveDate: effective || null,
      endDate: computedEnd,
      renewalNoticeDays: notice === '' ? null : Number(notice),
      signatureRequired,
    })
    setBusy(false)
    if (res.error || !res.contract) { setError(res.error ?? 'Could not create the contract.'); return }

    // ⭐ THE REPLACEMENT EXISTS BEFORE THE OLD ONE IS RETIRED. Superseding only
    // after the successor is real means the old contract can never sit marked
    // "superseded" while pointing at nothing — and if this step fails, the old
    // agreement is still standing, which is the safe way round.
    if (supersedesId) {
      const sup = await supersedeContract(supabase, supersedesId, res.contract.id)
      if (sup.error) {
        toast.error(`The replacement was created, but the old contract was not retired: ${sup.error}`)
      } else {
        toast.success('Replacement created. The signed contract is kept and marked superseded.')
        router.push(`/dashboard/contracts/${res.contract.id}`)
        return
      }
    }
    toast.success('Draft contract created')
    router.push(`/dashboard/contracts/${res.contract.id}`)
  }

  return (
    <PageContainer>
      <PageHeader
        title="New contract"
        description="Create a draft. Nothing is sent until you review it."
        crumb={{ label: 'Contracts', href: '/dashboard/contracts' }}
      />

      {error && <Banner tone="danger" className="mb-4">{error}</Banner>}

      <div className="space-y-4 max-w-2xl">
        <Card><CardBody className="space-y-4">
          <SectionHeading title="What kind of agreement" />
          <Select label="Template" value={templateId} onChange={e => setTemplateId(e.target.value)}
            options={[{ value: '', label: 'Start blank' },
                      ...templates.map(t => ({ value: t.id, label: t.name }))]} />
          <Input label="Title" value={title} onChange={e => setTitle(e.target.value)}
            placeholder="Seasonal service agreement" required />
          {/* ⭐ Free text with suggestions — EdgeHQ serves every trade, so the
              list is a starting point, never a limit. */}
          <Input label="Type" value={contractType} onChange={e => setContractType(e.target.value)}
            list="contract-types" placeholder="Service Agreement" />
          <datalist id="contract-types">
            {CONTRACT_TYPES.map(t => <option key={t} value={t} />)}
          </datalist>
        </CardBody></Card>

        <Card><CardBody className="space-y-4">
          <SectionHeading title="Who and where" />
          <CustomerPicker label="Customer" customers={customers} value={customerId}
            onChange={setCustomerId} allowManual={false} />
          {properties.length > 0 && (
            <Select label="Service location (optional)" value={propertyId}
              onChange={e => setPropertyId(e.target.value)}
              options={[{ value: '', label: 'No specific location' },
                        ...properties.map(p => ({ value: p.id, label: p.address || 'Location' }))]} />
          )}
          {recurrences.length > 0 && (
            <>
              <Select label="Recurring series this agreement governs (optional)" value={recurrenceId}
                onChange={e => setRecurrenceId(e.target.value)}
                options={[{ value: '', label: 'Not tied to a series' },
                          ...recurrences.map(r => ({ value: r.id, label: r.label }))]} />
              {/* ⭐⭐ The distinction the whole domain rests on, said plainly
                  where an owner is about to make the link. */}
              <p className="text-xs text-ink-faint -mt-2">
                Linking records that this agreement covers that series. It does not
                change when visits happen, and changing the schedule later will not
                change this agreement.
              </p>
            </>
          )}
        </CardBody></Card>

        <Card><CardBody className="space-y-4">
          <SectionHeading title="Term" />
          <Input label="Effective date" type="date" value={effective}
            onChange={e => setEffective(e.target.value)} />
          <Select label="Length" value={termMode}
            onChange={e => setTermMode(e.target.value as typeof termMode)}
            options={[{ value: 'months', label: 'For a number of months' },
                      { value: 'until', label: 'Until a specific date' },
                      { value: 'open', label: 'Open-ended' }]} />
          {termMode === 'months' && (
            <Input label="Months" type="number" min={1} value={termMonths}
              onChange={e => setTermMonths(e.target.value)} />
          )}
          {termMode === 'until' && (
            <Input label="End date" type="date" value={endDate}
              onChange={e => setEndDate(e.target.value)} />
          )}
          <p className="text-sm text-ink-soft">
            {computedEnd ? `Ends ${computedEnd}` : 'Open-ended — no end date.'}
          </p>
          {termMode !== 'open' && (
            <Input label="Tell me this many days before it ends" type="number" min={0} max={365}
              value={notice} onChange={e => setNotice(e.target.value)} />
          )}
        </CardBody></Card>

        <Card><CardBody className="space-y-3">
          <SectionHeading title="Signature" />
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1 w-4 h-4" checked={signatureRequired}
              onChange={e => setSignatureRequired(e.target.checked)} />
            <span>
              Require the customer to sign.
              <span className="block text-ink-faint text-xs mt-0.5">
                The contract becomes active when they sign. Without this, you activate it yourself.
              </span>
            </span>
          </label>
        </CardBody></Card>

        {/* type="button": a bare <button> inside a form defaults to submit and
            would navigate on Enter before the handler ran. */}
        <div className="flex flex-col sm:flex-row gap-2">
          <Button type="button" onClick={() => void submit()} disabled={busy} className="w-full sm:w-auto">
            {busy ? 'Creating…' : 'Create draft'}
          </Button>
          <Button type="button" variant="ghost" onClick={() => router.back()} className="w-full sm:w-auto">
            Cancel
          </Button>
        </div>
      </div>
    </PageContainer>
  )
}
