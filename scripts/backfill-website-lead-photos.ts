// ── One-time backfill: historical website-lead photos → the canonical contract ──
//
// PR #70 (7ece117) fixed the website-lead photo contract GOING FORWARD: lib/intake.ts
// now decodes the marketing site's inline `photos: [{base64, contentType, filename}]`
// and uploads them to the public `booking-uploads` bucket BEFORE the RPC persists
// raw_submission, so `photos` lands as the canonical `string[]` of public URLs that
// every reader already understands (LeadSummary → extractBookingPhotos → JobPhotos).
//
// It did NOT touch the leads that came in BEFORE the fix. Those rows still hold the
// legacy inline objects, so their photos remain invisible in the CRM even though the
// bytes were never lost. This script moves that history onto the same contract —
// the SAME bucket, the SAME decode helper (decodeInlinePhoto), no new architecture.
//
// SAFETY MODEL (this touches live customer data):
//   • DRY RUN BY DEFAULT — `--apply` is required to write anything.
//   • BACKUP FIRST — every affected row's complete original raw_submission is written
//     to disk before the first mutation, and `--restore <file>` puts it back.
//   • ALL-OR-NOTHING PER ROW — a row is rewritten only when every one of its photos
//     uploaded AND its public URL was fetched back successfully. One failure leaves
//     that row's legacy base64 exactly as it was, and says so out loud.
//   • NOTHING IS SILENTLY DROPPED — a malformed entry fails its row rather than
//     vanishing from the array. A photo the owner never hears about is the original bug.
//   • IDEMPOTENT — storage paths are CONTENT-ADDRESSED (sha256 of the decoded bytes),
//     so a rerun computes the identical path and an "already exists" upload is proof
//     of the same bytes, not a duplicate. And a migrated row no longer matches the
//     legacy predicate, so a second run selects nothing at all.
//   • NARROW — only website_leads whose `photos` array still contains a legacy OBJECT
//     entry. `--only <id,…>` narrows it further.
//
// Usage:
//   npx tsx scripts/backfill-website-lead-photos.ts                  # dry run
//   npx tsx scripts/backfill-website-lead-photos.ts --apply          # migrate
//   npx tsx scripts/backfill-website-lead-photos.ts --restore <file> # undo from backup
//
// Credentials (.env.local) — one of, in order of least privilege:
//   BACKFILL_OWNER_EMAIL + BACKFILL_OWNER_PASSWORD  → signs in as the owner and works
//        strictly inside the app's own RLS ("website_leads: select/update own").
//   SUPABASE_SERVICE_ROLE_KEY                       → service role.
// Uploads always go through the ANON client, exactly like the live intake door.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
// THE decode helper from the forward fix — same base64/data-URI handling, same size
// cap, same extension resolution. Reused rather than re-implemented so history and
// new submissions cannot drift apart.
import { decodeInlinePhoto, MAX_LEAD_PHOTOS, type InlinePhoto } from '../src/lib/intake'
// The CRM's OWN read path, used here to prove the migrated row is actually visible.
import { extractBookingPhotos } from '../src/lib/bookingPhotos'

// Minimal .env.local reader — this script is run by hand from the repo root and must
// not depend on a package the app doesn't declare. Existing process env always wins,
// so a credential can be passed inline for a single run without ever being written down.
function loadEnvLocal(file = '.env.local') {
  if (!existsSync(file)) return
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!m) continue
    const key = m[1]
    if (process.env[key] !== undefined) continue
    process.env[key] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2')
  }
}
loadEnvLocal()

const BUCKET = 'booking-uploads'
const argv = process.argv.slice(2)
const APPLY = argv.includes('--apply')
const RESTORE = argv.includes('--restore') ? argv[argv.indexOf('--restore') + 1] : ''
const ONLY = (argv.find(a => a.startsWith('--only='))?.slice('--only='.length) || '')
  .split(',').map(s => s.trim()).filter(Boolean)

