'use client'

import { PageHeader } from '@/components/layout/PageHeader'
import { BeforeAfterStudio } from '@/components/grow/beforeafter/BeforeAfterStudio'

// Before / After Studio — turn completed-job before & after photos into branded,
// ready-to-post images. All compositing runs in the browser; AI (optional) picks
// the strongest pair. Sits beside Marketing Studio under Grow; touches none of
// its content generation.
export default function BeforeAfterPage() {
  return (
    <div className="max-w-6xl">
      <PageHeader
        title="Before / After Studio"
        description="Turn a job’s before & after photos into a branded post — pick the best pair, then download for any channel."
      />
      <BeforeAfterStudio />
    </div>
  )
}
