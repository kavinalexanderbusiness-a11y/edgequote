import assert from 'node:assert/strict'
import { pgArrayLiteral, replaceExact, rewriteWebsiteSubmission, rewriteWebsiteSubmissionWithInline, sourcePathForSurface, targetForBytes, uuidFromHash } from './lib/customer-photo-backfill'

const owner = '11111111-1111-4111-8111-111111111111'
const token = 'public-token'
const base = 'https://project.supabase.co'
const legacy = `${base}/storage/v1/object/public/booking-uploads/${token}/old.jpg`
const bytes = Buffer.from('fixture-photo')

assert.equal(sourcePathForSurface({ value: legacy, surface: 'quote', supabaseUrl: base, bookingToken: token }), `${token}/old.jpg`)
assert.equal(sourcePathForSurface({ value: legacy, surface: 'quote', supabaseUrl: base, bookingToken: 'other' }), null)
assert.equal(sourcePathForSurface({ value: 'https://evil.test/storage/v1/object/public/booking-uploads/x.jpg', surface: 'quote', supabaseUrl: base, bookingToken: token }), null)
const portal = 'portal/22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333.jpg'
assert.equal(sourcePathForSurface({ value: portal, surface: 'portal', supabaseUrl: base }), portal)
assert.equal(sourcePathForSurface({ value: '../portal/x.jpg', surface: 'portal', supabaseUrl: base }), null)
const a = targetForBytes({ ownerId: owner, surface: 'quote', sourcePath: `${token}/old.jpg`, bytes, contentType: 'image/jpeg' })!
const b = targetForBytes({ ownerId: owner, surface: 'quote', sourcePath: `${token}/renamed.jpg`, bytes, contentType: 'image/jpeg' })!
assert.equal(a.path, b.path)
assert.match(a.ref, new RegExp(`^customer-upload:${owner}/booking/`))
assert.match(uuidFromHash(a.hash), /^[0-9a-f-]{36}$/)
const replacements = new Map([[legacy, a.ref]])
assert.deepEqual(replaceExact([legacy, 'keep', legacy], replacements), [a.ref, 'keep', a.ref])
const raw = { photos: [legacy], photos_unprocessed: [{ base64: 'x' }, { base64: 'y' }], photos_failed: 2, note: 'unchanged' }
const rewritten = rewriteWebsiteSubmission(raw, replacements, new Map([[0, 'customer-upload:recovered']]))
assert.deepEqual(rewritten.photos, [a.ref, 'customer-upload:recovered'])
assert.deepEqual(rewritten.photos_unprocessed, [{ base64: 'y' }])
assert.equal(rewritten.photos_failed, 1)
assert.equal(rewritten.note, 'unchanged')
assert.equal(raw.photos[0], legacy)
assert.deepEqual(
  rewriteWebsiteSubmissionWithInline({ photos: [{ base64: 'old' }, legacy] }, replacements, new Map(), new Map([[0, 'customer-upload:inline']])).photos,
  ['customer-upload:inline', a.ref],
)
assert.equal(pgArrayLiteral(['a', 'b"c']), '{"a","b\\"c"}')
console.log('customer photo backfill fixtures passed')
