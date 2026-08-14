import { TextareaHTMLAttributes, forwardRef } from 'react'
import { cn } from '@/lib/utils'
import { fieldBorder } from './fieldStyles'
import { useFieldIds } from './useFieldIds'

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string
  error?: string
  /**
   * A standing statement about the field, shown under the label — not a
   * placeholder (which vanishes the moment anyone types) and not a validation
   * message. Added for the scoped-note fields, where WHO WILL READ THIS is part
   * of the field's meaning and must stay legible while the owner writes:
   * "Only your team can see this" / "Appears on the quote PDF". A promise that
   * disappears on the first keystroke is not a promise.
   */
  hint?: string
}

const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, label, error, hint, id, ...props }, ref) => {
    // Tie the error and hint text to the field so a screen reader reads them on
    // focus. An error supersedes the hint in aria-describedby — someone being
    // told what went wrong should not first hear the standing description.
    const { id: inputId, errorId, hintId } = useFieldIds(id)
    return (
      <div className="flex flex-col gap-1.5">
        {label && (
          <label htmlFor={inputId} className="text-xs font-semibold text-ink-muted uppercase tracking-wide">
            {label}
          </label>
        )}
        {hint && !error && (
          <p id={hintId} className="text-[11px] text-ink-muted -mt-0.5">{hint}</p>
        )}
        <textarea
          ref={ref}
          id={inputId}
          rows={3}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : hint ? hintId : undefined}
          className={cn(
         'w-full bg-bg-tertiary border rounded-xl px-3.5 py-3 text-base sm:text-sm text-ink placeholder:text-ink-faint outline-none transition-all resize-none',
            fieldBorder(error),
            className
          )}
          {...props}
        />
        {error && <p id={errorId} className="text-xs text-red-400 animate-fade">{error}</p>}
      </div>
    )
  }
)

Textarea.displayName = 'Textarea'
export { Textarea }
