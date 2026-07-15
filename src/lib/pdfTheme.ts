// ── Shared PDF theme ─────────────────────────────────────────────────────────
// The ONE home for the visual constants every generated PDF shares: the palette
// and the branding logo-box size.
//
// STATUS: the three document PDFs — QuotePDF.tsx, InvoicePDF.tsx, ReceiptPDF.tsx
// — still carry their own byte-identical copies of both. They are OWNER-FROZEN;
// migrating them onto this module is a separate, separately-approved task. The
// values below were copied verbatim from QuotePDF.tsx so that migration is a
// pure no-op diff. If you change a value here, you have forked the design system
// until those three are migrated — don't.
//
// Deliberately NOT here: money/date formatters. Those already exist as
// `formatCurrency` / `parseLocalDate` in `@/lib/utils` and must be imported from
// there; a second copy in this file would be the exact duplication this module
// exists to end.

/** Palette shared by every generated PDF. Verbatim from QuotePDF.tsx:9-17. */
export const PDF_COLORS = {
  green: '#00C896',
  dark: '#0D1420',
  ink: '#1A2333',
  muted: '#6B7A90',
  faint: '#9AA7BB',
  line: '#E2E8F0',
  bgSoft: '#F6F9FC',
}

/**
 * Logo box size the 3 document PDFs use. Pasted 3× today; this is the shared home.
 *
 * Honours the Branding `logo_scale` (%), capped so a large scale can't push the
 * header off the page. A missing/zero scale, or anything under 50%, falls back
 * to 100% — matching QuotePDF.tsx:105-109 exactly.
 */
export function pdfLogoSize(logoScale: number | null | undefined): { width: number; height: number } {
  const scale = logoScale && logoScale >= 50 ? logoScale : 100
  return {
    width: Math.min(200, 130 * (scale / 100)),
    height: Math.min(105, 70 * (scale / 100)),
  }
}
