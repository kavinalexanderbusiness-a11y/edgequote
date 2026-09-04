import { notFound } from 'next/navigation'
import { S122Fixture } from './S122Fixture'

// ── A dev-only verification surface ──────────────────────────────────────────
//
// ⛔⛔ TWO INDEPENDENT LOCKS, AND BOTH MUST BE OPEN. A production build refuses
// on the first; every other environment still refuses unless someone has
// deliberately set S122_FIXTURE=1 for that one process. Neither is a UI toggle
// and neither can be flipped by a request — no header, cookie, query string or
// body reaches this decision.
//
// ⚠️ WHY A ROUTE AT ALL. A browser proof needs the real components running in a
// real browser, which needs a real page. The alternative — asserting on source
// text and calling it a browser pass — is the exact substitution this lane keeps
// catching: a guard that greps a file pins the implementation's address, not
// what a customer sees. So the honest options were a page or no proof, and this
// is the smallest possible page: a guard, and one client component.
//
// ⛔ It renders no customer data, holds no credential, and its transport is a
// deny-by-default stub (see S122Fixture). It never reaches a database.

export const dynamic = 'force-dynamic'

export default function Page() {
  if (process.env.NODE_ENV === 'production') notFound()
  if (process.env.S122_FIXTURE !== '1') notFound()
  return <S122Fixture />
}
