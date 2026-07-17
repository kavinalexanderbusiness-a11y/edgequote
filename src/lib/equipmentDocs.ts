import type { SupabaseClient } from '@supabase/supabase-js'
import { EQUIPMENT_DOCS_BUCKET, type DocKind, type EquipmentDoc } from '@/lib/equipment'

// ── Equipment document storage ───────────────────────────────────────────────
// The ONE place that knows the bucket, the path shape and how a private file is
// read. Components call these — they never build a path or mint a URL, so the
// owner-scoped folder rule (…/<user_id>/…) that the storage policies enforce
// can't be broken from a component by accident.

/** …/<user_id>/<equipment_id>/<random>-<safe name> — the shape the policies expect. */
function docPath(userId: string, equipmentId: string, fileName: string): string {
  const safe = fileName.replace(/[^a-zA-Z0-9.\-_]/g, '_').slice(-80)
  return `${userId}/${equipmentId}/${crypto.randomUUID()}-${safe}`
}

export async function listEquipmentDocs(sb: SupabaseClient, userId: string): Promise<EquipmentDoc[]> {
  const { data } = await sb.from('equipment_docs').select('*').eq('user_id', userId).order('created_at', { ascending: false })
  return (data as EquipmentDoc[]) || []
}

export async function uploadEquipmentDoc(
  sb: SupabaseClient,
  opts: { userId: string; equipmentId: string; file: File; kind: DocKind },
): Promise<{ doc?: EquipmentDoc; error?: string }> {
  const path = docPath(opts.userId, opts.equipmentId, opts.file.name)
  const { error: upErr } = await sb.storage.from(EQUIPMENT_DOCS_BUCKET).upload(path, opts.file, { upsert: false })
  if (upErr) return { error: upErr.message }
  const { data, error } = await sb.from('equipment_docs').insert({
    user_id: opts.userId,
    equipment_id: opts.equipmentId,
    path,
    name: opts.file.name,
    kind: opts.kind,
    mime: opts.file.type || null,
    size_bytes: opts.file.size ?? null,
  }).select().single()
  if (error || !data) {
    // Never leave an orphan object behind if the row didn't land.
    await sb.storage.from(EQUIPMENT_DOCS_BUCKET).remove([path])
    return { error: error?.message ?? 'Could not save the document.' }
  }
  return { doc: data as EquipmentDoc }
}

/** Short-lived signed URL — the bucket is private, so this is the only way in. */
export async function signedDocUrl(sb: SupabaseClient, doc: EquipmentDoc, seconds = 60): Promise<string | null> {
  const { data } = await sb.storage.from(EQUIPMENT_DOCS_BUCKET).createSignedUrl(doc.path, seconds)
  return data?.signedUrl ?? null
}

/** Remove the row AND the object — an orphaned file is a privacy leak, not clutter. */
export async function deleteEquipmentDoc(sb: SupabaseClient, doc: EquipmentDoc): Promise<{ error?: string }> {
  const { error } = await sb.from('equipment_docs').delete().eq('id', doc.id)
  if (error) return { error: error.message }
  await sb.storage.from(EQUIPMENT_DOCS_BUCKET).remove([doc.path])
  return {}
}
