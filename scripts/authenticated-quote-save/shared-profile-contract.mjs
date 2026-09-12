// Fixed reviewed product inputs for the disposable real-platform proof. These
// expected values come from Git 931dbc28, never from the database being checked.
export const SHARED_PROFILE_BASELINE = '931dbc2880b6145152c97441ea8d08308649c285'
export const SHARED_PROFILE_SQL_LF_SHA256 = Object.freeze({
  'supabase/migrations/20260830150001_baseline.sql': '4bac2e4c21e824d05d11ec9bed9732325886d1b17de654fc64acf0d0fc757c48',
  'supabase/migrations/20260905205937_self_service_registration.sql': '4dc2347ebceca800d5b1a1098ca01b326b9dd3316c9d84a44918cfa06630bf0b',
  'supabase/migrations/20260910151337_restrict_job_session_minutes.sql': '15dac700b26c27878a5d9b4437209004ab284b4b0e754655f56a442a1e66ed04',
  'supabase/proposals/pilot-quote-shared-profile.sql': '580ddd7c12d6a8637c689286785f913c78009b6d8b697bcdd126bfb389bc99ab',
  'supabase/proposals/pilot-quote-email-absent.sql': '0fed6bc4192f39e0f41848a3f70a89716fb3180c2d6b8da4ba5e3b3c8dfb987d',
  'supabase/proposals/pilot-email-core.sql': '434048ade9a3625a280707f12877f694281e72efbaa78b29ae141503876540fb',
  'supabase/proposals/pilot-quote-email-present.sql': 'd6db77d1cebd7111a1e767d0deb00234dab85b1e42f2e7205494e0e5b040b25c',
  'supabase/proposals/pilot-quote-identity.sql': '41912550714a654c63001b19914abddc3bad17f4e436e437e62f3c642228c56a',
  'supabase/proposals/pilot-quote-save.sql': 'b2f6f61fce3c18e31146d2f1c96ec2dbce67ea2e87d541985f176bb7da43b69c',
  'supabase/proposals/pilot-quote-versioned-acceptance.sql': '5dc0925aaeff4149a71e9dafb47a4d345fafa935156dc6c13ee847180d95cf2a',
})
export const SHARED_PROFILE_CATALOGUE_SHA256 = Object.freeze({
  absent: 'f933cd59b92fd1f107bbf01fec03c71d9054297bb0c3c164228369ced70e88f9',
  original: 'aadd4ce4f5338807d4364f56191c364df123c884ab69e0b6954521c27a63343c',
  present: '7c1050e8576b4616cf482b740c851ec7fe4edbf4bbd0222b13506a77f12865dd',
})
const MIGRATIONS = Object.freeze([
  'supabase/migrations/20260830150001_baseline.sql',
  'supabase/migrations/20260905205937_self_service_registration.sql',
  'supabase/migrations/20260910151337_restrict_job_session_minutes.sql',
])
export function sharedProfileInstallSequence(emailProfile, { acceptance = false } = {}) {
  if (!['absent', 'present'].includes(emailProfile) || typeof acceptance !== 'boolean') throw Error('Explicit fixed email profile and acceptance choice required')
  return Object.freeze([...MIGRATIONS, 'supabase/proposals/pilot-quote-shared-profile.sql',
    ...(emailProfile === 'present'
      ? ['supabase/proposals/pilot-email-core.sql', 'supabase/proposals/pilot-quote-email-present.sql']
      : ['supabase/proposals/pilot-quote-email-absent.sql']),
    'supabase/proposals/pilot-quote-identity.sql', 'supabase/proposals/pilot-quote-save.sql',
    ...(acceptance ? ['supabase/proposals/pilot-quote-versioned-acceptance.sql'] : [])])
}
