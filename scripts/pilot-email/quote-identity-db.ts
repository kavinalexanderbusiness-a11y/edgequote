// Disposable retained-quote baseline transport. No URL, HTTP or live-client API.
import assert from 'node:assert/strict'
import type { SupabaseClient } from '@supabase/supabase-js'
import { SqlStateError, type Database } from './database'

export type BaselineRow = Record<string, unknown>
export interface BaselineRequest {
  table: string
  operation: 'select' | 'insert' | 'update'
  transaction: string
  backend: number
  role: string
  owner: string
  outcome: 'committed' | 'rolled_back'
  rows: BaselineRow[]
  payload: BaselineRow | null
  sqlstate?: string
  detail?: string
}
type BaselineResponse = { data: unknown; error: SqlStateError | null }
interface BaselineBuilder {
  insert(value: BaselineRow): BaselineBuilder
  update(value: BaselineRow): BaselineBuilder
  select(value?: string): BaselineBuilder
  eq(column: string, value: unknown): BaselineBuilder
  single(): Promise<BaselineResponse>
  then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown): Promise<unknown>
}

const identifier = (name: string) => {
  assert.match(name, /^[a-z_][a-z0-9_]*$/)
  return '"' + name + '"'
}
const customerColumns = ['name', 'email', 'phone', 'address', 'city', 'province', 'postal_code', 'acquisition_source', 'user_id']
const propertyColumns = ['customer_id', 'user_id', 'address', 'city', 'province', 'postal_code', 'is_primary']
const quoteColumns = ['deposit_type', 'deposit_value', 'customer_id', 'customer_name', 'property_id', 'address',
  'service_type', 'service_template_id', 'initial_price', 'weekly_price', 'biweekly_price', 'monthly_price',
  'overgrowth_multiplier', 'custom_travel_required', 'show_travel_separately', 'notes', 'internal_notes',
  'hours', 'crew_size', 'rate', 'travel_fee', 'measured_sqft', 'measurement_snapshot', 'suggested_price']

/** Each awaited builder is exactly one committed REST-equivalent request.
 * The failed quote UPDATE rolls back ONLY its own transaction. There is no
 * transaction around the actual handler, so earlier customer/property writes
 * remain visible to the independent observer backend, just as with PostgREST.
 */
