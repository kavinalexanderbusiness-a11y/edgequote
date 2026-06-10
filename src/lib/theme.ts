'use client'

// Theme preference lives in localStorage (per device, like an OS setting) and is
// applied as <html data-theme="light|dark">. A pre-hydration script in layout.tsx
// applies it before first paint so there is no flash.

export type ThemePref = 'light' | 'dark' | 'system'

export const THEME_KEY = 'eq-theme'

export function getThemePref(): ThemePref {
  if (typeof window === 'undefined') return 'dark'
  const v = window.localStorage.getItem(THEME_KEY)
  return v === 'light' || v === 'system' ? v : 'dark'
}

export function resolveTheme(pref: ThemePref): 'light' | 'dark' {
  if (pref !== 'system') return pref
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

export function applyThemePref(pref: ThemePref) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(THEME_KEY, pref)
  document.documentElement.dataset.theme = resolveTheme(pref)
  document.documentElement.dataset.themePref = pref
}
