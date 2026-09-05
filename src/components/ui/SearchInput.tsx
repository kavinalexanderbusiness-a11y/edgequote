import { InputHTMLAttributes, forwardRef } from 'react'
import { Search, X } from 'lucide-react'
import { cn } from '@/lib/utils'

// ── SearchInput ───────────────────────────────────────────────────────────────
// THE search box. Replaces the 8+ hand-rolled `relative + <Search> + <input>`
// copies (customers, quotes, messages, portal, marketing posts/queue/library,
// photo uploader) that drifted on background, border, radius, height, icon size,
// icon offset and focus treatment. One spec, matching ui/Input's field tokens:
// bg-bg-tertiary · border-border-strong · rounded-xl · text-base sm:text-sm ·
// focus ring-accent/20 · w-4 icon at left-3.5. Compact contexts pass
// `size="sm"`.
//
// Three optional finishing touches, all opt-in, so existing call sites render
// exactly as before:
// • `label` — the ACCESSIBLE NAME. A placeholder is a hint, not a name: an
//   unlabeled search box reads as "search, edit text" to a screen reader, and
//   the Customers and Quotes boxes had no name in the accessibility tree. A
//   caller's own aria-label always wins.
// • `onClear` — an accessible Clear button while there is a value. WebKit's
//   built-in × is mouse-only and Firefox draws none; Escape clears too, but a
//   shortcut nobody can see is not a control. Hides the WebKit × so there is
//   exactly one.
// • `shortcutHint` — the keyboard shortcut ("/") as a <kbd> at the right of an
//   empty box on wider screens. It used to ride inside the placeholder
//   ("Search quotes…  ( / )"), where it read — and was announced — as text.
interface SearchInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  fieldSize?: 'sm' | 'md'
  label?: string
  onClear?: () => void
  shortcutHint?: string
}

const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(
  ({ className, fieldSize = 'md', label, onClear, shortcutHint, ...props }, ref) => {
    const sm = fieldSize === 'sm'
    const hasValue = typeof props.value === 'number' || (typeof props.value === 'string' && props.value.length > 0)
    const trailing = onClear && hasValue ? 'clear' : shortcutHint ? 'hint' : null
    return (
      <div className={cn('relative', className)}>
        <Search className={cn('absolute top-1/2 -translate-y-1/2 text-ink-faint pointer-events-none', sm ? 'left-3 w-3.5 h-3.5' : 'left-3.5 w-4 h-4')} />
        <input
          ref={ref}
          type="search"
          // Mobile keyboard ergonomics for a search box, all overridable via
          // {...props} below:
          // • enterKeyHint="search" — the return key becomes a Search key.
          // • no autocapitalize/autocorrect/spellcheck — a query is a name, an
          //   address, an email or a quote #, not prose; iOS capitalising the
          //   first letter and autocorrecting identifiers actively fights it.
          enterKeyHint="search"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className={cn(
            'w-full bg-bg-tertiary border border-border-strong text-ink placeholder:text-ink-faint outline-none transition-all',
            'focus:border-accent focus:ring-2 focus:ring-accent/20',
            sm ? 'rounded-lg pl-9 py-2 text-sm' : 'rounded-xl pl-10 py-3 text-base sm:text-sm',
            trailing ? (sm ? 'pr-9' : 'pr-10') : (sm ? 'pr-3' : 'pr-3.5'),
            onClear && '[&::-webkit-search-cancel-button]:appearance-none',
          )}
          {...props}
          aria-label={props['aria-label'] ?? label}
        />
        {trailing === 'clear' && (
          <button type="button" onClick={event => {
            // Clearing removes this button; keep typing focus in the search field.
            event.currentTarget.parentElement?.querySelector('input')?.focus({ preventScroll: true })
            onClear?.()
          }} aria-label="Clear search"
            className={cn('absolute top-1/2 -translate-y-1/2 flex items-center justify-center rounded-md text-ink-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
              sm ? 'right-1 w-7 h-7' : 'right-1.5 w-8 h-8')}>
            <X className={sm ? 'w-3.5 h-3.5' : 'w-4 h-4'} />
          </button>
        )}
        {trailing === 'hint' && (
          <kbd aria-hidden="true"
            className={cn('absolute top-1/2 -translate-y-1/2 hidden sm:inline-flex items-center rounded border border-border bg-bg-secondary px-1.5 h-5 text-[10px] font-medium text-ink-faint pointer-events-none',
              sm ? 'right-2' : 'right-3')}>
            {shortcutHint}
          </kbd>
        )}
      </div>
    )
  }
)

SearchInput.displayName = 'SearchInput'
export { SearchInput }
