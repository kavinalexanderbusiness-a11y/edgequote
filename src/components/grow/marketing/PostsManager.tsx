'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { FilterPill } from '@/components/ui/FilterPill'
import { EmptyState } from '@/components/ui/EmptyState'
import { Skeleton } from '@/components/ui/Skeleton'
import { CHANNELS, channel as channelDef } from '@/lib/marketing/channels'
import { listPieces, toggleFavorite, duplicatePiece, setArchived } from '@/lib/marketing/library'
import { captionFor, parseHashtags } from '@/lib/marketing/publishQueue'
import { cn } from '@/lib/utils'
import { Search, Star, Copy, Check, ExternalLink, CopyPlus, Archive, ArchiveRestore, Pencil, LayoutGrid, X } from 'lucide-react'
import type { ContentPiece, ContentStatus, MarketingCampaign, MarketingChannel, PostFilters, Season } from '@/lib/marketing/types'

const STATUSES: ContentStatus[] = ['draft', 'scheduled', 'published', 'failed']
const SEASONS: Season[] = ['spring', 'summer', 'fall', 'winter']
const STATUS_TONE: Record<ContentStatus, string> = {
  draft: 'text-ink-muted', approved: 'text-sky-400', scheduled: 'text-accent', published: 'text-emerald-400', failed: 'text-red-400',
}
// Same words the calendar uses for a content piece ("Posted", not "Published").
const STATUS_LABEL: Record<ContentStatus, string> = {
  draft: 'Draft', approved: 'Ready', scheduled: 'Scheduled', published: 'Posted', failed: 'Failed',
}

