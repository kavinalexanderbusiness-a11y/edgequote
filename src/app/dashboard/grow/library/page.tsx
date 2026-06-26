import { createClient } from '@/lib/supabase/server'
import { listCandidates } from '@/lib/marketing/data'
import { LibraryClient } from '@/components/grow/marketing/LibraryClient'

// Content Library — every completed job, scored and searchable, feeding the Studio.
export default async function LibraryPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null // dashboard layout redirects unauthenticated users

  const candidates = await listCandidates(supabase, user.id)
  return <LibraryClient candidates={candidates} />
}
