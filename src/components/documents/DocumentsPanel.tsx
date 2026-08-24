'use client'

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  DOCUMENT_CATEGORIES, PURPOSE_LABEL, PURPOSE_STATEMENT, VISIBILITY_HELP, VISIBILITY_LABEL,
  addVersion, cancelSignatureRequest, listDocuments, requestSignature, setArchived,
  setVisibility, signedDocumentUrl, sizeLabel,
  type DocumentEntity, type DocumentView, type DocumentVisibility, type SignaturePurpose,
} from '@/lib/documents'
import { uploadDocument } from '@/lib/documents'
import { formatDate } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { confirm as confirmDialog } from '@/lib/confirm'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Textarea } from '@/components/ui/Textarea'
import { Modal } from '@/components/ui/Modal'
import { InlineEmpty } from '@/components/ui/EmptyState'
import {
  Archive, ArchiveRestore, ExternalLink, Eye, FileText, Lock, PenLine, Upload, Users,
} from 'lucide-react'

// ── The owner's document surface ─────────────────────────────────────────────
//
// Attached to whichever record the page is about — a customer, a service
// location, a visit, a piece of equipment. Deliberately NOT a business-wide
// document browser: a file is found where the work is, which is also the only
// place its visibility means anything.
//
// ⭐ VISIBILITY IS THE LOUDEST CONTROL HERE. Every row states who can see it in
// words, because "internal" and "shared with the customer" differ by one click
// and by a great deal of consequence. New documents land on Internal.

const VIS_ICON: Record<DocumentVisibility, typeof Lock> = {
  internal: Lock, worker: Users, customer: Eye,
}

