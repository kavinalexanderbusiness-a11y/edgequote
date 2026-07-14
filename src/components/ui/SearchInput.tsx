import { InputHTMLAttributes, forwardRef } from 'react'
import { Search } from 'lucide-react'
import { cn } from '@/lib/utils'

// ── SearchInput ───────────────────────────────────────────────────────────────
// THE search box. Replaces the 8+ hand-rolled `relative + <Search> + <input>`
// copies (customers, quotes, messages, portal, marketing posts/queue/library,
// photo uploader) that drifted on background, border, radius, height, icon size,
// icon offset and focus treatment. One spec, matching ui/Input's field tokens:
// bg-bg-tertiary · border-border-strong · rounded-xl · text-base sm:text-sm ·
// focus ring-accent/20 · w-4 icon at left-3.5. Compact contexts pass
// `size="sm"`.
interface SearchInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  fieldSize?: 'sm' | 'md'
}

const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(
  ({ className, fieldSize = 'md', ...props }, ref) => {
    const sm = fieldSize === 'sm'
    return (
      <div className={cn('relative', className)}>
        <Search className={cn('absolute top-1/2 -translate-y-1/2 text-ink-faint pointer-events-none', sm ? 'left-3 w-3.5 h-3.5' : 'left-3.5 w-4 h-4')} />
        <input
          ref={ref}
          type="search"
          className={cn(
            'w-full bg-bg-tertiary border border-border-strong text-ink placeholder:text-ink-faint outline-none transition-all',
            'focus:border-accent focus:ring-2 focus:ring-accent/20',
            sm ? 'rounded-lg pl-9 pr-3 py-2 text-sm' : 'rounded-xl pl-10 pr-3.5 py-3 text-base sm:text-sm',
          )}
          {...props}
        />
      </div>
    )
  }
)

SearchInput.displayName = 'SearchInput'
export { SearchInput }
