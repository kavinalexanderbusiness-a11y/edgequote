interface QuoteSelection {
  customerId?: string | null
  propertyId?: string | null
}

/** A retained measurement must not replace a later explicit quote selection. */
export function isMeasurementHandoffCompatible(payload: unknown, selection: QuoteSelection): boolean {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false
  const { customerId, propertyId } = payload as { customerId?: unknown; propertyId?: unknown }

  // Legacy handoffs can omit identity; malformed identities are never coerced.
  if (customerId != null && typeof customerId !== 'string') return false
  if (propertyId != null && typeof propertyId !== 'string') return false

  // Unknown identity cannot establish compatibility with an explicit choice.
  // Compare the original opaque IDs exactly, never names or address text.
  if (selection.customerId && (
    typeof customerId !== 'string' || !customerId.trim() || customerId !== selection.customerId
  )) return false
  if (selection.propertyId && (
    typeof propertyId !== 'string' || !propertyId.trim() || propertyId !== selection.propertyId
  )) return false

  return true
}
