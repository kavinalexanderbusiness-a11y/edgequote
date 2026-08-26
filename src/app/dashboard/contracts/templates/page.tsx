'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  CONTRACT_TYPES, CONTRACT_PLACEHOLDERS, DEFAULT_RENEWAL_NOTICE_DAYS,
  listTemplates, type ContractTemplate,
} from '@/lib/contracts'
import { PURPOSE_LABEL, PURPOSE_STATEMENT, type SignaturePurpose } from '@/lib/documents'
import { toast } from '@/lib/toast'
import { PageContainer } from '@/components/layout/PageContainer'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card, CardBody } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Textarea } from '@/components/ui/Textarea'
import { Banner } from '@/components/ui/Banner'
import { EmptyState } from '@/components/ui/EmptyState'
import { SkeletonRows } from '@/components/ui/Skeleton'
import { SectionHeading } from '@/components/ui/SectionHeading'
import { FileSignature, Plus, Archive } from 'lucide-react'

// ── Contract templates ───────────────────────────────────────────────────────
// The BUSINESS MEANING of an agreement: what it says, how long it usually runs,
// and what signing it is supposed to mean.
//
// ⭐⭐ A TEMPLATE IS NOT A DOCUMENT. Editing one here changes what FUTURE
// contracts start from and can never reach a contract that has already been
// sent — that artifact is an immutable Session 74 version. The page says so,
// because "will this rewrite what my customer signed?" is the first question a
// careful owner asks.

const BLANK = {
  name: '', contract_type: 'Service Agreement', body: '',
  term_months: '12', open_ended: false,
  renewal_notice_days: String(DEFAULT_RENEWAL_NOTICE_DAYS),
  signature_required: true,
  purpose: 'customer_acknowledgement' as SignaturePurpose,
  statement: PURPOSE_STATEMENT.customer_acknowledgement,
}

