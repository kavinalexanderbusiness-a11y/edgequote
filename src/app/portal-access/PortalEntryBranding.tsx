'use client'

import { useSearchParams } from 'next/navigation'

// This is a presentation hint from the public marketing site, never a tenant,
// customer or authorization selector. Recovery stays neutral and unchanged.
// An exact allowlist avoids caller-controlled names, links or redirects.
export function PortalEntryBranding() {
  const searchParams = useSearchParams()
  const sites = searchParams.getAll('site')
  if (sites.length !== 1 || sites[0] !== 'edge-property-services-yyc') return null

  return (
    <a
      href="https://edgepropertyservicesyyc.ca"
      aria-label="Return to the Edge Property Services website"
      data-portal-business="edge-property-services-yyc"
      className="mb-8 inline-flex min-h-[48px] flex-col items-start rounded-sm text-accent-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-text focus-visible:ring-offset-4 focus-visible:ring-offset-bg"
    >
      <span className="text-2xl font-bold tracking-[0.12em]">EDGE</span>
      <span className="text-[10px] font-semibold uppercase tracking-[0.18em]">Property Services</span>
      <span className="mt-3 text-sm text-ink-muted underline underline-offset-4">← Return to website</span>
    </a>
  )
}
