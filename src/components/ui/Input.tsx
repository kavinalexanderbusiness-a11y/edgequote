import { InputHTMLAttributes, ReactNode, forwardRef } from 'react'
import { cn } from '@/lib/utils'
import { fieldBorder } from './fieldStyles'
import { useFieldIds } from './useFieldIds'

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string
  error?: string
  /** ReactNode, not string: a hint that needed to emphasise part of itself (e.g.
      "**0 = unlimited**") was the reason a caller kept hand-rolling the field. */
  hint?: ReactNode
  /** 'sm' = the blessed compact field (rounded-lg px-3 py-2 text-sm) for dense
      inline panels — instead of hand-rolling a smaller input per file. */
  fieldSize?: 'sm' | 'md'
}

const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, label, error, hint, id, fieldSize = 'md', ...props }, ref) => {
    // Always-unique ids (label-slugs collided when two fields shared a label,
    // breaking label↔input association); an explicit `id` still wins. The
    // error/hint ids tie their text to the field so a screen reader reads it on
    // focus — see the aria-describedby/aria-invalid wiring below.
    const { id: inputId, errorId, hintId } = useFieldIds(id)
    return (
      <div className="flex flex-col gap-1.5">
        {label && (
          <label htmlFor={inputId} className="text-xs font-semibold text-ink-muted uppercase tracking-wide">
            {label}
          </label>
        )}
        <input
          ref={ref}
          id={inputId}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : hint ? hintId : undefined}
          className={cn(
            'w-full bg-bg-tertiary border text-ink placeholder:text-ink-faint outline-none transition-all',
            fieldSize === 'sm' ? 'rounded-lg px-3 py-2 text-sm' : 'rounded-xl px-3.5 py-3 text-base sm:text-sm',
            fieldBorder(error),
            className
          )}
          {...props}
          // type="number" alone leaves iOS showing the full text keyboard;
          // inputMode="decimal" is what actually summons the number pad. Set
          // centrally so every qty/price/hours field in the app gets it — an
          // explicit inputMode from a caller still wins.
          inputMode={props.inputMode ?? (props.type === 'number' ? 'decimal' : undefined)}
        />
        {error && <p id={errorId} className="text-xs text-red-400 animate-fade">{error}</p>}
        {hint && !error && <p id={hintId} className="text-xs text-ink-faint animate-fade">{hint}</p>}
      </div>
    )
  }
)

Input.displayName = 'Input'
export { Input }
