// GET /api/v1/quotes — list (?status= ?customer_id= ?limit ?offset ?since)
import { listHandler } from '@/lib/integrations/v1'
export const dynamic = 'force-dynamic'
export const GET = listHandler('quote', ['status', 'customer_id'])
