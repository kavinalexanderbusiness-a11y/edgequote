import { notFound } from 'next/navigation'
import { GrowthVisualFixture } from './GrowthVisualFixture'

// ── A dev-only verification surface (the shape S122's browser fixture uses) ───
//
// ⛔⛔ TWO INDEPENDENT LOCKS, AND BOTH MUST BE OPEN. A production build refuses
// on the first; every other environment still refuses unless the process was
// started with GROWTH_VISUAL_FIXTURE=1. Neither is a UI toggle and neither can
// be flipped by a request — no header, cookie, query string or body reaches
// this decision. verify:growth-visual-fixture fails if either lock is removed.
//
// ⚠️ WHY A ROUTE AT ALL. The one pending item on the Growth follow-up is a
// browser proof at 375 / 390 / 430 / 1280 — real JSX, real Tailwind, real
// fonts, real wrapping — and a browser needs a page. Asserting on source text
// and calling it a visual pass is the substitution this lane keeps catching.
// This is the smallest page that can host the shipping view: a guard and one
// client component. It is linked from nowhere.
//
// ⛔ It renders no customer data, holds no credential and never reaches a
// database — see GrowthVisualFixture for the deny-by-default transport.

export const dynamic = 'force-dynamic'

export default function Page() {
  if (process.env.NODE_ENV === 'production') notFound()
  if (process.env.GROWTH_VISUAL_FIXTURE !== '1') notFound()
  return <GrowthVisualFixture />
}
