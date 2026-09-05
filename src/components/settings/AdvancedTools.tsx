'use client'

import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { useModules } from '@/hooks/useModules'
import { modulesForNavigation } from '@/lib/modules'
import { Card, CardHeader, CardBody } from '@/components/ui/Card'

/** Navigation only: uses the same enabled modules as search and the sidebar. */
export function AdvancedTools() {
  const { visible } = useModules()
  const tools = modulesForNavigation(visible, 'settings')

  return (
    <Card>
      <CardHeader>
        <h2 className="text-sm font-semibold text-ink">Advanced tools</h2>
        <p className="mt-1 text-sm text-ink-muted">Review activity, manage automation and connect other apps.</p>
      </CardHeader>
      {tools.length > 0 ? (
        <nav aria-label="Advanced tools" className="divide-y divide-border">
          {tools.map(({ key, label, href, description, icon: Icon }) => (
            <Link key={key} href={href}
              className="flex items-start gap-3 px-6 py-4 hover:bg-surface-raised transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40">
              <Icon aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-ink-muted" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-ink">{label}</span>
                <span className="mt-1 block text-sm text-ink-muted">{description}</span>
              </span>
              <ArrowRight aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-ink-faint" />
            </Link>
          ))}
        </nav>
      ) : (
        <CardBody><p className="text-sm text-ink-muted">These tools are turned off. You can enable them in Features.</p></CardBody>
      )}
    </Card>
  )
}
