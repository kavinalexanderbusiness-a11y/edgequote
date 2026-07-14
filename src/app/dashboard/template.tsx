// Remounts on every route navigation (Next.js template semantics), giving each
// page a soft fade-in instead of a hard swap. Pure opacity — no transform — so
// it can never re-anchor `position:fixed` overlays inside the page, and pages
// with their own animate-rise cascades layer on top without doubling movement.
export default function DashboardTemplate({ children }: { children: React.ReactNode }) {
  return <div className="animate-page">{children}</div>
}