// A stable id for this run's artifacts. Wall-clock, not random — an operator reading
// the backup directory needs to know WHEN, and reruns must not collide.
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-')
// Deliberately OUTSIDE the git repo: these files contain customer photo bytes and
// must never be committable.
const BACKUP_DIR = process.env.BACKFILL_BACKUP_DIR || resolve(process.cwd(), '..', 'backfill-backups')

type Row = { id: string; user_id: string; customer_id: string | null; created_at: string; raw_submission: Record<string, unknown> }
// One original array slot. `kind` is what we found there, and the slot's POSITION in
// the array is preserved end to end — a customer's photo order is information.
type Slot =
  | { kind: 'url'; ord: number; url: string }
  | { kind: 'legacy'; ord: number; photo: InlinePhoto }
  | { kind: 'malformed'; ord: number; why: string }

function log(s = '') { console.log(s) }
function fail(msg: string): never { console.error(`\n❌ ${msg}`); process.exit(1) }

// ── Clients ──────────────────────────────────────────────────────────────────
async function connect(): Promise<{ db: SupabaseClient; anon: SupabaseClient; mode: string }> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anonKey) fail('NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY missing from .env.local')

  // The upload client is the anon client on purpose: the live intake door uploads as
  // anon under `booking_uploads_public_insert`, so the objects this backfill creates
  // are created under the exact same policy as every canonical photo.
  const anon = createClient(url, anonKey)

  const email = process.env.BACKFILL_OWNER_EMAIL
  const password = process.env.BACKFILL_OWNER_PASSWORD
  if (email && password) {
    const db = createClient(url, anonKey, { auth: { persistSession: false } })
    const { data, error } = await db.auth.signInWithPassword({ email, password })
    if (error || !data.user) fail(`owner sign-in failed: ${error?.message || 'no user'}`)
    return { db, anon, mode: `owner session (${data.user.email}) — RLS enforced` }
  }
  const svc = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (svc) {
    const db = createClient(url, svc, { auth: { persistSession: false } })
    return { db, anon, mode: 'service role' }
  }
  fail('No database credential. Set BACKFILL_OWNER_EMAIL + BACKFILL_OWNER_PASSWORD (preferred) or SUPABASE_SERVICE_ROLE_KEY in .env.local')
}

// ── Classification ───────────────────────────────────────────────────────────
// Walk the ORIGINAL array once, in order. Every element becomes exactly one slot, so
// nothing can be dropped, reordered, or invented between here and the rewrite.
function classify(photos: unknown[]): Slot[] {
  return photos.map((item, i): Slot => {
    const ord = i + 1
    if (typeof item === 'string') {
      const s = item.trim()
      return /^https?:\/\//i.test(s)
        ? { kind: 'url', ord, url: s }
        : { kind: 'malformed', ord, why: 'string that is not an http(s) URL' }
    }
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { kind: 'malformed', ord, why: `unsupported element type (${item === null ? 'null' : typeof item})` }
    }
    const o = item as Record<string, unknown>
    const b64 = typeof o.base64 === 'string' ? o.base64.trim() : ''
    if (!b64) return { kind: 'malformed', ord, why: 'object without a base64 string' }
    const ct = typeof o.contentType === 'string' && o.contentType.toLowerCase().startsWith('image/')
      ? o.contentType.toLowerCase() : 'image/jpeg'
    const fn = typeof o.filename === 'string' && o.filename.trim() ? o.filename.trim() : 'photo'
    return { kind: 'legacy', ord, photo: { base64: b64, contentType: ct, filename: fn } }
  })
}

// Content-addressed, deterministic, and scoped under the owner's booking-token prefix —
// the same `<token>/…` namespace the booking door writes into. Deterministic is the
// whole idempotency guarantee: the same photo can only ever occupy one path.
function storagePath(token: string, leadId: string, ord: number, bytes: Buffer, filename: string, ext: string): string {
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 16)
  const safe = filename.replace(/[^a-zA-Z0-9.\-_]/g, '_').replace(/\.[a-z0-9]{2,5}$/i, '').slice(-40) || 'photo'
  return `${token}/lead-${leadId}-${ord}-${hash}-${safe}.${ext}`
}

