import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadPGlite, splitStatements } from './lib/pg-sql'

const OWNER = '00000000-0000-4000-8000-000000000001'
const CUSTOMER = '00000000-0000-4000-8000-000000000002'
const PROPERTY = '00000000-0000-4000-8000-000000000003'
const LEAD = '00000000-0000-4000-8000-000000000004'
const MOWING = '00000000-0000-4000-8000-000000000005'
const FERT = '00000000-0000-4000-8000-000000000006'
const BUNDLE = '00000000-0000-4000-8000-000000000007'
const TOKEN = 'bundle-runtime-token'

async function main() {
  const loaded = await loadPGlite()
  if (!loaded) {
    console.log('automatic service bundle runtime verification skipped: PGlite unavailable')
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
      create function extensions.digest(bytea,text) returns bytea language sql immutable as $$ select public.digest($1,$2) $$;

      create table public.business_settings(user_id uuid primary key,booking_token text,booking_enabled boolean);
      create table public.customers(id uuid primary key,user_id uuid,name text);
      create table public.properties(
        id uuid primary key,user_id uuid,customer_id uuid,address text,is_primary boolean,created_at timestamptz default now(),
        lawn_sqft numeric,lat double precision,lng double precision,lawn_polygon jsonb,google_place_id text,measurement_history jsonb default '[]'::jsonb
      );
      create table public.website_leads(
        id uuid primary key,user_id uuid,customer_id uuid,address text,quote_id uuid,status text default 'new'
      );
      create table public.service_templates(
        id uuid primary key default gen_random_uuid(),user_id uuid,name text,is_active boolean,published_at timestamptz,sort_order integer,created_at timestamptz default now()
      );
      create table public.automatic_service_pricing_versions(
        id uuid primary key,user_id uuid,service_key text,version integer,is_active boolean,enabled boolean,
        engine_version text,route_rule_version text,rules jsonb
      );
      create table public.automatic_bundle_pricing_versions(
        id uuid primary key,user_id uuid,version integer,is_active boolean,enabled boolean,engine_version text,rules jsonb
      );
      create table public.quotes(
        id uuid primary key default gen_random_uuid(),created_at timestamptz default now(),user_id uuid,quote_number text,
        customer_id uuid,customer_name text,address text,service_type text,notes text,hours numeric,crew_size integer,rate numeric,
        travel_fee numeric,status text,issued_date date,initial_price numeric,sent_at timestamptz,measured_sqft numeric,
        pricing_confidence text,property_id uuid,price_source text,measurement_snapshot jsonb,lead_meta jsonb,internal_notes text
      );
      create table public.quote_services(
        id uuid primary key default gen_random_uuid(),user_id uuid,quote_id uuid,service_type text,service_template_id uuid,
        quantity numeric,unit text,unit_price numeric,discount_type text,discount_value numeric,notes text,sort_order integer,kind text
      );
      create table public.service_requests(id uuid primary key default gen_random_uuid(),user_id uuid,customer_id uuid,message text);
      create table public.jobs(id uuid primary key default gen_random_uuid());
      create table public.payments(id uuid primary key default gen_random_uuid());
      create table public.invoices(id uuid primary key default gen_random_uuid());
    `)
    const migration = readFileSync(join('supabase','migrations','20260923174500_issue_automatic_service_bundle_quote.sql'),'utf8')
    for (const statement of splitStatements(migration)) await db.exec(`${statement};`)

    const rules = JSON.stringify({ minimum_margin_percent: 20 })
    await db.query(`insert into public.business_settings values ($1,$2,true)`,[OWNER,TOKEN])
    await db.query(`insert into public.customers values ($1,$2,'Customer')`,[CUSTOMER,OWNER])
    await db.query(`insert into public.properties(id,user_id,customer_id,address,is_primary) values ($1,$2,$3,'123 Main St',true)`,[PROPERTY,OWNER,CUSTOMER])
    await db.query(`insert into public.website_leads values ($1,$2,$3,'123 Main St',null,'new')`,[LEAD,OWNER,CUSTOMER])
    await db.query(`insert into public.service_templates(user_id,name,is_active,published_at,sort_order) values
      ($1,'Lawn Mowing & Edging',true,now(),1),($1,'Fertilization',true,now(),2)`,[OWNER])
    await db.query(`insert into public.automatic_service_pricing_versions values
      ($1,$2,'mowing',1,true,true,'engine-v1','route-v1',$3::jsonb),
      ($4,$2,'fertilization',1,true,true,'engine-v1','route-v1',$3::jsonb)`,[MOWING,OWNER,rules,FERT])
    await db.query(`insert into public.automatic_bundle_pricing_versions values
      ($1,$2,1,true,true,'bundle-v1',$3::jsonb)`,[BUNDLE,OWNER,JSON.stringify({
        minimum_services: 2,discount_kind: 'percentage',discount_value: 10,maximum_discount: 50,minimum_margin_percent: 20,
      })])

    const line = (serviceKey: string, label: string, cadence: string, price: number, cost: number, versionId: string) => ({
      serviceKey,label,cadence,state:'priced',price,priceLabel:'per visit',
      decision:{
        state:'priced',serviceKey,cadence,price,pricingVersionId:versionId,pricingVersion:1,
        pricingEngineVersion:'engine-v1',routeRuleVersion:'route-v1',idempotencyKey:'a'.repeat(64),
        economics:{totalCost:cost,profit:price-cost,marginPercent:(price-cost)/price*100},
      },
    })
    const decision = {
      state:'priced',estimateStatus:'written_estimate',
      lines:[line('mowing','Lawn mowing','weekly',100,50,MOWING),line('fertilization','Fertilization','one_time',80,40,FERT)],
      subtotal:180,discount:18,bundlePrice:162,bundlePricingVersionId:BUNDLE,bundlePricingVersion:1,pricingMode:'owner_authorized_bundle',
    }
    const measurement = {
      verified_by:'hmac_city_measurement_attestation',customer_confirmation:'automatic_applied',
      polygon_hash:'b'.repeat(64),sqft:2500,polygon:[{section:'lawn',ring:[{lat:51,lng:-114},{lat:51.001,lng:-114},{lat:51,lng:-114.001}]}],
      lat:51,lng:-114,source:'calgary_open_data_land_cover',confidence:'high',measured_at:'2026-09-23T18:00:00Z',
    }
    const route = {
      verified_by_server:true,provider:'google_places',place_id:'ChIJ-test',checked_at:'2026-09-23T18:00:00Z',
      city:'Calgary',province:'AB',country:'CA',quadrant:'SE',lat:51,lng:-114,
      base_distance_km:8,route_travel_km:4,nearby_jobs:3,eligible_route_days:2,route_rule_version:'route-v1',
    }
    const routes = { mowing:route, fertilization:{...route,eligible_route_days:null} }
    const issued = await db.query(`select public.issue_automatic_service_bundle_quote($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb) result`,[
      TOKEN,CUSTOMER,LEAD,JSON.stringify(decision),JSON.stringify(measurement),JSON.stringify(routes),
    ]) as { rows:Array<{result:{state:string;quote_id:string;replayed:boolean}}> }
    if (issued.rows[0].result.state !== 'quoted' || issued.rows[0].result.replayed) throw new Error(`first issue failed ${JSON.stringify(issued.rows[0].result)}`)
    const replay = await db.query(`select public.issue_automatic_service_bundle_quote($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb) result`,[
      TOKEN,CUSTOMER,LEAD,JSON.stringify(decision),JSON.stringify(measurement),JSON.stringify(routes),
    ]) as { rows:Array<{result:{state:string;replayed:boolean}}> }
    if (replay.rows[0].result.state !== 'quoted' || !replay.rows[0].result.replayed) throw new Error('idempotent replay failed')
    const evidence = await db.query(`select
      (select count(*)::int from public.quotes) quotes,
      (select count(*)::int from public.quote_services) lines,
      (select count(*)::int from public.jobs) jobs,
      (select count(*)::int from public.payments) payments,
      (select count(*)::int from public.invoices) invoices,
      (select status from public.website_leads where id=$1) lead_status`,[LEAD]) as {rows:Array<Record<string,number|string>>}
    const row = evidence.rows[0]
    if (row.quotes !== 1 || row.lines !== 2 || row.jobs !== 0 || row.payments !== 0 || row.invoices !== 0 || row.lead_status !== 'quoted') {
      throw new Error(`writer side effects invalid ${JSON.stringify(row)}`)
    }
    const tampered = structuredClone(decision)
    tampered.lines[0].decision.economics.profit = 999
    const rejected = await db.query(`select public.issue_automatic_service_bundle_quote($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb) result`,[
      TOKEN,CUSTOMER,LEAD,JSON.stringify(tampered),JSON.stringify(measurement),JSON.stringify(routes),
    ]) as {rows:Array<{result:{state:string;reason:string}}>}
    if (rejected.rows[0].result.state !== 'review_required') throw new Error('tampered economics were accepted')
    console.log('automatic service bundle runtime verification passed')
  } finally {
    await db.close()
  }
}

main().catch(error => { console.error(error); process.exit(1) })
