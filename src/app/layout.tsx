import type { Metadata, Viewport } from 'next'
import { DM_Sans, Syne } from 'next/font/google'
import { ThemeWatcher } from '@/components/layout/ThemeWatcher'
import { ServiceWorkerRegister } from '@/components/pwa/ServiceWorkerRegister'
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
  title: 'EdgeQuote — Field Service Platform',
  description: 'Quoting, scheduling, messaging, invoicing and payments for field service businesses.',
  applicationName: 'EdgeQuote',
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, title: 'EdgeQuote', statusBarStyle: 'default' },
  icons: { icon: '/icon.svg', shortcut: '/icon.svg', apple: '/icon.svg' },
  formatDetection: { telephone: false },
}

export const viewport: Viewport = {
  themeColor: '#0b1120',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',   // draw under the safe-area insets so we control them in CSS
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${dmSans.variable} ${syne.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="font-body bg-bg text-ink antialiased">
        <ThemeWatcher />
        <ServiceWorkerRegister />
        {children}
      </body>
    </html>
  )
}
