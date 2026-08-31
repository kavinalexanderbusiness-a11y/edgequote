import { Bot, LockKeyhole } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { loadOperatorSnapshot } from '@/lib/operator/snapshot'
import { OperatorClient } from '@/components/operator/OperatorClient'
import { PageContainer } from '@/components/layout/PageContainer'
import { PageHeader } from '@/components/layout/PageHeader'

export const dynamic = 'force-dynamic'

export default async function OperatorPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const snapshot = await loadOperatorSnapshot(supabase, user.id)

  return (
    <PageContainer width="wide">
      <PageHeader
        title="Operator"
        description="Evidence first. Recommendations second. Execution stays locked."
        action={<div className="inline-flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1.5 text-xs font-semibold text-ink-muted"><LockKeyhole className="h-3.5 w-3.5" /> Phase 1 · Read only</div>}
      />
      <div className="mb-5 flex items-start gap-3 rounded-2xl border border-accent/20 bg-accent/5 p-4">
        <div className="rounded-xl bg-accent/15 p-2"><Bot className="h-4 w-4 text-accent-text" /></div>
        <div><p className="text-sm font-semibold text-ink">Edge Operator V1</p><p className="mt-0.5 text-xs leading-5 text-ink-muted">It reads the same EdgeQuote records and canonical money rules as the rest of the app, explains uncertainty, and prepares safe next steps. Customer and business content is treated as untrusted data.</p></div>
      </div>
      <OperatorClient initial={snapshot} />
    </PageContainer>
  )
}
