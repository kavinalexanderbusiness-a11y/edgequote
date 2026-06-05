'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { Quote } from '@/types'
import { QuoteList } from '@/components/quotes/QuoteList'
import { PageHeader } from '@/components/layout/PageHeader'
import { Button } from '@/components/ui/Button'
import { Plus } from 'lucide-react'

export default function QuotesPage() {
  const [quotes, setQuotes] = useState<Quote[]>([])
  const [loading, setLoading] = useState(true)

  const supabase = createClient()

  async function fetchQuotes() {
    const { data: { user } } = await supabase.auth.getUser()
    const { data } = await supabase
      .from('quotes')
      .select('*')
      .eq('user_id', user!.id)
      .order('created_at', { ascending: false })
    setQuotes(data || [])
    setLoading(false)
  }

  useEffect(() => { fetchQuotes() }, [])

  async function handleDelete(id: string) {
    await supabase.from('quotes').delete().eq('id', id)
    setQuotes(prev => prev.filter(q => q.id !== id))
  }

  return (
    <div className="max-w-6xl space-y-6">
      <PageHeader
        title="Quotes"
        description={`${quotes.length} quote${quotes.length !== 1 ? 's' : ''} total`}
        action={
          <Link href="/dashboard/quotes/new">
            <Button><Plus className="w-4 h-4" /> New Quote</Button>
          </Link>
        }
      />
      {loading ? (
        <div className="text-center py-16 text-sm text-ink-muted">Loading quotes...</div>
      ) : (
        <QuoteList quotes={quotes} onDelete={handleDelete} />
      )}
    </div>
  )
}