export function PostsManager({ userId, initialPieces, initialHasMore, campaigns, initialCampaignId }: {
  userId: string
  initialPieces: ContentPiece[]
  initialHasMore: boolean
  campaigns: MarketingCampaign[]
  initialCampaignId?: string | null
}) {
  const supabase = useMemo(() => createClient(), [])
  const [filters, setFilters] = useState<PostFilters>({ campaignId: initialCampaignId || null })
  const [search, setSearch] = useState('')
  const [pieces, setPieces] = useState(initialPieces)
  const [hasMore, setHasMore] = useState(initialHasMore)
  const [loading, setLoading] = useState(false)
  const firstRender = useRef(true)

  const reload = useCallback(async (f: PostFilters) => {
    setLoading(true)
    const { pieces: rows, hasMore: more } = await listPieces(supabase, userId, f, 0)
    setPieces(rows); setHasMore(more); setLoading(false)
  }, [supabase, userId])

  // Debounced reload whenever filters/search change (skip the very first render).
  useEffect(() => {
    if (firstRender.current) { firstRender.current = false; return }
    const t = setTimeout(() => reload({ ...filters, search: search.trim() || undefined }), 250)
    return () => clearTimeout(t)
  }, [filters, search, reload])

  async function loadMore() {
    setLoading(true)
    const { pieces: rows, hasMore: more } = await listPieces(supabase, userId, { ...filters, search: search.trim() || undefined }, pieces.length)
    setPieces(prev => [...prev, ...rows]); setHasMore(more); setLoading(false)
  }

  function patch(p: Partial<PostFilters>) { setFilters(prev => ({ ...prev, ...p })) }

  function onLocalUpdate(updated: ContentPiece) {
    setPieces(prev => prev.map(p => p.id === updated.id ? updated : p))
  }
  async function favorite(p: ContentPiece) {
    const saved = await toggleFavorite(supabase, p.id, !p.favorite)
    if (saved) onLocalUpdate(saved)
  }
  async function duplicate(p: ContentPiece) {
    const copy = await duplicatePiece(supabase, userId, p.id)
    if (copy) setPieces(prev => [copy, ...prev])
  }
  async function archive(p: ContentPiece) {
    const saved = await setArchived(supabase, p.id, !p.archived_at)
    if (saved) {
      // if we're viewing active and just archived (or vice-versa), drop it from the list
      setPieces(prev => prev.filter(x => x.id !== p.id))
    }
  }

  const campaignName = (id: string | null) => campaigns.find(c => c.id === id)?.name || null

  return (
    <div className="space-y-4">
      {/* Search + filters */}
      <div className="space-y-2.5">
        <div className="relative">
          <Search className="w-4 h-4 text-ink-faint absolute left-3 top-1/2 -translate-y-1/2" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search posts…"
            className="w-full bg-bg-tertiary border border-border rounded-xl pl-9 pr-3 py-2.5 text-sm text-ink placeholder:text-ink-faint focus:outline-none focus:ring-2 focus:ring-accent/50" />
        </div>
        <div className="flex gap-1.5 flex-wrap">
          <FilterPill active={!!filters.favorite} onClick={() => patch({ favorite: !filters.favorite })}><Star className="w-3 h-3" /> Favorites</FilterPill>
          <FilterPill active={!!filters.archived} onClick={() => patch({ archived: !filters.archived })}><Archive className="w-3 h-3" /> Archived</FilterPill>
          <span className="w-px bg-border mx-0.5" />
          {STATUSES.map(s => <FilterPill key={s} active={filters.status === s} onClick={() => patch({ status: filters.status === s ? null : s })}><span className="capitalize">{s}</span></FilterPill>)}
        </div>
        <div className="flex gap-1.5 flex-wrap">
          {CHANNELS.map(c => <FilterPill key={c.key} active={filters.channel === c.key} onClick={() => patch({ channel: filters.channel === c.key ? null : c.key })}><c.icon className="w-3 h-3" /> {c.label}</FilterPill>)}
        </div>
        <div className="flex gap-1.5 flex-wrap items-center">
          {SEASONS.map(s => <FilterPill key={s} active={filters.season === s} onClick={() => patch({ season: filters.season === s ? null : s })}><span className="capitalize">{s}</span></FilterPill>)}
          {campaigns.length > 0 && (
            <select value={filters.campaignId || ''} onChange={e => patch({ campaignId: e.target.value || null })}
              className="bg-bg-tertiary border border-border rounded-full px-3 py-1.5 text-xs text-ink-muted focus:outline-none">
              <option value="">All campaigns</option>
              {campaigns.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          )}
        </div>
      </div>

      {loading && pieces.length === 0 ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="rounded-card border border-border bg-bg-secondary p-3 space-y-2">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-5/6" />
              <Skeleton className="h-3 w-2/3" />
            </div>
          ))}
        </div>
      ) : pieces.length === 0 ? (
        <EmptyState icon={LayoutGrid} title="No posts match your filters" description="Adjust the filters, or generate posts in Compose, Campaigns, or the calendar." />
      ) : (
        // Dim while a filter/search reload is in flight, so the change registers instead
        // of the stale list just sitting there.
        <div className={cn('grid gap-3 sm:grid-cols-2 lg:grid-cols-3 transition-opacity', loading && 'opacity-50')}>
          {pieces.map(p => (
            <PostCard key={p.id} piece={p} campaignName={campaignName(p.campaign_id)} supabase={supabase}
              onFavorite={() => favorite(p)} onDuplicate={() => duplicate(p)} onArchive={() => archive(p)} onUpdate={onLocalUpdate} />
          ))}
        </div>
      )}

      {pieces.length > 0 && (
        <div className="flex justify-center pt-1">
          {hasMore ? (
            <Button variant="secondary" size="sm" onClick={loadMore} loading={loading}>Load more</Button>
          ) : (
            <p className="text-[11px] text-ink-faint">That’s everything.</p>
          )}
        </div>
      )}
    </div>
  )
}

