import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadPGlite, splitStatements } from './lib/pg-sql'

const OWNER = '00000000-0000-4000-8000-000000000001'
const CUSTOMER = '00000000-0000-4000-8000-000000000002'
const PROPERTY = '00000000-0000-4000-8000-000000000003'
const QUOTE = '00000000-0000-4000-8000-000000000004'
const TOKEN = 'automatic-pricing-runtime-token'

async function main() {
  const loaded = await loadPGlite()
  if (!loaded) {
    console.log('automatic service pricing runtime verification skipped: PGlite unavailable')
    return
  }
  const db = await loaded.PGlite.create({ extensions: loaded.contribs })
  try {
    await db.exec(`
      create extension if not exists pgcrypto;
      create schema auth;
      create schema extensions;
      do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
      do $$ begin create role anon; exception when duplicate_object then null; end $$;
      do $$ begin create role service_role; exception when duplicate_object then null; end $$;
      create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$
        select nullif(current_setting('request.jwt.claim.sub', true),'')::uuid
      $$;
      create function extensions.digest(bytea,text) returns bytea language sql immutable as $$
        select public.digest($1,$2)
      $$;

      create table public.customers(id uuid primary key, user_id uuid not null, name text);
      create table public.properties(id uuid primary key, user_id uuid not null, customer_id uuid not null);
      create table public.quotes(
        id uuid primary key, user_id uuid not null, customer_id uuid not null, property_id uuid,
        quote_number text not null, customer_name text not null, service_type text not null,
        status text not null, selected_cadence text, lead_meta jsonb not null default '{}'::jsonb,
        hours numeric, crew_size integer, created_at timestamptz not null default now()
      );
      create table public.schedule_items(
        id uuid primary key default gen_random_uuid(), created_at timestamptz not null default now(),
        user_id uuid not null, type text not null, title text not null, customer_id uuid,
        property_id uuid, scheduled_date date not null, start_time time, duration_minutes integer,
        notes text, status text not null default 'scheduled', converted_quote_id uuid,
        customer_note text, cancel_reason text, updated_at timestamptz not null default now()
      );
      create table public.customer_portal_tokens(token text primary key,customer_id uuid,user_id uuid,revoked boolean default false);
      create table public.business_settings(user_id uuid primary key,module_meta jsonb default '{}'::jsonb);
      create table public.quote_services(
        id uuid primary key default gen_random_uuid(),user_id uuid,quote_id uuid,
        est_minutes integer,sort_order integer default 0,created_at timestamptz default now()
      );
      create table public.service_requests(
        id uuid primary key default gen_random_uuid(),user_id uuid,customer_id uuid,message text
      );
      create table public.jobs(id uuid primary key default gen_random_uuid(),user_id uuid);
      create function public.quote_acceptance_is_current(uuid) returns boolean language sql stable as $$ select true $$;
      create function public.public_quote_schedule_availability(text,uuid,integer)
      returns jsonb language sql stable as $$
        select jsonb_build_object('state','ready','dates',jsonb_build_array(jsonb_build_object('date','2026-09-30')))
      $$;
    `)

    const migration = readFileSync(join('supabase','migrations','20260923083454_automatic_service_pricing_and_day_holds.sql'),'utf8')
    for (const statement of splitStatements(migration)) await db.exec(`${statement};`)

    await db.query(`insert into auth.users(id) values ($1)`, [OWNER])
    await db.query(`select set_config('request.jwt.claim.sub',$1,false)`, [OWNER])
    const rules = {
      enabled: true,
      engine_version: 'automatic-service-v1', route_rule_version: 'route-v1',
      permitted_cadences: ['weekly','biweekly','one_time'],
      accepted_measurement_confidences: ['high'], accepted_measurement_sources: ['city_open_data'],
      maximum_measurement_age_minutes: 30,
      base_prices: { weekly: 45, biweekly: 55, one_time: 65 },
      base_lawn_sqft: 2000, additional_price_per_1000_sqft: 10, additional_area_price: 5,
      duration_crew_bands: [{ maximum_sqft: null, minutes: 60, crew_size: 1 }],
      loaded_labour_cost_per_hour: 30, materials: [], materials_cost_basis_confirmed: true,
      equipment_cost_per_visit: 5, delivery_cost_per_visit: 0, disposal_cost_per_visit: 0,
      overhead_cost_per_visit: 6, contingency_percent: 10, vehicle_cost_per_km: 1,
      included_route_km: 3, route_price_per_additional_km: 3, minimum_nearby_jobs_for_base: 2,
      isolated_stop_premium: 8, maximum_automatic_distance_km: 20,
      maximum_route_premium: 30, maximum_automatic_price: 250,
      payment_fee_percent: 3, payment_fee_fixed: 0.3, minimum_margin_percent: 30,
      price_rounding_increment: 5, full_cost_basis_confirmed: true,
    }
    const saved = await db.query(
      `select public.save_automatic_service_pricing_version('mowing',$1::jsonb) result`,
      [JSON.stringify(rules)],
    ) as { rows: Array<{ result: { state: string; id: string; rules_hash: string } }> }
    const versionId = saved.rows[0].result.id
    const rulesHash = saved.rows[0].result.rules_hash
    if (saved.rows[0].result.state !== 'saved' || !versionId) throw new Error('version was not saved')

    await db.query(`insert into public.customers(id,user_id,name) values ($1,$2,'Customer')`,[CUSTOMER,OWNER])
    await db.query(`insert into public.properties(id,user_id,customer_id) values ($1,$2,$3)`,[PROPERTY,OWNER,CUSTOMER])
    await db.query(`insert into public.customer_portal_tokens(token,customer_id,user_id) values ($1,$2,$3)`,[TOKEN,CUSTOMER,OWNER])
    await db.query(`insert into public.business_settings(user_id,module_meta) values ($1,$2::jsonb)`,[
      OWNER, JSON.stringify({ automatic_quote_day_holds: { enabled: true, confirmed_at: '2026-09-23T12:00:00Z', tentative_hold_hours: 24 } }),
    ])
    await db.query(`insert into public.quotes(
      id,user_id,customer_id,property_id,quote_number,customer_name,service_type,status,
      selected_cadence,lead_meta,hours,crew_size
    ) values ($1,$2,$3,$4,'EPS-TEST','Customer','Lawn Mowing & Edging','accepted','weekly',$5::jsonb,1,1)`,[
      QUOTE, OWNER, CUSTOMER, PROPERTY, JSON.stringify({
        automatic_pricing_version_id: versionId,
        automatic_price_state: 'priced', automatic_estimate_status: 'written_estimate',
        automatic_service_key: 'mowing', automatic_pricing_rules_hash: rulesHash,
        automatic_price_idempotency_key: 'a'.repeat(64),
        automatic_pricing_engine_version: 'automatic-service-v1', automatic_route_rule_version: 'route-v1',
      }),
    ])
    const held = await db.query(
      `select public.reserve_automatic_quote_day($1,$2,'2026-09-30') result`,[TOKEN,QUOTE],
    ) as { rows: Array<{ result: { state: string; arrival_time: null } }> }
    if (held.rows[0].result.state !== 'held_for_review' || held.rows[0].result.arrival_time !== null) {
      throw new Error(`unexpected hold result ${JSON.stringify(held.rows[0].result)}`)
    }
    const evidence = await db.query(`select si.start_time,q.status quote_status,
      (select count(*)::int from public.jobs) jobs,
      (select count(*)::int from public.automatic_quote_day_holds where status='pending_owner_review') holds
      from public.schedule_items si cross join public.quotes q where q.id=$1`,[QUOTE]) as {
      rows: Array<{ start_time: string | null; quote_status: string; jobs: number; holds: number }>
    }
    const row = evidence.rows[0]
    if (row.start_time !== null || row.quote_status !== 'accepted' || row.jobs !== 0 || row.holds !== 1) {
      throw new Error(`hold mutated a forbidden record ${JSON.stringify(row)}`)
    }
    console.log('automatic service pricing runtime verification passed')
  } finally {
    await db.close()
  }
}

main().catch(error => { console.error(error); process.exit(1) })
