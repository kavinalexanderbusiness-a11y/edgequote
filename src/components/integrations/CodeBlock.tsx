'use client'

// Copyable code + credential rows for the integrations surface — the
// WebsiteIntegration copy pattern promoted to a shared component (that file
// predates this one; its inline copies stay put on purpose).

import { useState } from 'react'
import { Check, Copy, Eye, EyeOff } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'

export function useCopy(): [string | null, (key: string, text: string) => Promise<void>] {
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const copy = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedKey(key)
      setTimeout(() => setCopiedKey(null), 1600)
    } catch {
      /* clipboard unavailable — the text is still selectable */
    }
  }
  return [copiedKey, copy]
}

export function CodeBlock({ code, label, className }: { code: string; label?: string; className?: string }) {
  const [copiedKey, copy] = useCopy()
  return (
    <div className={cn('relative group', className)}>
      {label && <div className="text-[11px] font-medium text-ink-faint mb-1">{label}</div>}
      <pre className="bg-bg-tertiary border border-border-strong rounded-lg p-3 pr-10 text-[11px] leading-relaxed font-mono text-ink-muted overflow-x-auto max-h-72 whitespace-pre">
        {code}
      </pre>
      <button
        type="button"
        onClick={() => copy('code', code)}
        aria-label="Copy code"
        className="absolute right-2 top-2 rounded-md p-1.5 text-ink-faint hover:text-ink hover:bg-surface transition-colors"
        style={label ? { top: '1.65rem' } : undefined}
      >
        {copiedKey === 'code' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
      </button>
    </div>
  )
}

export function CopyRow({
  label, value, masked = false, className,
}: { label: string; value: string; masked?: boolean; className?: string }) {
  const [copiedKey, copy] = useCopy()
  const [revealed, setRevealed] = useState(!masked)
  const shown = revealed ? value : value.slice(0, 10) + '•'.repeat(Math.max(6, Math.min(18, value.length - 10)))
  return (
    <div className={cn('space-y-1', className)}>
      <div className="text-[11px] font-medium text-ink-faint">{label}</div>
      <div className="flex items-center gap-1.5">
        <input
          readOnly
          value={shown}
          onFocus={(e) => e.currentTarget.select()}
          className="flex-1 min-w-0 rounded-lg border border-border-strong bg-bg-tertiary px-2.5 py-1.5 text-[12px] font-mono text-ink-muted"
        />
        {masked && (
          <Button variant="ghost" size="sm" onClick={() => setRevealed((r) => !r)} aria-label={revealed ? 'Hide' : 'Reveal'}>
            {revealed ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={() => copy(label, value)}>
          {copiedKey === label ? <><Check className="w-3.5 h-3.5 text-emerald-400" /> Copied</> : <><Copy className="w-3.5 h-3.5" /> Copy</>}
        </Button>
      </div>
    </div>
  )
}
