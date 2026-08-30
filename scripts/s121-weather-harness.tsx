// ── Session 121 timezone/weather harness ─────────────────────────────────────
//   tsx --tsconfig tsconfig.harness.json scripts/s121-weather-harness.tsx <outdir>
//
// Renders the REAL weather surfaces to static markup with the real compiled CSS,
// so headless Chrome can lay them out and MEASURE them at 375 / 390 / 430 /
// desktop. Same pattern as scripts/qb-harness.tsx and s121-acceptance-harness.
//
// ⭐ THE FIXTURE IS THE BUG. Every scene is built at the exact moment the defect
// bit: a tenant date of the 28th while UTC has already rolled to the 29th. If
// the page can be made to print two "Today"s, this is where it happens — so the
// CDP driver counts them rather than trusting that the code reads correctly.
//
// ⛔ Proves PRESENTATION. The date arithmetic itself is proved by
// verify:tenant-time against the real IANA database, and the labelling
// invariants by verify:weather-truth over every day of the year.

import { renderToStaticMarkup } from 'react-dom/server'
import { writeFileSync, readdirSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { Card } from '../src/components/ui/Card'
import { cn } from '../src/lib/utils'
import { forecastDayLabel, forecastDayFullLabel, rejectionLine, type DryDayEvaluation } from '../src/lib/weatherTruth'
import { addDaysISO, tenantTodayISO } from '../src/lib/tenantTime'
import { Sun, AlertTriangle, Droplets } from 'lucide-react'

const outdir = process.argv[2] || '.s121tz'
mkdirSync(outdir, { recursive: true })
const cssDir = '.next/static/css'
const css = readdirSync(cssDir).filter(f => f.endsWith('.css'))
  .map(f => readFileSync(join(cssDir, f), 'utf8')).join('\n')

// ⭐ 23:30 on the 28th in Edmonton — 05:30 on the 29th in UTC. The instant the
// two clocks disagreed, and therefore the instant the page printed two "Today"s.
const INSTANT = new Date('2026-08-29T05:30:00Z')
const TODAY = tenantTodayISO('America/Edmonton', INSTANT)   // 2026-08-28
const UTC_TODAY = INSTANT.toISOString().slice(0, 10)         // 2026-08-29

const DAYS = Array.from({ length: 7 }, (_, i) => ({
  date: addDaysISO(TODAY, i),
  precipProbability: [10, 80, 20, 5, 0, 0, 15][i],
  emoji: ['🌤️', '🌧️', '⛅', '☀️', '☀️', '☀️', '🌤️'][i],
  label: ['Partly cloudy', 'Rain', 'Cloudy', 'Sunny', 'Sunny', 'Sunny', 'Partly cloudy'][i],
}))

/** The two nearest-day cards — where the duplicate "Today" rendered. */
function DayCards() {
  return (
    <div className="max-w-5xl mx-auto p-4" data-probe="cards">
      {/* The setup, visible in the screenshot so a human can see WHICH moment is
          being measured. `data-nocount` keeps it out of the "how many things say
          Today" count — it is a caption about the fixture, not a day label. */}
      <p className="text-[10px] text-ink-faint mb-2" data-nocount>
        fixture: business date {TODAY} · UTC date {UTC_TODAY} (23:30 in Edmonton)
      </p>
      <div className="grid grid-cols-2 gap-3">
        {[DAYS[0], DAYS[1]].map(f => {
          const d = forecastDayLabel(f.date, TODAY)
          return (
            <Card key={f.date} className="p-4">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint">
                  {d.label} <span className="text-ink-faint/70 normal-case">· {d.dated}</span>
                </p>
              </div>
              <div className="flex items-center gap-3 mt-1">
                <span className="text-3xl leading-none">{f.emoji}</span>
                <div>
                  <p className="text-sm font-bold text-ink">{f.label}</p>
                  <p className="text-[11px] text-ink-muted">{f.precipProbability}% rain · 2mm · 21°/9°</p>
                </div>
              </div>
            </Card>
          )
        })}
      </div>
    </div>
  )
}

/** The 7-day outlook strip — where "Now" used to sit on tomorrow. */
function Strip() {
  return (
    <div className="max-w-5xl mx-auto p-4" data-probe="strip">
      <Card className="p-4">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint mb-2 flex items-center gap-1.5">
          <Droplets className="w-3.5 h-3.5" /> 7-day outlook
        </p>
        <div className="flex items-end gap-1.5 h-28">
          {DAYS.map(f => (
            <div key={f.date} className="flex-1 flex flex-col items-center justify-end gap-1 min-w-0">
              <span className="text-[10px] text-ink-faint tabular-nums">{f.precipProbability}%</span>
              <div className={cn('w-full rounded-t bg-emerald-500/40')} style={{ height: `${Math.max(4, f.precipProbability)}%` }} />
              <span className="text-base leading-none">{f.emoji}</span>
              <span className="text-[10px] text-ink-faint truncate w-full text-center leading-tight">
                {forecastDayLabel(f.date, TODAY).short}
              </span>
              <span className="text-[9px] text-ink-faint/70 truncate w-full text-center tabular-nums">
                {forecastDayLabel(f.date, TODAY).dated}
              </span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  )
}

// The business date is a Friday, so the offsets below land Sat/Sun on the
// weekend — one rejection of each kind, in an order an owner would actually
// meet them. A fixture whose "not one of your working days" fell on a Wednesday
// would measure the same pixels while illustrating nothing.
const REJECTIONS: DryDayEvaluation[] = [
  { date: addDaysISO(TODAY, 2), rejection: 'not_a_work_day' },                    // Sun
  { date: addDaysISO(TODAY, 3), rejection: 'over_capacity', detail: '11h of 8h' }, // Mon
  { date: addDaysISO(TODAY, 4), rejection: 'day_blocked' },                        // Tue
]

/** The rain-risk row, with the "why not the other dry days?" explanation open. */
function RiskRow() {
  return (
    <div className="max-w-5xl mx-auto p-4" data-probe="risk">
      <Card className="p-4">
        <p className="text-sm font-bold text-ink flex items-center gap-1.5 flex-wrap">
          <span className="text-lg leading-none">🌧️</span>
          {forecastDayFullLabel(DAYS[1].date, TODAY)} — Rain
        </p>
        <p className="text-[11px] text-ink-muted mt-0.5">80% rain · 6mm · wind 24 km/h · 4 jobs · 6h · $1,840 · 4 customers</p>
        <p className="text-xs font-semibold mt-2 flex items-center gap-1.5 text-red-400">
          <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-red-400" />
          Delay 4 jobs — heavy rain all day. Best move: {forecastDayFullLabel(addDaysISO(TODAY, 5), TODAY)}.
        </p>
        <p className="text-[11px] mt-2 flex items-center gap-1.5 text-ink-muted">
          Best move: {forecastDayFullLabel(addDaysISO(TODAY, 5), TODAY)} (6h of 8h after)
        </p>
        {/* Rendered OPEN so the measurement sees the real rows rather than a
            collapsed summary — a <details> that is shut measures nothing. */}
        <details className="mt-2" open>
          <summary className="cursor-pointer select-none text-[11px] text-ink-faint list-none min-h-[44px] flex items-center gap-1.5">
            <Sun className="w-3 h-3 shrink-0" />
            Why not the other dry days? ({REJECTIONS.length})
          </summary>
          <ul className="mt-1.5 space-y-1 pl-4">
            {REJECTIONS.map(e => (
              <li key={e.date} className="text-[11px] text-ink-muted">{rejectionLine(e, TODAY)}</li>
            ))}
          </ul>
          <p className="text-[10px] text-ink-faint mt-1.5 pl-4">
            Working days and daily capacity come from Settings; a blocked day is cleared from the schedule calendar.
          </p>
        </details>
      </Card>
    </div>
  )
}

/** All three together — the page as an owner meets it. */
function WholePage() {
  return (
    <div data-probe="page">
      <DayCards />
      <Strip />
      <RiskRow />
      <div className="max-w-5xl mx-auto p-4">
        <p className="text-[11px] text-ink-muted flex items-center gap-1.5">
          <AlertTriangle className="w-3 h-3 shrink-0 text-amber-400" />
          Delay recommended tomorrow — 4 jobs, 6h, $1,840 at risk
        </p>
      </div>
    </div>
  )
}

const SCENES: [string, React.ReactElement][] = [
  ['weather-day-cards', <DayCards key="c" />],
  ['weather-outlook-strip', <Strip key="s" />],
  ['weather-why-not', <RiskRow key="r" />],
  ['weather-whole-page', <WholePage key="p" />],
]

for (const [name, node] of SCENES) {
  const html = `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${css}</style>
<style>html,body{margin:0;background:var(--bg,#0b0f14);}</style>
</head><body>${renderToStaticMarkup(node)}</body></html>`
  writeFileSync(join(outdir, `${name}.html`), html)
  console.log(`  wrote ${name}.html  (tenant ${TODAY} / UTC ${UTC_TODAY})`)
}
