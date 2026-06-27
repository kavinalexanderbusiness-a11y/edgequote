'use client'

import { BeforeAfterStudio } from '@/components/grow/beforeafter/BeforeAfterStudio'

// Before / After Studio — turn completed-job before & after photos into branded,
// ready-to-post images. All compositing runs in the browser; AI (optional) picks
// the strongest pair. Sits beside Marketing Studio under Grow; touches none of
// its content generation. The Studio owns its own PageHeader (title + count +
// action) so it matches the Schedule design reference in every state.
export default function BeforeAfterPage() {
  return (
    <div className="max-w-5xl">
      <BeforeAfterStudio />
    </div>
  )
}