export function DocumentsPanel({ userId, entity, customerId, heading = 'Documents' }: {
  userId: string
  entity: DocumentEntity
  /** The customer this record resolves to, when there is one. Signature requests
   *  are offered only when a customer exists to ask — equipment has none. */
  customerId?: string | null
  heading?: string
}) {
  const supabase = useState(() => createClient())[0]
  const fileRef = useRef<HTMLInputElement>(null)
  const versionRef = useRef<HTMLInputElement>(null)

  const [docs, setDocs] = useState<DocumentView[] | null>(null)
  // ⭐ Distinct from "no documents". A failed read must never render as an empty
  // state — that is the false-all-clear this codebase has already been bitten by.
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const [pendingFile, setPendingFile] = useState<File | null>(null)
  const [versionFor, setVersionFor] = useState<DocumentView | null>(null)
  const [signFor, setSignFor] = useState<DocumentView | null>(null)

  const load = useCallback(async () => {
    try {
      setDocs(await listDocuments(supabase, userId, entity))
      setLoadError(null)
    } catch (e) {
      setDocs(null)
      setLoadError(e instanceof Error ? e.message : 'Could not load documents.')
    }
  }, [supabase, userId, entity.kind, entity.id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { void load() }, [load])

  async function open(d: DocumentView) {
    if (!d.current) { toast.error('That document has no file yet.'); return }
    const url = await signedDocumentUrl(supabase, d.current.storage_path)
    if (!url) { toast.error('Could not open that document — please try again.'); return }
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  async function changeVisibility(d: DocumentView, visibility: DocumentVisibility) {
    const res = await setVisibility(supabase, d.id, visibility)
    if (res.error) { toast.error(res.error); return }
    toast.success(VISIBILITY_LABEL[visibility] + '.')
    void load()
  }

  async function archive(d: DocumentView) {
    const restoring = !!d.archived_at
    if (!restoring) {
      const ok = await confirmDialog({
        title: `Archive ${d.name}?`,
        message: d.signature
          ? 'It leaves the customer portal and the crew phone. The signed record stays available to you — archiving is not deletion.'
          : 'It leaves the customer portal and the crew phone, and stays available to you here.',
        confirmLabel: 'Archive',
      })
      if (!ok) return
    }
    const res = await setArchived(supabase, d.id, !restoring)
    if (res.error) { toast.error(res.error); return }
    toast.success(restoring ? 'Document restored.' : 'Document archived.')
    void load()
  }

  function pick(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''            // let the same file be re-picked after a failure
    if (file) setPendingFile(file)
  }

  async function pickVersion(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    const target = versionFor
    setVersionFor(null)
    if (!file || !target) return
    setBusy(true)
    const res = await addVersion(supabase, { userId, documentId: target.id, file })
    setBusy(false)
    if (res.error) { toast.error(res.error); return }
    toast.success(`Version ${res.version?.version_no} uploaded.`)
    void load()
  }

  const visible = (docs ?? []).filter(d => showArchived || !d.archived_at)
  const archivedCount = (docs ?? []).filter(d => d.archived_at).length

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5 gap-2 flex-wrap">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint">{heading}</p>
        <div className="flex items-center gap-1.5">
          {archivedCount > 0 && (
            <Button size="sm" variant="ghost" onClick={() => setShowArchived(v => !v)}>
              {showArchived ? 'Hide archived' : `Archived (${archivedCount})`}
            </Button>
          )}
          <Button size="sm" variant="secondary" loading={busy} onClick={() => fileRef.current?.click()}>
            <Upload className="w-3.5 h-3.5" /> Add document
          </Button>
          <input ref={fileRef} type="file" hidden onChange={pick}
            accept="application/pdf,image/*,.doc,.docx,.xls,.xlsx,.txt" />
          <input ref={versionRef} type="file" hidden onChange={pickVersion}
            accept="application/pdf,image/*,.doc,.docx,.xls,.xlsx,.txt" />
        </div>
      </div>

      {loadError ? (
        // Says what is true: we could not look. Never "no documents".
        <div className="rounded-lg border border-border bg-surface px-3 py-2 text-xs text-ink-muted">
          Couldn&apos;t load documents. {loadError}{' '}
          <button type="button" onClick={() => void load()} className="text-accent-text hover:underline">Try again</button>
        </div>
      ) : docs === null ? (
        <div className="h-8 rounded-lg bg-surface animate-pulse" />
      ) : visible.length === 0 ? (
        <InlineEmpty className="py-2">
          No documents yet — attach the permit, warranty or work authorization so it&apos;s here when you need it.
        </InlineEmpty>
      ) : (
        <div className="space-y-1">
          {visible.map(d => (
            <DocumentRow
              key={d.id}
              d={d}
              entityKind={entity.kind}
              customerId={customerId ?? null}
              onOpen={() => void open(d)}
              onVisibility={v => void changeVisibility(d, v)}
              onArchive={() => void archive(d)}
              onNewVersion={() => { setVersionFor(d); versionRef.current?.click() }}
              onRequestSign={() => setSignFor(d)}
              onCancelRequest={async () => {
                const res = await cancelSignatureRequest(supabase, d.openRequest!.id)
                if (res.error) { toast.error(res.error); return }
                toast.success('Signature request cancelled.'); void load()
              }}
            />
          ))}
        </div>
      )}

      {pendingFile && (
        <UploadDialog
          file={pendingFile}
          entity={entity}
          onClose={() => setPendingFile(null)}
          onSave={async ({ name, category, visibility }) => {
            setBusy(true)
            const res = await uploadDocument(supabase, {
              userId, entity, file: pendingFile, name, category, visibility,
            })
            setBusy(false)
            if (res.error) { toast.error(res.error); return false }
            toast.success('Document attached.')
            setPendingFile(null)
            void load()
            return true
          }}
        />
      )}

      {signFor && customerId && (
        <SignatureRequestDialog
          doc={signFor}
          onClose={() => setSignFor(null)}
          onSave={async ({ statement, purpose }) => {
            const res = await requestSignature(supabase, {
              documentId: signFor.id,
              versionId: signFor.current!.id,
              customerId,
              statement, purpose, requestedBy: userId,
            })
            if (res.error) { toast.error(res.error); return false }
            toast.success('The customer will see this in their portal.')
            setSignFor(null)
            void load()
            return true
          }}
        />
      )}
    </div>
  )
}

// ── One document, as the owner sees it ───────────────────────────────────────
// Presentational: it holds no data access, so scripts/documents-harness.tsx can
// render the REAL row at 375/390/430 and measure it rather than a replica.
export function DocumentRow({
  d, entityKind, customerId,
  onOpen, onVisibility, onArchive, onNewVersion, onRequestSign, onCancelRequest,
}: {
  d: DocumentView
  entityKind: DocumentEntity['kind']
  customerId: string | null
  onOpen: () => void
  onVisibility: (v: DocumentVisibility) => void
  onArchive: () => void
  onNewVersion: () => void
  onRequestSign: () => void
  onCancelRequest: () => void
}) {
  const VisIcon = VIS_ICON[d.visibility]
  return (
    <div className="flex items-center gap-2 text-xs py-1.5 border-b border-border/50 last:border-0 flex-wrap">
      <FileText className="w-3 h-3 text-ink-faint shrink-0" />
      <button type="button" onClick={onOpen}
        className="tap-target-y text-left text-ink font-medium hover:text-accent-text truncate rounded max-w-[45%] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
        {d.name}
      </button>

      {d.current && d.current.version_no > 1 && (
        <span className="text-ink-faint shrink-0">v{d.current.version_no}</span>
      )}
      {d.category && <span className="text-ink-faint shrink-0 hidden sm:inline">{d.category}</span>}
      {d.current?.size_bytes ? (
        <span className="text-ink-faint shrink-0 hidden sm:inline">{sizeLabel(d.current.size_bytes)}</span>
      ) : null}

      {/* Signature state, in plain words. "Awaiting" is a real state a business
          chases, so it is never left implicit. */}
      {d.signature ? (
        <span className="shrink-0 text-emerald-400">
          Signed by {d.signature.signer_name} · {formatDate(d.signature.signed_at)}
        </span>
      ) : d.openRequest ? (
        <span className="shrink-0 text-amber-400">Awaiting signature</span>
      ) : null}

      {d.archived_at && <span className="shrink-0 text-ink-faint">Archived</span>}

      <div className="w-full sm:w-auto sm:ml-auto flex items-center gap-1.5 flex-wrap justify-end">
        {/* Visibility reads as a sentence, not a code. */}
        <Select
          value={d.visibility}
          onChange={e => onVisibility(e.target.value as DocumentVisibility)}
          aria-label={`Who can see ${d.name}`}
          className="h-8 py-0 text-xs tap-target-y min-w-0 max-w-[11rem]"
          options={(['internal', 'worker', 'customer'] as DocumentVisibility[])
            // The schema refuses these combinations, so the control never offers
            // them: a disabled-by-database option that looks available is a
            // promise the save will break.
            .filter(v => (v !== 'worker' || entityKind === 'job')
                      && (v !== 'customer' || entityKind !== 'equipment'))
            .map(v => ({ value: v, label: VISIBILITY_LABEL[v] }))}
        />
        <VisIcon className="w-3.5 h-3.5 text-ink-faint hidden sm:block" aria-hidden />

        {customerId && d.visibility === 'customer' && !d.signature && !d.openRequest && d.current && (
          <button type="button" onClick={onRequestSign} aria-label={`Request a signature on ${d.name}`}
            className="tap-target inline-flex items-center justify-center text-ink-faint hover:text-ink rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
            <PenLine className="w-3.5 h-3.5" />
          </button>
        )}
        {d.openRequest && (
          <Button size="sm" variant="ghost" onClick={onCancelRequest}>Cancel request</Button>
        )}

        <button type="button" onClick={onNewVersion}
          aria-label={`Upload a new version of ${d.name}`}
          title={d.frozen ? 'Signed — a replacement is added as a new version' : 'Upload a new version'}
          className="tap-target inline-flex items-center justify-center text-ink-faint hover:text-ink rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
          <Upload className="w-3.5 h-3.5" />
        </button>
        <button type="button" onClick={onOpen} aria-label={`Open ${d.name}`}
          className="tap-target inline-flex items-center justify-center text-ink-faint hover:text-ink rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
          <ExternalLink className="w-3.5 h-3.5" />
        </button>
        <button type="button" onClick={onArchive}
          aria-label={d.archived_at ? `Restore ${d.name}` : `Archive ${d.name}`}
          className="tap-target inline-flex items-center justify-center text-ink-faint hover:text-ink rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
          {d.archived_at ? <ArchiveRestore className="w-3.5 h-3.5" /> : <Archive className="w-3.5 h-3.5" />}
        </button>
      </div>
    </div>
  )
}

// ── Attaching ────────────────────────────────────────────────────────────────

/** Exported so scripts/documents-harness.tsx can measure the REAL dialog at
 *  phone widths rather than a replica of it. */
export function UploadDialog({ file, entity, onClose, onSave }: {
  file: File
  entity: DocumentEntity
  onClose: () => void
  onSave: (v: { name: string; category: string | null; visibility: DocumentVisibility }) => Promise<boolean>
}) {
  const [name, setName] = useState(file.name.replace(/\.[^.]+$/, ''))
  const [category, setCategory] = useState<string>('')
  // ⭐ DEFAULT SAFE. The dialog opens on Internal every time, and sharing is a
  // deliberate act rather than the path of least resistance.
  const [visibility, setVisibility] = useState<DocumentVisibility>('internal')
  const [saving, setSaving] = useState(false)

  const choices = (['internal', 'worker', 'customer'] as DocumentVisibility[])
    .filter(v => (v !== 'worker' || entity.kind === 'job') && (v !== 'customer' || entity.kind !== 'equipment'))

  async function submit() {
    setSaving(true)
    const ok = await onSave({ name, category: category || null, visibility })
    setSaving(false)
    if (ok) onClose()
  }

  return (
    <Modal open onClose={onClose} title="Attach document" icon={Upload} size="md" onSubmit={submit}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} loading={saving} disabled={!name.trim()}>Attach</Button>
        </>
      }>
      <div className="space-y-3">
        <p className="text-xs text-ink-muted flex items-center gap-1.5">
          <FileText className="w-3.5 h-3.5 shrink-0" />
          {file.name} · {sizeLabel(file.size)}
        </p>
        <Input label="Name" value={name} onChange={e => setName(e.target.value)} maxLength={200} />
        <Select label="Type" value={category} onChange={e => setCategory(e.target.value)}
          options={[{ value: '', label: 'No type' }, ...DOCUMENT_CATEGORIES.map(c => ({ value: c, label: c }))]} />
        <div>
          <Select label="Who can see it" value={visibility}
            onChange={e => setVisibility(e.target.value as DocumentVisibility)}
            options={choices.map(v => ({ value: v, label: VISIBILITY_LABEL[v] }))} />
          <p className="mt-1 text-[11px] text-ink-faint">{VISIBILITY_HELP[visibility]}</p>
        </div>
      </div>
    </Modal>
  )
}

