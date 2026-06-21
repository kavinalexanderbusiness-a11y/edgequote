'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Customer } from '@/types'
import { formatDate, getInitials } from '@/lib/utils'
import { createClient } from '@/lib/supabase/client'
import { ensurePortalToken, portalUrl } from '@/lib/portal'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Edit2, Trash2, Phone, Mail, FileText, Search, Link2, ExternalLink, Check } from 'lucide-react'

interface CustomerListProps {
  customers: Customer[]
  onEdit: (customer: Customer) => void
  onDelete: (id: string) => Promise<void>
}

export function CustomerList({ customers, onEdit, onDelete }: CustomerListProps) {
  const router = useRouter()
  const [search, setSearch] = useState('')
  const [deleting, setDeleting] = useState<string | null>(null)
  const [portalBusy, setPortalBusy] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  const filtered = customers.filter(c =>
    c.name.toLowerCase().includes(search.toLowerCase()) ||
    c.email?.toLowerCase().includes(search.toLowerCase()) ||
    c.city?.toLowerCase().includes(search.toLowerCase())
  )

  async function handleDelete(id: string) {
    if (!confirm('Delete this customer? Their quote history will be preserved.')) return
    setDeleting(id)
    await onDelete(id)
    setDeleting(null)
  }

  function showToast(msg: string) { setToast(msg); setTimeout(() => setToast(null), 2600) }

  // Get (or mint) the customer's magic-link portal token.
  async function getToken(customerId: string): Promise<string | null> {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return null
    return ensurePortalToken(supabase, user.id, customerId)
  }
  async function copyPortal(customerId: string) {
    setPortalBusy(customerId)
    try {
      const token = await getToken(customerId)
      if (!token) { showToast('Could not create the portal link — run the customer-portal migration first.'); return }
      const url = portalUrl(token)
      try { await navigator.clipboard.writeText(url) } catch { window.prompt('Copy this portal link:', url) }
      showToast('Portal link copied to clipboard')
    } finally { setPortalBusy(null) }
  }
  async function openPortal(customerId: string) {
    setPortalBusy(customerId)
    try {
      const token = await getToken(customerId)
      if (!token) { showToast('Could not create the portal link — run the customer-portal migration first.'); return }
      window.open(portalUrl(token), '_blank', 'noopener')
    } finally { setPortalBusy(null) }
  }

  return (
    <div className="space-y-4">
      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-faint" />
        <input
          type="text"
          placeholder="Search customers..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-full bg-surface border border-border-strong rounded-xl pl-10 pr-4 py-3 text-base sm:text-sm text-ink placeholder:text-ink-faint outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 transition-all"
        />
      </div>

      {/* List */}
      {filtered.length === 0 ? (
        <Card className="py-14 text-center text-sm text-ink-muted">
          {search ? 'No customers match your search.' : 'No customers yet.'}
        </Card>
      ) : (
        <div className="grid gap-3">
          {filtered.map(c => (
            <Card key={c.id} className="flex items-center gap-4 px-5 py-4 hover:border-border-strong transition-colors">
              {/* Avatar */}
              <div className="w-10 h-10 rounded-full bg-accent/10 border border-accent/20 flex items-center justify-center flex-shrink-0">
                <span className="text-sm font-bold text-accent">{getInitials(c.name)}</span>
              </div>
              {/* Info */}
              <div className="flex-1 min-w-0">
                <Link href={`/dashboard/customers/${c.id}`} className="text-sm font-semibold text-ink hover:text-accent transition-colors">{c.name}</Link>
                <div className="flex items-center gap-4 mt-1 flex-wrap">
                  {c.email && (
                    <a href={`mailto:${c.email}`} className="flex items-center gap-1 text-xs text-ink-muted hover:text-ink hover:underline">
                      <Mail className="w-3 h-3" /> {c.email}
                    </a>
                  )}
                  {c.phone && (
                    <a href={`tel:${c.phone}`} className="flex items-center gap-1 text-xs text-accent hover:underline">
                      <Phone className="w-3 h-3" /> {c.phone}
                    </a>
                  )}
                  {c.city && (
                    <span className="text-xs text-ink-faint">{c.city}, {c.province}</span>
                  )}
                  {c.acquisition_source && (
                    <span className="text-[10px] uppercase tracking-wide text-accent border border-accent/30 bg-accent/10 rounded px-1.5 py-0.5">{c.acquisition_source}</span>
                  )}
                </div>
              </div>
              {/* Added */}
              <p className="text-xs text-ink-faint hidden md:block">{formatDate(c.created_at)}</p>
              {/* Actions */}
              <div className="flex items-center gap-1">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => copyPortal(c.id)}
                  loading={portalBusy === c.id}
                  title="Copy this customer's private portal link (quotes, invoices, history, photos)"
                >
                  <Link2 className="w-4 h-4" /> Portal
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => openPortal(c.id)}
                  title="Open the customer portal in a new tab"
                >
                  <ExternalLink className="w-4 h-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => router.push(`/dashboard/quotes/new?customer=${c.id}`)}
                  title="New quote"
                >
                  <FileText className="w-4 h-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onEdit(c)}
                  title="Edit"
                >
                  <Edit2 className="w-4 h-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleDelete(c.id)}
                  loading={deleting === c.id}
                  className="hover:text-red-400"
                  title="Delete"
                >
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}
      <p className="text-xs text-ink-faint text-right">{filtered.length} customer{filtered.length !== 1 ? 's' : ''}</p>

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 bg-bg-secondary border border-border-strong rounded-full px-4 py-2 text-sm text-ink shadow-lg flex items-center gap-2">
          <Check className="w-4 h-4 text-emerald-400 shrink-0" /> {toast}
        </div>
      )}
    </div>
  )
}
