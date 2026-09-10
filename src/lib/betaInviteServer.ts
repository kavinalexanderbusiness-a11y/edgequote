// ── Beta invites: the server-only parts ──────────────────────────────────────
// Node crypto + the verification email + the attempt limiter. NEVER import this
// from client code: it drags the crypto polyfill into the bundle (see
// src/lib/integrations/constants.ts) and it has no business there — the raw
// token→hash boundary is exactly what keeps invites server-authoritative.
// scripts/verify-beta-signup.ts fails the build if a 'use client' file names it.

import { createHash, randomBytes } from 'crypto'

// Same construction as api_keys (src/lib/integrations/keys.ts): 32 random bytes
// as hex behind a recognisable prefix. 256 bits means enumeration is not a
// realistic attack; the rate limiter below exists for hygiene, not for safety.
export function generateBetaToken(): string {
  return `eqb_${randomBytes(32).toString('hex')}`
}

/** sha256 hex — what beta_invites.token_hash stores and what every lookup uses.
 *  The table's CHECK constraint (64 hex chars) makes storing a raw token
 *  structurally impossible. */
export function hashBetaToken(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex')
}

// ── The verification email ───────────────────────────────────────────────────
// Transactional, not marketing: the direct answer to a signup the recipient
// just performed — same class as portalAccessEmail, and like it, sent straight
// through sendEmail(): no governor (that is customer-cadence machinery), no
// notification_log (that ledger is keyed on a tenant's customer; this recipient
// has neither yet). The invite ledger row itself records send_count/last_sent_at.
//
// The confirm URL is the only secret-bearing content. No business data travels
// with it, and the "didn't sign up?" line is load-bearing: anyone can type a
// stranger's address into a signup form, so the mail must read correctly to a
// recipient who never asked for it — ignoring it must be safe and sufficient.
export function betaVerifyEmail(confirmUrl: string): { subject: string; html: string; text: string } {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const subject = 'Confirm your EdgeQuote account'
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;padding:28px 22px;color:#111827">
  <p style="margin:0 0 14px;font-size:16px">Welcome to the EdgeQuote beta,</p>
  <p style="margin:0;font-size:15px;line-height:1.55;color:#374151">Confirm your email address to finish creating your account. This link is single-use — requesting a new one replaces it.</p>
  <p style="margin:24px 0 0">
    <a href="${esc(confirmUrl)}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600;font-size:15px">Confirm my email</a>
  </p>
  <p style="margin:26px 0 0;font-size:13px;line-height:1.5;color:#6b7280">
    If you didn’t sign up for EdgeQuote, ignore this message — nothing happens without this link.
  </p>
  <p style="margin:18px 0 0;font-size:13px;color:#9ca3af">— EdgeQuote</p>
</div>`
  const text = [
    'Welcome to the EdgeQuote beta,',
    '',
    'Confirm your email address to finish creating your account. This link is single-use — requesting a new one replaces it.',
    '',
    confirmUrl,
    '',
    'If you didn’t sign up for EdgeQuote, ignore this message — nothing happens without this link.',
    '',
    '— EdgeQuote',
  ].join('\n')
  return { subject, html, text }
}

// ── Attempt limiting ─────────────────────────────────────────────────────────
// Per-IP, in-memory, best-effort: serverless instances each hold their own map,
// so this bounds enthusiasm per warm instance rather than globally. That is the
// honest trade and it is proportionate — the real defences are the 256-bit
// token (guessing is hopeless, and a miss teaches nothing: one uniform
// 'invalid'), and the DB-backed send throttle on the invite row itself
// (send_count / last_sent_at), which survives cold starts and is what actually
// protects the recipient's inbox. portal-access went DB-backed because email
// enumeration was its threat; there is no equivalent oracle here.
const WINDOW_MS = 60 * 60 * 1000
const MAX_ATTEMPTS_PER_WINDOW = 10
const attempts = new Map<string, number[]>()

export function allowBetaAttempt(ip: string): boolean {
  const now = Date.now()
  const kept = (attempts.get(ip) ?? []).filter(t => now - t < WINDOW_MS)
  if (kept.length >= MAX_ATTEMPTS_PER_WINDOW) { attempts.set(ip, kept); return false }
  kept.push(now)
  attempts.set(ip, kept)
  // Unrelated housekeeping so the map cannot grow without bound.
  if (attempts.size > 1000) {
    for (const [k, v] of attempts) if (v.every(t => now - t >= WINDOW_MS)) attempts.delete(k)
  }
  return true
}

/** Resend throttle, enforced against beta_invites.last_sent_at / send_count —
 *  the DB half of the limiter, shared by signup-retry and explicit resend. */
export const RESEND_MIN_INTERVAL_MS = 60 * 1000
export const MAX_VERIFICATION_SENDS = 8
