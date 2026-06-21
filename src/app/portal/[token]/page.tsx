'use client'

import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { formatCurrency, formatDate, cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import {
  FileText, Receipt, History, Image as ImageIcon, MessageSquarePlus, Check, Loader2,
  Phone, Globe, Mail, Leaf, CheckCircle2,
} from 'lucide-react'

// ── Customer Portal (magic link) ───────────────────────────────────────────────
// Public page at /portal/<token>. No login. EVERY read/write goes through the
// SECURITY DEFINER RPCs (get_portal_data / portal_accept_quote /
// portal_request_service), which return only the token's customer's data — the
// anon role can never reach another customer's records.

interface PortalQuote {
  id: string; quote_number: string; service_type: string; address: string
  total: number; initial_price: number | null; weekly_price: number | null
  biweekly_price: number | null; monthly_price: number | null; notes: string | null
  status: string; created_at: string
}
interface PortalInvoice {
  id: string; invoice_number: string; service_type: string | null; amount: number
  status: string; issued_date: string | null; due_date: string | null
  line_items: { description: string; amount: number; kind: string }[] | null; created_at: string
}
interface PortalJob { id: string; service_type: string | null; title: string; scheduled_date: string; status: string }
interface PortalPhoto { id: string; storage_path: string; kind: string; caption: string | null; taken_at: string }
interface PortalData {
  customer: { id: string; name: string; email: string | null; phone: string | null; address: string | null; city: string | null }
  business: { company_name: string | null; owner_name: string | null; phone: string | null; email_primary: string | null; website: string | null; logo_url: string | null } | null
  quotes: PortalQuote[]; invoices: PortalInvoice[]; history: PortalJob[]; photos: PortalPhoto[]
}

type Tab = 'quotes' | 'invoices' | 'history' | 'photos' | 'request'

export default function PortalPage() {
  const params = useParams()
  const token = String(params?.token || '')
  const supabase = useMemo(() => createClient(), [])
  const [data, setData] = useState<PortalData | null>(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<Tab>('quotes')
  const [accepting, setAccepting] = useState<string | null>(null)
  const [reqMsg, setReqMsg] = useState('')
  const [reqBusy, setReqBusy] = useState(false)
  const [reqSent, setReqSent] = useState(false)

  async function load() {
    const { data: d } = await supabase.rpc('get_portal_data', { p_token: token })
    setData((d as PortalData | null) ?? null)
    setLoading(false)
  }
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  function photoUrl(path: string) { return supabase.storage.from('job-photos').getPublicUrl(path).data.publicUrl }

  async function accept(qid: string) {
    setAccepting(qid)
    const { data: ok } = await supabase.rpc('portal_accept_quote', { p_token: token, p_quote_id: qid })
    if (ok) setData(d => d ? { ...d, quotes: d.quotes.map(q => q.id === qid ? { ...q, status: 'accepted' } : q) } : d)
    setAccepting(null)
  }
  async function sendRequest() {
    if (!reqMsg.trim()) return
    setReqBusy(true)
    const { data: ok } = await supabase.rpc('portal_request_service', { p_token: token, p_message: reqMsg.trim() })
    setReqBusy(false)
    if (ok) { setReqSent(true); setReqMsg('') }
  }

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center text-ink-muted"><Loader2 className="w-5 h-5 animate-spin" /></div>
  }
  if (!data) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-8 text-center">
        <Leaf className="w-10 h-10 text-ink-faint mb-3" />
        <p className="text-lg font-semibold text-ink">This link isn’t valid</p>
        <p className="text-sm text-ink-muted mt-1">It may have expired. Please contact your service provider for a new link.</p>
      </div>
    )
  }

  const biz = data.business
  const TABS: { key: Tab; label: string; icon: typeof FileText; n?: number }[] = [
    { key: 'quotes', label: 'Quotes', icon: FileText, n: data.quotes.length },
    { key: 'invoices', label: 'Invoices', icon: Receipt, n: data.invoices.length },
    { key: 'history', label: 'History', icon: History, n: data.history.length },
    { key: 'photos', label: 'Photos', icon: ImageIcon, n: data.photos.length },
    { key: 'request', label: 'Request', icon: MessageSquarePlus },
  ]

  return (
    <div className="min-h-screen bg-bg">
      <div className="max-w-lg mx-auto px-4 py-6 pb-24">
        {/* Business header */}
        <div className="flex items-center gap-3 mb-1">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {biz?.logo_url ? <img src={biz.logo_url} alt="" className="h-9 w-auto object-contain" /> : <Leaf className="w-7 h-7 text-accent" />}
          <div className="min-w-0">
            <p className="text-base font-bold text-ink truncate">{biz?.company_name || 'Your Service Provider'}</p>
            <p className="text-xs text-ink-muted">Hi {data.customer.name.split(' ')[0]} — here’s your account</p>
          </div>
        </div>
        {biz && (biz.phone || biz.email_primary || biz.website) && (
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-muted mb-4 pl-12">
            {biz.phone && <a href={`tel:${biz.phone}`} className="flex items-center gap-1 hover:text-ink"><Phone className="w-3 h-3" /> {biz.phone}</a>}
            {biz.email_primary && <a href={`mailto:${biz.email_primary}`} className="flex items-center gap-1 hover:text-ink"><Mail className="w-3 h-3" /> {biz.email_primary}</a>}
            {biz.website && <span className="flex items-center gap-1"><Globe className="w-3 h-3" /> {biz.website}</span>}
          </div>
        )}

        {/* Tabs */}
        <div className="flex gap-1.5 overflow-x-auto pb-1 mb-4 -mx-1 px-1">
          {TABS.map(t => (
            <button key={t.key} onClick={() => setTab(t.key)}
              className={cn('shrink-0 flex items-center gap-1.5 text-xs font-medium rounded-full px-3 py-2 border transition-colors',
                tab === t.key ? 'bg-accent text-black border-accent' : 'border-border text-ink-muted hover:text-ink')}>
              <t.icon className="w-3.5 h-3.5" /> {t.label}{t.n != null && t.n > 0 && <span className="opacity-70">{t.n}</span>}
            </button>
          ))}
        </div>

        {/* Quotes */}
        {tab === 'quotes' && (
          <Section empty={data.quotes.length === 0} emptyText="No quotes yet.">
            {data.quotes.map(q => (
              <Panel key={q.id}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-ink">{q.service_type}</p>
                    <p className="text-xs text-ink-muted">{q.quote_number} · {formatDate(q.created_at)}</p>
                  </div>
                  <StatusPill status={q.status} />
                </div>
                {q.address && <p className="text-xs text-ink-faint mt-1">{q.address}</p>}
                <div className="flex flex-wrap gap-2 mt-2">
                  {q.weekly_price ? <PriceChip label="Weekly" v={q.weekly_price} /> : null}
                  {q.biweekly_price ? <PriceChip label="Bi-weekly" v={q.biweekly_price} /> : null}
                  {q.monthly_price ? <PriceChip label="Monthly" v={q.monthly_price} /> : null}
                  {!q.weekly_price && !q.biweekly_price && !q.monthly_price ? <PriceChip label="Total" v={q.total} /> : null}
                </div>
                {q.notes && <p className="text-xs text-ink-muted mt-2 whitespace-pre-wrap">{q.notes}</p>}
                {q.status === 'sent' && (
                  <div className="mt-3">
                    <Button size="sm" onClick={() => accept(q.id)} loading={accepting === q.id}>
                      <Check className="w-4 h-4" /> Accept this quote
                    </Button>
                  </div>
                )}
                {q.status === 'accepted' && (
                  <p className="mt-3 inline-flex items-center gap-1.5 text-sm font-semibold text-emerald-400"><CheckCircle2 className="w-4 h-4" /> Accepted — thank you!</p>
                )}
              </Panel>
            ))}
          </Section>
        )}

        {/* Invoices */}
        {tab === 'invoices' && (
          <Section empty={data.invoices.length === 0} emptyText="No invoices yet.">
            {data.invoices.map(inv => (
              <Panel key={inv.id}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-ink">{inv.service_type || 'Services'}</p>
                    <p className="text-xs text-ink-muted">{inv.invoice_number} · {inv.issued_date ? formatDate(inv.issued_date) : formatDate(inv.created_at)}{inv.due_date ? ` · due ${formatDate(inv.due_date)}` : ''}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-base font-bold text-ink">{formatCurrency(Number(inv.amount))}</p>
                    <StatusPill status={inv.status} />
                  </div>
                </div>
                {inv.line_items && inv.line_items.length > 1 && (
                  <div className="mt-2 space-y-0.5">
                    {inv.line_items.map((li, i) => (
                      <p key={i} className="text-xs flex justify-between gap-3"><span className="text-ink-faint">{li.description}</span><span className="text-ink-muted">{formatCurrency(Number(li.amount))}</span></p>
                    ))}
                  </div>
                )}
              </Panel>
            ))}
          </Section>
        )}

        {/* Service history */}
        {tab === 'history' && (
          <Section empty={data.history.length === 0} emptyText="No completed visits yet.">
            {data.history.map(j => (
              <Panel key={j.id}>
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-ink flex items-center gap-1.5"><CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />{j.service_type || j.title}</p>
                  <span className="text-xs text-ink-muted">{formatDate(j.scheduled_date)}</span>
                </div>
              </Panel>
            ))}
          </Section>
        )}

        {/* Photos */}
        {tab === 'photos' && (
          <Section empty={data.photos.length === 0} emptyText="No photos yet.">
            <div className="grid grid-cols-2 gap-2">
              {data.photos.map(p => (
                <a key={p.id} href={photoUrl(p.storage_path)} target="_blank" rel="noopener noreferrer"
                  className="relative aspect-square rounded-xl overflow-hidden border border-border bg-bg-tertiary">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={photoUrl(p.storage_path)} alt={p.caption || ''} loading="lazy" className="w-full h-full object-cover" />
                  <span className="absolute bottom-1 left-1 text-[10px] font-medium text-white bg-black/50 rounded px-1.5 py-0.5">{formatDate(p.taken_at)}</span>
                </a>
              ))}
            </div>
          </Section>
        )}

        {/* Request service */}
        {tab === 'request' && (
          <Panel>
            {reqSent ? (
              <div className="text-center py-6">
                <CheckCircle2 className="w-8 h-8 text-emerald-400 mx-auto mb-2" />
                <p className="text-sm font-semibold text-ink">Request sent!</p>
                <p className="text-xs text-ink-muted mt-1">{biz?.company_name || 'We'}’ll be in touch soon.</p>
              </div>
            ) : (
              <>
                <p className="text-sm font-semibold text-ink mb-1">Request a service</p>
                <p className="text-xs text-ink-muted mb-2">Need a visit, a quote, or have a question? Send a note and we’ll get back to you.</p>
                <textarea value={reqMsg} onChange={e => setReqMsg(e.target.value)} rows={4} placeholder="e.g. Can you add a fall cleanup this month?"
                  className="w-full bg-bg-tertiary border border-border-strong rounded-lg px-3 py-2 text-sm text-ink outline-none focus:border-accent" />
                <div className="mt-2"><Button size="sm" onClick={sendRequest} loading={reqBusy} disabled={!reqMsg.trim()}>Send request</Button></div>
              </>
            )}
          </Panel>
        )}

        <p className="text-center text-[10px] text-ink-faint mt-8">Powered by EdgeQuote</p>
      </div>
    </div>
  )
}

function Section({ children, empty, emptyText }: { children: React.ReactNode; empty: boolean; emptyText: string }) {
  if (empty) return <p className="text-center text-sm text-ink-muted py-12">{emptyText}</p>
  return <div className="space-y-3">{children}</div>
}
function Panel({ children }: { children: React.ReactNode }) {
  return <div className="rounded-card border border-border bg-bg-secondary p-3.5">{children}</div>
}
function PriceChip({ label, v }: { label: string; v: number }) {
  return <span className="text-xs rounded-lg border border-border bg-bg-tertiary px-2 py-1"><span className="text-ink-faint">{label}</span> <span className="font-semibold text-ink">{formatCurrency(Number(v))}</span></span>
}
function StatusPill({ status }: { status: string }) {
  const tone = status === 'accepted' || status === 'paid' ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10'
    : status === 'declined' ? 'text-red-400 border-red-500/30 bg-red-500/10'
    : 'text-amber-400 border-amber-500/30 bg-amber-500/10'
  return <span className={cn('text-[10px] font-semibold uppercase tracking-wide rounded-full px-2 py-0.5 border', tone)}>{status}</span>
}
