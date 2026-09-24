/**
 * Historical customer-photo backfill. DRY RUN is the default.
 *
 * Inventory: website_leads.raw_submission photos/recoverable photos_unprocessed,
 * quotes.lead_meta.photos, and service_requests.photos. Apply verifies source
 * bytes, copies them from public booking-uploads to tenant-prefixed private
 * customer-uploads, verifies target size + SHA-256, then compare-and-swaps only
 * the exact value inventoried. Source deletion is a separate --cleanup-sources
 * phase and is refused until a full residual-reference scan is clean.
 *
 *   npx tsx scripts/backfill-website-lead-photos.ts
 *   npx tsx scripts/backfill-website-lead-photos.ts --apply
 *   npx tsx scripts/backfill-website-lead-photos.ts --apply --cleanup-sources
 *   npx tsx scripts/backfill-website-lead-photos.ts --only=<record-id,...>
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { decodeInlinePhoto, type InlinePhoto } from '../src/lib/intake'
import {
  SOURCE_BUCKET, TARGET_BUCKET, pgArrayLiteral, replaceExact, rewriteWebsiteSubmissionWithInline,
  sha256, sourcePathForSurface, sourcePathFromPublicUrl, targetForBytes, type Surface,
} from './lib/customer-photo-backfill'

function loadEnv(file = '.env.local') {
  if (!existsSync(file)) return
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2')
  }
}
loadEnv()

const args = process.argv.slice(2)
const APPLY = args.includes('--apply')
const CLEANUP = args.includes('--cleanup-sources')
const ONLY = new Set((args.find(a => a.startsWith('--only='))?.slice(7) || '').split(',').map(s => s.trim()).filter(Boolean))
const RUN = new Date().toISOString().replace(/[:.]/g, '-')
const OUT = process.env.BACKFILL_REPORT_DIR || resolve(process.cwd(), '..', 'backfill-reports')
const URL = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const MAX_BYTES = 12 * 1024 * 1024

type WebsiteRow = { id: string; user_id: string; raw_submission: Record<string, unknown> }
type QuoteRow = { id: string; user_id: string; lead_meta: Record<string, unknown> | null }
type RequestRow = { id: string; user_id: string; photos: string[] }
type RefPlan = { original: string; sourcePath: string; targetPath: string; targetRef: string; size: number; hash: string; contentType: string; recoveryIndex?: number }
type RowPlan = {
  table: 'website_leads' | 'quotes' | 'service_requests'; id: string; ownerId: string; surface: Surface
  before: Record<string, unknown> | string[]; replacements: Map<string, string>; recovered: Map<number, string>
  recoveredPhotos: Map<number, string>
  refs: RefPlan[]; problems: string[]
}

function die(message: string): never { throw new Error(message) }

async function inventoryRows(admin: SupabaseClient) {
  const [website, quote, request, settings] = await Promise.all([
    admin.from('website_leads').select('id,user_id,raw_submission').order('id'),
    admin.from('quotes').select('id,user_id,lead_meta').order('id'),
    admin.from('service_requests').select('id,user_id,photos').order('id'),
    admin.from('business_settings').select('user_id,booking_token'),
  ])
  for (const result of [website, quote, request, settings]) if (result.error) die(`inventory failed: ${result.error.message}`)
  const tokens = new Map((settings.data || []).flatMap(row => typeof row.user_id === 'string' && typeof row.booking_token === 'string'
    ? [[row.user_id, row.booking_token] as const] : []))
  return {
    websites: (website.data || []) as WebsiteRow[], quotes: (quote.data || []) as QuoteRow[],
    requests: (request.data || []) as RequestRow[], tokens,
  }
}

async function sourceBytes(admin: SupabaseClient, path: string): Promise<{ bytes: Buffer; contentType: string }> {
  const { data, error } = await admin.storage.from(SOURCE_BUCKET).download(path)
  if (error || !data) die(`${SOURCE_BUCKET}/${path}: ${error?.message || 'missing object'}`)
  const bytes = Buffer.from(await data.arrayBuffer())
  if (!bytes.length || bytes.length > MAX_BYTES) die(`${SOURCE_BUCKET}/${path}: invalid size ${bytes.length}`)
  return { bytes, contentType: data.type || '' }
}

async function planStoredRef(admin: SupabaseClient, ownerId: string, surface: Surface, original: string, sourcePath: string): Promise<RefPlan> {
  const source = await sourceBytes(admin, sourcePath)
  const target = targetForBytes({ ownerId, surface, sourcePath, bytes: source.bytes, contentType: source.contentType })
  if (!target) die(`${sourcePath}: unsupported image type or invalid tenant target`)
  return { original, sourcePath, targetPath: target.path, targetRef: target.ref, size: target.size, hash: target.hash, contentType: target.contentType }
}

async function buildPlans(admin: SupabaseClient, all: Awaited<ReturnType<typeof inventoryRows>>): Promise<RowPlan[]> {
  const plans: RowPlan[] = []
  const collectStrings = async (plan: RowPlan, values: unknown[]) => {
    for (const value of values) {
      if (typeof value !== 'string' || value.startsWith('customer-upload:')) continue
      const path = sourcePathForSurface({ value, surface: plan.surface, supabaseUrl: URL, bookingToken: all.tokens.get(plan.ownerId) })
      if (!path) { plan.problems.push(`unsupported or unowned reference: ${String(value).slice(0, 160)}`); continue }
      try {
        const ref = await planStoredRef(admin, plan.ownerId, plan.surface, value, path)
        plan.refs.push(ref); plan.replacements.set(value, ref.targetRef)
      } catch (error) { plan.problems.push((error as Error).message) }
    }
  }

  for (const row of all.websites) {
    if (ONLY.size && !ONLY.has(row.id)) continue
    const raw = row.raw_submission || {}
    const plan: RowPlan = { table: 'website_leads', id: row.id, ownerId: row.user_id, surface: 'website', before: raw, replacements: new Map(), recovered: new Map(), recoveredPhotos: new Map(), refs: [], problems: [] }
    const rawPhotos = Array.isArray(raw.photos) ? raw.photos : []
    await collectStrings(plan, rawPhotos)
    for (let index = 0; index < rawPhotos.length; index++) {
      const item = rawPhotos[index]
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue
      const obj = item as Record<string, unknown>
      if (typeof obj.base64 !== 'string') { plan.problems.push(`photos[${index}] unsupported inline shape`); continue }
      const decoded = decodeInlinePhoto({ base64: obj.base64, contentType: typeof obj.contentType === 'string' ? obj.contentType : 'image/jpeg', filename: typeof obj.filename === 'string' ? obj.filename : 'photo' } as InlinePhoto)
      if (!decoded) { plan.problems.push(`photos[${index}] cannot be safely decoded`); continue }
      const target = targetForBytes({ ownerId: row.user_id, surface: 'website', sourcePath: `recovered.${decoded.ext}`, bytes: decoded.bytes, contentType: decoded.contentType })
      if (!target) { plan.problems.push(`photos[${index}] unsupported image type`); continue }
      plan.refs.push({ original: `photos[${index}]`, sourcePath: '', targetPath: target.path, targetRef: target.ref, size: target.size, hash: target.hash, contentType: target.contentType, recoveryIndex: -(index + 1) })
      plan.recoveredPhotos.set(index, target.ref)
    }
    const unprocessed = Array.isArray(raw.photos_unprocessed) ? raw.photos_unprocessed : []
    for (let index = 0; index < unprocessed.length; index++) {
      const item = unprocessed[index]
      if (!item || typeof item !== 'object' || Array.isArray(item)) { plan.problems.push(`photos_unprocessed[${index}] unsupported shape`); continue }
      const obj = item as Record<string, unknown>
      if (typeof obj.base64 !== 'string') { plan.problems.push(`photos_unprocessed[${index}] has no base64`); continue }
      const decoded = decodeInlinePhoto({ base64: obj.base64, contentType: typeof obj.contentType === 'string' ? obj.contentType : 'image/jpeg', filename: typeof obj.filename === 'string' ? obj.filename : 'photo' } as InlinePhoto)
      if (!decoded) { plan.problems.push(`photos_unprocessed[${index}] cannot be safely decoded`); continue }
      const target = targetForBytes({ ownerId: row.user_id, surface: 'website', sourcePath: `recovered.${decoded.ext}`, bytes: decoded.bytes, contentType: decoded.contentType })
      if (!target) { plan.problems.push(`photos_unprocessed[${index}] unsupported image type`); continue }
      plan.refs.push({ original: `photos_unprocessed[${index}]`, sourcePath: '', targetPath: target.path, targetRef: target.ref, size: target.size, hash: target.hash, contentType: target.contentType, recoveryIndex: index })
      plan.recovered.set(index, target.ref)
    }
    if (plan.refs.length || plan.problems.length) plans.push(plan)
  }
  for (const row of all.quotes) {
    if (ONLY.size && !ONLY.has(row.id)) continue
    if (!row.lead_meta || !Array.isArray(row.lead_meta.photos)) continue
    const plan: RowPlan = { table: 'quotes', id: row.id, ownerId: row.user_id, surface: 'quote', before: row.lead_meta, replacements: new Map(), recovered: new Map(), recoveredPhotos: new Map(), refs: [], problems: [] }
    await collectStrings(plan, row.lead_meta.photos)
    if (plan.refs.length || plan.problems.length) plans.push(plan)
  }
  for (const row of all.requests) {
    if (ONLY.size && !ONLY.has(row.id)) continue
    if (!Array.isArray(row.photos) || !row.photos.length) continue
    const plan: RowPlan = { table: 'service_requests', id: row.id, ownerId: row.user_id, surface: 'portal', before: row.photos, replacements: new Map(), recovered: new Map(), recoveredPhotos: new Map(), refs: [], problems: [] }
    await collectStrings(plan, row.photos)
    if (plan.refs.length || plan.problems.length) plans.push(plan)
  }
  return plans
}

async function ensureTarget(admin: SupabaseClient, ref: RefPlan, source: Buffer) {
  if (source.length !== ref.size || sha256(source) !== ref.hash) die(`${ref.sourcePath || ref.original}: bytes changed after inventory`)
  const bucket = admin.storage.from(TARGET_BUCKET)
  const existing = await bucket.download(ref.targetPath)
  if (existing.data && !existing.error) {
    const bytes = Buffer.from(await existing.data.arrayBuffer())
    if (bytes.length !== ref.size || sha256(bytes) !== ref.hash) die(`${ref.targetPath}: existing target hash mismatch`)
    return 'verified-existing'
  }
  const { error } = await bucket.upload(ref.targetPath, source, { contentType: ref.contentType, upsert: false })
  if (error) die(`${ref.targetPath}: upload failed: ${error.message}`)
  const verify = await bucket.download(ref.targetPath)
  if (verify.error || !verify.data) die(`${ref.targetPath}: post-upload download failed`)
  const bytes = Buffer.from(await verify.data.arrayBuffer())
  if (bytes.length !== ref.size || sha256(bytes) !== ref.hash) die(`${ref.targetPath}: post-upload hash mismatch`)
  return 'uploaded'
}

async function applyPlan(admin: SupabaseClient, plan: RowPlan) {
  if (plan.problems.length) return { status: 'blocked', problems: plan.problems }
  const recovery = plan.table === 'website_leads' && !Array.isArray(plan.before) && Array.isArray((plan.before as Record<string, unknown>).photos_unprocessed)
    ? (plan.before as Record<string, unknown>).photos_unprocessed as unknown[] : []
  for (const ref of plan.refs) {
    let bytes: Buffer
    if (ref.recoveryIndex !== undefined) {
      const rawPhotos = !Array.isArray(plan.before) && Array.isArray((plan.before as Record<string, unknown>).photos) ? (plan.before as Record<string, unknown>).photos as unknown[] : []
      const obj = (ref.recoveryIndex < 0 ? rawPhotos[-ref.recoveryIndex - 1] : recovery[ref.recoveryIndex]) as Record<string, unknown>
      const decoded = decodeInlinePhoto({ base64: String(obj.base64), contentType: String(obj.contentType || 'image/jpeg'), filename: String(obj.filename || 'photo') })
      if (!decoded) die(`${ref.original}: recovery changed after inventory`)
      bytes = decoded.bytes
    } else bytes = (await sourceBytes(admin, ref.sourcePath)).bytes
    await ensureTarget(admin, ref, bytes)
  }

  if (plan.table === 'website_leads') {
    const before = plan.before as Record<string, unknown>
    const next = rewriteWebsiteSubmissionWithInline(before, plan.replacements, plan.recovered, plan.recoveredPhotos)
    const beforeCount = (Array.isArray(before.photos) ? before.photos.length : 0) + (Array.isArray(before.photos_unprocessed) ? before.photos_unprocessed.length : 0)
    const afterCount = (Array.isArray(next.photos) ? next.photos.length : 0) + (Array.isArray(next.photos_unprocessed) ? next.photos_unprocessed.length : 0)
    if (beforeCount !== afterCount) return { status: 'blocked', error: `photo count changed ${beforeCount} -> ${afterCount}` }
    const result = await admin.from('website_leads').update({ raw_submission: next }).eq('id', plan.id).eq('user_id', plan.ownerId).filter('raw_submission', 'eq', JSON.stringify(before)).select('id,raw_submission')
    return !result.error && result.data?.length === 1 ? { status: 'rewritten' } : { status: 'cas-miss', error: result.error?.message || 'record changed' }
  }
  if (plan.table === 'quotes') {
    const before = plan.before as Record<string, unknown>
    const next = { ...before, photos: replaceExact(before.photos, plan.replacements) }
    if ((before.photos as unknown[]).length !== (next.photos as unknown[]).length) return { status: 'blocked', error: 'photo count changed' }
    const result = await admin.from('quotes').update({ lead_meta: next }).eq('id', plan.id).eq('user_id', plan.ownerId).filter('lead_meta', 'eq', JSON.stringify(before)).select('id,lead_meta')
    return !result.error && result.data?.length === 1 ? { status: 'rewritten' } : { status: 'cas-miss', error: result.error?.message || 'record changed' }
  }
  const before = plan.before as string[]
  const next = replaceExact(before, plan.replacements) as string[]
  if (before.length !== next.length) return { status: 'blocked', error: 'photo count changed' }
  const result = await admin.from('service_requests').update({ photos: next }).eq('id', plan.id).eq('user_id', plan.ownerId).filter('photos', 'eq', pgArrayLiteral(before)).select('id,photos')
  return !result.error && result.data?.length === 1 ? { status: 'rewritten' } : { status: 'cas-miss', error: result.error?.message || 'record changed' }
}

function residualPaths(all: Awaited<ReturnType<typeof inventoryRows>>): Set<string> {
  const found = new Set<string>()
  const add = (surface: Surface, ownerId: string, values: unknown[]) => {
    for (const value of values) {
      const path = surface === 'portal'
        ? sourcePathForSurface({ value, surface, supabaseUrl: URL })
        : sourcePathFromPublicUrl(value, URL)
      if (path) found.add(path)
    }
  }
  for (const row of all.websites) add('website', row.user_id, Array.isArray(row.raw_submission?.photos) ? row.raw_submission.photos : [])
  for (const row of all.quotes) add('quote', row.user_id, Array.isArray(row.lead_meta?.photos) ? row.lead_meta!.photos as unknown[] : [])
  for (const row of all.requests) add('portal', row.user_id, Array.isArray(row.photos) ? row.photos : [])
  return found
}

async function main() {
  if (!URL || !KEY) die('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required')
  if (CLEANUP && !APPLY) die('--cleanup-sources requires --apply')
  if (CLEANUP && ONLY.size) die('--cleanup-sources is refused with --only; cleanup requires a full inventory')
  const admin = createClient(URL, KEY, { auth: { persistSession: false } })
  const initial = await inventoryRows(admin)
  const plans = await buildPlans(admin, initial)
  mkdirSync(OUT, { recursive: true, mode: 0o700 })
  const reportFile = join(OUT, `${APPLY ? 'apply' : 'dry-run'}-${RUN}.json`)
  const report: Record<string, unknown> = {
    run: RUN, mode: APPLY ? 'apply' : 'dry-run', cleanupRequested: CLEANUP,
    counts: { records: plans.length, refs: plans.reduce((n, p) => n + p.refs.length, 0), blocked: plans.filter(p => p.problems.length).length },
    records: plans.map(plan => ({ table: plan.table, id: plan.id, ownerId: plan.ownerId, refs: plan.refs.map(ref => ({ ...ref, original: ref.original.slice(0, 200) })), problems: plan.problems })),
  }
  if (!APPLY) {
    writeFileSync(reportFile, JSON.stringify(report, null, 2), { mode: 0o600 })
    console.log(`DRY RUN: ${plans.length} record(s); no uploads, rewrites, or deletions.\nReport: ${reportFile}`)
    return
  }
  const backupFile = join(OUT, `backup-${RUN}.json`)
  writeFileSync(backupFile, JSON.stringify({ run: RUN, records: plans.map(plan => ({ table: plan.table, id: plan.id, ownerId: plan.ownerId, before: plan.before })) }, null, 2), { mode: 0o600 })
  const results = []
  for (const plan of plans) results.push({ table: plan.table, id: plan.id, ...(await applyPlan(admin, plan)) })
  report.results = results; report.backup = backupFile
  if (CLEANUP) {
    const after = await inventoryRows(admin)
    const residual = residualPaths(after)
    const candidates = [...new Set(plans.flatMap(plan => plan.refs.map(ref => ref.sourcePath)).filter(Boolean))]
    const refused = candidates.filter(path => residual.has(path))
    if (refused.length) die(`cleanup refused: ${refused.length} source object(s) remain referenced`)
    const deletable = candidates.filter(path => !residual.has(path))
    const { error } = deletable.length ? await admin.storage.from(SOURCE_BUCKET).remove(deletable) : { error: null }
    if (error) die(`cleanup failed: ${error.message}`)
    report.cleanup = { deleted: deletable, residual: [...residual] }
  }
  writeFileSync(reportFile, JSON.stringify(report, null, 2), { mode: 0o600 })
  console.log(`APPLY finished. Backup: ${backupFile}\nLedger: ${reportFile}`)
  if (results.some(result => result.status !== 'rewritten')) process.exitCode = 1
}

main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exit(1) })
