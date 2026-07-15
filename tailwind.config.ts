import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      // Theme tokens live as CSS variables (globals.css) so Light/Dark/System
      // switch without touching components. Channel triplets keep Tailwind's
      // /opacity modifiers (bg-accent/10 etc.) working.
      colors: {
        bg: {
          DEFAULT: 'rgb(var(--c-bg) / <alpha-value>)',
          secondary: 'rgb(var(--c-bg-secondary) / <alpha-value>)',
          tertiary: 'rgb(var(--c-bg-tertiary) / <alpha-value>)',
        },
        surface: {
          DEFAULT: 'rgb(var(--c-surface) / <alpha-value>)',
          raised: 'rgb(var(--c-surface-raised) / <alpha-value>)',
        },
        border: {
          DEFAULT: 'var(--c-border)',
          strong: 'var(--c-border-strong)',
        },
        accent: {
          DEFAULT: 'rgb(var(--c-accent) / <alpha-value>)',
          hover: 'rgb(var(--c-accent-hover) / <alpha-value>)',
          dim: 'var(--c-accent-dim)',
          // Accent as TEXT only (`text-accent-text`). The DEFAULT above is a FILL
          // colour and fails AA as text on white; this one passes in both themes.
          // Never use for fills/borders/rings — see globals.css for the rationale.
          text: 'rgb(var(--c-accent-text) / <alpha-value>)',
        },
        ink: {
          DEFAULT: 'rgb(var(--c-ink) / <alpha-value>)',
          muted: 'rgb(var(--c-ink-muted) / <alpha-value>)',
          faint: 'rgb(var(--c-ink-faint) / <alpha-value>)',
        },
      },
      fontFamily: {
        display: ['var(--font-syne)', 'sans-serif'],
        body: ['var(--font-dm-sans)', 'sans-serif'],
      },
      borderRadius: {
        card: '14px',
        xl2: '20px',
      },
      // ── Layering contract ──────────────────────────────────────────────────
      // Everything that floats above the page stacks here. The numbers are the
      // ones the app already used — this only NAMES them, so a new overlay reads
      // the order instead of guessing it (guessing is how a stray `z-[55]` got
      // added). Local/in-card stacking keeps plain z-10…z-40; anything global
      // must use one of these.
      zIndex: {
        overlay: '50',        // dialogs, drawers, lightboxes + their scrims
        'overlay-top': '60',  // an overlay that must clear another overlay
        notice: '90',         // offline / install system notices
        toast: '100',         // toasts + the notification popover
        menu: '200',          // menus, popovers, command palette, skip link — always top
      },
      // 18px step — w-4.5/h-4.5 icons inside 32px chips were silently falling
      // back to lucide's 24px default because this step didn't exist.
      spacing: {
        '4.5': '1.125rem',
      },
    },
  },
  plugins: [],
}

export default config
