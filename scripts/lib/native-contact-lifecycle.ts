export type ContactLifecycle = 'lead' | 'client'

export interface NativeContactName {
  firstName?: string | null
  lastName?: string | null
  organization?: string | null
}

export interface VerifiedContactIdentity {
  firstName: string
  lastName?: string | null
  lifecycle: ContactLifecycle
  verifiedActiveClient?: boolean
}

export type ContactNamePlan =
  | { ok: true; firstName: string; lastName: string; lifecycle: ContactLifecycle }
  | { ok: false; reason: 'missing_first_name' | 'client_status_unverified' | 'first_name_conflict' | 'last_name_conflict' }

const LIFECYCLE_SUFFIX = /\s*\((lead|client)\)\s*$/i

export function cleanContactName(value?: string | null): string {
  return (value || '').replace(LIFECYCLE_SUFFIX, '').trim().replace(/\s+/g, ' ')
}

export function lifecycleFromNativeName(contact?: NativeContactName | null): ContactLifecycle | null {
  if (!contact) return null
  for (const value of [contact.lastName, contact.firstName, contact.organization]) {
    const match = (value || '').match(LIFECYCLE_SUFFIX)
    if (match) return match[1].toLowerCase() as ContactLifecycle
  }
  return null
}

function sameName(a: string, b: string): boolean {
  return a.localeCompare(b, undefined, { sensitivity: 'base' }) === 0
}

/**
 * Build the two fields written to Apple Contacts.
 *
 * The terminal lifecycle label lives in lastName so a first-name-only lead displays
 * as `First (Lead)`. A later verified surname becomes `First Last (Lead)` without a
 * second card. Existing surnames are preserved, conflicting names fail closed, and
 * a Client is never silently demoted to Lead.
 */
export function planNativeContactName(
  verified: VerifiedContactIdentity,
  existing?: NativeContactName | null,
): ContactNamePlan {
  const first = cleanContactName(verified.firstName)
  if (!first) return { ok: false, reason: 'missing_first_name' }
  if (verified.lifecycle === 'client' && !verified.verifiedActiveClient) {
    return { ok: false, reason: 'client_status_unverified' }
  }

  const existingFirst = cleanContactName(existing?.firstName)
  if (existingFirst && !sameName(existingFirst, first)) {
    return { ok: false, reason: 'first_name_conflict' }
  }

  const suppliedLast = cleanContactName(verified.lastName)
  const existingLast = cleanContactName(existing?.lastName)
  if (suppliedLast && existingLast && !sameName(suppliedLast, existingLast)) {
    return { ok: false, reason: 'last_name_conflict' }
  }

  const currentLifecycle = lifecycleFromNativeName(existing)
  const lifecycle = currentLifecycle === 'client' && verified.lifecycle === 'lead'
    ? 'client'
    : verified.lifecycle
  const surname = suppliedLast || existingLast
  const label = lifecycle === 'client' ? '(Client)' : '(Lead)'

  return {
    ok: true,
    firstName: first,
    lastName: surname ? `${surname} ${label}` : label,
    lifecycle,
  }
}

/** North-American comparison key shared by the local audit script. */
export function nativePhoneKey(value?: string | null): string {
  const digits = (value || '').replace(/\D/g, '')
  return digits.length >= 10 ? digits.slice(-10) : digits
}
