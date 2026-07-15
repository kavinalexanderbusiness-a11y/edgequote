import type { NextConfig } from 'next'

// ── Security headers ─────────────────────────────────────────────────────────
// This app had NONE. It serves a PUBLIC customer portal and a PUBLIC booking
// funnel — pages that show invoices, hand off to Stripe checkout, and accept a
// homeowner's address and photos. Those are exactly the pages worth framing,
// sniffing and downgrading.
//
// Every header below is safe to ship without a behavioural test. The one that
// ISN'T here is Content-Security-Policy: this app loads Google Maps, Stripe and
// Supabase and uses inline styles, so a CSP written blind would break the portal
// in production and I can't verify it from here. It's the right next step, but it
// needs a browser and a staging deploy — not a guess.
const securityHeaders = [
  // Never speak plain HTTP to this origin again. Vercel already redirects
  // http→https; HSTS is what stops the FIRST request being downgradeable.
  // `preload` is deliberate, but note it's a one-way door in practice — getting
  // off the browser preload list takes months.
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },

  // Stop the browser second-guessing Content-Type. Matters most for the PDFs and
  // JSON we hand back — a sniffed text/html is how an uploaded file becomes a
  // stored XSS.
  { key: 'X-Content-Type-Options', value: 'nosniff' },

  // Clickjacking. Nothing here is meant to be embedded, and the portal has
  // one-tap Approve and Pay buttons — precisely what a transparent overlay wants.
  // SAMEORIGIN rather than DENY only because it costs nothing to leave our own
  // future embeds possible.
  { key: 'X-Frame-Options', value: 'SAMEORIGIN' },

  // Portal URLs CONTAIN the customer's private token. Without this, that token
  // leaks in the Referer header to every outbound link they click — including the
  // Google review link we ask them to click. This is the header that stops a
  // customer's portal link landing in someone else's analytics.
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },

  // Drop capabilities the app doesn't use, so a future dependency can't quietly
  // start asking for them. camera stays enabled for self — JobPhotos uses
  // <input capture> for on-site photos. geolocation is NOT used anywhere
  // (verified: addresses are geocoded server-side from typed input, never from
  // the device).
  { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=(), payment=(), usb=()' },
]

const nextConfig: NextConfig = {
  // REMOVED: experimental.serverActions.allowedOrigins = ['localhost:3000'].
  // No 'use server' exists in this codebase, so it was inert — but it was a trap
  // set for the future: the first Server Action anyone wrote would work locally
  // and be silently rejected in production, because the deployed origin wasn't in
  // that list. Next allows same-origin by default, which is what's actually wanted.

  poweredByHeader: false,   // don't advertise the framework version

  async headers() {
    return [
      // Everything: dashboard, /portal, /book, and the API routes.
      { source: '/:path*', headers: securityHeaders },
    ]
  },
}

export default nextConfig
