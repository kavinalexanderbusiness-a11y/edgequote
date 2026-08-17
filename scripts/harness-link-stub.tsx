// Harness-only stub for next/link — a static render needs the <a> and its
// classes, not prefetching or the App Router context.
import React from 'react'

export default function Link(
  { href, children, ...rest }: { href: string; children: React.ReactNode } & Record<string, unknown>,
) {
  return React.createElement('a', { href, ...rest }, children)
}
