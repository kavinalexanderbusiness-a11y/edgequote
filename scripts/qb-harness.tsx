// ── Quote-builder measurement harness (investigation tool, not a guard) ──────
// Renders the REAL QuoteBuilder to static markup with representative props,
// wraps it in the REAL compiled Tailwind CSS, and writes an HTML file that
// headless Chrome can lay out and measure. Source-class estimates were declared
// insufficient for this task, so every number in the report comes from here.
//
// Usage: tsx scripts/qb-harness.tsx <outdir> [scenario]
import { renderToStaticMarkup } from 'react-dom/server'
import { writeFileSync, readdirSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { QuoteBuilder } from '../src/components/quotes/QuoteBuilder'
import type { Customer, ServiceTemplate, TravelFeeTier, BusinessSettings } from '../src/types'

const outdir = process.argv[2] || '.qb'
const scenario = process.argv[3] || 'blank'
mkdirSync(outdir, { recursive: true })

const cssDir = '.next/static/css'
const css = readdirSync(cssDir).filter(f => f.endsWith('.css'))
  .map(f => readFileSync(join(cssDir, f), 'utf8')).join('\n')

const customers = [
  { id: 'c1', user_id: 'u', name: 'Jane Smith', phone: '4035550100', email: 'jane@example.com',
    address: '123 Elm St SW, Calgary', created_at: '2026-01-01', lawn_sqft: 4200 },
  { id: 'c2', user_id: 'u', name: 'Bob Chen', phone: '4035550111', email: 'bob@example.com',
    address: '88 Oak Cres NW, Calgary', created_at: '2026-01-01' },
] as unknown as Customer[]

// ⚠️ Real column names. The first draft of this fixture invented `active` /
// `base_price` / `pricing_kind`, so `activeTemplates` came out EMPTY and the
// harness measured a first-run business with no catalogue while claiming to
// measure a working one — the service picker never rendered at all. Anything
// measured off a fixture that does not satisfy the component's own filters is
// a measurement of the wrong screen.
const tmpl = (id: string, name: string, category: string,
  pricing_display_type: string, default_rate: number, extra: Record<string, unknown> = {}) => ({
  id, user_id: 'u', name, category, pricing_display_type, default_rate,
  is_active: true, is_favorite: false, sort_order: 0,
  created_at: '2026-01-01', updated_at: '2026-01-01',
  default_description: null, notes: null, unit_cost: null, material_cost: null,
  ...extra,
})
// ⚠️⚠️ SCALE is part of the fixture. The first version of this file listed FOUR
// services — under the builder's own `activeTemplates.length <= 6` branch, so
// every number it ever produced was measured against a chip row, while the live
// business has TWENTY-THREE active services and gets the native <select>. The
// screen the owner complained about was never the screen being measured.
// This list mirrors the real catalogue: 23 active + 4 retired, 5 categories.
const CATALOGUE: [string, string, string, number][] = [
  ['Lawn Mowing', 'Lawn Care', 'starting_from', 65],
  ['Weekly Mowing', 'Lawn Care', 'starting_from', 55],
  ['Bi-Weekly Mowing', 'Lawn Care', 'starting_from', 65],
  ['One-Time Mowing', 'Lawn Care', 'starting_from', 85],
  ['String Trimming', 'Lawn Care', 'hourly', 60],
  ['Lawn Edging', 'Lawn Care', 'per_linear_ft', 1.5],
  ['Spring Cleanup', 'Property Maintenance', 'starting_from', 240],
  ['Fall Cleanup', 'Property Maintenance', 'starting_from', 240],
  ['Yard Cleanup', 'Property Maintenance', 'hourly', 75],
  ['Weed Removal', 'Property Maintenance', 'hourly', 65],
  ['Weed Control', 'Property Maintenance', 'starting_from', 90],
  ['Lawn Fertilization', 'Property Maintenance', 'per_sqft', 0.02],
  ['Grass Seeding', 'Property Maintenance', 'per_sqft', 0.05],
  ['Gravel Installation', 'Landscaping', 'starting_from_materials', 350],
  ['Mulch Installation', 'Landscaping', 'starting_from_materials', 280],
  ['Rock Installation', 'Landscaping', 'starting_from_materials', 400],
  ['Landscape Bed Cleanup', 'Landscaping', 'hourly', 70],
  ['General Landscaping', 'Landscaping', 'hourly', 85],
  ['Fire Pit Area Preparation', 'Landscaping', 'starting_from_materials', 600],
  ['Hedge Trimming', 'Tree & Shrub Care', 'hourly', 95],
  ['Bush Shaping', 'Tree & Shrub Care', 'hourly', 85],
  ['Pruning', 'Tree & Shrub Care', 'hourly', 90],
  ['Small Branch Removal', 'Tree & Shrub Care', 'hourly', 110],
]
const RETIRED: [string, string, string, number][] = [
  ['Snow Removal', 'Winter Services', 'starting_from', 120],
  ['Sidewalk Clearing', 'Winter Services', 'starting_from', 60],
  ['Ice Control', 'Winter Services', 'starting_from', 45],
  ['Salting', 'Winter Services', 'starting_from', 40],
]
const fullCatalogue = [
  ...CATALOGUE.map(([name, cat, kind, rate], i) =>
    tmpl(`t${i + 1}`, name, cat, kind, rate,
      i === 0 ? { default_description: 'Weekly mow, trim and blow.' } : {})),
  ...RETIRED.map(([name, cat, kind, rate], i) => tmpl(`r${i + 1}`, name, cat, kind, rate, { is_active: false })),
] as unknown as ServiceTemplate[]

// The other real shape: a business that pruned its catalogue to what fits on one
// screen. Kept so the ≤6 chip branch is still measured rather than assumed.
const smallCatalogue = [
  tmpl('t1', 'Lawn Mowing', 'Lawn Care', 'starting_from', 65,
    { default_description: 'Weekly mow, trim and blow.' }),
  tmpl('t2', 'Hedge Trimming', 'Tree & Shrub Care', 'hourly', 95),
  tmpl('t3', 'Spring Cleanup', 'Property Maintenance', 'starting_from', 240),
  tmpl('t4', 'Mulch Install', 'Landscaping', 'per_sqft', 3),
] as unknown as ServiceTemplate[]

const tiers = [
  { id: 'v1', user_id: 'u', max_km: 15, fee: 0 },
  { id: 'v2', user_id: 'u', max_km: 30, fee: 25 },
] as unknown as TravelFeeTier[]

const settings = {
  user_id: 'u', business_name: 'Edge Property Services', default_labor_rate: 25,
  gst_percent: 5, base_address: '1 Depot Rd, Calgary', pricing_mow_rate: 0.0125,
} as unknown as BusinessSettings

const SCENARIOS: Record<string, Record<string, unknown>> = {
  // The ≤6 chip branch, on the same blank form — measured, not assumed.
  small: {},
  // A fresh quote — what an owner meets in a driveway.
  blank: {},
  // Straight off an existing customer card.
  customer: { customer_id: 'c1', customer_name: 'Jane Smith', address: '123 Elm St SW, Calgary' },
  // From a website lead: the richest prefill the app produces.
  lead: {
    customer_id: 'c1', customer_name: 'Jane Smith', customer_phone: '4035550100',
    customer_email: 'jane@example.com', address: '123 Elm St SW, Calgary',
    service_type: 'Lawn Mowing', lawn_sqft: 4200, notes: 'Gate code 1234. Dog in yard.',
  },
  // Multi-service + materials — the shape that exercises both line drawers.
  multi: {
    customer_id: 'c1', customer_name: 'Jane Smith', address: '123 Elm St SW, Calgary',
    service_type: 'Spring Cleanup', initial_price: 240,
    services: [
      { service_type: 'Hedge Trimming', quantity: 3, unit: 'hour', unit_price: 95, kind: 'service' },
      { service_type: 'Mulch', quantity: 4, unit: 'yard', unit_price: 85, kind: 'material' },
    ],
  },
}

const html = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${css}</style>
<style>body{margin:0}</style>
</head><body class="bg-bg text-ink"><div id="root">${
  renderToStaticMarkup(
    React.createElement(QuoteBuilder, {
      customers, templates: scenario === 'small' ? smallCatalogue : fullCatalogue, tiers, settings,
      defaultValues: SCENARIOS[scenario] ?? {},
      onSubmit: async () => undefined,
    } as never),
  )
}</div></body></html>`

writeFileSync(join(outdir, `${scenario}.html`), html)
console.log(`${scenario}.html  ${(html.length / 1024).toFixed(0)} kB`)
