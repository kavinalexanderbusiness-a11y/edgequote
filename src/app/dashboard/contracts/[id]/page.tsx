'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import {
  STATUS_HELP, STATUS_LABEL, activateContract, contractSignatures, contractText,
  getContract, listTemplates, renewalLabel, sendContract,
  terminateContract, toView,
  type ContractTemplate, type ContractVars, type ContractView,
} from '@/lib/contracts'
import { PURPOSE_STATEMENT, signedDocumentUrl, type DocumentSignature, type DocumentVersion } from '@/lib/documents'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { confirm as confirmDialog } from '@/lib/confirm'
import { PageContainer } from '@/components/layout/PageContainer'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card, CardBody } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Banner } from '@/components/ui/Banner'
import { Textarea } from '@/components/ui/Textarea'
import { SectionHeading } from '@/components/ui/SectionHeading'
import { SkeletonRows } from '@/components/ui/Skeleton'
import { CheckCircle2, FileText, Send, XCircle, RefreshCw, Lock } from 'lucide-react'

// ── Contract detail ──────────────────────────────────────────────────────────
// One agreement: what it says, who it is with, how long it runs, and what has
// happened to it.
//
// ⭐⭐ EVERY IRREVERSIBLE STEP IS NAMED BEFORE IT HAPPENS. Sending mints an
// immutable Session 74 version; signing freezes the agreement; superseding
// preserves the old one. The database refuses the rest, and this page explains
// why rather than silently disabling a control.

