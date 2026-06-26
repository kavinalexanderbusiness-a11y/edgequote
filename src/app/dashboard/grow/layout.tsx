import { GrowNav } from '@/components/grow/GrowNav'

// The Grow section shell: a persistent rail (the 9-item Marketing spine) above
// every Grow surface, so Overview / Studio / Library feel like one product.
export default function GrowLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="max-w-5xl space-y-5">
      <GrowNav />
      {children}
    </div>
  )
}
