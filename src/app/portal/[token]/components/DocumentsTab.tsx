'use client'

import { useState } from 'react'
import { Download, FileText, Loader2, PenLine, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { SignaturePad } from '@/components/documents/SignaturePad'
import { sizeLabel } from '@/lib/documents'
import { formatDate } from '@/lib/utils'

// ── The customer's documents ─────────────────────────────────────────────────
//
// Only what the business deliberately shared: portal_get_documents returns
// customer-visibility, non-archived documents that resolve to THIS token's
// customer. There is no internal paperwork on this screen because there is no
// query on this screen that could reach any.
//
// The tab itself does not exist when the list is empty — an empty "Documents"
// pill on a homeowner's phone is a promise of something that was never sent.

/** Exactly the shape portal_get_documents projects. No storage path is in it,
 *  and the signature image is never projected at all. */
export interface PortalDocument {
  id: string
  name: string
  category: string | null
  created_at: string
  version_id: string
  version_no: number
  file_name: string
  mime: string | null
  size_bytes: number | null
  request_id: string | null
  signature_statement: string | null
  signature_purpose: string | null
  signature_state: 'signed' | 'awaiting_signature' | null
  signed_at: string | null
  signer_name: string | null
}

export function DocumentsTab({ token, documents, onSigned }: {
  token: string
  documents: PortalDocument[]
  onSigned: () => void
}) {
  const [signing, setSigning] = useState<PortalDocument | null>(null)

  const toSign = documents.filter(d => d.signature_state === 'awaiting_signature')

  return (
    <div className="space-y-3">
      {toSign.length > 0 && (
        <div className="rounded-card border border-amber-500/25 bg-amber-500/10 px-4 py-3">
          <p className="text-sm font-medium text-ink">
            {toSign.length === 1 ? 'One document needs your signature' : `${toSign.length} documents need your signature`}
          </p>
          <p className="text-xs text-ink-muted mt-0.5">Read it, then sign at the bottom.</p>
        </div>
      )}

      <div className="rounded-card border border-border bg-surface divide-y divide-border/60">
        {documents.map(d => (
          <div key={d.id} className="px-4 py-3">
            <div className="flex items-start gap-2.5">
              <FileText className="w-4 h-4 text-ink-faint shrink-0 mt-0.5" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-ink break-words">{d.name}</p>
                <p className="text-xs text-ink-faint mt-0.5">
                  {[d.category, sizeLabel(d.size_bytes), formatDate(d.created_at)].filter(Boolean).join(' · ')}
                  {d.version_no > 1 ? ` · version ${d.version_no}` : ''}
                </p>

                {d.signature_state === 'signed' && (
                  <p className="text-xs text-emerald-400 mt-1 flex items-center gap-1.5">
                    <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
                    Signed by {d.signer_name}{d.signed_at ? ` on ${formatDate(d.signed_at)}` : ''}
                  </p>
                )}
              </div>
            </div>

            {/* Stacked on a phone, inline from 400px — two 44px targets side by
                side do not fit at 375px without one of them being cramped. */}
            <div className="flex flex-col min-[400px]:flex-row gap-2 mt-2.5">
              <Button variant="secondary" size="md" className="min-[400px]:w-auto w-full"
                onClick={() => {
                  // A plain navigation: the route authorizes the token, then
                  // redirects to a short-lived signed URL. No storage path,
                  // bucket name or tenant id is ever in the client's hands.
                  window.location.href =
                    `/api/portal/documents/file?token=${encodeURIComponent(token)}&document=${encodeURIComponent(d.id)}`
                }}>
                <Download className="w-4 h-4" /> Download
              </Button>
              {d.signature_state === 'awaiting_signature' && (
                <Button size="md" className="min-[400px]:w-auto w-full" onClick={() => setSigning(d)}>
                  <PenLine className="w-4 h-4" /> Review &amp; sign
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>

      {signing && (
        <SignDialog token={token} doc={signing}
          onClose={() => setSigning(null)}
          onDone={() => { setSigning(null); onSigned() }} />
      )}
    </div>
  )
}

// ── Signing ──────────────────────────────────────────────────────────────────

function SignDialog({ token, doc, onClose, onDone }: {
  token: string
  doc: PortalDocument
  onClose: () => void
  onDone: () => void
}) {
  const [name, setName] = useState('')
  const [mark, setMark] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Both are required. A typed name without a mark is a form field; a mark
  // without a name is anonymous. The acknowledgement needs a person attached.
  const ready = name.trim().length > 0 && !!mark

  async function submit() {
    if (!ready || busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/portal/documents/sign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, documentId: doc.id, signerName: name.trim(), signature: mark }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok || !body.ok) {
        setError(body.error || "We couldn't record that. Please try again.")
        setBusy(false)
        return
      }
      onDone()
    } catch {
      setError("We couldn't reach the server. Please try again.")
      setBusy(false)
    }
  }

  return (
    <Modal open onClose={onClose} title={doc.name} icon={PenLine} size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={!ready} loading={busy}>
            {busy ? 'Recording…' : 'Sign'}
          </Button>
        </>
      }>
      <div className="space-y-3">
        <Button variant="secondary" size="md" className="w-full"
          onClick={() => window.open(
            `/api/portal/documents/file?token=${encodeURIComponent(token)}&document=${encodeURIComponent(doc.id)}`,
            '_blank', 'noopener,noreferrer')}>
          <Download className="w-4 h-4" /> Read the document first
        </Button>

        {/* ⭐ THE STATEMENT IS THE SIGNATURE'S MEANING. It is shown verbatim,
            above the pad, and it is the same text stored on the signature — so
            what the customer read and what the record says are one string. */}
        {doc.signature_statement && (
          <div className="rounded-lg border border-border bg-bg-secondary px-3 py-2.5">
            <p className="text-sm text-ink">{doc.signature_statement}</p>
          </div>
        )}

        <Input label="Your full name" value={name} onChange={e => setName(e.target.value)}
          maxLength={120} autoComplete="name" placeholder="Type your name" />

        <SignaturePad onChange={setMark} disabled={busy} />

        {error && <p className="text-xs text-red-400">{error}</p>}

        <p className="text-[11px] text-ink-faint">
          {/* Says exactly what is recorded, and claims nothing more. */}
          Signing records your name, the date and time, and the exact version of this
          document you agreed to. It is an acknowledgement, not a certified electronic
          signature.
        </p>
        {busy && (
          <p className="text-xs text-ink-muted flex items-center gap-1.5">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Recording your signature…
          </p>
        )}
      </div>
    </Modal>
  )
}
