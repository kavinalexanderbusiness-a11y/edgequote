import { GrowNav } from '@/components/grow/GrowNav'

// The Grow section shell: a persistent rail (the Marketing spine) above every Grow
// surface, so Overview / Studio / Library / Campaigns feel like one product and the
// Marketing Studio is always one tap away.
export default function GrowLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-5">
      <GrowNav />
      {children}
    </div>
  )
}
