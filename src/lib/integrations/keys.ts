// Credential minting + hashing for the integrations platform.
//
// API keys are shown ONCE and stored as a sha256 hash + display prefix —
// deliberately NOT the social_connections plaintext precedent. Webhook signing
// secrets and inbound tokens ARE stored readable: the owner must be able to
// see them (the secret verifies signatures; the token IS the endpoint URL).
//
// Node-only (crypto), pure: no env, no I/O.

import { createHash, randomBytes } from 'crypto'

// The constants live in ./constants — a leaf with NO imports, so a browser
// module that only needs a prefix or a limit doesn't drag this file's `crypto`
// import (and its ~124 kB polyfill) into the client bundle. Re-exported as
// VALUES here so every existing `from './keys'` import site is unchanged.
import {
  API_KEY_PREFIX, WEBHOOK_SECRET_PREFIX, INBOUND_TOKEN_PREFIX,
  API_SCOPES, API_RATE_LIMIT_PER_MINUTE, type ApiScope,
} from './constants'
export {
  API_KEY_PREFIX, WEBHOOK_SECRET_PREFIX, INBOUND_TOKEN_PREFIX,
  API_SCOPES, API_RATE_LIMIT_PER_MINUTE, type ApiScope,
}

/** Mint a full API key: `eq_live_` + 64 hex chars (32 random bytes). */
export function generateApiKey(): string {
  return API_KEY_PREFIX + randomBytes(32).toString('hex')
}

/** What we store + compare: sha256 hex of the full key. */
export function hashApiKey(rawKey: string): string {
  return createHash('sha256').update(rawKey, 'utf8').digest('hex')
}

/** What we display after creation: `eq_live_ab12` (prefix + first 4 of body). */
export function displayPrefix(rawKey: string): string {
  return rawKey.slice(0, API_KEY_PREFIX.length + 4)
}

export function isApiKeyShaped(raw: string): boolean {
  return /^eq_live_[0-9a-f]{64}$/.test(raw)
}

export function generateWebhookSecret(): string {
  return WEBHOOK_SECRET_PREFIX + randomBytes(24).toString('hex')
}

export function generateInboundToken(): string {
  return INBOUND_TOKEN_PREFIX + randomBytes(16).toString('hex')
}

export function normalizeScopes(input: unknown): ApiScope[] | null {
  if (!Array.isArray(input) || input.length === 0) return null
  const out: ApiScope[] = []
  for (const s of input) {
    if (s !== 'read' && s !== 'write') return null
    if (!out.includes(s)) out.push(s)
  }
  return out
}
