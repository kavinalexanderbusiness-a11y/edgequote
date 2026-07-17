'use client'

// ── Contextual help ──────────────────────────────────────────────────────────
// A quiet "?" that sits next to the thing it explains and deep-links into the
// Help Center at the right article. Deliberately NOT a tooltip or a popover:
//   • a tooltip can't be read on a phone (no hover) and can't be copied,
//   • a popover would fork the content — a second, shorter, drifting explanation
//     living in a component instead of in lib/help/content.
// One source of truth, one place to keep accurate. The `id` is checked against
// the content module at build time via the HelpArticleId union, so a link can't
// rot into a dead anchor when an article is renamed.

import Link from 'next/link'
import { HELP_ARTICLES, helpHref } from '@/lib/help/content'
import { HelpCircle } from 'lucide-react'
import { cn } from '@/lib/utils'

/** Every id the content module actually defines — a typo won't compile. */
export type HelpArticleId = (typeof HELP_ARTICLES)[number]['id']

export function HelpLink({ id, label, className }: {
  id: HelpArticleId
  /** Screen-reader text. Defaults to the article's own title. */
  label?: string
  className?: string
}) {
  const article = HELP_ARTICLES.find(a => a.id === id)
  const text = label || (article ? `Help: ${article.title}` : 'Help')
  return (
    <Link
      href={helpHref(id)}
      aria-label={text}
      title={text}
      className={cn(
        'inline-flex items-center justify-center text-ink-faint hover:text-accent-text transition-colors rounded',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
        className,
      )}
    >
      <HelpCircle className="w-3.5 h-3.5" />
    </Link>
  )
}
