import { Leaf } from 'lucide-react'

// ── BrandHeader ───────────────────────────────────────────────────────────────
// Shared logo + business name + subtitle for the CUSTOMER-FACING pages (booking
// flow + portal). Both used to hand-roll this verbatim and quietly drifted
// (mb-5 vs mb-4, different fallback names). One component → one brand.
export function BrandHeader({
  logoUrl,
  name,
  subtitle,
}: {
  logoUrl?: string | null
  name?: string | null
  subtitle: string
}) {
  return (
    <div className="flex items-center gap-3 mb-5">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {logoUrl ? (
        <img src={logoUrl} alt="" className="h-10 w-auto object-contain" />
      ) : (
        <div className="w-10 h-10 rounded-xl bg-accent/15 border border-accent/25 flex items-center justify-center">
          <Leaf className="w-5 h-5 text-accent-text" />
        </div>
      )}
      <div className="min-w-0">
        <p className="text-base font-bold text-ink truncate">{name || 'Your Service Provider'}</p>
        <p className="text-xs text-ink-muted truncate">{subtitle}</p>
      </div>
    </div>
  )
}
