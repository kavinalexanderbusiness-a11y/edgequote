'use client'

// Developer documentation — rendered FROM the platform's real constants
// (event catalog, serialized field lists, retry schedule, rate limits), so
// the docs cannot drift from the behavior without a failing verify check.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowDownToLine, ArrowLeft, BookOpen, Globe, KeyRound, ShieldCheck, Webhook, Zap } from 'lucide-react'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { SectionHeading } from '@/components/ui/SectionHeading'
import { CodeBlock, CopyRow } from '@/components/integrations/CodeBlock'
import { INTEGRATION_EVENTS, SERIALIZED_FIELDS, TEST_EVENT, sampleDeliveryBody } from '@/lib/integrations/events'
import { BACKOFF_MINUTES, MAX_ATTEMPTS, AUTO_DISABLE_AFTER, RETENTION_DAYS } from '@/lib/integrations/retry'
import { API_RATE_LIMIT_PER_MINUTE } from '@/lib/integrations/keys'
import { SIGNATURE_HEADER, SIGNATURE_TOLERANCE_SECONDS } from '@/lib/integrations/signing'

const RESOURCES: { path: string; method: string; scope: string; note: string }[] = [
  { path: '/api/v1/me', method: 'GET', scope: 'read', note: 'Key introspection — use as the connection test.' },
  { path: '/api/v1/customers', method: 'GET', scope: 'read', note: 'List customers. Params: limit, offset, since.' },
  { path: '/api/v1/customers', method: 'POST', scope: 'write', note: 'Find-or-create a customer (dedup by phone, then email).' },
  { path: '/api/v1/customers/:id', method: 'GET', scope: 'read', note: 'One customer.' },
  { path: '/api/v1/quotes', method: 'GET', scope: 'read', note: 'List quotes. Extra filters: status, customer_id.' },
  { path: '/api/v1/quotes/:id', method: 'GET', scope: 'read', note: 'One quote.' },
  { path: '/api/v1/jobs', method: 'GET', scope: 'read', note: 'List jobs. Extra filters: status, customer_id, scheduled_date.' },
  { path: '/api/v1/jobs/:id', method: 'GET', scope: 'read', note: 'One job.' },
  { path: '/api/v1/invoices', method: 'GET', scope: 'read', note: 'List invoices. Extra filters: status, customer_id.' },
  { path: '/api/v1/invoices/:id', method: 'GET', scope: 'read', note: 'One invoice.' },
  { path: '/api/v1/events', method: 'GET', scope: 'read', note: 'The captured event stream. Filters: event, since. Rows match webhook bodies exactly.' },
  { path: '/api/v1/hooks', method: 'GET', scope: 'read', note: 'List webhook subscriptions.' },
  { path: '/api/v1/hooks', method: 'POST', scope: 'write', note: 'Subscribe a URL to events (REST hooks). Returns the signing secret once.' },
  { path: '/api/v1/hooks/:id', method: 'DELETE', scope: 'write', note: 'Unsubscribe.' },
]

const VERIFY_SNIPPET = `import { createHmac, timingSafeEqual } from 'crypto'

export function verifyEdgeQuote(secret, header, rawBody) {
  const parts = Object.fromEntries(header.split(',').map(p => p.split('=', 2)))
  const age = Math.abs(Date.now() / 1000 - Number(parts.t))
  if (age > ${SIGNATURE_TOLERANCE_SECONDS}) return false // stale — replay guard
  const expected = createHmac('sha256', secret)
    .update(parts.t + '.' + rawBody)          // the RAW body, not re-serialized JSON
    .digest('hex')
  const a = Buffer.from(parts.v1), b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}`

