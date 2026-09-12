import { randomUUID } from 'node:crypto'

// Disposable authenticated proof fixtures only. createUser owns real GoTrue
// provisioning; this module never inserts auth rows, creates credentials on a
// provider, changes platform objects, or constructs a JWT/session.
const PASSWORD = 'Synthetic-Quote-Save-Only-2026!'
const STAMP = '2026-09-11T12:00:00.000Z'
const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/
const uuid = value => {
  if (typeof value !== 'string' || !uuidPattern.test(value)) throw Error('Expected fixture UUID')
  return value
}
const literal = value => {
  if (typeof value !== 'string' || value.includes('\0')) throw Error('Expected fixture SQL text')
  return `E'${value.replaceAll('\\', '\\\\').replaceAll("'", "''")}'`
}
const idSql = value => `${literal(uuid(value))}::uuid`
const jsonSql = value => `${literal(JSON.stringify(value))}::jsonb`
const profile = value => {
  if (value !== 'absent' && value !== 'present') throw Error('Explicit fixed fixture email profile required')
  return value
}

// Explicit table/order vocabulary for independent row observation. Children
// use commercial order, never response arrival or insertion order. Full rows
// preserve native timestamps, generated fields and unintended changes; no Save
// planner, receipt or browser value is consulted by this readback.
const TABLES = Object.freeze([
  ['business_settings', 't.id'], ['customers', 't.id'], ['properties', 't.id'], ['quotes', 't.id'],
  ['quote_services', 't.quote_id,t.sort_order,t.id'], ['quote_options', 't.quote_id,t.sort_order,t.id'],
  ['quote_addons', 't.quote_id,t.sort_order,t.id'], ['quote_acceptances', 't.quote_id,t.seq,t.id'],
  ['service_templates', 't.sort_order,t.id'], ['service_units', 't.sort_order,t.id'],
  ['service_pricing_plans', 't.sort_order,t.id'], ['travel_fee_tiers', 't.sort_order,t.id'],
  ['pricing_config_versions', 't.id'], ['property_measurements', 't.id'], ['property_measurement_events', 't.id'],
  ['pilot_quote_followup_workflows', 't.id'], ['pilot_email_send_attempts', 't.id'],
  ['messages', 't.id'], ['notification_log', 't.id'], ['audit_events', 't.id'],
  ['integration_events', 't.id'], ['webhook_deliveries', 't.id'],
])
const OPTIONAL_EMAIL_TABLES = new Set(['pilot_quote_followup_workflows', 'pilot_email_send_attempts'])

/** sql(text) returns parsed rows, including native JSON objects. One SELECT
 * observes all three fixture tenants and shared units in one DB snapshot.
 * Auth rows are deliberately excluded: actual sign-in timestamps are not
 * business mutations and no auth secrets belong in a proof artifact. */
export async function readFixture(sql, fixture) {
  if (typeof sql !== 'function') throw Error('Actual SQL transport required')
  const emailProfile = profile(fixture.emailProfile)
  const owners = ['ownerA', 'ownerB', 'denied'].map(key => [key, uuid(fixture[key])])
  if (new Set(owners.map(([, owner]) => owner)).size !== 3) throw Error('Fixture users must be distinct')
  const tables = fixture.acceptanceVersioned ? [...TABLES, ['notifications', 't.id']] : TABLES
  const ownerRows = owner => `jsonb_build_object(${tables.map(([table, order]) =>
    emailProfile === 'absent' && OPTIONAL_EMAIL_TABLES.has(table)
      ? `${literal(table)},'[]'::jsonb`
      : `${literal(table)},(select coalesce(jsonb_agg(to_jsonb(t) order by ${order}),'[]'::jsonb)
      from public.${table} t where t.user_id=${idSql(owner)})`).join(',')})`
  // The materialized profile check and every selected row share one statement
  // snapshot. The absent branch contains no reference to optional relations;
  // empty arrays are exposed only for a successful intended-profile result.
  const rows = await sql(`select verified.email_profile,
    case when verified.email_profile=${literal(emailProfile)} then jsonb_build_object(
    ${owners.map(([key, owner]) => `${literal(key)},${ownerRows(owner)}`).join(',')},
    'systemUnits',(select coalesce(jsonb_agg(to_jsonb(t) order by t.sort_order,t.id),'[]'::jsonb)
      from public.service_units t where t.user_id is null)
    ) else null end as fixture_rows
    from (with checked as materialized (select public._pilot_quote_email_profile() as email_profile)
      select email_profile from checked) verified`)
  if (!Array.isArray(rows) || rows.length !== 1 || !rows[0]?.fixture_rows
    || rows[0].email_profile !== emailProfile
    || typeof rows[0].fixture_rows !== 'object' || Array.isArray(rows[0].fixture_rows)) {
    throw Error('SQL transport must return one parsed fixture_rows object')
  }
  const result = rows[0].fixture_rows
  for (const [key] of owners) {
    if (!result[key] || tables.some(([table]) => !Array.isArray(result[key][table]))) {
      throw Error('Incomplete independent fixture readback')
    }
  }
  if (!Array.isArray(result.systemUnits)) throw Error('Incomplete shared unit readback')
  return result
}

