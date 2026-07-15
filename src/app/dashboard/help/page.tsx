'use client'

// ── Help Center ──────────────────────────────────────────────────────────────
// Renders lib/help/content — the ONE source every help surface reads. This page
// adds no content of its own; it searches, groups and links. A contextual "?"
// anywhere in the app deep-links here via helpHref(id) and lands on the article.

import { useEffect, useMemo, useRef, useState } from 'react'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card, CardBody } from '@/components/ui/Card'
import { SearchInput } from '@/components/ui/SearchInput'
import { FilterPill } from '@/components/ui/FilterPill'
import { EmptyState } from '@/components/ui/EmptyState'
import { cn } from '@/lib/utils'
import {
  HELP_ARTICLES, HELP_CATEGORIES, searchHelp,
  type HelpArticle, type HelpCategory,
} from '@/lib/help/content'
import { LifeBuoy, Search, ChevronDown } from 'lucide-react'

export default function HelpPage() {
  const [query, setQuery] = useState('')
  const [cat, setCat] = useState<HelpCategory | 'all'>('all')
  const [open, setOpen] = useState<string | null>(null)
  const refs = useRef<Record<string, HTMLDivElement | null>>({})

  // Land on the article a contextual link pointed at: open it and scroll to it.
  // Runs once — after that the URL hash is just history, and re-reacting to it
  // would fight the user every time they opened something else.
  useEffect(() => {
    const id = typeof window !== 'undefined' ? window.location.hash.slice(1) : ''
    if (!id || !HELP_ARTICLES.some(a => a.id === id)) return
    setOpen(id)
    // Wait for the accordion to paint before measuring where to scroll.
    const t = window.setTimeout(() => refs.current[id]?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60)
    return () => window.clearTimeout(t)
  }, [])

  const results = useMemo(() => {
    const byCat = cat === 'all' ? HELP_ARTICLES : HELP_ARTICLES.filter(a => a.category === cat)
    return searchHelp(query, byCat)
  }, [query, cat])

  // While searching, the category grouping just gets in the way — results are
  // already ranked by relevance, so show them as one ordered list.
  const searching = query.trim().length > 0

  return (
    <div>
      <PageHeader
        title="Help"
        description="How this app actually behaves — including the parts that are deliberately surprising."
      />

      <div className="space-y-4">
        <SearchInput
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search help — try “autopay”, “expired”, “rain”, “why didn’t it send”"
          aria-label="Search help"
        />

        {!searching && (
          <div className="flex flex-wrap gap-1.5">
            <FilterPill active={cat === 'all'} onClick={() => setCat('all')}>All</FilterPill>
            {HELP_CATEGORIES.map(c => (
              <FilterPill key={c.key} active={cat === c.key} onClick={() => setCat(c.key)}>{c.label}</FilterPill>
            ))}
          </div>
        )}

        {results.length === 0 ? (
          <EmptyState
            icon={Search}
            title="Nothing matches that"
            description={`No help article mentions “${query.trim()}”. Try a plainer word — “paid”, “route”, “consent” — or ask us directly.`}
          />
        ) : searching ? (
          <div className="space-y-2">
            <p className="text-xs text-ink-faint">{results.length} result{results.length !== 1 ? 's' : ''}</p>
            {results.map(a => (
              <ArticleRow key={a.id} a={a} open={open === a.id} onToggle={() => setOpen(open === a.id ? null : a.id)}
                anchor={el => { refs.current[a.id] = el }} />
            ))}
          </div>
        ) : (
          HELP_CATEGORIES
            .filter(c => cat === 'all' || cat === c.key)
            .map(c => {
              const items = results.filter(a => a.category === c.key)
              if (!items.length) return null
              return (
                <div key={c.key} className="space-y-2">
                  <div className="pt-2">
                    <h2 className="text-sm font-semibold text-ink tracking-tight">{c.label}</h2>
                    <p className="text-xs text-ink-faint">{c.blurb}</p>
                  </div>
                  {items.map(a => (
                    <ArticleRow key={a.id} a={a} open={open === a.id} onToggle={() => setOpen(open === a.id ? null : a.id)}
                      anchor={el => { refs.current[a.id] = el }} />
                  ))}
                </div>
              )
            })
        )}

        <Card>
          <CardBody className="flex items-start gap-3">
            <LifeBuoy className="w-4 h-4 text-accent-text shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-ink">Still stuck?</p>
              <p className="text-xs text-ink-muted mt-0.5">
                If the answer isn&rsquo;t here, it&rsquo;s our gap and not yours. Tell us what you were trying to do and
                we&rsquo;ll both fix the app and write the missing page.
              </p>
            </div>
          </CardBody>
        </Card>
      </div>
    </div>
  )
}

function ArticleRow({ a, open, onToggle, anchor }: {
  a: HelpArticle; open: boolean; onToggle: () => void; anchor: (el: HTMLDivElement | null) => void
}) {
  // Not the shared <Collapsible/>: this needs a controlled open state (deep links
  // and search both drive it from outside) and scroll-into-view anchoring, neither
  // of which that primitive exposes. Same visual language, different contract.
  return (
    <div ref={anchor} id={a.id} className="scroll-mt-4 rounded-card border border-border bg-bg-secondary overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="w-full text-left px-4 py-3 flex items-start justify-between gap-3 hover:bg-bg-tertiary/40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
      >
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink tracking-tight">{a.title}</p>
          <p className="text-xs text-ink-muted mt-0.5">{a.summary}</p>
        </div>
        <ChevronDown className={cn('w-4 h-4 text-ink-faint shrink-0 mt-0.5 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="px-4 pb-4 pt-1 space-y-4 border-t border-border/60">
          {a.sections.map((s, i) => (
            <div key={i}>
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-ink-faint mb-1.5">{s.heading}</p>
              <div className="space-y-2">
                {s.body.map((p, j) => (
                  <p key={j} className="text-sm text-ink-muted leading-relaxed">{renderInline(p)}</p>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// The content module writes **bold** and `code` — the same markers the message
// templates use, so authors only learn one convention for the whole app.
function renderInline(text: string) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
  return parts.map((p, i) => {
    if (p.startsWith('**') && p.endsWith('**')) return <strong key={i} className="text-ink font-semibold">{p.slice(2, -2)}</strong>
    if (p.startsWith('`') && p.endsWith('`')) return <code key={i} className="font-mono text-[0.85em] text-ink border border-border rounded px-1 py-0.5">{p.slice(1, -1)}</code>
    return <span key={i}>{p}</span>
  })
}
