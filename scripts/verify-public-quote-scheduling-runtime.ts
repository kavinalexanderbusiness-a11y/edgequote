// Runtime contract test for the public accepted-quote scheduling RPCs.
//
// This uses a disposable in-memory PGlite database only. The fixture supplies
// the tables these two functions read, then loads their definitions verbatim
// from the current migration. That keeps this guard coupled to executable SQL
// without connecting to, or writing to, any Supabase project.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { loadPGlite, splitStatements } from './lib/pg-sql'

type JsonObject = Record<string, any>

const MIGRATIONS = join('supabase', 'migrations')
const OWNER = '00000000-0000-0000-0000-000000000001'
const CUSTOMER = '00000000-0000-0000-0000-000000000002'
const PROPERTY = '00000000-0000-0000-0000-000000000003'
const TOKEN = 'runtime-scheduling-token'

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail?: unknown) {
  if (condition) {
    passed++
    console.log(`  ✓ ${name}`)
    return
  }
  failed++
  const suffix = detail === undefined ? '' : `\n      ${JSON.stringify(detail)}`
  console.error(`  ✗ ${name}${suffix}`)
}

function section(name: string) {
  console.log(`\n■ ${name}`)
}

async function main() {
  const pglite = await loadPGlite()
  if (!pglite) throw new Error('PGlite is required: install @electric-sql/pglite')

  const { PGlite, contribs } = pglite
  const db = await PGlite.create({ extensions: contribs })

  try {
    await db.exec(`
      create extension if not exists pgcrypto;

      create table public.customer_portal_tokens (
        token text primary key,
        customer_id uuid not null,
        user_id uuid not null,
        revoked boolean not null default false
      );

      create table public.business_settings (
        user_id uuid primary key,
        module_meta jsonb not null default '{}'::jsonb,
        preferred_work_days integer[],
        daily_capacity_hours numeric,
        default_crew_size integer,
        timezone text
      );

      create table public.quotes (
        id uuid primary key,
        user_id uuid not null,
        customer_id uuid not null,
        property_id uuid,
        quote_number text not null,
        customer_name text not null,
        service_type text not null,
        status text not null,
        selected_cadence text,
        lead_meta jsonb not null default '{}'::jsonb,
        hours numeric,
        crew_size integer,
        accepted_price numeric,
        total numeric,
        deposit_type text,
        deposit_value numeric,
        notes text,
        created_at timestamptz not null default now(),
        acceptance_current boolean not null default true
      );

      create table public.jobs (
        id uuid primary key default gen_random_uuid(),
        user_id uuid not null,
        customer_id uuid,
        property_id uuid,
        quote_id uuid,
        title text,
        service_type text,
        scheduled_date date,
        duration_minutes integer,
        crew_size integer,
        price numeric,
        status text,
        notes text,
        is_initial_visit boolean,
        created_at timestamptz not null default now()
      );

      create table public.day_statuses (
        user_id uuid not null,
        date date not null,
        blocks boolean,
        starts_at time,
        ends_at time,
        crew_size integer,
        primary key (user_id, date)
      );

      create table public.quote_services (
        id uuid primary key default gen_random_uuid(),
        user_id uuid not null,
        quote_id uuid not null,
        est_minutes integer,
        sort_order integer not null default 0,
        created_at timestamptz not null default now()
      );

      create table public.schedule_items (
        id uuid primary key default gen_random_uuid(),
        user_id uuid not null,
        scheduled_date date not null,
        status text not null,
        duration_minutes integer
      );

      create table public.payments (
        id uuid primary key default gen_random_uuid(),
        user_id uuid not null,
        quote_id uuid,
        kind text,
        status text,
        provider text,
        amount numeric not null
      );

      create table public.service_requests (
        id uuid primary key default gen_random_uuid(),
        user_id uuid not null,
        customer_id uuid not null,
        message text not null
      );

      create function public.quote_acceptance_is_current(p_quote_id uuid)
      returns boolean language sql stable set search_path = 'public', 'pg_temp'
      as $$ select q.acceptance_current from public.quotes q where q.id = p_quote_id $$;
    `)

    for (const functionName of [
      'public_quote_schedule_availability',
      'portal_schedule_accepted_quote',
    ]) {
      // Read migrations in the same filename order as the release/rebuild path,
      // and execute the LAST definition. Pinning this guard to the migration that
      // first introduced the RPC would silently test stale SQL after an override.
      const definitions = readdirSync(MIGRATIONS)
        .filter((file) => file.endsWith('.sql'))
        .sort()
        .flatMap((file) => splitStatements(readFileSync(join(MIGRATIONS, file), 'utf8'))
          .filter((candidate) => new RegExp(
            `\\bcreate\\s+or\\s+replace\\s+function\\s+public\\.${functionName}\\s*\\(`,
            'i',
          ).test(candidate))
          .map((statement) => ({ file, statement })))
      const current = definitions.at(-1)
      if (!current) throw new Error(`ordered migrations do not define ${functionName}`)
      await db.exec(`${current.statement};`)
      console.log(`  · ${functionName} ← ${current.file}`)
    }

    const queryJson = async (sql: string, params: unknown[] = []): Promise<JsonObject> => {
      const result = await db.query(sql, params)
      return (result.rows[0] as { result: JsonObject }).result
    }
    const localDate = async (offset: number): Promise<string> => {
      const result = await db.query(
        `select ((now() at time zone 'America/Edmonton')::date + $1::integer)::text as date`,
        [offset],
      )
      return (result.rows[0] as { date: string }).date
    }
    const availability = (quoteId: string, days = 30) => queryJson(
      'select public.public_quote_schedule_availability($1, $2::uuid, $3)::jsonb as result',
      [TOKEN, quoteId, days],
    )
    const schedule = (quoteId: string, date: string) => queryJson(
      'select public.portal_schedule_accepted_quote($1, $2::uuid, $3::date)::jsonb as result',
      [TOKEN, quoteId, date],
    )
    const hasDate = (result: JsonObject, date: string) =>
      Array.isArray(result.dates) && result.dates.some((entry: JsonObject) => entry.date === date)

    let quoteSequence = 16
    const nextQuoteId = () => {
      const tail = (quoteSequence++).toString(16).padStart(12, '0')
      return `00000000-0000-4000-8000-${tail}`
    }
    const reset = async (capacityHours = 8) => {
      await db.exec(`
        delete from public.service_requests;
        delete from public.payments;
        delete from public.schedule_items;
        delete from public.quote_services;
        delete from public.jobs;
        delete from public.day_statuses;
        delete from public.quotes;
        delete from public.customer_portal_tokens;
        delete from public.business_settings;
      `)
      await db.query(`
        insert into public.customer_portal_tokens (token, customer_id, user_id)
        values ($1, $2::uuid, $3::uuid)
      `, [TOKEN, CUSTOMER, OWNER])
      await db.query(`
        insert into public.business_settings (
          user_id, module_meta, preferred_work_days, daily_capacity_hours,
          default_crew_size, timezone
        ) values (
          $1::uuid,
          jsonb_build_object('public_quote_scheduling', jsonb_build_object(
            'enabled', true,
            'confirmed_at', now(),
            'minimum_notice_days', 1,
            'booking_window_days', 30,
            'travel_buffer_minutes_per_visit', 30
          )),
          array[0,1,2,3,4,5,6], $2::numeric, 1, 'America/Edmonton'
        )
      `, [OWNER, capacityHours])
    }
    const addQuote = async (overrides: JsonObject = {}) => {
      const id = overrides.id ?? nextQuoteId()
      const routeApproved = overrides.routeApproved ?? true
      const durationConfirmed = overrides.durationConfirmed ?? true
      const leadMeta = {
        ...(routeApproved ? {
          route_eligibility: 'approved',
          route_eligibility_approved_at: '2026-09-22T00:00:00Z',
        } : {}),
        ...(durationConfirmed ? { scheduling_inputs_confirmed_at: '2026-09-22T00:00:00Z' } : {}),
      }
      await db.query(`
        insert into public.quotes (
          id, user_id, customer_id, property_id, quote_number, customer_name,
          service_type, status, selected_cadence, lead_meta, hours, crew_size,
          accepted_price, total, deposit_type, deposit_value, acceptance_current
        ) values (
          $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 'Runtime Customer',
          'Runtime Service', $6, $7, $8::jsonb, $9::numeric, $10::integer,
          $11::numeric, $12::numeric, $13, $14::numeric, $15::boolean
        )
      `, [
        id, OWNER, CUSTOMER, overrides.propertyId === null ? null : PROPERTY,
        `RUNTIME-${quoteSequence}`, overrides.status ?? 'accepted', overrides.cadence ?? null,
        JSON.stringify(overrides.leadMeta ?? leadMeta), overrides.hours ?? 1.5,
        overrides.crewSize ?? 1, overrides.acceptedPrice ?? 300, overrides.total ?? 300,
        overrides.depositType ?? null, overrides.depositValue ?? null,
        overrides.acceptanceCurrent ?? true,
      ])
      return id as string
    }

    section('The current migration definitions are executing')
    const definitions = await db.query(`
      select proname from pg_proc
       where pronamespace = 'public'::regnamespace
         and proname in ('public_quote_schedule_availability', 'portal_schedule_accepted_quote')
       order by proname
    `)
    check('both scheduling functions were loaded from the migration', definitions.rows.length === 2)

    section('Blocked days and cancelled work')
    await reset()
    const blockedQuote = await addQuote()
    const blockedDate = await localDate(2)
    const cancelledDate = await localDate(3)
    await db.query(
      `insert into public.day_statuses (user_id, date, blocks) values ($1::uuid, $2::date, true)`,
      [OWNER, blockedDate],
    )
    await db.query(`
      insert into public.jobs (
        user_id, customer_id, scheduled_date, duration_minutes, crew_size, status, title
      ) values ($1::uuid, $2::uuid, $3::date, 1440, 1, 'cancelled', 'Cancelled work')
    `, [OWNER, CUSTOMER, cancelledDate])
    const blockedResult = await availability(blockedQuote)
    check('a blocked day is absent', !hasDate(blockedResult, blockedDate), blockedResult)
    check('a cancelled job consumes no capacity', hasDate(blockedResult, cancelledDate), blockedResult)

    section('An exact capacity fit remains bookable')
    await reset()
    const exactQuote = await addQuote({ hours: 1.5 })
    const exactDate = await localDate(2)
    await db.query(`
      insert into public.jobs (
        user_id, customer_id, scheduled_date, duration_minutes, crew_size, status, title
      ) values ($1::uuid, $2::uuid, $3::date, 330, 1, 'scheduled', 'Existing work')
    `, [OWNER, CUSTOMER, exactDate])
    const exactAvailability = await availability(exactQuote)
    check('the day is offered when remaining capacity equals the quote plus buffer',
      hasDate(exactAvailability, exactDate), exactAvailability)
    const exactBooking = await schedule(exactQuote, exactDate)
    check('the exact-fit quote schedules', exactBooking.state === 'scheduled', exactBooking)
    const exactUsage = await db.query(`
      select sum(duration_minutes + 30)::int as minutes
        from public.jobs where user_id = $1::uuid and scheduled_date = $2::date
          and status in ('scheduled', 'in_progress')
    `, [OWNER, exactDate])
    check('the booked day lands exactly on 480 route minutes',
      Number((exactUsage.rows[0] as { minutes: number }).minutes) === 480, exactUsage.rows[0])

    section('Unknown and malformed durations fail closed')
    await reset()
    const durationQuote = await addQuote()
    const unknownJobDate = await localDate(2)
    const unknownItemDate = await localDate(3)
    const halfOverrideDate = await localDate(4)
    await db.query(`
      insert into public.jobs (
        user_id, customer_id, scheduled_date, duration_minutes, crew_size, status, title
      ) values ($1::uuid, $2::uuid, $3::date, null, 1, 'scheduled', 'Unknown duration')
    `, [OWNER, CUSTOMER, unknownJobDate])
    await db.query(`
      insert into public.schedule_items (user_id, scheduled_date, status, duration_minutes)
      values ($1::uuid, $2::date, 'scheduled', null)
    `, [OWNER, unknownItemDate])
    await db.query(`
      insert into public.day_statuses (user_id, date, blocks, starts_at, ends_at)
      values ($1::uuid, $2::date, false, '09:00', null)
    `, [OWNER, halfOverrideDate])
    const unknownAvailability = await availability(durationQuote)
    check('a scheduled job with unknown duration closes the day',
      !hasDate(unknownAvailability, unknownJobDate), unknownAvailability)
    check('a scheduled item with unknown duration closes the day',
      !hasDate(unknownAvailability, unknownItemDate), unknownAvailability)
    check('a half-set day override closes the day',
      !hasDate(unknownAvailability, halfOverrideDate), unknownAvailability)
    await db.query(`
      insert into public.quote_services (user_id, quote_id, est_minutes, sort_order)
      values ($1::uuid, $2::uuid, 90, 0), ($1::uuid, $2::uuid, null, 1)
    `, [OWNER, durationQuote])
    const unknownQuoteDuration = await availability(durationQuote)
    check('an additional quoted service with unknown duration blocks all scheduling',
      unknownQuoteDuration.state === 'review_required'
        && unknownQuoteDuration.dates.length === 0
        && unknownQuoteDuration.missing.includes('Set the duration for every additional quoted service.'),
      unknownQuoteDuration)

    section('Acceptance, route approval, and deposit gates')
    await reset()
    const gatedQuote = await addQuote({ status: 'sent', routeApproved: false, acceptanceCurrent: false })
    let gated = await availability(gatedQuote)
    check('a quote that is not accepted cannot schedule', gated.state === 'awaiting_acceptance', gated)
    await db.query(`update public.quotes set status = 'accepted' where id = $1::uuid`, [gatedQuote])
    gated = await availability(gatedQuote)
    check('stale acceptance fails closed',
      gated.state === 'review_required' && gated.reason === 'quote_changed', gated)
    await db.query(`update public.quotes set acceptance_current = true where id = $1::uuid`, [gatedQuote])
    gated = await availability(gatedQuote)
    check('route eligibility must be explicitly approved',
      gated.state === 'review_required'
        && gated.missing.includes('Approve this service address and route eligibility on the quote.'), gated)
    await db.query(`
      update public.quotes
         set lead_meta = lead_meta || jsonb_build_object(
           'route_eligibility', 'approved',
           'route_eligibility_approved_at', now()
         ), deposit_type = 'fixed', deposit_value = 100
       where id = $1::uuid
    `, [gatedQuote])
    gated = await availability(gatedQuote)
    check('an unpaid required deposit blocks dates',
      gated.state === 'awaiting_deposit' && Number(gated.deposit_remaining) === 100, gated)
    await db.query(`
      insert into public.payments (user_id, quote_id, kind, status, provider, amount)
      values ($1::uuid, $2::uuid, 'payment', 'paid', 'etransfer', 100)
    `, [OWNER, gatedQuote])
    gated = await availability(gatedQuote)
    check('the exact paid deposit opens scheduling', gated.state === 'ready' && gated.dates.length > 0, gated)

    section('A stale selected date is rejected at write time')
    await reset()
    const staleQuote = await addQuote()
    const staleDate = await localDate(-1)
    const staleResult = await schedule(staleQuote, staleDate)
    const staleCount = await db.query(
      `select count(*)::int as count from public.jobs where quote_id = $1::uuid`, [staleQuote],
    )
    check('a date outside the fresh availability set creates no job',
      Number((staleCount.rows[0] as { count: number }).count) === 0, staleResult)
    check('the rejected date is echoed without being called scheduled',
      staleResult.state !== 'scheduled' && staleResult.selected_date === staleDate, staleResult)

    section('Retries and concurrent-ish capacity contention')
    await reset()
    const retryQuote = await addQuote()
    const retryDate = await localDate(2)
    const retryResults = await Promise.all([
      schedule(retryQuote, retryDate),
      schedule(retryQuote, retryDate),
    ])
    const retryCount = await db.query(
      `select count(*)::int as count from public.jobs where quote_id = $1::uuid`, [retryQuote],
    )
    check('two near-simultaneous retries create one job',
      Number((retryCount.rows[0] as { count: number }).count) === 1, retryResults)
    check('the retry is idempotent',
      retryResults.some((r) => r.state === 'scheduled')
        && retryResults.some((r) => r.state === 'already_scheduled'), retryResults)

    await reset(4.5)
    const capacityQuoteA = await addQuote({ hours: 4 })
    const capacityQuoteB = await addQuote({ hours: 4 })
    const contestedDate = await localDate(2)
    const contestedResults = await Promise.all([
      schedule(capacityQuoteA, contestedDate),
      schedule(capacityQuoteB, contestedDate),
    ])
    const contestedCount = await db.query(`
      select count(*)::int as count from public.jobs
       where user_id = $1::uuid and scheduled_date = $2::date
         and status in ('scheduled', 'in_progress')
    `, [OWNER, contestedDate])
    check('one exact-capacity slot cannot be double-booked by competing quotes',
      Number((contestedCount.rows[0] as { count: number }).count) === 1, contestedResults)
    check('only one competing call reports a completed schedule',
      contestedResults.filter((r) => r.state === 'scheduled').length === 1, contestedResults)
  } finally {
    await db.close()
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
