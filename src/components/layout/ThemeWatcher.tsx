'use client'

import { useEffect } from 'react'
import { getThemePref, applyThemePref } from '@/lib/theme'

// Keeps "System" mode live: when the OS scheme flips while the app is open,
// re-resolve the data-theme attribute. Renders nothing.
export function ThemeWatcher() {
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    const onChange = () => { if (getThemePref() === 'system') applyThemePref('system') }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return null
}
