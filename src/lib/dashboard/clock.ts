import { safeTimeZone, tenantMoment } from '@/lib/tenantTime'

/** One instant and zone for the dashboard header and all its day queries. */
export function dashboardClock(timeZone: string | null | undefined, now = new Date()) {
  const zone = safeTimeZone(timeZone)
  const { date, hour } = tenantMoment(zone, now)
  return {
    today: date,
    greeting: hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening',
    dateLine: now.toLocaleDateString('en-CA', {
      timeZone: zone, weekday: 'long', month: 'long', day: 'numeric',
    }),
  }
}
