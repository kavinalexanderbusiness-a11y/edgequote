'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRealtimeRefresh } from '@/hooks/useRealtime'
import { Customer, CustomerFormValues } from '@/types'
import { CustomerList } from '@/components/customers/CustomerList'
import { CustomerForm } from '@/components/customers/CustomerForm'
import { PageHeader } from '@/components/layout/PageHeader'
import Link from 'next/link'
import { Button } from '@/components/ui/Button'
import { Card, CardHeader, CardBody } from '@/components/ui/Card'
import { Plus, X, Upload } from 'lucide-react'

export default function CustomersPage() {
  const [customers, setCustomers] = useState<Customer[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<Customer | null>(null)
  const [uid, setUid] = useState<string | null>(null)

  const supabase = useMemo(() => createClient(), [])

  async function fetchCustomers() {
    const { data: { user } } = await supabase.auth.getUser()
    if (user) setUid(user.id)
    const { data } = await supabase
      .from('customers')
      .select('*')
      .eq('user_id', user!.id)
      .order('name')
    setCustomers(data || [])
    setLoading(false)
  }

  useEffect(() => { fetchCustomers() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Command-palette "New Customer" deep-links here with ?new=1 → open the form.
  useEffect(() => {
    if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('new') === '1') {
      setShowForm(true); setEditing(null)
      window.history.replaceState({}, '', '/dashboard/customers')
    }
  }, [])

  // Live: new/edited/deleted customers (import, API, another device) appear instantly.
  useRealtimeRefresh('customers', uid ? `user_id=eq.${uid}` : null, fetchCustomers)

  function normalize(values: CustomerFormValues) {
    return {
      ...values,
      acquisition_source: values.acquisition_source || null,
      referred_by_customer_id: values.referred_by_customer_id || null,
    }
  }

  async function handleAdd(values: CustomerFormValues) {
    const { data: { user } } = await supabase.auth.getUser()

    // Insert customer
    const { data: newCustomer, error } = await supabase
      .from('customers')
      .insert({ ...normalize(values), user_id: user!.id })
      .select()
      .single()

    if (error || !newCustomer) {
      console.error('Failed to create customer:', error)
      return
    }

    // Auto-create a primary property from the customer's address
    if (values.address) {
      await supabase.from('properties').insert({
        customer_id: newCustomer.id,
        user_id: user!.id,
        address: values.address,
        city: values.city || null,
        province: values.province || 'AB',
        postal_code: values.postal_code || null,
        is_primary: true,
      })
    }

    await fetchCustomers()
    setShowForm(false)
  }

  async function handleEdit(values: CustomerFormValues) {
    if (!editing) return
    await supabase.from('customers').update(normalize(values)).eq('id', editing.id)

    // If address changed, update the primary property address too
    if (values.address) {
      await supabase
        .from('properties')
        .update({
          address: values.address,
          city: values.city || null,
          province: values.province || 'AB',
          postal_code: values.postal_code || null,
        })
        .eq('customer_id', editing.id)
        .eq('is_primary', true)
    }

    await fetchCustomers()
    setEditing(null)
  }

  async function handleDelete(id: string) {
    const prev = customers
    setCustomers(p => p.filter(c => c.id !== id))   // optimistic
    const { error } = await supabase.from('customers').delete().eq('id', id)
    if (error) { setCustomers(prev); alert('Could not delete the customer: ' + error.message) }
  }

  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader
        title="Customers"
        description={`${customers.length} customer${customers.length !== 1 ? 's' : ''} in your database`}
        action={
          <div className="flex items-center gap-2">
            <Link href="/dashboard/customers/import">
              <Button variant="secondary"><Upload className="w-4 h-4" /> Import</Button>
            </Link>
            <Button onClick={() => { setShowForm(true); setEditing(null) }}>
              <Plus className="w-4 h-4" /> Add Customer
            </Button>
          </div>
        }
      />

      {(showForm || editing) && (
        <Card>
          <CardHeader className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-ink">
              {editing ? 'Edit Customer' : 'New Customer'}
            </h2>
            <button
              onClick={() => { setShowForm(false); setEditing(null) }}
              className="text-ink-faint hover:text-ink transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </CardHeader>
          <CardBody>
            <CustomerForm
              customers={editing ? customers.filter(c => c.id !== editing.id) : customers}
              defaultValues={editing ? {
                name: editing.name || '',
                email: editing.email || '',
                phone: editing.phone || '',
                address: editing.address || '',
                city: editing.city || '',
                province: editing.province || '',
                postal_code: editing.postal_code || '',
                notes: editing.notes || '',
                acquisition_source: editing.acquisition_source || '',
                referred_by_customer_id: editing.referred_by_customer_id || '',
              } : undefined}
              onSubmit={editing ? handleEdit : handleAdd}
              onCancel={() => { setShowForm(false); setEditing(null) }}
              isEdit={!!editing}
            />
          </CardBody>
        </Card>
      )}

      {loading ? (
        <div className="text-center py-16 text-sm text-ink-muted">Loading customers...</div>
      ) : (
        <CustomerList
          customers={customers}
          onEdit={c => { setEditing(c); setShowForm(false) }}
          onDelete={handleDelete}
          onRefresh={fetchCustomers}
        />
      )}
    </div>
  )
}