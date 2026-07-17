// GET /api/v1/jobs — list (?status= ?customer_id= ?scheduled_date= ?limit ?offset ?since)
import { listHandler } from '@/lib/integrations/v1'
export const dynamic = 'force-dynamic'
export const GET = listHandler('job', ['status', 'customer_id', 'scheduled_date'])
