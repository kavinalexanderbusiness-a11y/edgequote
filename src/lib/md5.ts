// ── md5, in the browser ──────────────────────────────────────────────────────
//
// Exists for exactly one reason: the terms-payment classification is welded to
// the terms it was computed from by a fingerprint, and the database's half of
// that comparison is `quote_terms_fingerprint()` = `md5(btrim(terms_text))`.
// The owner's Settings save is a client component writing an UPSERT (the
// settings-lane contract — nothing else ever creates that row), so the
// fingerprint has to be computable in the browser, and Web Crypto offers
// SHA-* but not MD5.
//
// ⚠️ This is NOT a security primitive and must never be used as one. MD5 is
// chosen because Postgres already computes it and the two answers must be
// byte-identical; the property being relied on is determinism, not collision
// resistance. A collision here would let a stale classification look fresh —
// which requires an attacker who can already write the owner's terms, at which
// point they can write the claim too.
//
// ⭐ Correctness is PROVEN, not assumed: verify:payment-timing-copy runs this
// implementation against node:crypto's md5 over a corpus that includes empty
// input, unicode, emoji and multi-block lengths. If it ever disagrees, every
// acceptance under terms fails closed (loudly) and the guard goes red.

const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
]

// K[i] = floor(abs(sin(i + 1)) * 2^32), the standard table.
const K = (() => {
  const k = new Uint32Array(64)
  for (let i = 0; i < 64; i++) k[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296)
  return k
})()

const rotl = (x: number, c: number) => (x << c) | (x >>> (32 - c))

/** Lowercase hex md5 of a string, encoded as UTF-8 first (as Postgres does). */
export function md5(input: string): string {
  const bytes = new TextEncoder().encode(input)
  const len = bytes.length
  // Pad to 56 mod 64, then 8 bytes of little-endian bit length.
  const withPad = (((len + 8) >>> 6) + 1) << 6
  const buf = new Uint8Array(withPad)
  buf.set(bytes)
  buf[len] = 0x80
  const bitLen = len * 8
  // Only the low 32 bits of the length are written; inputs here are terms text,
  // never 512MB, and the high word stays zero exactly as it would in Postgres.
  const dv = new DataView(buf.buffer)
  dv.setUint32(withPad - 8, bitLen >>> 0, true)
  dv.setUint32(withPad - 4, Math.floor(bitLen / 4294967296), true)

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476
  const M = new Uint32Array(16)

  for (let off = 0; off < withPad; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = dv.getUint32(off + i * 4, true)
    let A = a0, B = b0, C = c0, D = d0
    for (let i = 0; i < 64; i++) {
      let F: number, g: number
      if (i < 16) { F = (B & C) | (~B & D); g = i }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16 }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16 }
      else { F = C ^ (B | ~D); g = (7 * i) % 16 }
      F = (F + A + K[i] + M[g]) >>> 0
      A = D; D = C; C = B
      B = (B + rotl(F, S[i])) >>> 0
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0
    c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0
  }

  const hex = (n: number) => {
    let s = ''
    for (let i = 0; i < 4; i++) s += ((n >>> (i * 8)) & 0xff).toString(16).padStart(2, '0')
    return s
  }
  return hex(a0) + hex(b0) + hex(c0) + hex(d0)
}
