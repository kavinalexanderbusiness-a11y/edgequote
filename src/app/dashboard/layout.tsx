import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Sidebar } from '@/components/layout/Sidebar'
import { InstallPrompt } from '@/components/pwa/InstallPrompt'
import { CommandPalette } from '@/components/command/CommandPalette'
import { OfflineStatus } from '@/components/pwa/OfflineStatus'
import { Toaster } from '@/components/ui/Toaster'
import { ConfirmHost } from '@/components/ui/ConfirmHost'
import { UploadQueueWidget } from '@/components/photos/UploadQueueWidget'

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) redirect('/login')

  return (
    <div className="lg:flex min-h-screen">
      {/* Keyboard users can jump the sidebar straight to page content. Visually
          hidden until focused (Tab from the top of the page). */}
      <a href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-menu focus:rounded-lg focus:bg-accent focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-black focus:shadow-lg">
        Skip to content
      </a>
      <Sidebar />
      <main id="main-content" tabIndex={-1} className="flex-1 min-w-0 p-4 lg:p-8 bg-bg overflow-auto focus:outline-none">
        {children}
      </main>
      <InstallPrompt />
      <CommandPalette />
      <OfflineStatus />
      <Toaster />
      <ConfirmHost />
      <UploadQueueWidget />
    </div>
  )
}