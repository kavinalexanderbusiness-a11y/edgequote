export type QuoteStatus =
  | 'draft' | 'sent' | 'accepted' | 'scheduled' | 'completed' | 'paid' | 'declined'

export interface Customer {
  id: string
  created_at: string
  updated_at: string
  name: string
  email: string | null
  phone: string | null
  address: string | null
  city: string | null
  province: string | null
  postal_code: string | null
  notes: string | null
  tags: string[]
  user_id: string
}

export interface Quote {
  id: string
  created_at: string
  updated_at: string
  quote_number: string
  customer_id: string | null
  customer_name: string
  address: string
  service_type: string
  notes: string | null
  hours: number
  crew_size: number
  rate: number
  travel_fee: number
  man_hours: number
  subtotal: number
  total: number
  service_frequency: 'one_time' | 'initial_weekly' | 'initial_biweekly'
  initial_price: number | null
  recurring_price: number | null
  recurring_interval: 'weekly' | 'bi_weekly' | null
  custom_travel_required: boolean
  show_travel_separately: boolean
  status: QuoteStatus
  service_template_id: string | null
  overgrowth_multiplier: number
  issued_date: string | null
  user_id: string
  customers?: Pick<Customer, 'id' | 'name' | 'email' | 'phone'>
}

export interface QuoteFormValues {
  customer_id: string
  customer_name: string
  address: string
  service_type: string
  service_template_id: string
  overgrowth_multiplier: number
  distance_km: number
  hours: number
  crew_size: number
  rate: number
  travel_fee: number
  notes: string
  service_frequency: 'one_time' | 'initial_weekly' | 'initial_biweekly'
  initial_price: number
  recurring_price: number
  recurring_interval: 'weekly' | 'bi_weekly' | ''
  custom_travel_required: boolean
  show_travel_separately: boolean
  status: QuoteStatus
}

export interface CustomerFormValues {
  name: string
  email: string
  phone: string
  address: string
  city: string
  province: string
  postal_code: string
  notes: string
}

export interface DashboardStats {
  totalQuotes: number
  revenueQuoted: number
  acceptedJobs: number
  pendingQuotes: number
  acceptedRevenue: number
  monthlyRevenue: number
  conversionRate: number
}

export interface BusinessSettings {
  id: string
  created_at: string
  updated_at: string
  company_name: string
  owner_name: string | null
  phone: string | null
  email_primary: string | null
  email_secondary: string | null
  website: string | null
  logo_url: string | null
  base_address: string | null
  base_lat: number | null
  base_lng: number | null
  default_rate: number
  terms_text: string | null
  user_id: string
}

export interface TravelFeeTier {
  id: string
  created_at: string
  min_km: number
  max_km: number | null
  fee: number | null
  is_custom: boolean
  sort_order: number
  user_id: string
}

export interface ServiceTemplate {
  id: string
  created_at: string
  updated_at: string
  name: string
  category: string
  default_rate: number
  default_description: string | null
  notes: string | null
  is_active: boolean
  sort_order: number
  user_id: string
}

export interface ServiceTemplateFormValues {
  name: string
  category: string
  default_rate: number
  default_description: string
  notes: string
  is_active: boolean
}

export interface BusinessSettingsFormValues {
  company_name: string
  owner_name: string
  phone: string
  email_primary: string
  email_secondary: string
  website: string
  base_address: string
  default_rate: number
  terms_text: string
}

export const SERVICE_CATEGORIES = [
  'Lawn Care',
  'Property Maintenance',
  'Landscaping',
  'Tree & Shrub Care',
  'Winter Services',
  'General',
] as const

export const OVERGROWTH_LEVELS = [
  { label: 'Normal Lawn', multiplier: 1.0, description: 'Standard condition — base price' },
  { label: '6–12 inches', multiplier: 1.5, description: 'Moderate overgrowth' },
  { label: '1–2 feet', multiplier: 2.0, description: 'Heavy overgrowth' },
  { label: 'Over 2 feet', multiplier: 0, description: 'Custom quote required' },
] as const

export const SERVICE_FREQUENCIES = [
  { value: 'one_time', label: 'One-Time Service' },
  { value: 'initial_weekly', label: 'Initial + Weekly Maintenance' },
  { value: 'initial_biweekly', label: 'Initial + Bi-Weekly Maintenance' },
] as const

export const SERVICE_TYPES = [
  'Lawn Mowing',
  'Yard Cleanup',
  'Snow Removal',
  'Landscaping',
  'Pressure Washing',
  'Window Cleaning',
  'Junk Removal',
  'Fencing',
  'Painting',
  'Other',
] as const

export const STATUS_LABELS: Record<QuoteStatus, string> = {
  draft: 'Draft',
  sent: 'Sent',
  accepted: 'Accepted',
  scheduled: 'Scheduled',
  completed: 'Completed',
  paid: 'Paid',
  declined: 'Declined',
}

export const STATUS_COLORS: Record<QuoteStatus, string> = {
  draft:     'bg-ink-faint/20 text-ink-muted border-ink-faint/30',
  sent:      'bg-blue-500/10 text-blue-400 border-blue-500/20',
  accepted:  'bg-accent-dim text-accent border-accent/20',
  scheduled: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
  completed: 'bg-teal-500/10 text-teal-400 border-teal-500/20',
  paid:      'bg-emerald-500/15 text-emerald-400 border-emerald-500/25',
  declined:  'bg-red-500/10 text-red-400 border-red-500/20',
}