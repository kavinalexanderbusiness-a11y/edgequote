'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { recordImportConsent, SMS_CONSENT_WARNING } from '@/lib/consent'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card, CardBody } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { ArrowLeft, Upload, ShieldAlert, Check } from 'lucide-react'

// Minimal CSV parser — handles quoted fields, embedded commas, and "" escapes.
function parseCSV(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [], field = '', inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++ } else inQuotes = false }
      else field += ch
    } else if (ch === '"') inQuotes = true
    else if (ch === ',') { row.push(field); field = '' }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = '' }
    else if (ch !== '\r') field += ch
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row) }
  return rows.filter(r => r.some(c => c.trim() !== ''))
}

const normHeader = (h: string) => h.toLowerCase().trim().replace(/[\s-]+/g, '_')
const truthy = (v: string) => ['true', '1', 'yes', 'y', 'x', 't'].includes(v.toLowerCase().trim())

interface ParsedRow {
  name: string; email: string | null; phone: string | null; address: string | null
  city: string | null; province: string | null; postal_code: string | null; notes: string | null
  sms_opt_in: boolean; email_opt_in: boolean
}

function buildRows(csv: string): { rows: ParsedRow[]; error?: string } {
  const grid = parseCSV(csv)
  if (grid.length < 2) return { rows: [], error: 'Need a header row plus at least one customer row.' }
  const headers = grid[0].map(normHeader)
  const col = (name: string) => headers.indexOf(name)
  if (col('name') < 0) return { rows: [], error: 'A "name" column is required.' }
  const at = (r: string[], i: number) => (i >= 0 && r[i] != null ? r[i].trim() : '')
  const rows: ParsedRow[] = []
  for (const r of grid.slice(1)) {
    const name = at(r, col('name'))
    if (!name) continue
    rows.push({
      name,
      email: at(r, col('email')) || null,
      phone: at(r, col('phone')) || null,
      address: at(r, col('address')) || null,
      city: at(r, col('city')) || null,
      province: at(r, col('province')) || null,
      postal_code: at(r, col('postal_code')) || null,
      notes: at(r, col('notes')) || null,
      sms_opt_in: col('sms_opt_in') >= 0 ? truthy(at(r, col('sms_opt_in'))) : false,
      email_opt_in: col('email_opt_in') >= 0 ? truthy(at(r, col('email_opt_in'))) : false,
    })
  }
  return { rows }
}

