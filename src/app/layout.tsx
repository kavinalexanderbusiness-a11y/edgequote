import type { Metadata, Viewport } from 'next'
import localFont from 'next/font/local'
import { ThemeWatcher } from '@/components/layout/ThemeWatcher'
import { ServiceWorkerRegister } from '@/components/pwa/ServiceWorkerRegister'
import './globals.css'

// Applies the saved theme BEFORE first paint (no flash). Defaults to dark.
const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem('eq-theme');t=(t==='light'||t==='system')?t:'dark';var r=t==='system'?(matchMedia('(prefers-color-scheme: light)').matches?'light':'dark'):t;document.documentElement.dataset.theme=r;document.documentElement.dataset.themePref=t;}catch(e){}})()`

const dmSans = localFont({
  src: './fonts/dm-sans.ttf',
  weight: '100 1000',
  display: 'swap',
  variable: '--font-dm-sans',
})

const syne = localFont({
  src: './fonts/syne.ttf',
  display: 'swap',
  variable: '--font-syne',
  weight: '400 800',
})

export const metadata: Metadata = {
  title: 'EdgeHQ — Field Service Platform',
  description: 'Quoting, scheduling, messaging, invoicing and payments for field service businesses.',
  applicationName: 'EdgeHQ',
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, title: 'EdgeHQ', statusBarStyle: 'default' },
  icons: {
    icon: [
      { url: '/icon.svg', type: 'image/svg+xml', sizes: 'any' },
      { url: '/icon-192.png', type: 'image/png', sizes: '192x192' },
    ],
    shortcut: '/icon-192.png',
    apple: { url: '/apple-touch-icon.png', type: 'image/png', sizes: '180x180' },
  },
  formatDetection: { telephone: false },
}

export const viewport: Viewport = {
  themeColor: '#090a0c',
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
