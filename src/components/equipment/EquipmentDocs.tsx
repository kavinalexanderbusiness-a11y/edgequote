'use client'

import { useRef, useState, type ChangeEvent } from 'react'
import { createClient } from '@/lib/supabase/client'
import { DOC_KINDS, docKindLabel, fileSize, type DocKind, type EquipmentDoc } from '@/lib/equipment'
import { uploadEquipmentDoc, signedDocUrl, deleteEquipmentDoc } from '@/lib/equipmentDocs'
import { formatDate } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { confirm as confirmDialog } from '@/lib/confirm'
import { Button } from '@/components/ui/Button'
import { Select } from '@/components/ui/Select'
import { InlineEmpty } from '@/components/ui/EmptyState'
import { FileText, Upload, Trash2, ExternalLink } from 'lucide-react'

// The paperwork that proves what the machine's record claims: the warranty
// certificate behind "under warranty", the receipt behind the purchase price.
// Private bucket → every open mints a fresh short-lived signed URL through the
// shared storage helper; this component never touches a path itself.
const MAX_MB = 15

export function EquipmentDocs({ userId, equipmentId, docs, onChanged }: {
  userId: string
  equipmentId: string
  docs: EquipmentDoc[]
  onChanged: () => void
}) {
  const supabase = useState(() => createClient())[0]
  const fileRef = useRef<HTMLInputElement>(null)
  const [kind, setKind] = useState<DocKind>('receipt')
  const [busy, setBusy] = useState(false)
  const [openingId, setOpeningId] = useState<string | null>(null)

  async function pick(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || [])
    e.target.value = ''   // let the same file be re-picked after a failure
    if (!files.length) return
    setBusy(true)
    let ok = 0
    for (const file of files) {
      if (file.size > MAX_MB * 1024 * 1024) {
        toast.error(`${file.name} is over ${MAX_MB} MB — upload a smaller scan or photo.`)
        continue
      }
      const res = await uploadEquipmentDoc(supabase, { userId, equipmentId, file, kind })
      if (res.error) toast.error(`Could not upload ${file.name}: ${res.error}`)
      else ok++
    }
    setBusy(false)
    if (ok) { toast.success(`${ok} document${ok !== 1 ? 's' : ''} attached.`); onChanged() }
  }

  async function open(doc: EquipmentDoc) {
    setOpeningId(doc.id)
    const url = await signedDocUrl(supabase, doc)
    setOpeningId(null)
    if (!url) { toast.error('Could not open that document — please try again.'); return }
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  async function remove(doc: EquipmentDoc) {
    const ok = await confirmDialog({
      title: `Delete ${doc.name}?`,
      message: 'The file is removed from storage as well. This cannot be undone.',
      confirmLabel: 'Delete document', destructive: true,
    })
    if (!ok) return
    const res = await deleteEquipmentDoc(supabase, doc)
    if (res.error) { toast.error('Could not delete it: ' + res.error); return }
    toast.success('Document deleted.')
    onChanged()
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5 gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint">Documents</p>
        <div className="flex items-center gap-1.5">
          <Select value={kind} onChange={e => setKind(e.target.value as DocKind)} aria-label="Document type"
            options={DOC_KINDS.map(d => ({ value: d.value, label: d.label }))} className="h-8 py-0 text-xs" />
          <Button size="sm" variant="secondary" loading={busy} onClick={() => fileRef.current?.click()}>
            <Upload className="w-3.5 h-3.5" /> Attach
          </Button>
          <input ref={fileRef} type="file" multiple hidden onChange={pick}
            accept="image/*,application/pdf,.doc,.docx,.txt" />
        </div>
      </div>

      {docs.length === 0 ? (
        <InlineEmpty className="py-2">No paperwork yet — attach the receipt, warranty certificate or manual so it's here when you need it.</InlineEmpty>
      ) : (
        <div className="space-y-1">
          {docs.map(d => (
            <div key={d.id} className="flex items-center gap-2 text-xs py-1 border-b border-border/50 last:border-0">
              <FileText className="w-3 h-3 text-ink-faint shrink-0" />
              <button type="button" onClick={() => open(d)} disabled={openingId === d.id}
                className="text-ink font-medium hover:text-accent-text truncate rounded disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                {d.name}
              </button>
              <span className="text-ink-faint shrink-0">{docKindLabel(d.kind)}</span>
              {d.size_bytes ? <span className="text-ink-faint shrink-0 hidden sm:inline">{fileSize(d.size_bytes)}</span> : null}
              <span className="text-ink-faint ml-auto shrink-0">{formatDate(d.created_at)}</span>
              <button type="button" onClick={() => open(d)} aria-label={`Open ${d.name}`}
                className="shrink-0 text-ink-faint hover:text-ink rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                <ExternalLink className="w-3.5 h-3.5" />
              </button>
              <button type="button" onClick={() => remove(d)} aria-label={`Delete ${d.name}`}
                className="shrink-0 text-ink-faint hover:text-red-400 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