export default function ImportCustomersPage() {
  const router = useRouter()
  const supabase = createClient()
  const [csv, setCsv] = useState('')
  const [rows, setRows] = useState<ParsedRow[]>([])
  const [parseError, setParseError] = useState<string | null>(null)
  const [smsAck, setSmsAck] = useState(false)
  const [importing, setImporting] = useState(false)
  const [done, setDone] = useState<number | null>(null)

  const smsCount = rows.filter(r => r.sms_opt_in).length
  const emailCount = rows.filter(r => r.email_opt_in).length

  function preview(text: string) {
    setCsv(text); setDone(null)
    if (!text.trim()) { setRows([]); setParseError(null); return }
    const { rows: r, error } = buildRows(text)
    setRows(r); setParseError(error ?? null); setSmsAck(false)
  }
  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]; if (!f) return
    preview(await f.text())
  }

  async function runImport() {
    if (!rows.length) return
    if (smsCount > 0 && !smsAck) return
    setImporting(true)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { setImporting(false); return }
      const insertRows = rows.map(r => ({
        user_id: user.id, name: r.name, email: r.email, phone: r.phone, address: r.address,
        city: r.city, province: r.province || 'AB', postal_code: r.postal_code, notes: r.notes,
        sms_opt_in: r.sms_opt_in, email_opt_in: r.email_opt_in,
      }))
      const { data: inserted, error } = await supabase.from('customers').insert(insertRows).select('id, address, city, province, postal_code')
      if (error || !inserted) { setParseError('Import failed: ' + (error?.message || 'unknown error')); setImporting(false); return }

      // Primary property per row that has an address (mirrors single-add).
      const props = (inserted as { id: string; address: string | null; city: string | null; province: string | null; postal_code: string | null }[])
        .filter(c => c.address)
        .map(c => ({ customer_id: c.id, user_id: user.id, address: c.address, city: c.city, province: c.province || 'AB', postal_code: c.postal_code, is_primary: true }))
      if (props.length) await supabase.from('properties').insert(props)

      // Audit every imported opt-in.
      await recordImportConsent(supabase, {
        userId: user.id, changedBy: user.email || user.id,
        rows: (inserted as { id: string }[]).map((c, i) => ({ customerId: c.id, sms: rows[i]?.sms_opt_in ?? false, email: rows[i]?.email_opt_in ?? false })),
      })
      setDone(inserted.length)
    } finally { setImporting(false) }
  }

  return (
    <div className="max-w-3xl space-y-6">
      <Link href="/dashboard/customers" className="text-sm text-ink-muted hover:text-ink flex items-center gap-1.5"><ArrowLeft className="w-4 h-4" /> Back to customers</Link>
      <PageHeader title="Import Customers" description="Paste or upload a CSV. Optional columns: sms_opt_in, email_opt_in." />

      {done != null ? (
        <Card>
          <CardBody className="text-center py-10 space-y-3">
            <Check className="w-10 h-10 text-emerald-400 mx-auto" />
            <p className="text-lg font-semibold text-ink">Imported {done} customer{done !== 1 ? 's' : ''}.</p>
            <Button onClick={() => router.push('/dashboard/customers')}>Back to customers</Button>
          </CardBody>
        </Card>
      ) : (
        <>
          <Card>
            <CardBody className="space-y-3">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <p className="text-xs text-ink-muted">Columns: <span className="text-ink">name</span> (required), email, phone, address, city, province, postal_code, notes, sms_opt_in, email_opt_in</p>
                <label className="inline-flex items-center gap-1.5 text-xs font-medium text-accent cursor-pointer">
                  <Upload className="w-3.5 h-3.5" /> Upload CSV file
                  <input type="file" accept=".csv,text/csv" onChange={onFile} className="hidden" />
                </label>
              </div>
              <textarea
                value={csv}
                onChange={e => preview(e.target.value)}
                rows={8}
                placeholder={'name,email,phone,city,sms_opt_in,email_opt_in\nJane Doe,jane@example.com,403-555-0100,Calgary,false,true'}
                className="w-full bg-bg-tertiary border border-border-strong rounded-xl px-3.5 py-2.5 text-sm font-mono text-ink outline-none focus:border-accent"
              />
              {parseError && <p className="text-sm text-red-400">{parseError}</p>}
            </CardBody>
          </Card>

          {rows.length > 0 && (
            <Card>
              <CardBody className="space-y-3">
                <p className="text-sm font-semibold text-ink">{rows.length} customer{rows.length !== 1 ? 's' : ''} ready · {emailCount} email opt-in · {smsCount} SMS opt-in</p>
                <div className="max-h-48 overflow-auto rounded-lg border border-border divide-y divide-border">
                  {rows.slice(0, 25).map((r, i) => (
                    <div key={i} className="flex items-center gap-3 px-3 py-1.5 text-xs">
                      <span className="font-medium text-ink min-w-0 truncate flex-1">{r.name}</span>
                      <span className="text-ink-faint truncate">{r.email || r.phone || ''}</span>
                      {r.sms_opt_in && <span className="text-[10px] text-emerald-400">SMS</span>}
                      {r.email_opt_in && <span className="text-[10px] text-emerald-400">Email</span>}
                    </div>
                  ))}
                  {rows.length > 25 && <p className="px-3 py-1.5 text-[11px] text-ink-faint">…and {rows.length - 25} more</p>}
                </div>

                {smsCount > 0 && (
                  <label className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 cursor-pointer">
                    <input type="checkbox" checked={smsAck} onChange={e => setSmsAck(e.target.checked)} className="mt-0.5 w-4 h-4 accent-accent" />
                    <span className="text-xs text-ink-muted"><ShieldAlert className="w-3.5 h-3.5 text-amber-400 inline mr-1" />{SMS_CONSENT_WARNING}</span>
                  </label>
                )}

                <Button onClick={runImport} loading={importing} disabled={smsCount > 0 && !smsAck}>
                  Import {rows.length} customer{rows.length !== 1 ? 's' : ''}
                </Button>
              </CardBody>
            </Card>
          )}
        </>
      )}
    </div>
  )
}