// ── Asking for a signature ───────────────────────────────────────────────────

/** Exported for the phone harness — see UploadDialog. */
export function SignatureRequestDialog({ doc, onClose, onSave }: {
  doc: DocumentView
  onClose: () => void
  onSave: (v: { statement: string; purpose: SignaturePurpose }) => Promise<boolean>
}) {
  const [purpose, setPurpose] = useState<SignaturePurpose>('work_authorization')
  const [statement, setStatement] = useState(PURPOSE_STATEMENT.work_authorization)
  // True once the owner edits the wording — after that, changing the purpose
  // must not silently overwrite what they wrote.
  const [touched, setTouched] = useState(false)
  const [saving, setSaving] = useState(false)

  function changePurpose(p: SignaturePurpose) {
    setPurpose(p)
    if (!touched) setStatement(PURPOSE_STATEMENT[p])
  }

  async function submit() {
    setSaving(true)
    const ok = await onSave({ statement, purpose })
    setSaving(false)
    if (ok) onClose()
  }

  return (
    <Modal open onClose={onClose} title="Request a signature" icon={PenLine} size="md" onSubmit={submit}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} loading={saving} disabled={statement.trim().length < 10}>
            Request signature
          </Button>
        </>
      }>
      <div className="space-y-3">
        <p className="text-xs text-ink-muted">
          The customer signs <span className="text-ink font-medium">{doc.name}</span>
          {doc.current ? ` (version ${doc.current.version_no})` : ''} in their portal.
        </p>
        <Select label="What are they agreeing to?" value={purpose}
          onChange={e => changePurpose(e.target.value as SignaturePurpose)}
          options={(Object.keys(PURPOSE_LABEL) as SignaturePurpose[])
            .map(p => ({ value: p, label: PURPOSE_LABEL[p] }))} />
        <Textarea label="Statement" value={statement} rows={3} maxLength={1000}
          onChange={e => { setStatement(e.target.value); setTouched(true) }}
          hint="Shown above the signature box, word for word. This is what the signature means." />
        <p className="text-[11px] text-ink-faint">
          {/* Honest about what this is. The product must never imply more. */}
          This records an acknowledgement — who signed, when, and the exact version they
          agreed to. It is not a certified or qualified electronic signature.
        </p>
        <p className="text-[11px] text-ink-faint">
          If you upload a new version before they sign, the request stops applying and you&apos;ll
          need to ask again — nobody is recorded as agreeing to a file they never saw.
        </p>
      </div>
    </Modal>
  )
}
