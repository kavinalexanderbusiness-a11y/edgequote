import {
  cleanContactName, lifecycleFromNativeName, nativePhoneKey, planNativeContactName,
} from './lib/native-contact-lifecycle'

let passed = 0
function check(label: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
  passed++
}

check('normalizes formatted phone to a stable national key', nativePhoneKey('+1 (403) 473-5107'), '4034735107')
check('strips only a terminal lifecycle label', cleanContactName('Savadlou (Lead)'), 'Savadlou')
check('reads a terminal lifecycle label', lifecycleFromNativeName({ firstName: 'Janine', lastName: '(Client)' }), 'client')

check('creates first-name-only lead display', planNativeContactName({ firstName: 'Janine', lifecycle: 'lead' }), {
  ok: true, firstName: 'Janine', lastName: '(Lead)', lifecycle: 'lead',
})
check('adds a later verified surname without duplicating the lifecycle label', planNativeContactName(
  { firstName: 'Sirous', lastName: 'Savadlou', lifecycle: 'lead' },
  { firstName: 'Sirous', lastName: '(Lead)' },
), { ok: true, firstName: 'Sirous', lastName: 'Savadlou (Lead)', lifecycle: 'lead' })
check('preserves an existing surname when the audit only knows the first name', planNativeContactName(
  { firstName: 'Sirous', lifecycle: 'lead' },
  { firstName: 'Sirous', lastName: 'Savadlou (Lead)' },
), { ok: true, firstName: 'Sirous', lastName: 'Savadlou (Lead)', lifecycle: 'lead' })
check('does not demote a verified client during a later lead audit', planNativeContactName(
  { firstName: 'Eddie', lifecycle: 'lead' },
  { firstName: 'Eddie', lastName: '(Client)' },
), { ok: true, firstName: 'Eddie', lastName: '(Client)', lifecycle: 'client' })
check('refuses client promotion without verified active status', planNativeContactName(
  { firstName: 'Eddie', lifecycle: 'client' },
  { firstName: 'Eddie', lastName: '(Lead)' },
), { ok: false, reason: 'client_status_unverified' })
check('allows client promotion with explicit verified active status', planNativeContactName(
  { firstName: 'Eddie', lifecycle: 'client', verifiedActiveClient: true },
  { firstName: 'Eddie', lastName: '(Lead)' },
), { ok: true, firstName: 'Eddie', lastName: '(Client)', lifecycle: 'client' })
check('fails closed on a conflicting existing surname', planNativeContactName(
  { firstName: 'Sirous', lastName: 'Savadlou', lifecycle: 'lead' },
  { firstName: 'Sirous', lastName: 'Different (Lead)' },
), { ok: false, reason: 'last_name_conflict' })
check('fails closed on a conflicting existing first name', planNativeContactName(
  { firstName: 'Janine', lifecycle: 'lead' },
  { firstName: 'Someone Else', lastName: '(Lead)' },
), { ok: false, reason: 'first_name_conflict' })

console.log(`Native contact reconciliation: ${passed} passed, 0 failed.`)
