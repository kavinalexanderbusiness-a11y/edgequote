// Dormant B3 server adapter. Read-only verification never enables Checkout.
// Configuration comes from the server, never a plan form or a return URL.
import { PRODUCT_PLANS, type ProductPlanId } from '../productPlans'
import {
  billingId, billingObject, platformProvider, PLATFORM_STRIPE_API_VERSION,
  type BillingEnvironment, type PlatformProviderConfig,
} from './provider'

type PriceMapping = Readonly<{ priceId: string; productId: string }>
export type PlatformPlanPriceMapping = Readonly<Record<ProductPlanId, PriceMapping>>
export interface VerifiedPlatformPlanCatalogue {
  readonly platformAccountId: string
  readonly merchantAccountId: string
  readonly livemode: boolean
  readonly prices: PlatformPlanPriceMapping
  readonly checkoutEnabled: false
  readonly taxSetupVerified: false
}

/** No default IDs, sandbox fallback, price lookup keys or browser amounts. */
export function platformPlanPriceMapping(env: BillingEnvironment): PlatformPlanPriceMapping | null {
  try {
    const prices = Object.fromEntries(PRODUCT_PLANS.map(plan => {
      const suffix = plan.id.toUpperCase()
      return [plan.id, Object.freeze({
        priceId: billingId(env[`PLATFORM_STRIPE_PRICE_${suffix}`], 'price'),
        productId: billingId(env[`PLATFORM_STRIPE_PRODUCT_${suffix}`], 'prod'),
      })]
    })) as Record<ProductPlanId, PriceMapping>
    if (new Set(Object.values(prices).map(price => price.priceId)).size !== 3 ||
        new Set(Object.values(prices).map(price => price.productId)).size !== 3) return null
    return Object.freeze(prices)
  } catch { return null }
}

const MAX_PRICE_BYTES = 64 * 1024
async function readPrice(config: PlatformProviderConfig, id: string, fetcher: typeof fetch) {
  // Expand every field used to rule out alternate currencies and inactive products.
  const query = new URLSearchParams()
  query.append('expand[]', 'product')
  query.append('expand[]', 'currency_options')
  const result = await fetcher(`https://api.stripe.com/v1/prices/${encodeURIComponent(id)}?${query}`, {
    method: 'GET', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(8000),
    headers: { Authorization: `Bearer ${config.secret}`, 'Stripe-Version': PLATFORM_STRIPE_API_VERSION },
  })
  if (!result.ok || !result.body) throw new Error('price_read_failed')
  const reader = result.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_PRICE_BYTES) throw new Error('price_response_too_large')
      chunks.push(value)
    }
  } finally {
    // Cancellation also releases an oversized/erroring response without retaining it.
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return billingObject(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
}

function checkPrice(raw: Record<string, unknown>, expected: PriceMapping, amount: number, livemode: boolean) {
  const recurring = billingObject(raw.recurring)
  const product = billingObject(raw.product)
  const decimal = new RegExp(`^${amount}(?:\\.0{1,12})?$`)
  if (raw.object !== 'price' || raw.id !== expected.priceId || raw.active !== true ||
      raw.livemode !== livemode || raw.currency !== 'cad' || raw.type !== 'recurring' ||
      raw.billing_scheme !== 'per_unit' || raw.unit_amount !== amount ||
      typeof raw.unit_amount_decimal !== 'string' || !decimal.test(raw.unit_amount_decimal) ||
      raw.custom_unit_amount !== null || raw.transform_quantity !== null || raw.tiers_mode !== null ||
      recurring.interval !== 'month' || recurring.interval_count !== 1 ||
      recurring.usage_type !== 'licensed' || recurring.trial_period_days !== null ||
      product.object !== 'product' || product.id !== expected.productId ||
      product.active !== true || product.livemode !== livemode ||
      !['unspecified', 'exclusive'].includes(String(raw.tax_behavior))) {
    throw new Error('price_facts_mismatch')
  }
  // A separate reviewed policy is required before offering currency conversions,
  // tiers, adjustable quantities, custom prices, metered usage or price-level trials.
  if (!Object.prototype.hasOwnProperty.call(raw, 'currency_options') || raw.currency_options === undefined) {
    throw new Error('currency_options_not_returned')
  }
  if (raw.currency_options !== null) {
    const options = billingObject(raw.currency_options)
    if (Object.keys(options).some(currency => currency !== 'cad')) throw new Error('alternate_currency_price')
    if (options.cad !== undefined) {
      const cad = billingObject(options.cad)
      if (cad.unit_amount !== amount || typeof cad.unit_amount_decimal !== 'string' ||
          !decimal.test(cad.unit_amount_decimal) || cad.custom_unit_amount !== null ||
          cad.tax_behavior !== raw.tax_behavior) throw new Error('alternate_cad_price')
    }
  }
}

/** Verifies the actual accounts, then all three exact provider price objects.
 * Errors are deliberately finite: no provider response, credentials or payload
 * can escape in a log or public error. Price verification is not tax readiness,
 * subscription ownership, consent, a paid entitlement or activation approval. */
export async function verifyPlatformPlanCatalogue(
  config: PlatformProviderConfig,
  mapping: PlatformPlanPriceMapping,
  fetcher: typeof fetch = fetch,
): Promise<VerifiedPlatformPlanCatalogue | null> {
  try {
    if (typeof config.livemode !== 'boolean') return null
    billingId(config.platformAccountId, 'acct')
    billingId(config.merchantAccountId, 'acct')
    // Re-parse into an immutable snapshot before the first await. A caller cannot
    // replace an ID while the actual account verification is in flight.
    if (Object.keys(mapping).sort().join(',') !== 'base,plus,premium') return null
    const copied = platformPlanPriceMapping(Object.fromEntries(PRODUCT_PLANS.flatMap(plan => [
      [`PLATFORM_STRIPE_PRICE_${plan.id.toUpperCase()}`, mapping[plan.id].priceId],
      [`PLATFORM_STRIPE_PRODUCT_${plan.id.toUpperCase()}`, mapping[plan.id].productId],
    ])))
    if (!copied) return null
    const scopeConfig = Object.freeze({ ...config })
    const scope = await platformProvider(scopeConfig, fetcher).verifyScope()
    if (!scope) return null
    for (const plan of PRODUCT_PLANS) {
      const price = copied[plan.id]
      checkPrice(await readPrice(scopeConfig, price.priceId, fetcher), price, plan.monthlyPriceCents, scope.livemode)
    }
    return Object.freeze({ ...scope, prices: copied, checkoutEnabled: false, taxSetupVerified: false })
  } catch { return null }
}
