'use client'

import { cn } from '@/lib/utils'

interface ToggleProps {
  checked: boolean
  onChange: (checked: boolean) => void
  label?: string
  ariaLabel?: string   // accessible name when there's no visible `label`
  disabled?: boolean
}

export function Toggle({ checked, onChange, label, ariaLabel, disabled }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={!label ? ariaLabel : undefined}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="inline-flex items-center gap-2.5 rounded-full disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
    >
      <span
        className={cn(
          'relative w-10 h-6 rounded-full transition-colors duration-200',
          checked ? 'bg-accent' : 'bg-ink-faint/30'
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform duration-200',
            checked && 'translate-x-4'
          )}
        />
      </span>
      {label && <span className="text-sm text-ink-muted">{label}</span>}
    </button>
  )
}