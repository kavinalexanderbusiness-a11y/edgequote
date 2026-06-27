'use client'

import { useEffect, useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { toneSoft, type Tone } from '@/lib/tone'

// ── AI Vision — shared UI primitives ──────────────────────────────────────────
// Small pieces reused across the Vision surface so the same chip / entrance
// animation isn't re-implemented (and re-styled slightly differently) in every
// component. Purely presentational; no behaviour.

// One tinted status chip. Replaces the `inline-flex … rounded-full border` +
// toneSoft[tone] markup that was hand-rolled in 4 components.
export function Pill({
  tone, icon: Icon, children, className,
}: { tone: Tone; icon?: LucideIcon; children: React.ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full border', toneSoft[tone], className)}>
      {Icon && <Icon className="w-2.5 h-2.5 shrink-0" />}
      {children}
    </span>
  )
}

// Fade + lift content in on mount. Used to make property/tab swaps feel smooth
// without pulling in an animation library or touching global CSS. Give it a
// `key` that changes on a real swap so it re-runs only when it should.
export function FadeIn({ children, className }: { children: React.ReactNode; className?: string }) {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const r = requestAnimationFrame(() => setShown(true))
    return () => cancelAnimationFrame(r)
  }, [])
  return (
    <div className={cn('transition-[opacity,transform] duration-300 ease-out', shown ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-1', className)}>
      {children}
    </div>
  )
}
