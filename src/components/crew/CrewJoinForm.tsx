'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Banner } from '@/components/ui/Banner'
import { LogOut } from 'lucide-react'

// Redeeming is a single DEFINER call (crew_redeem_invite). Every rule lives in
// SQL — expired, already used, wrong code, already linked, owner account — so
// the answer cannot differ between this form and any other caller, and the
// messages here are the database's own words rather than a second guess at them.
export function CrewJoinForm() {
  const router = useRouter()
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setBusy(true)
    const supabase = createClient()
    const { error: rpcError } = await supabase.rpc('crew_redeem_invite', { p_code: code.trim().toUpperCase() })
    if (rpcError) {
      setError(rpcError.message || 'That code didn’t work.')
      setBusy(false)
      return
    }
    // Full reload, not a soft push: the role changed, and every gate on the way
    // in (middleware, the crew layout) re-reads it from the database.
    router.replace('/crew')
    router.refresh()
  }

  return (
    <form onSubmit={submit} className="mt-6 space-y-4">
      {error && <Banner tone="danger">{error}</Banner>}
      <Input
        label="Join code"
        value={code}
        onChange={e => setCode(e.target.value.toUpperCase())}
        placeholder="ABCD2345"
        autoCapitalize="characters"
        autoCorrect="off"
        spellCheck={false}
        maxLength={12}
        required
      />
      <Button type="submit" className="w-full tap-target h-12" loading={busy} disabled={code.trim().length < 4}>
        Join
      </Button>
      <button
        type="button"
        onClick={async () => { await createClient().auth.signOut({ scope: 'global' }); router.replace('/login'); router.refresh() }}
        className="w-full text-xs text-ink-muted hover:text-ink flex items-center justify-center gap-1.5 py-2"
      >
        <LogOut className="w-3.5 h-3.5" aria-hidden /> Sign out
      </button>
    </form>
  )
}