// Native SQL fixture preparation only. Every transition uses the existing
// reviewed RPC, with no claim/start/confirm/finalize or external send. These are
// ordinary committed fixture calls, not an assertion about browser authority.
async function seedRetainedEmail(sql, fixture, onPrivateValue) {
  if (fixture.emailProfile !== 'present' || fixture.retainedEmail !== true || !fixture.acceptanceVersioned) throw Error('Retained fixture scope mismatch')
  const registerPrivateState = value => {
    if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
      if (['secret_ref', 'reply_token', 'reply_to', 'route_token', 'idempotency_key'].includes(key) && typeof child === 'string' && child.length) onPrivateValue(child)
      else registerPrivateState(child)
    }
    return value
  }
  const call = async (expression, expectedCode) => {
    const rows = await sql(`select ${expression} as result`)
    if (!Array.isArray(rows) || rows.length !== 1 || !rows[0]?.result || rows[0].result.code !== expectedCode) throw Error('Native retained-fixture RPC refused expected transition')
    return rows[0].result
  }
  const secretRef = 'synthetic/shared-profile/' + randomUUID()
  onPrivateValue(secretRef)
  const receivingDomain = 'reply.fixture.invalid'
  await sql(`update public.customers set email=${literal('retained-' + fixture.customerA + '@fixture.example.invalid')},
    email_opt_in=true,message_prefs=jsonb_build_object('estimates',true)
    where id=${idSql(fixture.customerA)} and user_id=${idSql(fixture.ownerA)}`)
  const created = await call(`public.pilot_email_create_connection(${idSql(fixture.ownerA)},
    ${literal('shared-profile/' + fixture.ownerA)},'proof@fixture.example.invalid',${literal(receivingDomain)},${literal(secretRef)},'fixture-v1')`, 'created')
  const connectionId = uuid(created.connection_id)
  for (const state of ['verified', 'active']) await call(`public.pilot_email_set_connection_state(${idSql(connectionId)},${literal(state)})`, 'updated')
  const approved = await call(`public.pilot_email_approve_workflow(${idSql(connectionId)},${idSql(fixture.customerA)},${idSql(fixture.quoteA)},
    jsonb_build_array(jsonb_build_object('subject','Synthetic held follow-up','text','Synthetic fixture copy; never sent.',
      'due_at',(clock_timestamp()+interval '30 days')::text)),${idSql(fixture.ownerA)})`, 'approved')
  const workflowId = uuid(approved.workflow_id)
  // Read complete native retained rows immediately after approval. Register
  // generated capabilities before any later assertion/report can expose them;
  // retain the untouched values in memory for exact before/after comparisons.
  const retainedRows = await sql(`select public._pilot_quote_email_retained(${idSql(fixture.ownerA)},${idSql(fixture.quoteA)}) as retained`)
  const retained = retainedRows?.[0]?.retained
  if (Array.isArray(retained?.attempts)) for (const attempt of retained.attempts) {
    for (const value of [attempt?.reply_token, attempt?.payload?.reply_to, attempt?.idempotency_key]) {
      if (typeof value === 'string' && value.length > 0) onPrivateValue(value)
    }
  }
  if (!Array.isArray(retainedRows) || retainedRows.length !== 1 || !Array.isArray(retained?.workflows)
    || !Array.isArray(retained?.attempts) || retained.workflows.length !== 1 || retained.attempts.length !== 1) throw Error('Expected exactly one native retained workflow and attempt')
  const attemptId = uuid(retained.attempts[0].id)
  if (!/^[a-f0-9]{48}$/.test(retained.attempts[0].reply_token)
    || retained.attempts[0].payload?.reply_to !== retained.attempts[0].reply_token + '@' + receivingDomain
    || retained.workflows[0].id !== workflowId || retained.attempts[0].workflow_id !== workflowId) throw Error('Native retained fixture binding differs from approval')
  await call(`public.pilot_email_hold_workflow(${idSql(workflowId)},'owner_paused')`, 'held')
  await call(`public.pilot_email_set_connection_state(${idSql(connectionId)},'paused')`, 'updated')
  const final = await sql(`select jsonb_build_object(
    'connections',(select coalesce(jsonb_agg(to_jsonb(c) order by c.id),'[]'::jsonb)
      from public.pilot_email_connections c where c.user_id=${idSql(fixture.ownerA)}),
    'retained',public._pilot_quote_email_retained(${idSql(fixture.ownerA)},${idSql(fixture.quoteA)}),
    'events',(select coalesce(jsonb_agg(to_jsonb(e) order by e.id),'[]'::jsonb) from public.pilot_email_webhook_events e
      where e.connection_id in (select id from public.pilot_email_connections where user_id=${idSql(fixture.ownerA)})),
    'due_in_future',(select a.due_at>clock_timestamp() from public.pilot_email_send_attempts a where a.id=${idSql(attemptId)})
    ) as state`)
  const state = registerPrivateState(final?.[0]?.state), connection = state?.connections?.[0], workflow = state?.retained?.workflows?.[0], attempt = state?.retained?.attempts?.[0]
  if (!Array.isArray(final) || final.length !== 1 || state?.connections?.length !== 1
    || state?.retained?.workflows?.length !== 1 || state?.retained?.attempts?.length !== 1 || state?.events?.length !== 0
    || connection.id !== connectionId || connection.user_id !== fixture.ownerA || connection.state !== 'paused'
    || workflow.id !== workflowId || workflow.user_id !== fixture.ownerA || workflow.customer_id !== fixture.customerA
    || workflow.quote_id !== fixture.quoteA || workflow.state !== 'held' || workflow.hold_reason !== 'owner_paused' || !workflow.held_at
    || attempt.id !== attemptId || attempt.user_id !== fixture.ownerA || attempt.quote_id !== fixture.quoteA
    || attempt.workflow_id !== workflowId || attempt.state !== 'pending' || attempt.fence !== 0
    || state.due_in_future !== true
    || ['lease_until','first_started_at','provider_email_id','confirmed_at','message_id','notification_log_id'].some(key => attempt[key] !== null)) {
    throw Error('Retained fixture was not paused, held, pending and unsent')
  }
  fixture.retainedEmailIds = Object.freeze({ connectionId, workflowId, attemptId })
  fixture.retainedEmailBefore = state
}

