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

import { createInterface } from 'node:readline'
import { createClient } from '@supabase/supabase-js'
import { loadEnvLocal } from './lib/verify-fixture'
import { generateBetaToken, hashBetaToken } from '../src/lib/betaInviteServer'
import { buildBetaSignupUrl } from '../src/lib/betaInvite'
import { cleanOrigin } from '../src/lib/appOrigin'
import { endProcess } from './lib/shutdown'

// ⚠️ SNAPSHOT BEFORE loadEnvLocal(). loadEnvLocal copies .env.local into
// process.env, after which "the operator deliberately exported a credential for
// this run" and "a password has been sitting in a file since March" are
// indistinguishable — and the file is the one that goes stale. Only a credential
// present in the REAL environment is treated as deliberate; a .env.local
// password is ignored for auth, which is what makes prompting the default.
const REAL_ENV = {
  email: process.env.PORTAL_RPC_OWNER_EMAIL,
  password: process.env.PORTAL_RPC_OWNER_PASSWORD,
}

loadEnvLocal()

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

// Where invite URLs point. The default is the CURRENT production host: this
// constant used to name app.edgepropertyservicesyyc.ca, which was retired on
// 2026-08-15 and now answers DEPLOYMENT_NOT_FOUND — an invite built on it is a
// dead link handed to a real business. Cleaned through the same reader every
// other generated link uses, so a BOM or stray quote in the env var cannot
// produce an unusable URL here either.
const APP_URL = cleanOrigin(process.env.NEXT_PUBLIC_APP_URL) || 'https://app.edgehq.ca'

// ── Operator credentials ─────────────────────────────────────────────────────
// PROMPTING IS THE DEFAULT, and the reason is concrete: on 2026-08-16 this CLI
// failed with "Invalid login credentials" while the same operator could sign in
// through the browser. Nothing was mangled — .env.local simply held a password
// that had been rotated hours earlier. A secret copied into a file is a secret
// that goes stale silently, and the CLI cannot tell that apart from a typo.
//
// So: the environment is honoured when it is deliberately set (CI, scripted
// runs), and otherwise the operator is asked, with the password never echoed and
// never written anywhere.
function promptVisible(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()) }))
}

function promptHidden(question: string): Promise<string> {
  return new Promise(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    // Suppress the echo of everything typed after the prompt itself. Without
    // this the password appears in the terminal and then in the scrollback, the
    // shell history buffer and any screen recording.
    let shown = false
    const asAny = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WritableStream }
    asAny._writeToOutput = (s: string) => { if (!shown) { asAny.output.write(question); shown = true } }
    rl.question(question, ans => { rl.close(); process.stdout.write('\n'); resolve(ans) })
  })
}

async function operatorCredentials(): Promise<{ email: string; password: string }> {
  const envEmail = REAL_ENV.email?.trim()
  const envPassword = REAL_ENV.password
  if (envEmail && envPassword) {
    console.log(`Operator: ${envEmail}  (from the environment)`)
    return { email: envEmail, password: envPassword }
  }
  // The email may come from .env.local — it is not a secret and does not rotate.
  // The PASSWORD may not.
  const knownEmail = envEmail || process.env.PORTAL_RPC_OWNER_EMAIL?.trim()
  if (!process.stdin.isTTY) {
    throw new OperatorError(
      'No operator credentials, and no terminal to ask on.\n' +
      '  For a scripted run, export both in the REAL environment:\n' +
      '    $env:PORTAL_RPC_OWNER_EMAIL / $env:PORTAL_RPC_OWNER_PASSWORD\n' +
      '  Otherwise run this from an interactive terminal and it will prompt.',
    )
  }
  const email = knownEmail || await promptVisible('Operator email: ')
  if (knownEmail) console.log(`Operator: ${knownEmail}`)
  const password = await promptHidden('Operator password (not shown): ')
  return { email, password }
}

/** An operational problem the operator can act on — reported as a sentence, not a stack. */
class OperatorError extends Error {}

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

  const creds = await operatorCredentials()

  // autoRefreshToken:false is not a style choice. GoTrue otherwise starts a
  // refresh timer that keeps a libuv handle open, and node then aborts at exit
  // with "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" — a crash AFTER
  // the work succeeded, which reads like the work failed. A one-shot CLI never
  // needs a token refreshed.
  const db = createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } })

  const { data: signIn, error: signInErr } = await db.auth.signInWithPassword({
    email: creds.email, password: creds.password,
  })
  // Drop the password as soon as it has been used. It cannot be scrubbed from V8
  // with certainty, but nothing downstream should be able to reach it.
  creds.password = ''

  if (signInErr) {
    console.error(`\nSign-in failed: ${signInErr.message}`)
    if (/invalid login credentials/i.test(signInErr.message)) {
      console.error(
        '\n  That is the server rejecting the email/password pair — not a parsing problem.\n' +
        '  The usual cause is a password rotated since it was last written down.\n' +
        `  Project: ${URL}\n` +
        '  Re-run and type the password when prompted (leave PORTAL_RPC_OWNER_PASSWORD unset).',
      )
    }
    return 1
  }

  // Authorisation is the DATABASE's answer, not this CLI's — create_beta_invite
  // re-checks platform_operators itself and the RPC is the only thing that can
  // grant. This check exists so a non-operator gets a sentence they can act on
  // instead of a bare 42501 from three layers down.
  const uid = signIn.user?.id
  const { count, error: opErr } = await db.from('platform_operators')
    .select('user_id', { count: 'exact', head: true }).eq('user_id', uid ?? '')
  if (opErr) {
    // SELECT on platform_operators is not granted to authenticated, so a refusal
    // here is EXPECTED and is not evidence of anything. Say so rather than
    // implying the operator check failed.
    console.log(`Signed in as ${creds.email} — operator status is enforced by the database.`)
  } else if (!count) {
    console.error(
      `\nRefused: ${creds.email} signed in, but is not a platform operator.\n` +
      '  Only an account in platform_operators may mint invites, and that table is\n' +
      '  service_role-write-only by design. Nothing here can grant it.',
    )
    return 1
  } else {
    console.log(`Signed in as ${creds.email} — platform operator confirmed.`)
  }

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

main()
  .then(code => endProcess(code))
  .catch(err => {
    // An operator-facing problem is a sentence. A programming error is a stack.
    if (err instanceof OperatorError) console.error(`\n${err.message}\n`)
    else console.error(err)
    return endProcess(1)
  })
