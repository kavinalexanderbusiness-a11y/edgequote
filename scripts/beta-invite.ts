// ── Beta invites: the operator's console ─────────────────────────────────────
//
//   npm run beta:invite -- create --label "Smith Lawn Co" [--email sam@smith.ca] [--days 14]
//   npm run beta:invite -- list
//   npm run beta:invite -- revoke --id <uuid>
//
// Mints/revokes/lists the one-time signup invites behind /signup. Runs as the
// FOUNDING ACCOUNT (PORTAL_RPC_OWNER_* in .env.local) — the DB-side gate is the
// platform_operators table, not these credentials: any non-operator session
// calling these RPCs gets 42501 no matter what it owns.
//
// The raw token is printed ONCE, here, inside the URL — the database stores
// only its sha256 (beta_invites.token_hash has a CHECK that makes storing a
// raw token structurally impossible). Lose the URL? Revoke and mint a fresh
// one; they're disposable by design.

import { createClient } from '@supabase/supabase-js'
import { loadEnvLocal } from './lib/verify-fixture'
import { generateBetaToken, hashBetaToken } from '../src/lib/betaInviteServer'
import { buildBetaSignupUrl } from '../src/lib/betaInvite'

loadEnvLocal()

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const EMAIL = process.env.PORTAL_RPC_OWNER_EMAIL
const PASSWORD = process.env.PORTAL_RPC_OWNER_PASSWORD
// Where invite URLs point. Overridable for previews; defaults to production.
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://app.edgepropertyservicesyyc.ca'

function usage(): never {
  console.log([
    'Usage:',
    '  npm run beta:invite -- create --label "Who this is for" [--email them@example.com] [--days 14]',
    '  npm run beta:invite -- list',
    '  npm run beta:invite -- revoke --id <uuid>',
  ].join('\n'))
  process.exit(2)
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main(): Promise<number> {
  const cmd = process.argv[2]
  if (!cmd || !['create', 'list', 'revoke'].includes(cmd)) usage()
  if (!URL || !ANON) { console.error('Missing NEXT_PUBLIC_SUPABASE_URL / _ANON_KEY in .env.local'); return 1 }
  if (!EMAIL || !PASSWORD) { console.error('Missing PORTAL_RPC_OWNER_EMAIL / _PASSWORD in .env.local'); return 1 }

  const db = createClient(URL, ANON, { auth: { persistSession: false } })
  const { error: signInErr } = await db.auth.signInWithPassword({ email: EMAIL, password: PASSWORD })
  if (signInErr) { console.error(`Sign-in failed: ${signInErr.message}`); return 1 }

  try {
    if (cmd === 'create') {
      const label = arg('label')
      if (!label) usage()
      const days = Number(arg('days') ?? 14)
      const email = arg('email') ?? null

      // Token minted HERE; only the hash crosses the wire.
      const token = generateBetaToken()
      const { data, error } = await db.rpc('create_beta_invite', {
        p_token_hash: hashBetaToken(token),
        p_label: label,
        p_email: email,
        p_days: Number.isFinite(days) ? days : 14,
      })
      if (error) { console.error(`Refused: ${error.message}`); return 1 }
      const row = data as { id: string; expires_at: string }
      console.log('')
      console.log(`Invite for: ${label}${email ? ` (locked to ${email})` : ''}`)
      console.log(`Expires:    ${new Date(row.expires_at).toLocaleString()}`)
      console.log(`Id:         ${row.id}`)
      console.log('')
      console.log('Hand this URL to the business (it is shown only once):')
      console.log('')
      console.log(`  ${buildBetaSignupUrl(APP_URL, token)}`)
      console.log('')
      return 0
    }

    if (cmd === 'list') {
      const { data, error } = await db.rpc('list_beta_invites')
      if (error) { console.error(`Refused: ${error.message}`); return 1 }
      const rows = (data ?? []) as Array<{
        id: string; label: string; email: string | null; state: string
        created_at: string; expires_at: string; redeemed_at: string | null; send_count: number
      }>
      if (rows.length === 0) { console.log('No invites yet.'); return 0 }
      for (const r of rows) {
        const when = r.state === 'redeemed' && r.redeemed_at
          ? `redeemed ${r.redeemed_at.slice(0, 10)}`
          : `expires ${r.expires_at.slice(0, 10)}`
        console.log(`${r.state.padEnd(9)} ${r.label}${r.email ? ` <${r.email}>` : ''} — ${when} (emails: ${r.send_count})  id=${r.id}`)
      }
      return 0
    }

    // revoke
    const id = arg('id')
    if (!id) usage()
    const { data, error } = await db.rpc('revoke_beta_invite', { p_id: id })
    if (error) { console.error(`Refused: ${error.message}`); return 1 }
    console.log(data === true ? 'Revoked.' : 'No invite with that id.')
    return data === true ? 0 : 1
  } finally {
    // LOCAL scope only — a global sign-out here would revoke the owner's
    // sessions on every device (the 214-logouts-a-day incident).
    await db.auth.signOut({ scope: 'local' }).catch(() => {})
  }
}

main().then(code => process.exit(code)).catch(err => { console.error(err); process.exit(1) })
