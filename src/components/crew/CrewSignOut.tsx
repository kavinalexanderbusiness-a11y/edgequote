'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/Button'
import { LogOut } from 'lucide-react'

// Work phones get shared and get lost. Signing out has to be one obvious tap,
// and it has to actually clear the session before we navigate — pushing first
// would race the cookie clear and land back on a still-authenticated /crew.
export function CrewSignOut() {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  return (
    <Button
      variant="secondary"
      className="w-full tap-target h-12"
      loading={busy}
      onClick={async () => {
        setBusy(true)
        await createClient().auth.signOut()
        router.replace('/login')
        router.refresh()
      }}
    >
      <LogOut className="w-4 h-4" aria-hidden /> Sign out
    </Button>
  )
}