function settingsSql(owner, name) {
  return `insert into public.business_settings(
    user_id,company_name,owner_name,business_type,timezone,default_rate,base_address,
    daily_capacity_hours,gst_percent,crew_cost_per_hour,pricing_base_charge,pricing_mow_rate,
    pricing_recommended_mult,pricing_premium_mult,pricing_travel_rate,payment_fee_strategy,fee_recovery_percent
  ) values (${idSql(owner)},${literal(name)},'Synthetic Owner','general','Etc/UTC',50,'20 Fixture Office',
    8,0,30,28,15,1,1.2,1.5,'global_price_increase',0);`
}

function quoteSql({ owner, customer, property, quote, suffix, price, hours, rate, area }) {
  // These fixed fixture values are source data, not a reconstructed pricing
  // engine. General visit is non-lawn; an area >0 renders the actual area input
  // while avoiding a conditional property/lawn measurement write during Save.
  if (![price, hours, rate, area].every(Number.isFinite)) throw Error('Finite fixture numbers required')
  const name = `Synthetic Customer ${suffix}`, address = `${suffix === 'A' ? 10 : suffix === 'B' ? 90 : 190} Fixture Street`
  const snapshot = { v: 2, type: 'area', unit: 'sqft', value: area,
    parts: [{ label: 'Synthetic measured area', value: area }], measuredAt: STAMP,
    serviceTemplateId: null, serviceName: 'General visit', term: 'one_time', basis: 'flat', rate, price }
  return `insert into public.customers(id,user_id,name,address,city,province,phone,email,archived_at)
    values(${idSql(customer)},${idSql(owner)},${literal(name)},${literal(address)},null,null,null,null,null);
    insert into public.properties(id,user_id,customer_id,address,city,province,is_primary)
    values(${idSql(property)},${idSql(owner)},${idSql(customer)},${literal(address)},null,null,true);
    insert into public.quotes(id,user_id,customer_id,property_id,quote_number,customer_name,address,
      service_type,service_template_id,status,initial_price,hours,crew_size,rate,overgrowth_multiplier,
      travel_fee,measured_sqft,notes,internal_notes,measurement_snapshot)
    values(${idSql(quote)},${idSql(owner)},${idSql(customer)},${idSql(property)},${literal('AUTH-SAVE-' + suffix)},
      ${literal(name)},${literal(address)},'General visit',null,'draft',${price},${hours},1,${rate},1,0,${area},
      ${literal('Original public scope ' + suffix)},${literal('Original internal note ' + suffix)},${jsonSql(snapshot)});`
}

