'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Property } from '@/types'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card, CardBody } from '@/components/ui/Card'
import { MapPin, Home, User } from 'lucide-react'

export default function PropertiesPage() {
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
        <div className="text-center py-16 text-sm text-ink-muted">
          No properties yet. Properties are created automatically when you add a customer.
        </div>
      ) : (
        <div className="space-y-3">
          {properties.map(property => (
            <Card key={property.id}>
              <CardBody>
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-start gap-3">
                    <div className="w-9 h-9 rounded-lg bg-accent/10 flex items-center justify-center shrink-0 mt-0.5">
                      <Home className="w-4 h-4 text-accent" />
                    </div>
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
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
                      {property.notes && (
                        <p className="text-xs text-ink-faint mt-1">{property.notes}</p>
                      )}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    {property.lat && property.lng ? (
                      <p className="text-xs text-accent font-medium">📍 Geocoded</p>
                    ) : (
                      <p className="text-xs text-ink-faint">No coordinates yet</p>
                    )}
                  </div>
                </div>
              </CardBody>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}