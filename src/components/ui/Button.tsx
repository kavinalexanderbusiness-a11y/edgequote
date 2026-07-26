import { AnchorHTMLAttributes, ButtonHTMLAttributes, forwardRef } from 'react'
import Link from 'next/link'
import { cn } from '@/lib/utils'

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
type ButtonSize = 'sm' | 'md' | 'lg'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  loading?: boolean
}

// ONE class builder for everything that looks like a button. Before this
// existed, ten <Link>s across the app carried a hand-pasted copy of these
// strings — and every copy silently missed the 44px touch-target rework below,
// which is exactly how a primitive bypass drifts: not wrong on the day it's
// pasted, wrong the first time the primitive learns something new.
const BASE = 'inline-flex items-center justify-center gap-2 font-medium rounded-xl transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50'

const VARIANTS: Record<ButtonVariant, string> = {
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
const SIZES: Record<ButtonSize, string> = {
  sm: 'px-3.5 py-3 text-sm sm:py-2',
  md: 'px-4 py-3 text-sm sm:py-2.5',
  lg: 'px-5 py-3 text-base',
}

/** The full button look for a given variant/size — shared by Button and ButtonLink. */
export function buttonClasses(variant: ButtonVariant = 'primary', size: ButtonSize = 'md', className?: string) {
  return cn(BASE, VARIANTS[variant], SIZES[size], className)
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'primary', size = 'md', loading, children, disabled, type = 'button', ...props }, ref) => {
    return (
      // Default type="button": a plain <button> inside a <form> submits it, so an
      // untyped Button in a form (toggles, dialogs, measure tools) silently saved
      // the form. Submit buttons opt in explicitly with type="submit".
      <button
        ref={ref}
        type={type}
        className={buttonClasses(variant, size, className)}
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

interface ButtonLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  href: string
  variant?: ButtonVariant
  size?: ButtonSize
  /** External URL — renders a plain <a target="_blank" rel="noopener noreferrer"> instead of next/link. */
  external?: boolean
}

// A link that looks like a Button — THE primitive for navigation styled as an
// action ("New quote" in a header, "Open in Maps"). Same variants, same sizes,
// same focus ring, and crucially the same 44px mobile touch target, from the
// same class builder — so a Button rework can never strand a look-alike link
// again. next/link for in-app routes; `external` for real anchors.
function ButtonLink({ href, variant = 'primary', size = 'md', external, className, children, ...props }: ButtonLinkProps) {
  const cls = buttonClasses(variant, size, className)
  if (external) {
    return <a href={href} target="_blank" rel="noopener noreferrer" className={cls} {...props}>{children}</a>
  }
  return <Link href={href} className={cls} {...props}>{children}</Link>
}

export { Button, ButtonLink }
