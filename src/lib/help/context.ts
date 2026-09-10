import { helpHref } from './content'

/** More specific routes precede their parent; unknown pages retain a useful guide. */
export function contextualHelpHref(pathname: string): string {
  const routes: [string, string][] = [
    ['/dashboard/weather', 'rain-delay'],
    ['/dashboard/routes', 'routes-and-order'],
    ['/dashboard/quotes', 'quote-lifecycle'],
    ['/dashboard/invoices', 'invoice-lifecycle'],
    ['/dashboard/payments', 'getting-paid'],
    ['/dashboard/messages', 'consent'],
    ['/dashboard/customers', 'the-portal'],
    ['/dashboard/schedule', 'day-capacity'],
    ['/dashboard/settings', 'first-week'],
  ]
  const match = routes.find(([prefix]) => pathname === prefix || pathname.startsWith(`${prefix}/`))
  return helpHref(match?.[1] ?? 'quick-tips')
}