/** New marked disposable database only; caller owns that check and platform
 * lifecycle. No retries, upserts, mutation of existing users or implicit cleanup.
 * createUser(email,password) must return the UUID from real GoTrue, not a fake.
 * The denied user owns a quote but has no settings, making its owner-role test
 * meaningful rather than merely asking it to read another tenant's quote. */
export async function seedFixtures({ sql, createUser, acceptanceFixture, sharedUnitId, emailProfile, retainedEmail = false, onPrivateValue }) {
  if (typeof sql !== 'function' || typeof createUser !== 'function') throw Error('Actual SQL and GoTrue transports required')
  profile(emailProfile)
  if (typeof retainedEmail !== 'boolean' || (retainedEmail && (emailProfile !== 'present' || !acceptanceFixture || typeof onPrivateValue !== 'function'))) {
    throw Error('Retained email fixture requires explicit present profile, acceptance fixture and private-value registration')
  }
  const installed = await sql('select public._pilot_quote_email_profile() as email_profile')
  if (!Array.isArray(installed) || installed.length !== 1 || installed[0]?.email_profile !== emailProfile) throw Error('Fixture profile differs from verified installation')
  const run = randomUUID()
  const fixture = { emailProfile, retainedEmail, password: PASSWORD, emailA: `owner-a-${run}@fixture.example.invalid`,
    emailB: `owner-b-${run}@fixture.example.invalid`, deniedEmail: `denied-${run}@fixture.example.invalid`,
    customerA: randomUUID(), propertyA: randomUUID(), quoteA: randomUUID(),
    customerB: randomUUID(), propertyB: randomUUID(), quoteB: randomUUID(),
    customerDenied: randomUUID(), propertyDenied: randomUUID(), quoteDenied: randomUUID(),
    unitId: sharedUnitId ? uuid(sharedUnitId) : randomUUID(), serviceIdsA: [randomUUID(), randomUUID(), randomUUID()].sort() }
  if (sharedUnitId) {
    const unit = await sql(`select id from public.service_units where id=${idSql(sharedUnitId)} and user_id is null
      and code='each' and label='Each' and abbrev='ea' and step=1 and decimals=0 and sort_order=0 and active`)
    if (unit.length !== 1 || unit[0].id !== sharedUnitId) throw Error('Exact existing synthetic shared unit required')
  }
  fixture.ownerA = uuid(await createUser(fixture.emailA, PASSWORD))
  fixture.ownerB = uuid(await createUser(fixture.emailB, PASSWORD))
  fixture.denied = uuid(await createUser(fixture.deniedEmail, PASSWORD))
  if (new Set([fixture.ownerA, fixture.ownerB, fixture.denied]).size !== 3) throw Error('GoTrue returned duplicate fixture users')
  const [primary, preparation, cleanup] = fixture.serviceIdsA
  await sql(`begin;
    ${settingsSql(fixture.ownerA, 'Synthetic Save Business A')}
    ${settingsSql(fixture.ownerB, 'Synthetic Save Business B')}
    ${quoteSql({ owner: fixture.ownerA, customer: fixture.customerA, property: fixture.propertyA, quote: fixture.quoteA,
      suffix: 'A', price: 101.23, hours: 1.13, rate: 37.17, area: 1234.56 })}
    ${quoteSql({ owner: fixture.ownerB, customer: fixture.customerB, property: fixture.propertyB, quote: fixture.quoteB,
      suffix: 'B', price: 207.89, hours: 2.37, rate: 48.19, area: 4321.09 })}
    ${quoteSql({ owner: fixture.denied, customer: fixture.customerDenied, property: fixture.propertyDenied, quote: fixture.quoteDenied,
      suffix: 'DENIED', price: 101.23, hours: 1.13, rate: 37.17, area: 1234.56 })}
    ${sharedUnitId ? '' : `insert into public.service_units(id,user_id,code,label,abbrev,step,decimals,sort_order,active)
      values(${idSql(fixture.unitId)},null,'each','Each','ea',1,0,0,true);`}
    insert into public.quote_services(id,user_id,quote_id,service_type,service_template_id,quantity,unit,unit_price,
      est_minutes,discount_type,discount_value,notes,sort_order,kind) values
      (${idSql(cleanup)},${idSql(fixture.ownerA)},${idSql(fixture.quoteA)},'Included cleanup',null,3,'each',0,30,null,null,'Cleanup scope',20,'service'),
      (${idSql(preparation)},${idSql(fixture.ownerA)},${idSql(fixture.quoteA)},'Included preparation',null,2,'each',0,15,null,null,'Preparation scope',3,'service'),
      (${idSql(primary)},${idSql(fixture.ownerA)},${idSql(fixture.quoteA)},'General visit',null,1,'each',101.23,68,null,null,null,3,'service');
    set constraints all immediate;
    commit;`)
  if (acceptanceFixture) {
    const { termsText, patch } = acceptanceFixture
    if (typeof termsText !== 'string' || !termsText.trim() || !patch
      || typeof patch.terms_payment_claim !== 'string' || !/^[0-9a-f]{32}$/.test(patch.terms_payment_claim_fingerprint)
      || !Number.isInteger(patch.terms_payment_claim_version)
      || typeof acceptanceFixture.onPrivateValue !== 'function') throw Error('Canonical fixture terms metadata and private-value scrubber required')
    fixture.acceptanceVersioned = true
    fixture.portalTokenA = 'synthetic-portal-' + randomUUID()
    fixture.portalTokenB = 'synthetic-foreign-' + randomUUID()
    fixture.revokedPortalTokenA = 'synthetic-revoked-' + randomUUID()
    for (const value of [fixture.portalTokenA, fixture.portalTokenB, fixture.revokedPortalTokenA]) acceptanceFixture.onPrivateValue(value)
    fixture.addonIdsA = [randomUUID(), randomUUID()]
    fixture.termsA = termsText
    await sql(`begin;
      update public.quotes set status='sent',sent_at=clock_timestamp(),issued_date=current_date,valid_until=current_date+30
        where id in (${idSql(fixture.quoteA)},${idSql(fixture.quoteB)},${idSql(fixture.quoteDenied)});
      update public.business_settings set terms_text=${literal(termsText)},terms_payment_claim=${literal(patch.terms_payment_claim)},
        terms_payment_claim_fingerprint=${literal(patch.terms_payment_claim_fingerprint)},terms_payment_claim_version=${patch.terms_payment_claim_version}
        where user_id=${idSql(fixture.ownerA)};
      insert into public.customer_portal_tokens(token,user_id,customer_id,revoked) values
        (${literal(fixture.portalTokenA)},${idSql(fixture.ownerA)},${idSql(fixture.customerA)},false),
        (${literal(fixture.portalTokenB)},${idSql(fixture.ownerB)},${idSql(fixture.customerB)},false),
        (${literal(fixture.revokedPortalTokenA)},${idSql(fixture.ownerA)},${idSql(fixture.customerA)},true);
      insert into public.quote_addons(id,user_id,quote_id,name,price,is_selected,sort_order) values
        (${idSql(fixture.addonIdsA[0])},${idSql(fixture.ownerA)},${idSql(fixture.quoteA)},'Included fixture detail',17.35,true,0),
        (${idSql(fixture.addonIdsA[1])},${idSql(fixture.ownerA)},${idSql(fixture.quoteA)},'Unselected fixture extra',29.75,false,1);
      set constraints all immediate;
      commit;`)
  }
  if (retainedEmail) await seedRetainedEmail(sql, fixture, onPrivateValue)
  fixture.before = await readFixture(sql, fixture)
  if (fixture.before.ownerA.business_settings.length !== 1 || fixture.before.ownerB.business_settings.length !== 1
    || fixture.before.denied.business_settings.length !== 0
    || fixture.before.ownerA.quotes.length !== 1 || fixture.before.ownerB.quotes.length !== 1 || fixture.before.denied.quotes.length !== 1
    || fixture.before.ownerA.quote_services.length !== 3
    || JSON.stringify(fixture.before.ownerA.quote_services.map(row => row.id)) !== JSON.stringify(fixture.serviceIdsA)) {
    throw Error('Seeded fixture shape differs from expected native rows')
  }
  return fixture
}
