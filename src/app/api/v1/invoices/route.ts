// GET /api/v1/invoices — list (?status= ?customer_id= ?limit ?offset ?since)
import { listHandler } from '@/lib/integrations/v1'
export const dynamic = 'force-dynamic'
export const GET = listHandler('invoice', ['status', 'customer_id'])
