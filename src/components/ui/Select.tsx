import { SelectHTMLAttributes, forwardRef, useId } from 'react'
import { cn } from '@/lib/utils'

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string
  error?: string
  hint?: string
  options: { value: string; label: string; disabled?: boolean }[]
  placeholder?: string
  /** 'sm' = the blessed compact field (rounded-lg px-3 py-2 text-sm) — matches Input's. */
  fieldSize?: 'sm' | 'md'
}

const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, label, error, hint, options, placeholder, id, fieldSize = 'md', ...props }, ref) => {
    const generatedId = useId()
    const inputId = id ?? generatedId
    return (
      <div className="flex flex-col gap-1.5">
        {label && (
          <label htmlFor={inputId} className="text-xs font-semibold text-ink-muted uppercase tracking-wide">
            {label}
          </label>
        )}
        <select
          ref={ref}
          id={inputId}
          className={cn(
            'w-full bg-bg-tertiary border text-ink outline-none transition-all appearance-none',
            fieldSize === 'sm' ? 'rounded-lg px-3 py-2 pr-8 text-sm' : 'rounded-xl px-3.5 py-3 text-base sm:text-sm',
            'bg-[url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'14\' height=\'14\' viewBox=\'0 0 24 24\' fill=\'none\' stroke=\'%238A9AB8\' stroke-width=\'2\'%3E%3Cpath d=\'M6 9l6 6 6-6\'/%3E%3C/svg%3E")] bg-no-repeat bg-[right_14px_center]',
            error
              ? 'border-red-500/50 focus:border-red-500 focus:ring-2 focus:ring-red-500/20'
              : 'border-border-strong focus:border-accent focus:ring-2 focus:ring-accent/20',
            className
          )}
          {...props}
        >
          {placeholder && <option value="">{placeholder}</option>}
          {options.map((opt) => (
            <option key={opt.value} value={opt.value} disabled={opt.disabled} className="bg-bg-secondary">
              {opt.label}
            </option>
          ))}
        </select>
        {error && <p className="text-xs text-red-400 animate-fade">{error}</p>}
        {hint && !error && <p className="text-xs text-ink-faint animate-fade">{hint}</p>}
      </div>
    )
  }
)

Select.displayName = 'Select'
export { Select }
