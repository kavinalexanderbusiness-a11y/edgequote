import { ButtonHTMLAttributes, forwardRef } from 'react'
import { cn } from '@/lib/utils'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md' | 'lg'
  loading?: boolean
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'primary', size = 'md', loading, children, disabled, type = 'button', ...props }, ref) => {
    const base = 'inline-flex items-center justify-center gap-2 font-medium rounded-xl transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50'

    const variants = {
      primary:   'bg-accent text-black hover:bg-accent-hover active:scale-[0.98] shadow-sm',
      secondary: 'bg-surface border border-border-strong text-ink hover:bg-surface-raised active:scale-[0.98]',
      ghost:     'text-ink-muted hover:text-ink hover:bg-surface active:scale-[0.98]',
      danger:    'bg-red-500/10 border border-red-500/20 text-red-400 hover:bg-red-500/20 active:scale-[0.98]',
    }

    // 44px on a phone, unchanged on a desktop.
    //
    // This app is used one-handed, in a truck, with gloves on — and sm (36px) and md
    // (40px) both sat under the 44px minimum, while `lg` (48px) was too heavy for
    // dense rows. Every surface that needed a real touch target therefore hand-rolled
    // its way around the primitive, and they each picked a different answer: the
    // customer profile's quick actions ended up at 44, the property page's actions at
    // 24, timeline chips at 20, "Show more" at 16. Six heights, one intent.
    //
    // Padding rather than min-height, deliberately: `min-h-[44px]` would beat an
    // explicit `h-7 w-7` on an icon button (min-height wins over height) and render it
    // 44 tall by 28 wide. Padding leaves those overrides behaving exactly as they do
    // today. text-sm's line box is 20px, so py-3 → 20 + 24 = 44.
    const sizes = {
      sm: 'px-3.5 py-3 text-sm sm:py-2',
      md: 'px-4 py-3 text-sm sm:py-2.5',
      lg: 'px-5 py-3 text-base',
    }

    return (
      // Default type="button": a plain <button> inside a <form> submits it, so an
      // untyped Button in a form (toggles, dialogs, measure tools) silently saved
      // the form. Submit buttons opt in explicitly with type="submit".
      <button
        ref={ref}
        type={type}
        className={cn(base, variants[variant], sizes[size], className)}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        {...props}
      >
        {loading && (
          <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
          </svg>
        )}
        {children}
      </button>
    )
  }
)

Button.displayName = 'Button'
export { Button }
