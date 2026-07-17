import type { SupabaseClient } from '@supabase/supabase-js'

// ── Receipt storage ──────────────────────────────────────────────────────────
// The ONE place that knows the bucket, the path shape and how a private receipt
// is read. Components call these; they never build a path or mint a URL, so the
// owner-scoped folder rule (…/<user_id>/…) the storage policies enforce cannot be
// broken from a component by accident. Modelled exactly on lib/equipmentDocs.ts —
// same mechanism, same policy shape, same rollback discipline.
//
// WHY A DEDICATED BUCKET rather than reusing equipment-docs: the path IS the
// access rule and the retention story. Receipts are tax records with a 6-year CRA
// retention expectation; equipment docs are manuals and warranties. Filing one in
// the other's bucket means any future lifecycle rule, export or purge on either
// silently catches the other. This is not a second upload system — it's the same
// helper shape over a bucket whose name tells the truth about what's in it.
//
// It stays PRIVATE. A receipt carries what the business bought, where and when;
// a public URL would make that guessable. Reads go through short-lived signed URLs.

export const EXPENSE_RECEIPTS_BUCKET = 'expense-receipts'

/** 10 MB — a phone photo of a receipt is ~2–4 MB; a scanned PDF far less. */
export const MAX_RECEIPT_BYTES = 10 * 1024 * 1024

export const RECEIPT_ACCEPT = 'image/jpeg,image/png,image/heic,image/webp,application/pdf'

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/heic', 'image/webp', 'application/pdf'])

/** …/<user_id>/<expense_id>/<random>-<safe name> — the shape the policies expect. */
function receiptPath(userId: string, expenseId: string, fileName: string): string {
  const safe = fileName.replace(/[^a-zA-Z0-9.\-_]/g, '_').slice(-80)
  return `${userId}/${expenseId}/${crypto.randomUUID()}-${safe}`
}

export function validateReceipt(file: File): string | null {
  if (file.size > MAX_RECEIPT_BYTES) return 'That file is over 10 MB — try a photo instead of a scan.'
  // Some browsers report an empty type for HEIC; fall back to the extension rather
  // than refusing a receipt the owner can plainly see.
  const type = file.type || guessType(file.name)
  if (!ALLOWED_MIME.has(type)) return 'Attach a photo (JPG, PNG, HEIC, WebP) or a PDF.'
  return null
}

/**
 * Upload a receipt for an expense that ALREADY EXISTS, returning its path.
 *
 * The ordering matters: the expense row is written first, then the receipt is
 * attached. Money that left the business is the fact worth keeping — if the upload
 * fails on bad signal in a parking lot, the owner has the expense and can attach
 * the photo later, rather than losing both to a failed multipart POST.
 */
export async function uploadReceipt(
  sb: SupabaseClient,
  opts: { userId: string; expenseId: string; file: File },
): Promise<{ path?: string; error?: string }> {
  const invalid = validateReceipt(opts.file)
  if (invalid) return { error: invalid }
  const path = receiptPath(opts.userId, opts.expenseId, opts.file.name)
  const { error } = await sb.storage
    .from(EXPENSE_RECEIPTS_BUCKET)
    .upload(path, opts.file, { upsert: false, contentType: opts.file.type || guessType(opts.file.name) })
  if (error) return { error: error.message }
  return { path }
}

/**
 * Attach a receipt to an expense: upload, point the row at it, and only then drop
 * the old object.
 *
 * Order is deliberate. If the row update fails we remove the NEW object (no orphan)
 * and the old receipt is still attached — a failed replace leaves the owner exactly
 * where they started, never with an expense pointing at nothing.
 */
export async function replaceReceipt(
  sb: SupabaseClient,
  opts: { userId: string; expenseId: string; file: File; previousPath?: string | null },
): Promise<{ path?: string; error?: string }> {
  const up = await uploadReceipt(sb, opts)
  if (up.error || !up.path) return { error: up.error }

  const { error } = await sb.from('expenses').update({ receipt_path: up.path }).eq('id', opts.expenseId)
  if (error) {
    await sb.storage.from(EXPENSE_RECEIPTS_BUCKET).remove([up.path])
    return { error: error.message }
  }
  if (opts.previousPath && opts.previousPath !== up.path) {
    await sb.storage.from(EXPENSE_RECEIPTS_BUCKET).remove([opts.previousPath])
  }
  return { path: up.path }
}

/**
 * Detach and delete a receipt. Clears the column FIRST: an expense pointing at a
 * missing object renders a broken receipt forever, whereas an object with no row
 * pointing at it is only reachable by someone holding a signed URL that has since
 * expired. If the object delete fails, the books are still consistent.
 */
export async function removeReceipt(
  sb: SupabaseClient,
  opts: { expenseId: string; path: string },
): Promise<{ error?: string }> {
  const { error } = await sb.from('expenses').update({ receipt_path: null }).eq('id', opts.expenseId)
  if (error) return { error: error.message }
  await sb.storage.from(EXPENSE_RECEIPTS_BUCKET).remove([opts.path])
  return {}
}

/** Short-lived signed URL — the bucket is private, so this is the only way in. */
export async function signedReceiptUrl(
  sb: SupabaseClient,
  path: string,
  seconds = 60,
): Promise<string | null> {
  const { data } = await sb.storage.from(EXPENSE_RECEIPTS_BUCKET).createSignedUrl(path, seconds)
  return data?.signedUrl ?? null
}

export function isPdfReceipt(path: string): boolean {
  return path.toLowerCase().endsWith('.pdf')
}

function guessType(name: string): string {
  const ext = name.toLowerCase().split('.').pop() || ''
  if (ext === 'pdf') return 'application/pdf'
  if (ext === 'png') return 'image/png'
  if (ext === 'heic') return 'image/heic'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  return ''
}
