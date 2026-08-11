'use client'

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Card, CardHeader, CardBody } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Banner } from '@/components/ui/Banner'
import { EXPORT_ENTITIES } from '@/lib/export/manifest'
import { timeAgo } from '@/lib/utils'
import { Download, Check, AlertTriangle, Loader2, FileArchive } from 'lucide-react'

// ── Take your data with you ──────────────────────────────────────────────────
// The whole point of this card is that it never lies about where it is up to.
//
// THE RULE: nothing says "ready" until the bytes exist. The request is awaited
// in full, the response is turned into a Blob, and only THEN is a download
// triggered — so "Preparing" covers the entire time the server is reading, and
// the success line quotes the row count the archive actually contains, read back
// off the finished file's own headers rather than from an optimistic guess.
//
// A failure is a stated sentence plus a button that tries the same thing again;
// there is no half-state where a partial file has landed in Downloads.

interface LastExport {
  created_at: string
  total_rows: number
  bytes: number
}

type Phase =
  | { s: 'idle' }
  | { s: 'working' }
  | { s: 'done'; filename: string; rows: number; bytes: number }
  | { s: 'error'; message: string }

function prettyBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

export function DataExport() {
  const [supabase] = useState(() => createClient())
  const [phase, setPhase] = useState<Phase>({ s: 'idle' })
  const [last, setLast] = useState<LastExport | null>(null)

  const loadLast = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession()
    const uid = session?.user?.id
    if (!uid) return
    const { data } = await supabase
      .from('data_exports')
      .select('created_at, total_rows, bytes')
      .eq('user_id', uid)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    setLast((data as LastExport) ?? null)
  }, [supabase])

  useEffect(() => { void loadLast() }, [loadLast])

  async function runExport() {
    setPhase({ s: 'working' })
    try {
      const res = await fetch('/api/export', { method: 'POST' })

      if (!res.ok) {
        // The server sends a sentence explaining what happened. Prefer it over
        // anything invented here; fall back only if the body isn't readable.
        let message = 'The export could not be built. Nothing was downloaded.'
        try {
          const body = await res.json()
          if (typeof body?.error === 'string' && body.error) message = body.error
        } catch { /* non-JSON error body — keep the fallback */ }
        setPhase({ s: 'error', message })
        return
      }

      // Await the WHOLE body. Until this resolves there is no file, and the card
      // still says "Preparing".
      const blob = await res.blob()
      const disposition = res.headers.get('Content-Disposition') || ''
      const filename = /filename="([^"]+)"/.exec(disposition)?.[1] || 'edgequote-export.zip'
      const rows = Number(res.headers.get('X-Export-Rows') || 0)

      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 10000)

      setPhase({ s: 'done', filename, rows, bytes: blob.size })
      void loadLast()
    } catch {
      // A dropped connection mid-download lands here. The browser may have kept a
      // partial file, so say so rather than claim success.
      setPhase({
        s: 'error',
        message: 'The download did not finish — the connection dropped before the file was complete. Any partly-downloaded file is not usable. Please try again.',
      })
    }
  }

  const working = phase.s === 'working'

  return (
    <Card>
      <CardHeader>
        <h2 className="text-sm font-semibold text-ink flex items-center gap-2">
          <FileArchive className="w-4 h-4 text-accent-text" /> Your data
        </h2>
      </CardHeader>
      <CardBody className="space-y-4">
        <div className="text-sm text-ink-muted space-y-2">
          <p>
            Download your customers, quotes, visits, invoices and payments as
            spreadsheet files in a single .zip. It is yours — for your records, an
            accountant, or moving to something else.
          </p>
          <p>
            Every file opens in Excel, Numbers or Google Sheets, and a README
            inside explains what each column means.
          </p>
        </div>

        <div className="rounded-card border border-border bg-surface-raised px-4 py-3">
          <p className="text-xs font-medium text-ink mb-2">
            {EXPORT_ENTITIES.length} files, including
          </p>
          <p className="text-xs text-ink-muted leading-relaxed">
            {EXPORT_ENTITIES.map(e => e.label).join(' · ')}
          </p>
          <p className="text-xs text-ink-faint mt-2">
            Photos, receipts and documents are not included — only their details.
            Customer portal links, card processor references and API keys are
            never exported.
          </p>
        </div>

        {phase.s === 'error' && (
          <Banner tone="danger" icon={AlertTriangle}>{phase.message}</Banner>
        )}

        {phase.s === 'done' && (
          <Banner tone="success" icon={Check}>
            Downloaded <span className="font-medium">{phase.filename}</span>
            {phase.rows > 0 && <> — {phase.rows.toLocaleString('en-CA')} records</>}
            {' '}({prettyBytes(phase.bytes)}).
          </Banner>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={runExport} disabled={working}>
            {working
              ? <><Loader2 className="w-4 h-4 animate-spin" /> Preparing your export…</>
              : <><Download className="w-4 h-4" /> {phase.s === 'error' ? 'Try again' : 'Export my data'}</>}
          </Button>
          {working && (
            <span className="text-xs text-ink-muted">
              Reading your records. The download starts on its own when the file is ready.
            </span>
          )}
          {!working && last && (
            <span className="text-xs text-ink-faint">
              Last export {timeAgo(last.created_at)} — {last.total_rows.toLocaleString('en-CA')} records, {prettyBytes(last.bytes)}
            </span>
          )}
        </div>
      </CardBody>
    </Card>
  )
}