// A URL we wrote must actually SERVE the photo before we are allowed to throw away the
// base64 it came from. Same assumption every canonical photo relies on: a public GET.
async function verifyUrl(url: string, expectBytes: number): Promise<{ ok: boolean; detail: string }> {
  try {
    const r = await fetch(url, { method: 'GET', cache: 'no-store' })
    if (!r.ok) return { ok: false, detail: `HTTP ${r.status}` }
    const ct = r.headers.get('content-type') || ''
    const body = Buffer.from(await r.arrayBuffer())
    if (!ct.toLowerCase().startsWith('image/')) return { ok: false, detail: `content-type ${ct || '(none)'}` }
    if (body.length !== expectBytes) return { ok: false, detail: `served ${body.length}B, expected ${expectBytes}B` }
    return { ok: true, detail: `HTTP 200 ${ct} ${body.length}B` }
  } catch (e) {
    return { ok: false, detail: `fetch failed: ${(e as Error).message}` }
  }
}

const fmtBytes = (n: number) => n >= 1048576 ? `${(n / 1048576).toFixed(2)} MB` : `${(n / 1024).toFixed(1)} KB`

// ── Restore ──────────────────────────────────────────────────────────────────
async function restore(db: SupabaseClient, file: string) {
  const backup = JSON.parse(readFileSync(file, 'utf8')) as { rows: { id: string; raw_submission: Record<string, unknown> }[] }
  log(`Restoring ${backup.rows.length} row(s) from ${file}\n`)
  for (const r of backup.rows) {
    const { error } = await db.from('website_leads').update({ raw_submission: r.raw_submission }).eq('id', r.id)
    log(error ? `  ❌ ${r.id}: ${error.message}` : `  ✅ ${r.id} restored`)
    if (error) process.exitCode = 1
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const { db, anon, mode } = await connect()
  log('═'.repeat(78))
  log(`  Website-lead photo backfill — ${APPLY ? '🔴 APPLY (writes production data)' : '🔵 DRY RUN (no writes)'}`)
  log(`  run ${RUN_ID} · auth: ${mode}`)
  log('═'.repeat(78))

  if (RESTORE) return restore(db, RESTORE)

  // ── Select. Narrow by construction: a `photos` array must be present, and the row
  // is only kept if it still holds a LEGACY object entry.
  let q = db.from('website_leads')
    .select('id, user_id, customer_id, created_at, raw_submission')
    .not('raw_submission->photos', 'is', null)
    .order('created_at', { ascending: true })
  if (ONLY.length) q = q.in('id', ONLY)
  const { data, error } = await q
  if (error) fail(`select failed: ${error.message}`)

  const candidates = (data || []) as Row[]
  const affected: { row: Row; slots: Slot[] }[] = []
  let skippedMigrated = 0
  let skippedNoPhotos = 0
  for (const row of candidates) {
    const photos = row.raw_submission?.photos
    if (!Array.isArray(photos) || photos.length === 0) { skippedNoPhotos++; continue }
    const slots = classify(photos)
    if (!slots.some(s => s.kind === 'legacy')) { skippedMigrated++; continue }
    affected.push({ row, slots })
  }

  log(`\nScanned ${candidates.length} lead(s) carrying a photos array.`)
  log(`  · ${affected.length} still on the LEGACY inline representation`)
  log(`  · ${skippedMigrated} already canonical (or nothing left to convert) — untouched`)
  log(`  · ${skippedNoPhotos} with an empty/absent photos array — untouched`)
  if (affected.length === 0) {
    log('\n✅ Nothing to migrate. (A rerun after a successful migration lands here.)')
    return
  }

  // Booking tokens keep the new objects inside the same `<token>/` namespace the
  // booking door uses. One lookup per owner.
  const tokens = new Map<string, string>()
  for (const uid of new Set(affected.map(a => a.row.user_id))) {
    const { data: bs, error: be } = await db.from('business_settings').select('booking_token').eq('user_id', uid).maybeSingle()
    if (be || !bs?.booking_token) fail(`no booking_token for user ${uid}${be ? `: ${be.message}` : ''} — cannot place uploads in the canonical namespace`)
    tokens.set(uid, bs.booking_token as string)
  }

  // ── Decode everything up front. Purely local, so the dry run reports exactly the
  // same per-photo verdicts the apply run will act on.
  type Plan = {
    row: Row; slots: Slot[]; token: string
    photos: { ord: number; filename: string; contentType: string; bytes: number; path: string; url: string; decoded: Buffer }[]
    problems: string[]
    alreadyUrls: number
  }
  const plans: Plan[] = []
  for (const { row, slots } of affected) {
    const token = tokens.get(row.user_id)!
    const plan: Plan = { row, slots, token, photos: [], problems: [], alreadyUrls: slots.filter(s => s.kind === 'url').length }
    if (slots.length > MAX_LEAD_PHOTOS) {
      // Reported, never truncated: dropping a photo to satisfy a forward-facing cap
      // would destroy history. The operator decides.
      plan.problems.push(`${slots.length} entries exceeds MAX_LEAD_PHOTOS (${MAX_LEAD_PHOTOS}); migrating all of them anyway (history is not truncated)`)
    }
    for (const s of slots) {
      if (s.kind === 'malformed') { plan.problems.push(`#${s.ord}: ${s.why}`); continue }
      if (s.kind === 'url') continue
      const d = decodeInlinePhoto(s.photo)
      if (!d) { plan.problems.push(`#${s.ord}: base64 did not decode (or busts the size cap) — ${s.photo.filename}`); continue }
      const path = storagePath(token, row.id, s.ord, d.bytes, s.photo.filename, d.ext)
      plan.photos.push({
        ord: s.ord, filename: s.photo.filename, contentType: d.contentType,
        bytes: d.bytes.length, path, decoded: d.bytes,
        url: anon.storage.from(BUCKET).getPublicUrl(path).data.publicUrl,
      })
    }
    plans.push(plan)
  }

  // ── Report ────────────────────────────────────────────────────────────────
  const totalPhotos = plans.reduce((n, p) => n + p.photos.length, 0)
  const totalBytes = plans.reduce((n, p) => n + p.photos.reduce((m, x) => m + x.bytes, 0), 0)
  const blocked = plans.filter(p => p.problems.some(x => !x.includes('history is not truncated')))

  log('\n' + '─'.repeat(78))
  log('  AFFECTED LEADS')
  log('─'.repeat(78))
  for (const p of plans) {
    const bytes = p.photos.reduce((m, x) => m + x.bytes, 0)
    log(`\n  ${p.row.id}  ${p.row.created_at.slice(0, 10)}  customer=${p.row.customer_id || '(none)'}`)
    log(`    ${p.slots.length} entr${p.slots.length === 1 ? 'y' : 'ies'} → ${p.photos.length} legacy photo(s) to upload, ${p.alreadyUrls} already canonical · ${fmtBytes(bytes)}`)
    for (const ph of p.photos) log(`      #${ph.ord} ${ph.filename} · ${ph.contentType} · ${fmtBytes(ph.bytes)} → ${ph.path}`)
    for (const w of p.problems) log(`      ⚠️  ${w}`)
  }

  log('\n' + '─'.repeat(78))
  log(`  TOTAL: ${plans.length} lead(s) · ${totalPhotos} photo(s) · ${fmtBytes(totalBytes)} to move into ${BUCKET}`)
  if (blocked.length) log(`  ⛔ ${blocked.length} lead(s) BLOCKED by malformed entries — they will NOT be rewritten`)
  log('─'.repeat(78))

  mkdirSync(BACKUP_DIR, { recursive: true })

  if (!APPLY) {
    const file = join(BACKUP_DIR, `dryrun-${RUN_ID}.json`)
    writeFileSync(file, JSON.stringify({
      run: RUN_ID, mode: 'dry-run', bucket: BUCKET,
      totals: { leads: plans.length, photos: totalPhotos, bytes: totalBytes },
      leads: plans.map(p => ({
        id: p.row.id, created_at: p.row.created_at, customer_id: p.row.customer_id,
        entries: p.slots.length, legacy: p.photos.length, alreadyCanonical: p.alreadyUrls,
        problems: p.problems, wouldChange: p.problems.length === 0 || !blocked.includes(p),
        photos: p.photos.map(({ decoded: _d, ...rest }) => rest),
        otherKeys: Object.keys(p.row.raw_submission).filter(k => k !== 'photos').sort(),
      })),
    }, null, 2))
    log(`\n🔵 DRY RUN — nothing was uploaded and nothing was written.`)
    log(`   Plan saved: ${file}`)
    log(`   Re-run with --apply to migrate.`)
    return
  }

  // ── BACKUP BEFORE THE FIRST MUTATION ──────────────────────────────────────
  const backupFile = join(BACKUP_DIR, `backup-${RUN_ID}.json`)
  writeFileSync(backupFile, JSON.stringify({
    run: RUN_ID, takenAt: new Date().toISOString(), table: 'website_leads',
    note: 'Complete pre-migration raw_submission for every affected row, including the original inline base64. Restore with: npx tsx scripts/backfill-website-lead-photos.ts --restore <this file>',
    rows: plans.map(p => ({ id: p.row.id, user_id: p.row.user_id, created_at: p.row.created_at, raw_submission: p.row.raw_submission })),
  }, null, 2))
  log(`\n💾 Backup written before any change: ${backupFile} (${fmtBytes(Buffer.byteLength(readFileSync(backupFile)))})`)

  // ── Migrate ───────────────────────────────────────────────────────────────
  const ledger: unknown[] = []
  let okRows = 0, okPhotos = 0, failedRows = 0, reusedObjects = 0
  for (const p of plans) {
    log(`\n▶ ${p.row.id}`)
    if (blocked.includes(p)) {
      failedRows++
      log(`   ⛔ SKIPPED — malformed entries present; its original data is untouched:`)
      for (const w of p.problems) log(`      · ${w}`)
      ledger.push({ leadId: p.row.id, status: 'skipped', reason: 'malformed entries', problems: p.problems })
      continue
    }

    const uploaded = new Map<number, string>()
    const perPhoto: unknown[] = []
    let rowOk = true
    for (const ph of p.photos) {
      const { error: upErr } = await anon.storage.from(BUCKET)
        .upload(ph.path, ph.decoded, { contentType: ph.contentType, upsert: false })
      // Content-addressed path ⇒ "already exists" means THESE bytes are already there.
      // That is the rerun case, and it is a success, not a duplicate.
      const dup = !!upErr && /exists|duplicate/i.test(upErr.message)
      if (upErr && !dup) {
        rowOk = false
        log(`   ❌ #${ph.ord} upload failed: ${upErr.message}`)
        perPhoto.push({ ord: ph.ord, path: ph.path, status: 'upload-failed', error: upErr.message })
        continue
      }
      if (dup) reusedObjects++
      const v = await verifyUrl(ph.url, ph.bytes)
      if (!v.ok) {
        rowOk = false
        log(`   ❌ #${ph.ord} uploaded but URL did not verify: ${v.detail}`)
        perPhoto.push({ ord: ph.ord, path: ph.path, url: ph.url, status: 'verify-failed', detail: v.detail })
        continue
      }
      uploaded.set(ph.ord, ph.url)
      perPhoto.push({ ord: ph.ord, path: ph.path, url: ph.url, bytes: ph.bytes, status: dup ? 'already-present' : 'uploaded', verified: v.detail })
      log(`   ✅ #${ph.ord} ${dup ? 'already present' : 'uploaded'} + verified (${v.detail})`)
    }

    if (!rowOk) {
      failedRows++
      log(`   ⛔ NOT rewritten — its legacy base64 is preserved exactly as it was.`)
      ledger.push({ leadId: p.row.id, status: 'failed', photos: perPhoto })
      continue
    }

    // Rebuild the array IN ORIGINAL ORDER, then keep every other key byte-for-byte.
    const newPhotos = p.slots.map(s => s.kind === 'url' ? s.url : uploaded.get(s.ord)!)
    if (newPhotos.some(u => typeof u !== 'string')) {
      failedRows++
      log('   ⛔ internal order mismatch — not rewritten')
      ledger.push({ leadId: p.row.id, status: 'failed', reason: 'order mismatch' })
      continue
    }
    const next = { ...p.row.raw_submission, photos: newPhotos }

    // Optimistic guard: refuse to overwrite a row that changed since we read it.
    const { data: fresh, error: fe } = await db.from('website_leads').select('raw_submission').eq('id', p.row.id).single()
    if (fe || JSON.stringify(fresh?.raw_submission) !== JSON.stringify(p.row.raw_submission)) {
      failedRows++
      log(`   ⛔ row changed since it was read — not rewritten${fe ? ` (${fe.message})` : ''}`)
      ledger.push({ leadId: p.row.id, status: 'failed', reason: 'row changed under us' })
      continue
    }

    const { error: ue } = await db.from('website_leads').update({ raw_submission: next }).eq('id', p.row.id)
    if (ue) {
      failedRows++
      log(`   ❌ update failed: ${ue.message} — photos are stored, row left on legacy data (safe to rerun)`)
      ledger.push({ leadId: p.row.id, status: 'failed', reason: `update: ${ue.message}`, photos: perPhoto })
      continue
    }

    // Read back and prove it through the CRM's own reader.
    const { data: after } = await db.from('website_leads').select('raw_submission').eq('id', p.row.id).single()
    const readable = extractBookingPhotos(after?.raw_submission)
    const otherBefore = { ...p.row.raw_submission }; delete otherBefore.photos
    const otherAfter = { ...(after?.raw_submission as Record<string, unknown>) }; delete otherAfter.photos
    const untouched = JSON.stringify(otherBefore) === JSON.stringify(otherAfter)
    if (readable.length !== newPhotos.length || !untouched) {
      failedRows++
      log(`   ❌ post-write check FAILED (CRM sees ${readable.length}/${newPhotos.length}, other fields ${untouched ? 'intact' : 'CHANGED'}) — restore from the backup`)
      ledger.push({ leadId: p.row.id, status: 'failed', reason: 'post-write verification', readable: readable.length, untouched })
      continue
    }
    okRows++; okPhotos += p.photos.length
    log(`   ✅ rewritten — CRM reads ${readable.length} photo(s); all ${Object.keys(otherAfter).length} other fields unchanged`)
    ledger.push({ leadId: p.row.id, status: 'migrated', photos: perPhoto, crmVisible: readable.length })
  }

  const ledgerFile = join(BACKUP_DIR, `ledger-${RUN_ID}.json`)
  writeFileSync(ledgerFile, JSON.stringify({ run: RUN_ID, backup: backupFile, bucket: BUCKET, results: ledger }, null, 2))

  log('\n' + '═'.repeat(78))
  log(`  ${okRows}/${plans.length} lead(s) migrated · ${okPhotos}/${totalPhotos} photo(s) now canonical`)
  if (reusedObjects) log(`  ${reusedObjects} storage object(s) already existed (rerun) — no duplicates created`)
  if (failedRows) log(`  ⛔ ${failedRows} lead(s) NOT migrated — their original data is intact (see ledger)`)
  log(`  backup: ${backupFile}`)
  log(`  ledger: ${ledgerFile}`)
  log('═'.repeat(78))
  if (failedRows) process.exitCode = 1
}

main().catch(e => fail((e as Error).stack || String(e)))
