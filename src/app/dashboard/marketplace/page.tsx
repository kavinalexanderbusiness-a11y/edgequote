import { redirect } from 'next/navigation'

// The Marketplace was an app store for fifteen first-party features that ship
// with every account, cost nothing and arrive switched on. Managing them lives
// in Settings → Features, which was always the other half of the pair; the full
// reasoning is in components/settings/ModuleManager. This keeps old links alive.
export default function MarketplaceRedirect() {
  redirect('/dashboard/settings#modules')
}
