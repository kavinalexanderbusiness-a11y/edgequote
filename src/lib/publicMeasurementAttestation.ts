import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

export interface VerifiedPublicMeasurement {
  matchedAddress: string
  sqft: number
  polygonHash: string
  lat: number
  lng: number
  source: string
  confidence: 'high' | 'medium' | 'low'
  measuredAt: string
}

export type MeasurementVerification =
  | { ok: true; measurement: VerifiedPublicMeasurement }
  | { ok: false; code: string; decision: string }

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`
}

export function normalizePublicMeasurementAddress(value: unknown): string {
  const aliases: Record<string, string> = {
    avenue: 'av', ave: 'av', boulevard: 'bv', blvd: 'bv', circle: 'ci', cir: 'ci',
    close: 'cl', common: 'cm', court: 'ct', crescent: 'cr', cres: 'cr', drive: 'dr',
    gate: 'ga', gardens: 'gd', green: 'gr', grove: 'gv', heights: 'ht', hill: 'hi',
    lane: 'ln', link: 'li', manor: 'mr', mews: 'me', parade: 'pa', park: 'pk',
    place: 'pl', point: 'pt', road: 'rd', row: 'ro', square: 'sq', street: 'st',
    str: 'st', terrace: 'tc', ter: 'tc', trail: 'tr', view: 'vi', villas: 'vs', way: 'wy',
  }
  return String(value || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/)
    .filter(Boolean).filter(token => !['calgary', 'alberta', 'ab', 'canada'].includes(token))
    .map(token => aliases[token] || token).join(' ')
}

export function publicMeasurementPolygonHash(polygon: unknown): string {
  return createHash('sha256').update(stableJson(polygon)).digest('hex')
}

function fail(code: string, decision: string): MeasurementVerification {
  return { ok: false, code, decision }
}

/** Verify the marketing server's immutable City-measurement envelope. */
export function verifyPublicMeasurementAttestation(input: {
  token: unknown
  confirmation: unknown
  submittedAddress: unknown
  submittedSqft: unknown
  submittedPolygon: unknown
  nowMs?: number
  secret?: string
}): MeasurementVerification {
  if (!['looks_right', 'automatic_applied'].includes(String(input.confirmation || ''))) {
    return fail('measurement_not_confirmed_unchanged', 'Only an unchanged server-issued automatic outline can be priced automatically.')
  }
  const secret = String(input.secret ?? process.env.EDGE_ESTIMATOR_MEASUREMENT_SECRET ?? '').trim()
  if (secret.length < 32) return fail('measurement_verifier_unavailable', 'Review the lead because server measurement verification is not configured.')
  const token = typeof input.token === 'string' ? input.token.trim() : ''
  if (!token || token.length > 8_000) return fail('measurement_attestation_missing', 'Create and confirm a fresh automatic lawn outline.')
  const pieces = token.split('.')
  if (pieces.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(pieces[0]) || !/^[A-Za-z0-9_-]+$/.test(pieces[1])) {
    return fail('measurement_attestation_invalid', 'Create and confirm a fresh automatic lawn outline.')
  }
  const expected = createHmac('sha256', secret).update(pieces[0]).digest()
  let actual: Buffer
  try { actual = Buffer.from(pieces[1], 'base64url') } catch { return fail('measurement_attestation_invalid', 'Create and confirm a fresh automatic lawn outline.') }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return fail('measurement_attestation_invalid', 'Create and confirm a fresh automatic lawn outline.')
  }

  let payload: Record<string, unknown>
  try {
    const decoded = Buffer.from(pieces[0], 'base64url').toString('utf8')
    payload = JSON.parse(decoded) as Record<string, unknown>
    if (stableJson(payload) !== decoded) return fail('measurement_attestation_invalid', 'Create and confirm a fresh automatic lawn outline.')
  } catch { return fail('measurement_attestation_invalid', 'Create and confirm a fresh automatic lawn outline.') }

  const nowMs = input.nowMs ?? Date.now()
  const measuredAtMs = Date.parse(String(payload.measuredAt || ''))
  const expiresAtMs = Date.parse(String(payload.expiresAt || ''))
  const sqft = Number(payload.sqft)
  const claimedSqft = Number(input.submittedSqft)
  const centre = payload.centre as { lat?: unknown; lng?: unknown } | null
  const lat = Number(centre?.lat)
  const lng = Number(centre?.lng)
  const confidence = String(payload.confidence || '')
  const source = String(payload.source || '')
  if (payload.v !== 1 || !Number.isInteger(sqft) || sqft <= 0 || sqft > 10_000_000
    || !Number.isFinite(lat) || !Number.isFinite(lng) || lat < 50.6 || lat > 51.4 || lng < -114.6 || lng > -113.6
    || !['high', 'medium', 'low'].includes(confidence) || source !== 'calgary_open_data_land_cover'
    || !Number.isFinite(measuredAtMs) || !Number.isFinite(expiresAtMs)
    || measuredAtMs > nowMs + 60_000 || expiresAtMs <= nowMs || expiresAtMs - measuredAtMs > 30 * 60 * 1000) {
    return fail('measurement_attestation_invalid', 'Create and confirm a fresh automatic lawn outline.')
  }
  if (normalizePublicMeasurementAddress(input.submittedAddress) !== payload.address
    || claimedSqft !== sqft
    || publicMeasurementPolygonHash(input.submittedPolygon) !== payload.polygonHash) {
    return fail('measurement_changed_after_verification', 'Review the lead because the confirmed address, area or outline changed after server measurement.')
  }
  return {
    ok: true,
    measurement: {
      matchedAddress: String(payload.matchedAddress || input.submittedAddress || ''),
      sqft,
      polygonHash: String(payload.polygonHash),
      lat,
      lng,
      source,
      confidence: confidence as VerifiedPublicMeasurement['confidence'],
      measuredAt: new Date(measuredAtMs).toISOString(),
    },
  }
}
