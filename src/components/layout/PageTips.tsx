'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { CircleHelp } from 'lucide-react'
import { contextualHelpHref } from '@/lib/help/context'

export function PageTips() {
  const pathname = usePathname()
  if (pathname === '/dashboard/help') return null
  return (
    <Link href={contextualHelpHref(pathname)}
      className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-border px-3 text-sm font-medium text-ink-muted hover:text-ink hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
      <CircleHelp className="h-4 w-4" aria-hidden="true" />
      Tips
    </Link>
  )
}
