import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'

async function main() {
 const db = new PGlite()
 await db.exec(`
 create role anon; create role authenticated; create role service_role;
 create table customers(id uuid primary key,user_id uuid,autopay_enabled boolean,stripe_customer_id text);
 create table customer_portal_tokens(token text,customer_id uuid,user_id uuid,revoked boolean);
 create table payment_methods(customer_id uuid,user_id uuid,stripe_payment_method_id text,stripe_customer_id text,is_default boolean,created_at timestamptz);
 create table jobs(id uuid,user_id uuid,customer_id uuid,recurrence_id uuid,status text);
 create table invoices(id uuid primary key,user_id uuid,customer_id uuid,status text,job_id uuid,amount numeric,amount_paid numeric);
 create table business_settings(user_id uuid,gst_percent numeric);
 create table payments(id uuid default gen_random_uuid(),invoice_id uuid,user_id uuid,amount numeric,stripe_payment_intent text,stripe_session_id text unique,kind text,provider text);
 `)
 await db.exec("insert into payments(amount,stripe_payment_intent,stripe_session_id,kind,provider) values(10,'pi_legacy','autopay:legacy','payment','stripe')")
 await db.exec(readFileSync('supabase/proposals/card-charge-safety-review.sql','utf8'))
 await db.exec("insert into payments(amount,stripe_payment_intent,stripe_session_id,kind,provider) values(10,'pi_legacy','autopay-pi:pi_legacy','payment','stripe') on conflict(stripe_session_id) do nothing")
 assert.equal((await db.query<{n:number}>('select count(*)::int n from payments')).rows[0].n,1,'legacy replay remains one payment after normalization')
 await db.exec('delete from payments')
 const u='00000000-0000-0000-0000-000000000001', c='00000000-0000-0000-0000-000000000002', i='00000000-0000-0000-0000-000000000003', j='00000000-0000-0000-0000-000000000004'
 await db.exec(`insert into customers values('${c}','${u}',true,'cus_one'); insert into customer_portal_tokens values('token','${c}','${u}',false);
 insert into payment_methods values('${c}','${u}','pm_one','cus_one',true,now()); insert into jobs values('${j}','${u}','${c}','${j}','completed');
 insert into invoices values('${i}','${u}','${c}','draft','${j}',90,20); insert into business_settings values('${u}',null);`)
 const claim=async(user=u,method='pm_one',cents=7000)=> (await db.query<{id:string|null}>('select claim_card_charge($1,$2,$3,$4,$5,$6) as id',[i,user,c,method,'cus_one',cents])).rows[0].id
 const consent=async(enabled:boolean,terms='recurring-balance-v1')=>(await db.query<{ok:boolean}>('select record_card_charge_consent($1,$2,$3) as ok',['token',enabled,terms])).rows[0].ok
 assert.equal(await claim(),null,'old boolean alone cannot authorize')
 assert.equal(await consent(true,'unreviewed'),false)
 assert.equal(await consent(true),true)
 assert.equal(await claim(c),null,'foreign owner denied')
 assert.equal(await claim(u,'pm_other'),null,'foreign/replaced card denied')
 assert.equal(await claim(u,'pm_one',9000),null,'stale paid balance denied')
 await db.exec(`update jobs set status='scheduled'`)
 assert.equal(await claim(),null,'unfinished job denied')
 await db.exec(`update jobs set status='completed'; update invoices set status='cancelled'`)
 assert.equal(await claim(),null,'cancelled denied')
 await db.exec(`update invoices set status='draft'`)
 assert.equal(await consent(false),true)
 await db.exec('update customers set autopay_enabled=true')
 assert.equal(await claim(),null,'owner toggle cannot revive revoked consent')
 assert.equal(await consent(true),true)
 // PGlite serializes execution; competing callers exercise the unique claim
 // contract but do not substitute for multi-connection production lock testing.
 const attempts=await Promise.all(Array.from({length:20},()=>claim()))
 assert.equal(attempts.filter(Boolean).length,1,'exactly one durable claim')
 await db.exec("update card_charge_attempts set created_at=now()-interval '3 days'")
 assert.equal(await claim(),null,'claim never expires with Stripe cache')
 const history=await db.query<{n:number}>('select count(*)::int n from card_charge_consents')
 assert.equal(history.rows[0].n,2,'old consent evidence preserved')
 await db.exec(`insert into payments(invoice_id,user_id,amount,stripe_payment_intent,stripe_session_id,kind,provider) values('${i}','${u}',70,'pi_one','autopay-pi:pi_one','payment','stripe')`)
 await assert.rejects(()=>db.exec(`insert into payments(amount,stripe_payment_intent,stripe_session_id,kind,provider) values(70,'pi_one','other-session','payment','stripe')`))
 await db.exec(`insert into payments(amount,stripe_payment_intent,stripe_session_id,kind,provider) values(70,'pi_one','credit:one','credit','credit'),(-70,'pi_one','refund:one','payment','stripe'),(70,'pi_two','autopay-pi:pi_two','payment','stripe')`)
 assert.equal((await db.query<{n:number}>('select count(*)::int n from payments')).rows[0].n,4,'distinct charge + credit/refund mirrors preserved')
 await db.exec('set role authenticated')
 await assert.rejects(()=>claim())
 await assert.rejects(()=>db.query('select * from card_charge_consents'))
 await db.exec('reset role')
 await db.close()
 console.log('Card charge SQL safety: authorization, revocation, competing claims, no expiry, balance, job state, permissions, distinct PI and mirrors passed (local PGlite).')
}
main().catch(e=>{console.error(e);process.exitCode=1})
