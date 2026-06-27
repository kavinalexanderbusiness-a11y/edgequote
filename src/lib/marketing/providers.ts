import type { ConnectionMode, MarketingChannel } from './types'

// ── Publishing provider abstraction ──────────────────────────────────────────────────
// Every platform implements the SAME PublishProvider interface, so adding a real
// integration (or a new network) never means rewriting the publishing system — you add
// one provider and flip its `apiStatus` to 'available'. Today no network has a wired
// integration, so all providers are 'planned' (Meta/Google/LinkedIn/Threads) or
// 'unavailable' (Nextdoor — no public posting API). The queue + UI route everything
// through `effectiveMode`, which returns 'manual' until a provider is genuinely live —
// so nothing is ever faked: manual = copy & paste, api = a real connected account.

export type ApiStatus =
  | 'available'    // a real integration is wired and this account can direct-publish
  | 'planned'      // an official API exists; integration is on the roadmap
  | 'unavailable'  // no official posting API — this platform stays manual forever

export interface PublishInput {
  piece: { title: string | null; body: string; hashtags: string[]; imageUrl: string | null }
  account: { id: string | null; name: string }
}
export interface PublishSuccess { externalId: string; url: string | null }

export type PublishErrorCode = 'not_connected' | 'api_unavailable' | 'rate_limited' | 'auth_expired' | 'unknown'
export class ProviderError extends Error {
  code: PublishErrorCode
  constructor(code: PublishErrorCode, message: string) { super(message); this.code = code; this.name = 'ProviderError' }
}

export interface RateLimit { perHour: number; minSpacingSec: number }

export interface PublishProvider {
  platform: MarketingChannel
  label: string
  apiStatus: ApiStatus
  apiName: string | null        // the integration that will/does power direct publishing
  scopes: string[]              // OAuth scopes a real connection will request
  rateLimit: RateLimit
  // The OAuth authorize URL once an integration is wired; null today → UI shows the
  // honest "connect manually / coming soon" path.
  authorizeUrl(redirectUri: string): string | null
  // Direct-publish a post. Throws ProviderError. NEVER called for manual connections.
  publish(input: PublishInput): Promise<PublishSuccess>
}

// A platform whose official API exists but isn't wired yet. authorizeUrl returns null
// (no OAuth screen), publish throws a clear, honest error.
function planned(platform: MarketingChannel, label: string, apiName: string, scopes: string[], rateLimit: RateLimit): PublishProvider {
  return {
    platform, label, apiStatus: 'planned', apiName, scopes, rateLimit,
    authorizeUrl() { return null },
    async publish() {
      throw new ProviderError('api_unavailable', `${label} direct publishing isn't available yet — connect the account and post with one tap.`)
    },
  }
}

// A platform with no official posting API: copy & paste forever.
function manualOnly(platform: MarketingChannel, label: string): PublishProvider {
  return {
    platform, label, apiStatus: 'unavailable', apiName: null, scopes: [],
    rateLimit: { perHour: 1000, minSpacingSec: 0 },
    authorizeUrl() { return null },
    async publish() {
      throw new ProviderError('api_unavailable', `${label} has no public posting API — publish by copy & paste.`)
    },
  }
}

export const PROVIDERS: Record<MarketingChannel, PublishProvider> = {
  facebook:  planned('facebook',  'Facebook Pages',           'Meta Graph API',              ['pages_manage_posts', 'pages_read_engagement'], { perHour: 25, minSpacingSec: 30 }),
  instagram: planned('instagram', 'Instagram Business',       'Meta Graph API',              ['instagram_content_publish'],                   { perHour: 25, minSpacingSec: 60 }),
  gbp:       planned('gbp',       'Google Business Profile',  'Google Business Profile API', ['business.manage'],                             { perHour: 10, minSpacingSec: 60 }),
  linkedin:  planned('linkedin',  'LinkedIn Pages',           'LinkedIn Marketing API',      ['w_organization_social'],                       { perHour: 20, minSpacingSec: 30 }),
  threads:   planned('threads',   'Threads',                  'Threads API',                 ['threads_content_publish'],                     { perHour: 20, minSpacingSec: 30 }),
  nextdoor:  manualOnly('nextdoor', 'Nextdoor'),
}

export function provider(ch: MarketingChannel): PublishProvider {
  return PROVIDERS[ch]
}

// The mode a publish will actually use: 'api' only when an account is in api-mode AND a
// real provider is live; otherwise 'manual'. This is what keeps the system honest.
export function effectiveMode(ch: MarketingChannel, connectionMode: ConnectionMode | undefined): ConnectionMode {
  return connectionMode === 'api' && PROVIDERS[ch].apiStatus === 'available' ? 'api' : 'manual'
}

// Direct-publish dispatch (api mode). Manual publishes never reach here.
export function dispatchPublish(ch: MarketingChannel, input: PublishInput): Promise<PublishSuccess> {
  return PROVIDERS[ch].publish(input)
}
