'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Property } from '@/types'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card, CardBody } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { formatDate } from '@/lib/utils'
import { MapPin, Home, User, Ruler, History } from 'lucide-react'

export default function PropertiesPage() {
  const router = useRouter()
  const [properties, setProperties] = useState<Property[]>([])
  const [loading, setLoading] = useState(true)

  const supabase = createClient()

  useEffect(() => {
    async function fetchProperties() {
      const { data: { user } } = await supabase.auth.getUser()
      const { data } = await supabase
        .from('properties')
        .select('*, customers(id, name, email, phone)')
        .eq('user_id', user!.id)
        .order('created_at', { ascending: false })
      setProperties((data as Property[]) || [])
      setLoading(false)
    }
    fetchProperties()
  }, [])

  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader
        title="Properties"
        description={`${properties.length} propert${properties.length !== 1 ? 'ies' : 'y'} on file`}
      />

      {loading ? (
        <div className="text-center py-16 text-sm text-ink-muted">Loading properties...</div>
      ) : properties.length === 0 ? (
        <EmptyState
          icon={Home}
          title="No properties yet"
          description="Properties are created automatically when you add a customer or save a quote. Add your first customer to get started."
          action={{ label: 'Add a customer', onClick: () => router.push('/dashboard/customers') }}
        />
      ) : (
        <div className="space-y-3">
          {properties.map(property => {
            const hist = Array.isArray(property.measurement_history) ? property.measurement_history : []
            const last = hist.length ? hist[hist.length - 1] : null
            return (
            <Card key={property.id}>
              <CardBody>
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-start gap-3 min-w-0">
                    <div className="w-9 h-9 rounded-lg bg-accent/10 flex items-center justify-center shrink-0 mt-0.5">
                      <Home className="w-4 h-4 text-accent" />
                    </div>
                    <div className="space-y-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-semibold text-ink">{property.address}</p>
                        {property.is_primary && (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold border uppercase tracking-wide bg-accent-dim text-accent border-accent/20">
                            Primary
                          </span>
                        )}
                      </div>
                      {(property.city || property.province) && (
                        <p className="text-xs text-ink-muted flex items-center gap-1">
                          <MapPin className="w-3 h-3" />
                          {[property.city, property.province, property.postal_code].filter(Boolean).join(', ')}
                        </p>
                      )}
                      {property.customers && (
                        <p className="text-xs text-ink-faint flex items-center gap-1">
                          <User className="w-3 h-3" />
                          {property.customers.name}
                        </p>
                      )}
                      {(property.lawn_sqft || property.fence_length) && (
                        <p className="text-xs text-ink-faint">
                          {property.lawn_sqft ? `Lawn ${property.lawn_sqft} ft²` : ''}
                          {property.lawn_sqft && property.fence_length ? ' · ' : ''}
                          {property.fence_length ? `Fence ${property.fence_length} ft` : ''}
                        </p>
                      )}
                      {last && (
                        <p className="text-xs text-ink-faint flex items-center gap-1">
                          <History className="w-3 h-3" />
                          Last measured {formatDate(last.date)} · {(last.total_sqft ?? last.lawn_sqft ?? 0).toLocaleString()} ft²
                          {hist.length > 1 && <span className="text-ink-faint">· {hist.length} measurements</span>}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-2 shrink-0">
                    <Link href={`/dashboard/properties/measure?id=${property.id}`}>
                      <Button variant="secondary" size="sm">
                        <Ruler className="w-3.5 h-3.5" /> Measure
                      </Button>
                    </Link>
                    {property.lat && property.lng ? (
                      <p className="text-xs text-accent font-medium">📍 Located</p>
                    ) : (
                      <p className="text-xs text-ink-faint">No coords yet</p>
                    )}
                  </div>
                </div>
              </CardBody>
            </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}