import type { Metadata } from 'next'
import { DM_Sans, Syne } from 'next/font/google'
import { ThemeWatcher } from '@/components/layout/ThemeWatcher'
import './globals.css'

// Applies the saved theme BEFORE first paint (no flash). Defaults to dark.
const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem('eq-theme');t=(t==='light'||t==='system')?t:'dark';var r=t==='system'?(matchMedia('(prefers-color-scheme: light)').matches?'light':'dark'):t;document.documentElement.dataset.theme=r;document.documentElement.dataset.themePref=t;}catch(e){}})()`

const dmSans = DM_Sans({
  subsets: ['latin'],
  variable: '--font-dm-sans',
})

const syne = Syne({
  subsets: ['latin'],
  variable: '--font-syne',
  weight: ['400', '500', '600', '700', '800'],
})

export const metadata: Metadata = {
  title: 'EdgeQuote AI — Edge Property Services',
  description: 'Internal quoting tool for Edge Property Services',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${dmSans.variable} ${syne.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="font-body bg-bg text-ink antialiased">
        <ThemeWatcher />
        {children}
      </body>
    </html>
  )
}
