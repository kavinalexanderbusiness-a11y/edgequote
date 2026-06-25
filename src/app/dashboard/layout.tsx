import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Sidebar } from '@/components/layout/Sidebar'
import { InstallPrompt } from '@/components/pwa/InstallPrompt'

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) redirect('/login')

  return (
    <div className="lg:flex min-h-screen">
      <Sidebar />
      <main className="flex-1 min-w-0 p-4 lg:p-8 bg-bg overflow-auto">
        {children}
      </main>
      <InstallPrompt />
    </div>
  )
}