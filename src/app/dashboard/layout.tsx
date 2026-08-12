import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { readUser } from '@/lib/authState'
import { AuthUnavailable } from '@/components/auth/AuthUnavailable'
import { Sidebar } from '@/components/layout/Sidebar'
import { BottomNav } from '@/components/layout/BottomNav'
import { RouteFocusManager } from '@/components/layout/RouteFocusManager'
import { InstallPrompt } from '@/components/pwa/InstallPrompt'
import { CommandPalette } from '@/components/command/CommandPalette'
import { OfflineStatus } from '@/components/pwa/OfflineStatus'
import { Toaster } from '@/components/ui/Toaster'
import { ConfirmHost } from '@/components/ui/ConfirmHost'
import { UploadQueueWidget } from '@/components/photos/UploadQueueWidget'
import { InboundToast } from '@/components/messages/InboundToast'

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient()
  // THREE answers (lib/authState): only a VERIFIED "no session" may send someone
  // to the login form. A failure to reach the auth server renders the retry
  // surface instead — it shows no dashboard data, so nothing leaks, and it does
  // not throw away a session nobody proved was gone.
  const auth = await readUser(supabase)
  if (auth.kind === 'signed-out') redirect('/login')
  if (auth.kind === 'unavailable') return <AuthUnavailable reason={auth.reason} />
  const user = auth.user

  // First run: an account with NO business_settings row has never been set up —
  // nothing creates that row at signup, so its absence is the one unambiguous
  // "brand new" signal. Send them to /setup (which lives OUTSIDE this layout, so
  // this can never loop). The row's mere existence stands the redirect down:
  // every existing business has one, and /setup's own "skip" creates it — so
  // this fires exactly once per new account and never for anyone configured.
  // Errors fail OPEN (no redirect): a transient read failure must not lock a
  // working business out of its dashboard.
  const { data: bizRow, error: bizErr } = await supabase
    .from('business_settings').select('user_id').eq('user_id', user.id).maybeSingle()
  if (!bizErr && !bizRow) redirect('/setup')

  return (
    <div className="lg:flex min-h-screen">
      {/* Keyboard users can jump the sidebar straight to page content. Visually
          hidden until focused (Tab from the top of the page). */}
      <a href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-menu focus:rounded-lg focus:bg-accent focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-black focus:shadow-lg">
        Skip to content
      </a>
      <Sidebar />
      {/* pb-28 on mobile = clearance for the fixed BottomNav (h ~64px + safe
          area) so no page's last row hides behind the bar. lg resets it. */}
      <main id="main-content" tabIndex={-1} className="flex-1 min-w-0 p-4 pb-28 lg:p-8 bg-bg overflow-auto focus:outline-none">
        {children}
      </main>
      <BottomNav />
      {/* Moves focus to <main> on client-side navigation — the skip-link target
          above was built for this but nothing wired the focus move. */}
      <RouteFocusManager />
      <InstallPrompt />
      <CommandPalette />
      <OfflineStatus />
      <InboundToast />
      <Toaster />
      <ConfirmHost />
      <UploadQueueWidget />
    </div>
  )
}