import { GRADE_COLORS, type Grade } from '@/lib/grade'
import { cn } from '@/lib/utils'

// ONE grade chip. Was four copies (two byte-identical, two size variants) that each
// re-derived the same alpha suffixes: fill = colour+'22', border = colour+'55'.
//
// `children` overrides the glyph for the one caller (Data Quality) that colours the
// chip by grade but shows the 0-100 score inside it.

const SIZES: Record<'sm' | 'md' | 'lg', string> = {
  sm: 'w-8 h-8 rounded-lg text-sm',
  md: 'w-10 h-10 rounded-xl text-lg',
  lg: 'w-16 h-16 rounded-2xl text-2xl tabular-nums',
}

export function GradeBadge({
  grade, size = 'md', className, children,
}: {
  grade: Grade
  size?: 'sm' | 'md' | 'lg'
  className?: string
  children?: React.ReactNode
}) {
  const color = GRADE_COLORS[grade]
  return (
    <div
      className={cn('flex items-center justify-center font-black shrink-0', SIZES[size], className)}
      style={{ backgroundColor: color + '22', color, border: `1px solid ${color}55` }}
    >
      {children ?? grade}
    </div>
  )
}
