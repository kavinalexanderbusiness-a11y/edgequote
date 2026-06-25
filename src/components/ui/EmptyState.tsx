import { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from './Button'

interface EmptyStateProps {
  icon: LucideIcon
  title: string
  description: string
  action?: { label: string; onClick: () => void }
  className?: string
}

export function EmptyState({ icon: Icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center justify-center py-20 text-center', className)}>
      <div className="w-14 h-14 rounded-2xl bg-surface-raised border border-border-strong flex items-center justify-center mb-4">
        <Icon className="w-6 h-6 text-ink-faint" />
      </div>
      <h3 className="text-base font-semibold text-ink mb-1">{title}</h3>
      <p className="text-sm text-ink-muted max-w-xs mb-6">{description}</p>
      {action && (
        <Button onClick={action.onClick}>{action.label}</Button>
      )}
    </div>
  )
}

// Compact in-card / in-panel empty. Use when a full EmptyState (py-20) would be
// too tall — e.g. an empty list inside a Card. One look for all "nothing here yet"
// lines so they stop drifting on size, colour and padding.
export function InlineEmpty({ icon: Icon, children, className }: { icon?: LucideIcon; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 py-8 px-4 text-center text-sm text-ink-muted', className)}>
      {Icon && <Icon className="w-5 h-5 text-ink-faint" />}
      <span>{children}</span>
    </div>
  )
}