export function baselineSqlSupabase(db: Database, owner: string, trace: BaselineRequest[]): SupabaseClient {
  assert.match(owner, /^31000000-0000-4000-8000-00000000000[123]$/)
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: owner } }, error: null }) },
    from(table: string) {
      assert.ok(['customers', 'properties', 'quotes'].includes(table), 'Unexpected baseline handler table: ' + table)
      let operation: BaselineRequest['operation'] = 'select'
      let fields: string | null = null
      let payload: BaselineRow | null = null
      let executed = false
      const filters: { column: string; value: unknown }[] = []
      const mutate = (kind: 'insert' | 'update', value: BaselineRow): BaselineBuilder => {
        assert.equal(operation, 'select'); assert.equal(payload, null); assert.equal(fields, null)
        assert.ok(value && typeof value === 'object' && !Array.isArray(value))
        operation = kind; payload = { ...value }; return builder
      }
      const run = async (single: boolean): Promise<BaselineResponse> => {
        assert.equal(executed, false, 'A REST-equivalent request must execute exactly once'); executed = true
        const keys = Object.keys(payload ?? {}).sort()
        if (table === 'customers' && operation === 'insert') {
          assert.deepEqual(keys, [...customerColumns].sort()); assert.equal(fields, '*'); assert.equal(single, true)
          assert.deepEqual(filters, []); assert.equal(payload!.user_id, owner)
        } else if (table === 'customers' && operation === 'update') {
          assert.ok(keys.length > 0 && keys.every(k => ['phone', 'email', 'acquisition_source'].includes(k)))
          assert.equal(fields, null); assert.equal(single, false)
          assert.deepEqual(filters.map(f => f.column), ['id'])
        } else if (table === 'properties' && operation === 'select') {
          assert.equal(fields, 'id, address, is_primary'); assert.equal(single, false)
          assert.deepEqual(filters.map(f => f.column), ['customer_id'])
        } else if (table === 'properties' && operation === 'insert') {
          assert.deepEqual(keys, [...propertyColumns].sort()); assert.equal(fields, 'id'); assert.equal(single, true)
          assert.deepEqual(filters, []); assert.equal(payload!.user_id, owner)
        } else if (table === 'quotes' && operation === 'update') {
          assert.deepEqual(keys, [...quoteColumns].sort()); assert.equal(fields, '*'); assert.equal(single, true)
          assert.deepEqual(filters.map(f => f.column), ['id'])
          assert.equal(payload!.measured_sqft, null); assert.equal(payload!.measurement_snapshot, null)
        } else throw new Error('Unexpected baseline builder chain: ' + table + '.' + operation)

        const params: unknown[] = []
        const parameter = (value: unknown) => {
          assert.ok(value === null || ['string', 'boolean', 'number'].includes(typeof value), 'Bounded scalar payload required')
          params.push(value); return '$' + params.length
        }
        const columns = fields === '*' ? '*' : fields?.split(',').map(s => identifier(s.trim())).join(',')
        let sql: string
        if (operation === 'insert') {
          sql = `insert into public.${identifier(table)} (${keys.map(identifier).join(',')}) values (${keys.map(k => parameter(payload![k])).join(',')})`
        } else if (operation === 'update') {
          sql = `update public.${identifier(table)} set ${keys.map(k => identifier(k) + '=' + parameter(payload![k])).join(',')}`
        } else sql = `select ${columns} from public.${identifier(table)}`
        if (filters.length) sql += ' where ' + filters.map(f => identifier(f.column) + '=' + parameter(f.value)).join(' and ')
        if (operation !== 'select' && columns) sql += ' returning ' + columns

        await db.exec('begin; set local role authenticated')
        let context: { transaction: string; backend: number; role: string; owner: string } | undefined
        try {
          await db.query(`select set_config('request.jwt.claim.sub',$1,true),
            set_config('request.jwt.claim.role','authenticated',true),set_config('request.jwt.claims',$2,true)`,
          [owner, JSON.stringify({ sub: owner, role: 'authenticated' })])
          context = (await db.query<{ transaction: string; backend: number; role: string; owner: string }>(
            `select pg_current_xact_id()::text as transaction,pg_backend_pid() as backend,current_user as role,current_setting('request.jwt.claim.sub',true) as owner`)).rows[0]
          assert.equal(context.role, 'authenticated'); assert.equal(context.owner, owner)
          const result = await db.query(sql, params)
          if (single) assert.equal(result.rows.length, 1, 'Successful single-row request must return exactly one row')
          await db.exec('commit')
          trace.push({ table, operation, ...context, outcome: 'committed', rows: result.rows, payload })
          return { data: single ? result.rows[0] : fields ? result.rows : null, error: null }
        } catch (error) {
          await db.exec('rollback')
          // Preserve the actual driver error. Never manufacture the expected FK.
          if (!(error instanceof SqlStateError) || !context) throw error
          trace.push({ table, operation, ...context, outcome: 'rolled_back', rows: [], payload,
            sqlstate: error.code, detail: error.detail })
          return { data: null, error }
        }
      }
      const builder: BaselineBuilder = {
        insert(value: BaselineRow) { return mutate('insert', value) },
        update(value: BaselineRow) { return mutate('update', value) },
        select(value = '*') { assert.equal(fields, null); fields = value; return builder },
        eq(column: string, value: unknown) { identifier(column); filters.push({ column, value }); return builder },
        single() { return run(true) },
        then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) { return run(false).then(resolve, reject) },
      }
      return builder
    },
  }
  return client as unknown as SupabaseClient
}

/** One observer query captures complete rows in the bounded identity/history
 * tables plus native audit/integration side effects. No column whitelist hides
 * changed metadata, primary flags or frozen workflow/attempt bytes. */
export async function baselineOwnerSnapshot(db: Database, owner: string): Promise<Record<string, BaselineRow[]>> {
  const tables = ['customers', 'properties', 'quotes', 'pilot_email_connections', 'pilot_quote_followup_workflows',
    'pilot_email_send_attempts', 'audit_events', 'integration_events', 'webhook_deliveries']
  const queries = tables.map(table => `select '${table}' as name,coalesce((select jsonb_agg(to_jsonb(r) order by r.id)
    from public.${identifier(table)} r where r.user_id=$1::uuid),'[]'::jsonb) as value`)
  return (await db.query<{ value: Record<string, BaselineRow[]> }>(
    `select jsonb_object_agg(s.name,s.value) as value from (${queries.join(' union all ')}) s`, [owner])).rows[0].value
}
