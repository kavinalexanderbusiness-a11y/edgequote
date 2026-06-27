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
  // OAuth config for the future direct integration. authorizeUrl builds the real
  // consent URL when the platform's client id env is set; otherwise null (→ the UI
  // shows the honest manual path). The whole OAuth round-trip is env-gated so it works
  // the moment an app is registered, with zero code change here.
  oauth: OAuthConfig | null
  authorizeUrl(redirectUri: string, state: string): string | null
  // Direct-publish a post. Throws ProviderError. NEVER called for manual connections.
  publish(input: PublishInput): Promise<PublishSuccess>
}

export interface OAuthConfig {
  authUrl: string        // the provider's consent endpoint
  clientIdEnv: string    // env var holding the OAuth client id (server-configured)
  responseType: string
}

function buildAuthorizeUrl(oauth: OAuthConfig | null, scopes: string[], redirectUri: string, state: string): string | null {
  if (!oauth) return null
  const clientId = process.env[oauth.clientIdEnv]
  if (!clientId) return null // not configured yet → UI falls back to manual
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: oauth.responseType,
    scope: scopes.join(' '),
    state,
  })
  return `${oauth.authUrl}?${q.toString()}`
}

// A platform whose official API exists but isn't wired yet. The OAuth seam is present;
// publish throws a clear, honest error until the integration ships.
function planned(platform: MarketingChannel, label: string, apiName: string, scopes: string[], rateLimit: RateLimit, oauth: OAuthConfig): PublishProvider {
  return {
    platform, label, apiStatus: 'planned', apiName, scopes, rateLimit, oauth,
    authorizeUrl(redirectUri, state) { return buildAuthorizeUrl(oauth, scopes, redirectUri, state) },
    async publish() {
      throw new ProviderError('api_unavailable', `${label} direct publishing isn't available yet — connect the account and post with one tap.`)
    },
  }
}

// A platform with no official posting API: copy & paste forever.
function manualOnly(platform: MarketingChannel, label: string): PublishProvider {
  return {
    platform, label, apiStatus: 'unavailable', apiName: null, scopes: [],
    rateLimit: { perHour: 1000, minSpacingSec: 0 }, oauth: null,
    authorizeUrl() { return null },
    async publish() {
      throw new ProviderError('api_unavailable', `${label} has no public posting API — publish by copy & paste.`)
    },
  }
}

const META_OAUTH: OAuthConfig = { authUrl: 'https://www.facebook.com/v19.0/dialog/oauth', clientIdEnv: 'META_APP_ID', responseType: 'code' }

export const PROVIDERS: Record<MarketingChannel, PublishProvider> = {
  facebook:  planned('facebook',  'Facebook Pages',           'Meta Graph API',              ['pages_manage_posts', 'pages_read_engagement'], { perHour: 25, minSpacingSec: 30 }, META_OAUTH),
  instagram: planned('instagram', 'Instagram Business',       'Meta Graph API',              ['instagram_content_publish', 'pages_show_list'], { perHour: 25, minSpacingSec: 60 }, META_OAUTH),
  gbp:       planned('gbp',       'Google Business Profile',  'Google Business Profile API', ['https://www.googleapis.com/auth/business.manage'], { perHour: 10, minSpacingSec: 60 }, { authUrl: 'https://accounts.google.com/o/oauth2/v2/auth', clientIdEnv: 'GOOGLE_CLIENT_ID', responseType: 'code' }),
  linkedin:  planned('linkedin',  'LinkedIn Pages',           'LinkedIn Marketing API',      ['w_organization_social', 'r_organization_social'], { perHour: 20, minSpacingSec: 30 }, { authUrl: 'https://www.linkedin.com/oauth/v2/authorization', clientIdEnv: 'LINKEDIN_CLIENT_ID', responseType: 'code' }),
  threads:   planned('threads',   'Threads',                  'Threads API',                 ['threads_basic', 'threads_content_publish'], { perHour: 20, minSpacingSec: 30 }, { authUrl: 'https://threads.net/oauth/authorize', clientIdEnv: 'THREADS_APP_ID', responseType: 'code' }),
  nextdoor:  manualOnly('nextdoor', 'Nextdoor'),
}

export function provider(ch: MarketingChannel): PublishProvider {
  return PROVIDERS[ch]
}

// Can a platform offer one-tap connect right now? Only when the provider is fully live
// AND its OAuth app is configured. Today this is false everywhere → manual is the path.
export function canConnectApi(ch: MarketingChannel): boolean {
  const p = PROVIDERS[ch]
  return p.apiStatus === 'available' && !!p.oauth && !!process.env[p.oauth.clientIdEnv]
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
