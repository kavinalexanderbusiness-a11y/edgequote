'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { Card, CardHeader, CardBody } from '@/components/ui/Card'
import { Phone, MapPin, Clock, Navigation } from 'lucide-react'

interface TodayJob {
  id: string
  title: string
  start_time: string | null
  customers?: { name: string; phone: string | null } | null
  properties?: { address: string | null } | null
}

function localToday(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function TodayJobs() {
  const supabase = createClient()
  const [jobs, setJobs] = useState<TodayJob[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      const { data } = await supabase
        .from('jobs')
        .select('id, title, start_time, customers(name, phone), properties(address)')
        .eq('user_id', user!.id)
        .eq('scheduled_date', localToday())
        .in('status', ['scheduled', 'in_progress'])
        .order('start_time', { nullsFirst: true })
      setJobs((data as unknown as TodayJob[]) || [])
      setLoading(false)
    }
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <Card>
      <CardHeader className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-ink">Today&apos;s Jobs</h2>
        <Link href="/dashboard/routes" className="text-xs text-accent hover:text-accent-hover flex items-center gap-1">
          Plan route <Navigation className="w-3 h-3" />
        </Link>
      </CardHeader>
      <CardBody className="p-0">
        {loading ? (
          <div className="py-10 text-center text-sm text-ink-muted">Loading...</div>
        ) : jobs.length === 0 ? (
          <div className="py-10 text-center text-sm text-ink-muted">Nothing scheduled today.</div>
        ) : (
          <div className="divide-y divide-border">
            {jobs.map(j => {
              const address = j.properties?.address || null
              const mapsUrl = address
                ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`
                : null
              return (
                <div key={j.id} className="flex items-center justify-between gap-3 px-5 py-3.5">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-ink truncate">{j.title}</p>
                    <div className="flex items-center gap-3 mt-0.5 flex-wrap">
                      {j.start_time && (
                        <span className="text-xs text-ink-muted flex items-center gap-1">
                          <Clock className="w-3 h-3" />{j.start_time.slice(0, 5)}
                        </span>
                      )}
                      {address && <span className="text-xs text-ink-faint truncate">{address}</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {j.customers?.phone && (
                      
                        href={`tel:${j.customers.phone}`}
                        className="w-9 h-9 rounded-lg bg-accent/10 text-accent flex items-center justify-center hover:bg-accent/20 transition-colors"
                        title={`Call ${j.customers.name}`}
                      >
                        <Phone className="w-4 h-4" />
                      </a>
                    )}
                    {mapsUrl && (
                      
                        href={mapsUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="w-9 h-9 rounded-lg bg-surface border border-border text-ink-muted flex items-center justify-center hover:text-ink transition-colors"
                        title="Open in Maps"
                      >
                        <MapPin className="w-4 h-4" />
                      </a>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </CardBody>
    </Card>
  )
}