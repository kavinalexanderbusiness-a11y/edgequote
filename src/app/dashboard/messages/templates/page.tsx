'use client'

import Link from 'next/link'
import { PageHeader } from '@/components/layout/PageHeader'
import { MessageTemplateEditor } from '@/components/settings/MessageTemplateEditor'
import { Settings } from 'lucide-react'

// ── Templates, inside the Communications Center ────────────────────────────────
// THE one template editor (the same component Settings → Messaging mounts) —
// edits save to business_settings.message_templates, which every sender reads
// through renderMessage. Editing here or in Settings is the same edit.
export default function MessageTemplatesPage() {
  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <PageHeader title="Message templates"
        description="What every send starts from — automations, one-tap sends, and the composer all read these."
        action={
          <Link href="/dashboard/settings#messaging"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-ink-muted hover:text-ink border border-border rounded-xl px-3 py-2 transition-colors">
            <Settings className="w-3.5 h-3.5" /> Automations & delivery settings
          </Link>
        } />
      <MessageTemplateEditor />
    </div>
  )
}