function PostCard({ piece, campaignName, supabase, onFavorite, onDuplicate, onArchive, onUpdate }: {
  piece: ContentPiece
  campaignName: string | null
  supabase: ReturnType<typeof createClient>
  onFavorite: () => void
  onDuplicate: () => void
  onArchive: () => void
  onUpdate: (p: ContentPiece) => void
}) {
  const def = channelDef(piece.channel)
  const [copied, setCopied] = useState(false)
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(piece.title || '')
  const [body, setBody] = useState(piece.body)
  const [tags, setTags] = useState(piece.hashtags.join(' '))
  const [saving, setSaving] = useState(false)

  function copy() {
    navigator.clipboard?.writeText(captionFor(piece)).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) })
  }
  async function save() {
    setSaving(true)
    const hashtags = parseHashtags(tags)
    const { data } = await supabase.from('content_pieces').update({ title: title.trim() || null, body: body.trim(), hashtags }).eq('id', piece.id).select('*').maybeSingle()
    setSaving(false)
    if (data) { onUpdate(data as ContentPiece); setEditing(false) }
  }

  return (
    <Card className="p-3 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <def.icon className="w-3.5 h-3.5 text-ink-muted shrink-0" />
        <span className="text-xs font-semibold text-ink">{def.label}</span>
        <span className={cn('text-[10px]', STATUS_TONE[piece.status])}>· {STATUS_LABEL[piece.status]}</span>
        <button onClick={onFavorite} className="ml-auto shrink-0" title="Favorite">
          <Star className={cn('w-4 h-4', piece.favorite ? 'fill-amber-400 text-amber-400' : 'text-ink-faint hover:text-ink')} />
        </button>
      </div>

      {editing ? (
        <div className="space-y-1.5">
          {def.usesTitle && <input value={title} onChange={e => setTitle(e.target.value)} placeholder="Headline" className="w-full bg-bg-tertiary border border-border rounded-lg px-2 py-1.5 text-xs text-ink" />}
          <textarea value={body} onChange={e => setBody(e.target.value)} rows={5} className="w-full bg-bg-tertiary border border-border rounded-lg px-2 py-1.5 text-xs text-ink resize-y" />
          {def.usesHashtags && <input value={tags} onChange={e => setTags(e.target.value)} placeholder="hashtags" className="w-full bg-bg-tertiary border border-border rounded-lg px-2 py-1.5 text-xs text-accent" />}
          <div className="flex gap-1.5">
            <Button size="sm" onClick={save} loading={saving}>Save</Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}><X className="w-3.5 h-3.5" /></Button>
          </div>
        </div>
      ) : (
        <>
          {piece.title && <p className="text-sm font-medium text-ink line-clamp-1">{piece.title}</p>}
          <p className="text-xs text-ink-muted line-clamp-4 whitespace-pre-wrap leading-relaxed flex-1">{piece.body || '(empty)'}</p>
          {piece.hashtags.length > 0 && <p className="text-[10px] text-accent line-clamp-1 break-words">{piece.hashtags.map(h => `#${h}`).join(' ')}</p>}
        </>
      )}

      <div className="flex items-center gap-1 flex-wrap pt-1 border-t border-border/60">
        {campaignName && <span className="text-[10px] text-ink-faint truncate max-w-[90px]" title={campaignName}>◆ {campaignName}</span>}
        <div className="ml-auto flex items-center gap-0.5">
          <IconBtn title="Copy caption" onClick={copy}>{copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}</IconBtn>
          <IconBtn title="Edit" onClick={() => setEditing(e => !e)}><Pencil className="w-3.5 h-3.5" /></IconBtn>
          <IconBtn title="Duplicate" onClick={onDuplicate}><CopyPlus className="w-3.5 h-3.5" /></IconBtn>
          {/* Copy the caption in the same gesture as opening the platform — one tap to post. */}
          <IconBtn title="Copy caption & open platform" onClick={() => { copy(); window.open(def.openUrl, '_blank') }}><ExternalLink className="w-3.5 h-3.5" /></IconBtn>
          <IconBtn title={piece.archived_at ? 'Restore' : 'Archive'} onClick={onArchive}>{piece.archived_at ? <ArchiveRestore className="w-3.5 h-3.5" /> : <Archive className="w-3.5 h-3.5" />}</IconBtn>
        </div>
      </div>
    </Card>
  )
}

function IconBtn({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" title={title} onClick={onClick} className="p-1.5 rounded-lg text-ink-faint hover:text-ink hover:bg-surface transition-colors">{children}</button>
}