export default function ContractDetailPage() {
  const supabase = useMemo(() => createClient(), [])
  const router = useRouter()
  const { id } = useParams<{ id: string }>()

  const [uid, setUid] = useState<string | null>(null)
  const [contract, setContract] = useState<ContractView | null>(null)
  const [signature, setSignature] = useState<DocumentSignature | null>(null)
  const [version, setVersion] = useState<DocumentVersion | null>(null)
  const [customerName, setCustomerName] = useState<string>('')
  const [propertyAddress, setPropertyAddress] = useState<string>('')
  const [businessName, setBusinessName] = useState<string>('')
  const [template, setTemplate] = useState<ContractTemplate | null>(null)
  const [body, setBody] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return
      setUid(user.id)

      const row = await getContract(supabase, id)
      if (!row) { setError('That contract could not be found.'); return }
      const sigs = await contractSignatures(
        supabase, row.signature_request_id ? [row.signature_request_id] : [])
      setContract(toView(row, sigs))
      setSignature(sigs[0] ?? null)

      const { data: cust } = await supabase.from('customers')
        .select('name').eq('id', row.customer_id).maybeSingle()
      setCustomerName((cust as { name: string } | null)?.name ?? '')

      if (row.property_id) {
        const { data: prop } = await supabase.from('properties')
          .select('address').eq('id', row.property_id).maybeSingle()
        setPropertyAddress((prop as { address: string } | null)?.address ?? '')
      }
      const { data: biz } = await supabase.from('business_settings')
        .select('business_name').eq('user_id', user.id).maybeSingle()
      setBusinessName((biz as { business_name: string } | null)?.business_name ?? '')

      if (row.document_version_id) {
        const { data: v } = await supabase.from('document_versions')
          .select('*').eq('id', row.document_version_id).maybeSingle()
        setVersion((v as DocumentVersion) || null)
      }

      const tpls = await listTemplates(supabase, user.id, { includeArchived: true }).catch(() => [])
      const t = tpls.find(x => x.id === row.template_id) || null
      setTemplate(t)
      if (row.status === 'draft') setBody(prev => prev || t?.body || '')
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the contract.')
    } finally {
      setLoading(false)
    }
  }, [supabase, id])

  useEffect(() => { void load() }, [load])

  const vars: ContractVars = useMemo(() => ({
    customer_name: customerName,
    business_name: businessName,
    property_address: propertyAddress,
    contract_title: contract?.title,
    contract_type: contract?.contract_type,
    effective_date: contract?.effective_date,
    end_date: contract?.end_date,
  }), [customerName, businessName, propertyAddress, contract])

  const doSend = async () => {
    if (!uid || !contract) return
    if (!body.trim()) { toast.error('The agreement has no text yet.'); return }
    const ok = await confirmDialog({
      title: 'Send this contract?',
      // ⭐ The irreversibility is stated in the owner's language, before it happens.
      message: 'This creates the permanent version the customer will see and sign. After this, the wording cannot be changed — a revision means a replacement contract.',
      confirmLabel: 'Send for signature',
    })
    if (!ok) return
    setBusy(true)
    const res = await sendContract(supabase, {
      userId: uid,
      contract,
      template,
      vars,
      body,
      statement: template?.statement || PURPOSE_STATEMENT.customer_acknowledgement,
      purpose: template?.purpose || 'customer_acknowledgement',
    })
    setBusy(false)
    if (res.error) { toast.error(res.error); return }
    toast.success('Sent. The customer can sign it in their portal.')
    void load()
  }

  const doActivate = async () => {
    setBusy(true)
    const res = await activateContract(supabase, id)
    setBusy(false)
    if (res.error) { toast.error(res.error); return }
    toast.success('Contract is active')
    void load()
  }

  const doTerminate = async () => {
    const reason = window.prompt('Why is this agreement ending? (kept on the record)')
    if (reason === null) return
    setBusy(true)
    const res = await terminateContract(supabase, id, reason)
    setBusy(false)
    if (res.error) { toast.error(res.error); return }
    toast.success('Contract terminated')
    void load()
  }

  const doSupersede = async () => {
    if (!contract) return
    const ok = await confirmDialog({
      title: 'Replace this contract?',
      message: 'The signed record is kept exactly as it is and marked superseded. You will start a new draft for the replacement.',
      confirmLabel: 'Start a replacement',
    })
    if (!ok) return
    // The replacement is created first, so the old row never sits in a
    // superseded state pointing at nothing.
    router.push(`/dashboard/contracts/new?customer=${contract.customer_id}&supersedes=${contract.id}`)
  }

  const openDocument = async () => {
    if (!version) return
    const url = await signedDocumentUrl(supabase, version.storage_path)
    if (!url) { toast.error('Could not open the document.'); return }
    window.open(url, '_blank', 'noopener')
  }

  if (loading) return <PageContainer><SkeletonRows count={5} /></PageContainer>
  if (error || !contract) {
    return (
      <PageContainer>
        <Banner tone="danger">{error ?? 'Not found.'}</Banner>
      </PageContainer>
    )
  }

  const note = renewalLabel(contract.renewal)
  const canSend = contract.status === 'draft'
  const canActivate = contract.status === 'sent'
    && (!contract.signature_required || contract.signed)

  return (
    <PageContainer>
      <PageHeader
        title={contract.title}
        description={`${customerName}${contract.contract_type ? ` · ${contract.contract_type}` : ''}`}
        crumb={{ label: 'Contracts', href: '/dashboard/contracts' }}
      />

      <div className="space-y-4 max-w-3xl">
        <Card><CardBody className="space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-ink">{STATUS_LABEL[contract.display]}</span>
            {contract.signed && (
              <span className="inline-flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-400">
                <CheckCircle2 className="w-3.5 h-3.5" /> Signed
              </span>
            )}
          </div>
          <p className="text-sm text-ink-soft">{STATUS_HELP[contract.display]}</p>
          <p className="text-sm text-ink-soft">{contract.termLabel}</p>
          {note && <p className="text-sm text-amber-700 dark:text-amber-400">{note}</p>}
        </CardBody></Card>

        {/* ── The agreement text ─────────────────────────────────────────── */}
        <Card><CardBody className="space-y-3">
          <SectionHeading title={canSend ? 'The agreement' : 'The signed version'} />
          {canSend ? (
            <>
              <Textarea label="Wording" value={body} onChange={e => setBody(e.target.value)}
                rows={12}
                hint="Placeholders like {{customer_name}} are filled in when you send." />
              <details className="text-sm">
                <summary className="cursor-pointer text-ink-soft">Preview</summary>
                <pre className="mt-2 p-3 bg-surface-2 rounded-lg text-xs whitespace-pre-wrap overflow-x-auto">
                  {contractText(contract.title, contract.contract_type, body, vars)}
                </pre>
              </details>
            </>
          ) : (
            <div className="space-y-2">
              <p className="text-sm text-ink-soft flex items-start gap-1.5">
                <Lock className="w-4 h-4 mt-0.5 shrink-0" />
                {/* ⭐ Explains WHY it is locked instead of just disabling it. */}
                This is the exact version that was sent. It cannot change — that is
                what makes it worth signing.
              </p>
              {version && (
                <Button type="button" variant="secondary" onClick={() => void openDocument()}>
                  <FileText className="w-4 h-4" /> Open version {version.version_no}
                </Button>
              )}
            </div>
          )}
        </CardBody></Card>

        {/* ── Signature evidence ─────────────────────────────────────────── */}
        {signature && (
          <Card><CardBody className="space-y-2">
            <SectionHeading title="Signature" />
            <dl className="text-sm grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1">
              <div><dt className="text-ink-faint">Signed by</dt><dd className="text-ink">{signature.signer_name}</dd></div>
              <div><dt className="text-ink-faint">When</dt><dd className="text-ink">{new Date(signature.signed_at).toLocaleString()}</dd></div>
              <div className="sm:col-span-2">
                <dt className="text-ink-faint">Agreed to</dt>
                <dd className="text-ink">“{signature.statement}”</dd>
              </div>
              <div><dt className="text-ink-faint">Where</dt>
                <dd className="text-ink">{signature.source === 'portal' ? 'Customer portal' : 'Recorded by you'}</dd></div>
            </dl>
            {/* ⛔ LEGAL HONESTY, at the exact place a claim would be tempting. */}
            <p className="text-xs text-ink-faint">
              EdgeHQ recorded the name entered, the time, and the exact version agreed to.
              That is evidence of intent, not proof of identity, and EdgeHQ does not
              provide legal advice about enforceability.
            </p>
          </CardBody></Card>
        )}

        {/* ── Links ──────────────────────────────────────────────────────── */}
        <Card><CardBody className="space-y-2">
          <SectionHeading title="Related" />
          <ul className="text-sm space-y-1">
            <li>
              <Link href={`/dashboard/customers/${contract.customer_id}`}
                className="text-accent-text hover:underline">{customerName || 'Customer'}</Link>
            </li>
            {propertyAddress && <li className="text-ink-soft">{propertyAddress}</li>}
            {contract.quote_id && (
              <li><Link href={`/dashboard/quotes/${contract.quote_id}`}
                className="text-accent-text hover:underline">Related quote</Link></li>
            )}
            {contract.job_recurrence_id && (
              // ⭐⭐ The sentence that keeps the two ideas apart, on the surface
              // where an owner is most likely to conflate them.
              <li className="text-ink-soft">
                Governs a recurring series. Visits are scheduled in Schedule — changing
                the schedule does not change this agreement.
              </li>
            )}
            {contract.template_name && (
              <li className="text-ink-faint text-xs">
                Made from “{contract.template_name}”
                {contract.status !== 'draft' && ' — later edits to that template do not affect this contract.'}
              </li>
            )}
          </ul>
        </CardBody></Card>

        {/* Buttons stack on a phone and are full-width there — no tiny targets. */}
        <div className="flex flex-col sm:flex-row gap-2">
          {canSend && (
            <Button type="button" onClick={() => void doSend()} disabled={busy} className="w-full sm:w-auto">
              <Send className="w-4 h-4" /> {busy ? 'Sending…' : 'Send for signature'}
            </Button>
          )}
          {canActivate && (
            <Button type="button" onClick={() => void doActivate()} disabled={busy} className="w-full sm:w-auto">
              <CheckCircle2 className="w-4 h-4" /> Mark active
            </Button>
          )}
          {(contract.status === 'active' || contract.status === 'sent') && (
            <Button type="button" variant="secondary" onClick={() => void doTerminate()}
              disabled={busy} className="w-full sm:w-auto">
              <XCircle className="w-4 h-4" /> Terminate
            </Button>
          )}
          {contract.signed && contract.status !== 'superseded' && (
            <Button type="button" variant="secondary" onClick={() => void doSupersede()}
              disabled={busy} className="w-full sm:w-auto">
              <RefreshCw className="w-4 h-4" /> Replace with a new contract
            </Button>
          )}
        </div>

        {contract.status === 'sent' && contract.signature_required && !contract.signed && (
          <p className={cn('text-sm text-ink-soft')}>
            Waiting for {customerName || 'the customer'} to sign in their portal.
          </p>
        )}
      </div>
    </PageContainer>
  )
}