export default function IntegrationDocsPage() {
  const [base, setBase] = useState('https://your-app.example')
  useEffect(() => {
    setBase((process.env.NEXT_PUBLIC_APP_URL || window.location.origin).replace(/\/$/, ''))
  }, [])

  return (
    <div className="max-w-4xl mx-auto space-y-8">
      <PageHeader
        title="API & webhook docs"
        description="Everything a developer — or a Zapier/Make scenario — needs to talk to EdgeQuote."
        crumb={{ label: 'Integrations', href: '/dashboard/integrations' }}
        action={
          <Link href="/dashboard/integrations">
            <Button variant="secondary"><ArrowLeft className="w-4 h-4" /> Manage integrations</Button>
          </Link>
        }
      />

      {/* Getting started */}
      <section id="getting-started" className="space-y-3 animate-rise stagger-1">
        <SectionHeading icon={KeyRound} title="Authentication" sub="Every request carries an API key you create under Integrations → API keys." />
        <Card>
          <CardBody className="space-y-3">
            <CopyRow label="Base URL" value={base} />
            <CodeBlock label="Your first request" code={`curl ${base}/api/v1/me \\\n  -H "Authorization: Bearer eq_live_…"`} />
            <p className="text-[12px] text-ink-muted">
              Keys have <Badge tone="info">read</Badge> and optionally <Badge tone="warn">write</Badge> scope. They are shown once and stored hashed —
              a lost key means minting a new one. Limit: {API_RATE_LIMIT_PER_MINUTE} requests/minute per key (HTTP 429 beyond it).
            </p>
          </CardBody>
        </Card>
      </section>

      {/* REST resources */}
      <section id="rest" className="space-y-3 animate-rise stagger-2">
        <SectionHeading icon={Globe} title="REST API" sub="Newest-first lists with limit (max 200), offset, and since (ISO timestamp). Responses: { data, has_more }." />
        <Card>
          <CardBody className="space-y-1.5">
            {RESOURCES.map((r) => (
              <div key={`${r.method} ${r.path}`} className="flex items-start gap-3 rounded-lg border border-border px-3 py-2">
                <Badge tone={r.method === 'GET' ? 'info' : r.method === 'POST' ? 'success' : 'danger'}>{r.method}</Badge>
                <code className="text-[12px] font-mono text-ink shrink-0">{r.path}</code>
                <span className="text-[12px] text-ink-muted flex-1">{r.note}</span>
                <Badge tone={r.scope === 'write' ? 'warn' : 'neutral'}>{r.scope}</Badge>
              </div>
            ))}
            <CodeBlock label="Example — invoices still owing" code={`curl "${base}/api/v1/invoices?status=unpaid&limit=20" \\\n  -H "Authorization: Bearer eq_live_…"`} className="pt-2" />
          </CardBody>
        </Card>
      </section>

      {/* Events */}
      <section id="events" className="space-y-3 animate-rise stagger-3">
        <SectionHeading icon={Zap} title="Events" sub="Captured at the database — dashboard, customer portal, booking page and Stripe all emit identically." />
        <div className="space-y-2">
          {INTEGRATION_EVENTS.map((ev) => (
            <Card key={ev.key}>
              <CardBody className="space-y-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <code className="text-[13px] font-mono text-accent-text font-semibold">{ev.key}</code>
                  <Badge tone="neutral">{ev.entity}</Badge>
                  <span className="text-[12px] text-ink-muted">{ev.description}</span>
                </div>
                <CodeBlock code={JSON.stringify(sampleDeliveryBody(ev.key), null, 2)} />
              </CardBody>
            </Card>
          ))}
        </div>
        <p className="text-[12px] text-ink-faint">
          Entity fields per resource: {Object.entries(SERIALIZED_FIELDS).map(([k, v]) => `${k} (${v.length})`).join(' · ')} — API responses and webhook
          payloads use the same field sets. Events are kept {RETENTION_DAYS} days; the payload `id` is stable across retries (use it for idempotency).
        </p>
      </section>

      {/* Webhooks */}
      <section id="webhooks" className="space-y-3 animate-rise stagger-4">
        <SectionHeading icon={Webhook} title="Outbound webhooks" sub="Signed JSON POSTs the moment events happen, with automatic retries." />
        <Card>
          <CardHeader><h3 className="font-semibold text-ink flex items-center gap-2"><ShieldCheck className="w-4 h-4 text-accent-text" /> Verifying signatures</h3></CardHeader>
          <CardBody className="space-y-3">
            <p className="text-[12px] text-ink-muted">
              Every delivery carries <code className="text-ink">{SIGNATURE_HEADER}: t=&lt;unix&gt;,v1=&lt;hmac&gt;</code> — an HMAC-SHA256 of{' '}
              <code className="text-ink">{'`${t}.${rawBody}`'}</code> keyed by the endpoint&apos;s <code className="text-ink">whsec_</code> secret, plus{' '}
              <code className="text-ink">x-edgequote-event</code> and <code className="text-ink">x-edgequote-delivery</code> headers.
            </p>
            <CodeBlock label="Node.js verification" code={VERIFY_SNIPPET} />
          </CardBody>
        </Card>
        <Card>
          <CardHeader><h3 className="font-semibold text-ink">Retries & failure policy</h3></CardHeader>
          <CardBody className="space-y-2">
            <p className="text-[12px] text-ink-muted">
              Answer any 2xx within 8 seconds. Anything else retries up to {MAX_ATTEMPTS} total attempts with backoff:
            </p>
            <div className="flex flex-wrap gap-1.5">
              {BACKOFF_MINUTES.map((m, i) => (
                <Badge key={i} tone="neutral">{m < 60 ? `${m}m` : `${m / 60}h`}</Badge>
              ))}
            </div>
            <p className="text-[12px] text-ink-muted">
              After {AUTO_DISABLE_AFTER} consecutive failed attempts the endpoint is paused automatically (resume it from the Webhooks tab).
              Use the <em>Test</em> button to send a signed <code className="text-ink">{TEST_EVENT}</code> through the real pipeline, and the
              delivery log to inspect payloads, responses and retry timing.
            </p>
          </CardBody>
        </Card>
      </section>

      {/* Inbound */}
      <section id="inbound" className="space-y-3 animate-rise stagger-5">
        <SectionHeading icon={ArrowDownToLine} title="Inbound webhooks" sub="POST JSON at EdgeQuote and get a customer or a full lead out." />
        <Card>
          <CardBody className="space-y-3">
            <CodeBlock code={`curl -X POST ${base}/api/hooks/in/eqin_… \\\n  -H "Content-Type: application/json" \\\n  -d '{\n    "name": "Jordan Miller",\n    "email": "jordan@example.com",\n    "phone": "403-555-0142",\n    "address": "128 Aspen Ridge Way SW",\n    "message": "Please quote weekly mowing."\n  }'`} />
            <p className="text-[12px] text-ink-muted">
              Field aliases from common tools are understood (full_name, tel, comments, …). At least one of name / email / phone is required.
              Returning customers are matched by phone (last 10 digits), then email — same rules as the website form. A <em>lead</em> hook also raises a
              service request that threads into Messages. GET the URL for a side-effect-free liveness check. Limit: 60 payloads/hour per hook.
            </p>
          </CardBody>
        </Card>
      </section>

      {/* Zapier */}
      <section id="zapier" className="space-y-3 animate-rise stagger-6">
        <SectionHeading icon={Zap} title="Zapier recipe" sub="Works today with 'Webhooks by Zapier' — no EdgeQuote app install needed." />
        <Card>
          <CardBody className="space-y-2 text-[13px] text-ink-muted">
            <p><strong className="text-ink">Trigger (instant):</strong> Webhooks by Zapier → <em>Catch Hook</em>. Copy the hook URL Zapier gives you, then either add it under Integrations → Webhooks, or subscribe via the API:</p>
            <CodeBlock code={`curl -X POST ${base}/api/v1/hooks \\\n  -H "Authorization: Bearer eq_live_…" \\\n  -H "Content-Type: application/json" \\\n  -d '{"url": "https://hooks.zapier.com/hooks/catch/…", "events": ["invoice.paid", "quote.accepted"]}'`} />
            <p><strong className="text-ink">Trigger (polling / samples):</strong> point Zapier&apos;s GET at <code className="text-ink">{`${base}/api/v1/events?event=invoice.paid`}</code>.</p>
            <p><strong className="text-ink">Action (create a lead in EdgeQuote):</strong> Webhooks by Zapier → <em>POST</em> to your inbound webhook URL with the JSON fields above.</p>
            <p><strong className="text-ink">Lookups:</strong> GET any REST resource (e.g. find a customer by listing with filters) using the API key in an Authorization header.</p>
          </CardBody>
        </Card>
      </section>

      {/* Make */}
      <section id="make" className="space-y-3 animate-rise stagger-6">
        <SectionHeading icon={BookOpen} title="Make (Integromat) recipe" />
        <Card>
          <CardBody className="space-y-2 text-[13px] text-ink-muted">
            <p><strong className="text-ink">Instant trigger:</strong> add a <em>Custom webhook</em> module, copy its URL into Integrations → Webhooks (pick your events), and Make receives signed deliveries.</p>
            <p><strong className="text-ink">Actions & searches:</strong> use the <em>HTTP</em> module with <code className="text-ink">Authorization: Bearer eq_live_…</code> against the REST API, or POST to an inbound webhook URL to create leads.</p>
          </CardBody>
        </Card>
      </section>

      <p className="text-[12px] text-ink-faint pb-4">
        Also available: the public booking API (services, availability, bookings) keyed by your booking token — see{' '}
        <Link href="/dashboard/settings#booking" className="text-accent-text hover:underline">Settings → Online booking</Link>.
      </p>
    </div>
  )
}
