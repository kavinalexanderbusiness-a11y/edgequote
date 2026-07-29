// ── Integration constants — the leaf the browser can afford to import ────────
// Prefixes, scopes, header names, limits. Pure values, NO imports — in
// particular no `crypto`.
//
// Why this file exists: keys.ts and signing.ts are Node-only (they open with
// `import { createHash, randomBytes } from 'crypto'` / `createHmac,
// timingSafeEqual`). The developer API-docs page is a client component that
// wanted four of these constants, and importing them from those modules pulled
// the ENTIRE crypto-browserify polyfill into that route's browser bundle —
// measured at 124 kB gzip / 409 kB raw, about ten times the page's own weight,
// for four numbers and a string.
//
// keys.ts and signing.ts re-export everything below as VALUES, so every
// existing import site (API routes, scripts/verify-integrations.ts) keeps
// working untouched. Client code should import from HERE.

export const API_KEY_PREFIX = 'eq_live_'
export const WEBHOOK_SECRET_PREFIX = 'whsec_'
export const INBOUND_TOKEN_PREFIX = 'eqin_'

export const API_SCOPES = ['read', 'write'] as const
export type ApiScope = (typeof API_SCOPES)[number]

export const API_RATE_LIMIT_PER_MINUTE = 120 // enforced in authenticate_api_key()

export const SIGNATURE_HEADER = 'x-edgequote-signature'
export const EVENT_HEADER = 'x-edgequote-event'
export const DELIVERY_HEADER = 'x-edgequote-delivery'
export const SIGNATURE_TOLERANCE_SECONDS = 300
