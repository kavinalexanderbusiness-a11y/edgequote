// ── Documents measurement harness (investigation tool, not a guard) ──────────
// Renders the Session-74 surfaces to static markup — the REAL DocumentRow, the
// REAL upload / signature-request / signing dialogs, the REAL portal list and
// the REAL crew affordance — wrapped in the compiled Tailwind CSS so headless
// Chrome can lay them out and measure (prove-documents-mobile.mjs).
//
// Credential-free, the same posture as dayactions-harness: this machine cannot
// mint a dashboard session, so the component tree is measured directly rather
// than by driving a signed-in browser.
//
// Usage: npx tsx --tsconfig tsconfig.harness.json scripts/documents-harness.tsx <outdir>

// Components construct a supabase browser client during render — give them the
// same placeholders CI builds with, before the import graph loads.
process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'https://placeholder.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'placeholder-anon-key-for-build-only'

import { renderToStaticMarkup } from 'react-dom/server'
import { writeFileSync, readdirSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { DocumentRow, UploadDialog, SignatureRequestDialog } from '../src/components/documents/DocumentsPanel'
import { DocumentsTab, SignDialog, type PortalDocument } from '../src/app/portal/[token]/components/DocumentsTab'
import { CrewStopDocuments } from '../src/components/crew/CrewStopDocuments'
import { SignaturePad } from '../src/components/documents/SignaturePad'
import type { DocumentView } from '../src/lib/documents'

const outdir = process.argv[2] || '.documents-harness'
mkdirSync(outdir, { recursive: true })

const cssDir = '.next/static/css'
const css = readdirSync(cssDir).filter(f => f.endsWith('.css'))
  .map(f => readFileSync(join(cssDir, f), 'utf8')).join('\n')

const noop = () => undefined

// Deliberately unkind fixtures: a long document name and a long signer name are
// what actually break a 375px row, not "Permit.pdf".
const version = (n: number, file: string) => ({
  id: 'v' + n, document_id: 'd', version_no: n, storage_path: 'u/d/x.pdf',
  file_name: file, mime: 'application/pdf', size_bytes: 248311,
  uploaded_by: 'u', uploaded_at: '2026-08-20T10:00:00Z', replaced_note: null,
})

const base = {
  user_id: 'u', customer_id: 'c', property_id: null, job_id: null, equipment_id: null,
  archived_at: null, created_at: '2026-08-20T10:00:00Z',
}

const rows = [
  {
    ...base, id: 'd1', name: 'Development permit — 1841 Constantinopoulos Crescent SW', category: 'Permit',
    visibility: 'internal', current: version(1, 'permit.pdf'), signature: null, openRequest: null, frozen: false,
  },
  {
    ...base, id: 'd2', name: 'Work authorization', category: 'Work authorization',
    visibility: 'customer', current: version(2, 'authorization-v2.pdf'),
    signature: null,
    openRequest: {
      id: 'r1', document_id: 'd2', version_id: 'v2', customer_id: 'c',
      statement: 'I authorize the work described in this document.',
      purpose: 'work_authorization', requested_at: '2026-08-21T09:00:00Z', cancelled_at: null,
    },
    frozen: false,
  },
  {
    ...base, id: 'd3', name: 'Completion acknowledgement', category: 'Completion acknowledgement',
    visibility: 'customer', current: version(1, 'completion.pdf'),
    signature: {
      id: 's1', document_id: 'd3', request_id: 'r0', version_id: 'v1', customer_id: 'c',
      signer_name: 'Alexandra Constantinopoulos', statement: 'I confirm the work is complete.',
      purpose: 'completion_acknowledgement', source: 'portal', signed_at: '2026-08-22T14:05:00Z',
    },
    openRequest: null, frozen: true,
  },
  {
    ...base, id: 'd4', name: 'Superseded inspection report', category: 'Inspection report',
    visibility: 'internal', archived_at: '2026-08-22T15:00:00Z',
    current: version(3, 'inspection-v3.pdf'), signature: null, openRequest: null, frozen: false,
  },
] as unknown as DocumentView[]

const portalDocs: PortalDocument[] = [
  {
    id: 'd2', name: 'Work authorization — 1841 Constantinopoulos Crescent SW', category: 'Work authorization',
    created_at: '2026-08-21T09:00:00Z', version_id: 'v2', version_no: 2, file_name: 'authorization-v2.pdf',
    mime: 'application/pdf', size_bytes: 248311, request_id: 'r1',
    signature_statement: 'I authorize the work described in this document to be carried out at my property.',
    signature_purpose: 'work_authorization', signature_state: 'awaiting_signature',
    signed_at: null, signer_name: null,
  },
  {
    id: 'd3', name: 'Completion acknowledgement', category: 'Completion acknowledgement',
    created_at: '2026-08-22T14:00:00Z', version_id: 'v1', version_no: 1, file_name: 'completion.pdf',
    mime: 'application/pdf', size_bytes: 91002, request_id: 'r0',
    signature_statement: 'I confirm the work is complete.', signature_purpose: 'completion_acknowledgement',
    signature_state: 'signed', signed_at: '2026-08-22T14:05:00Z', signer_name: 'Alexandra Constantinopoulos',
  },
]

const card = (children: React.ReactNode) => (
  <main className="max-w-md mx-auto p-4">
    <div className="rounded-lg border border-border bg-surface p-3">{children}</div>
  </main>
)

const scenarios: Record<string, React.ReactElement> = {
  // The owner's list on a phone: four rows covering every state the row can be
  // in — internal, awaiting signature, signed/frozen, archived.
  'owner-rows': card(
    <div className="space-y-1">
      {rows.map(d => (
        <DocumentRow key={d.id} d={d} entityKind="job" customerId="c"
          onOpen={noop} onVisibility={noop} onArchive={noop}
          onNewVersion={noop} onRequestSign={noop} onCancelRequest={noop} />
      ))}
    </div>,
  ),
  'owner-upload': (
    <UploadDialog
      file={{ name: 'development-permit-1841-constantinopoulos.pdf', size: 248311, type: 'application/pdf' } as File}
      entity={{ kind: 'job', id: 'j1' }} onClose={noop} onSave={async () => true} />
  ),
  'owner-signature-request': (
    <SignatureRequestDialog doc={rows[1]} onClose={noop} onSave={async () => true} />
  ),
  'portal-documents': (
    <main className="max-w-lg mx-auto p-4">
      <DocumentsTab token="tok" documents={portalDocs} onSigned={noop} />
    </main>
  ),
  // The signing sheet — the statement, the name field, and the pad, which is the
  // one control on this phone a customer must actually be able to draw in.
  'portal-sign': <SignDialog token="tok" doc={portalDocs[0]} onClose={noop} onDone={noop} />,
  'signature-pad': card(<SignaturePad onChange={noop} />),
  'crew-documents': (
    <main className="max-w-md mx-auto p-4">
      <div className="rounded-lg border border-border bg-bg-secondary p-2.5">
        <CrewStopDocuments jobId="j1" count={2} />
      </div>
    </main>
  ),
}

const wrap = (body: string) => `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${css}</style>
<style>body{margin:0}</style>
</head><body class="bg-bg text-ink">${body}</body></html>`

for (const [name, el] of Object.entries(scenarios)) {
  const html = wrap(renderToStaticMarkup(el))
  writeFileSync(join(outdir, `${name}.html`), html)
  console.log(`${name}.html  ${(html.length / 1024).toFixed(0)} kB`)
}
