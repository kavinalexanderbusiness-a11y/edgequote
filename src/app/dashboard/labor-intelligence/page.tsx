import { redirect } from 'next/navigation'

// Labor Intelligence has been merged into Business Intelligence as the
// "Labour accuracy & crew efficiency" section. This thin redirect keeps old
// links and bookmarks working.
export default function LaborIntelligenceRedirect() {
  redirect('/dashboard/intelligence')
}