export default function ContractTemplatesPage() {
  const supabase = useMemo(() => createClient(), [])
  const [uid, setUid] = useState<string | null>(null)
  const [rows, setRows] = useState<ContractTemplate[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | 'new' | null>(null)
  const [form, setForm] = useState({ ...BLANK })
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return
      setUid(user.id)
      setRows(await listTemplates(supabase, user.id))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load templates.')
    } finally {
      setLoading(false)
    }
  }, [supabase])

  useEffect(() => { void load() }, [load])

  const startNew = () => { setForm({ ...BLANK }); setEditing('new') }
  const startEdit = (t: ContractTemplate) => {
    setForm({
      name: t.name,
      contract_type: t.contract_type ?? '',
      body: t.body,
      term_months: t.term_months ? String(t.term_months) : '',
      open_ended: t.open_ended,
      renewal_notice_days: t.renewal_notice_days === null ? '' : String(t.renewal_notice_days),
      signature_required: t.signature_required,
      purpose: t.purpose,
      statement: t.statement,
    })
    setEditing(t.id)
  }

  const save = async () => {
    if (!uid) return
    if (!form.name.trim()) { toast.error('Give the template a name.'); return }
    if (form.body.trim().length < 1) { toast.error('The template needs some wording.'); return }
    if (form.statement.trim().length < 10) {
      toast.error('The sentence the customer agrees to must be a real sentence.'); return
    }
    setBusy(true)
    const patch = {
      user_id: uid,
      name: form.name.trim(),
      contract_type: form.contract_type.trim() || null,
      body: form.body,
      // ⭐ Open-ended and a fixed term are mutually exclusive — the database
      // refuses the pair, so the form must not construct it.
      term_months: form.open_ended || !form.term_months ? null : Number(form.term_months),
      open_ended: form.open_ended,
      renewal_notice_days: form.renewal_notice_days === '' ? null : Number(form.renewal_notice_days),
      signature_required: form.signature_required,
      purpose: form.purpose,
      statement: form.statement.trim(),
      updated_at: new Date().toISOString(),
    }
    const res = editing === 'new'
      ? await supabase.from('contract_templates').insert(patch)
      : await supabase.from('contract_templates').update(patch).eq('id', editing)
    setBusy(false)
    if (res.error) { toast.error(res.error.message); return }
    toast.success(editing === 'new' ? 'Template created' : 'Template saved')
    setEditing(null)
    void load()
  }

  const archive = async (t: ContractTemplate) => {
    const { error: e } = await supabase.from('contract_templates')
      .update({ archived_at: new Date().toISOString() }).eq('id', t.id)
    if (e) { toast.error(e.message); return }
    toast.success('Template archived')
    void load()
  }

  return (
    <PageContainer>
      <PageHeader
        title="Contract templates"
        description="What your agreements say, and what signing one means."
        crumb={{ label: 'Contracts', href: '/dashboard/contracts' }}
        action={
          <Button type="button" onClick={startNew}>
            <Plus className="w-4 h-4" /> New template
          </Button>
        }
      />

      {error && <Banner tone="danger" className="mb-4">{error}</Banner>}

      {editing && (
        <Card className="mb-4"><CardBody className="space-y-4">
          <SectionHeading title={editing === 'new' ? 'New template' : 'Edit template'} />
          {/* ⭐⭐ The question every owner has, answered before they type. */}
          <Banner tone="info">
            Editing a template only changes contracts you create from now on. Anything
            already sent or signed keeps the exact wording it was sent with.
          </Banner>
          <Input label="Name" value={form.name}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
          <Input label="Type" value={form.contract_type} list="tpl-types"
            onChange={e => setForm(f => ({ ...f, contract_type: e.target.value }))} />
          <datalist id="tpl-types">
            {CONTRACT_TYPES.map(t => <option key={t} value={t} />)}
          </datalist>

          <Textarea label="Wording" rows={10} value={form.body}
            onChange={e => setForm(f => ({ ...f, body: e.target.value }))}
            hint={`Placeholders: ${CONTRACT_PLACEHOLDERS.map(p => `{{${p}}}`).join(' ')}`} />

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input label="Default term (months)" type="number" min={1}
              value={form.term_months} disabled={form.open_ended}
              onChange={e => setForm(f => ({ ...f, term_months: e.target.value }))} />
            <Input label="Renewal notice (days)" type="number" min={0} max={365}
              value={form.renewal_notice_days}
              onChange={e => setForm(f => ({ ...f, renewal_notice_days: e.target.value }))} />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="w-4 h-4" checked={form.open_ended}
              onChange={e => setForm(f => ({ ...f, open_ended: e.target.checked }))} />
            Open-ended by default (no end date)
          </label>

          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="w-4 h-4" checked={form.signature_required}
              onChange={e => setForm(f => ({ ...f, signature_required: e.target.checked }))} />
            Require a signature
          </label>
          {form.signature_required && (
            <>
              <Select label="What signing means" value={form.purpose}
                onChange={e => {
                  const p = e.target.value as SignaturePurpose
                  setForm(f => ({ ...f, purpose: p, statement: PURPOSE_STATEMENT[p] }))
                }}
                options={(Object.keys(PURPOSE_LABEL) as SignaturePurpose[])
                  .map(p => ({ value: p, label: PURPOSE_LABEL[p] }))} />
              {/* ⭐ The statement is the MEANING of the signature, so it must be
                  the owner's words — the product only suggests a starting point. */}
              <Textarea label="The sentence the customer agrees to" rows={3}
                value={form.statement}
                onChange={e => setForm(f => ({ ...f, statement: e.target.value }))} />
            </>
          )}

          <div className="flex flex-col sm:flex-row gap-2">
            <Button type="button" onClick={() => void save()} disabled={busy} className="w-full sm:w-auto">
              {busy ? 'Saving…' : 'Save template'}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setEditing(null)} className="w-full sm:w-auto">
              Cancel
            </Button>
          </div>
        </CardBody></Card>
      )}

      {loading ? <SkeletonRows count={3} /> : rows.length === 0 && !editing ? (
        <EmptyState icon={FileSignature} title="No templates yet"
          description="A template holds the wording you reuse — a service agreement, a maintenance plan, a terms acknowledgement."
          action={{ label: 'New template', onClick: startNew }} />
      ) : (
        <div className="space-y-2">
          {rows.map(t => (
            <Card key={t.id}><CardBody className="py-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="font-medium text-ink truncate">{t.name}</div>
                  <div className="text-sm text-ink-soft">
                    {t.contract_type || 'No type'} ·{' '}
                    {t.open_ended ? 'Open-ended' : t.term_months ? `${t.term_months} months` : 'Term set per contract'}
                    {t.signature_required ? ' · signature required' : ' · no signature'}
                  </div>
                </div>
                <div className="flex gap-2 shrink-0">
                  <Button type="button" variant="secondary" onClick={() => startEdit(t)}>Edit</Button>
                  <Button type="button" variant="ghost" onClick={() => void archive(t)}>
                    <Archive className="w-4 h-4" /> Archive
                  </Button>
                </div>
              </div>
            </CardBody></Card>
          ))}
        </div>
      )}
    </PageContainer>
  )
}
