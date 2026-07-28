// ── Verify: propertyLabel — naming ONE property, unambiguously ───────────────
//   npm run verify:property-label
//
// Multi-property customers are the whole reason this exists: a landlord's two
// "100 Main St" in different towns must never render as one address. The label adds
// the city (or neighbourhood) exactly when the street alone is ambiguous, and never
// when it isn't. Pure function, so these are plain assertions — no DB, no network.

import { propertyLabel } from '../src/lib/customers'

let failures = 0
const eq = (name: string, got: string, want: string) =>
  got === want ? console.log(`  ✓ ${name}`) : (failures++, console.log(`  ✗ ${name}\n      want "${want}", got "${got}"`))

console.log('\nStreet + city — the disambiguator that multi-property needs:')
eq('street alone when no city', propertyLabel({ address: '12 Oak St' }), '12 Oak St')
eq('appends city when present', propertyLabel({ address: '100 Main St', city: 'Springfield' }), '100 Main St, Springfield')
eq('two same-numbered streets stay distinct',
  propertyLabel({ address: '100 Main St', city: 'Shelbyville' }), '100 Main St, Shelbyville')
eq('city NOT duplicated when the street already carries it',
  propertyLabel({ address: '5 King Rd, Calgary', city: 'Calgary' }), '5 King Rd, Calgary')
eq('neighbourhood is the fallback when there is no city',
  propertyLabel({ address: '9 Elm Ave', neighborhood: 'Queensland' }), '9 Elm Ave, Queensland')
eq('city wins over neighbourhood', propertyLabel({ address: '9 Elm Ave', city: 'Calgary', neighborhood: 'Queensland' }), '9 Elm Ave, Calgary')

console.log('\nDegenerate rows never render blank:')
eq('no street → city stands in', propertyLabel({ city: 'Airdrie' }), 'Airdrie')
eq('nothing at all → a word, not empty', propertyLabel({}), 'Property')
eq('null fields → a word, not empty', propertyLabel({ address: null, city: null, neighborhood: null }), 'Property')
eq('whitespace-only street is treated as empty', propertyLabel({ address: '   ', city: 'Airdrie' }), 'Airdrie')

console.log('\nThe primary tag is opt-in and only fires for the primary:')
eq('primaryTag on a primary', propertyLabel({ address: '1 A St', city: 'Calgary', is_primary: true }, { primaryTag: true }), '1 A St, Calgary · primary')
eq('primaryTag on a NON-primary adds nothing', propertyLabel({ address: '2 B St', city: 'Calgary', is_primary: false }, { primaryTag: true }), '2 B St, Calgary')
eq('no primaryTag option → never tagged, even if primary', propertyLabel({ address: '1 A St', is_primary: true }), '1 A St')

console.log(
  failures === 0
    ? '\n✅ propertyLabel verified — every property names itself, and no two collapse into one.\n'
    : `\n❌ ${failures} propertyLabel check(s) FAILED\n`,
)
process.exit(failures === 0 ? 0 : 1)
