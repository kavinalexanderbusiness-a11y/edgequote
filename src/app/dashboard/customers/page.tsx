'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Customer, CustomerFormValues } from '@/types'
import { CustomerList } from '@/components/customers/CustomerList'
import { CustomerForm } from '@/components/customers/CustomerForm'
import { PageHeader } from '@/components/layout/PageHeader'
import { Button } from '@/components/ui/Button'
import { Card, CardHeader, CardBody } from '@/components/ui/Card'
import { Plus, X } from 'lucide-react'

export default function CustomersPage() {
  const [customers, setCustomers] = useState<Customer[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<Customer | null>(null)

  const supabase = createClient()

  async function fetchCustomers() {
    const { data: { user } } = await supabase.auth.getUser()
    const { data } = await supabase
      .from('customers')
      .select('*')
      .eq('user_id', user!.id)
      .order('name')
    setCustomers(data || [])
    setLoading(false)
  }

  useEffect(() => { fetchCustomers() }, [])

  async function handleAdd(values: CustomerFormValues) {
    const { data: { user } } = await supabase.auth.getUser()
    await supabase.from('customers').insert({ ...values, user_id: user!.id })
    await fetchCustomers()
    setShowForm(false)
  }

  async function handleEdit(values: CustomerFormValues) {
    if (!editing) return
    await supabase.from('customers').update(values).eq('id', editing.id)
    await fetchCustomers()
    setEditing(null)
  }

  async function handleDelete(id: string) {
    await supabase.from('customers').delete().eq('id', id)
    setCustomers(prev => prev.filter(c => c.id !== id))
  }

  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader
        title="Customers"
        description={`${customers.length} customer${customers.length !== 1 ? 's' : ''} in your database`}
        action={
          <Button onClick={() => { setShowForm(true); setEditing(null) }}>
            <Plus className="w-4 h-4" /> Add Customer
          </Button>
        }
      />

      {/* Add / Edit Form */}
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
              defaultValues={editing || undefined}
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
        />
      )}
    </div>
  )
}
