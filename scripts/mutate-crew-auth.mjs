// Mutation test for verify:crew-auth.
// Each mutation reintroduces a defect this session actually fixed (or one the
// brief names). A mutation the guard does not catch is a hole in the guard.
//
// ⚠️ COMMIT FIRST. This rewrites source files and restores them from the bytes
// it read, not from git — but a crash mid-run leaves the tree mutated.
// ⚠️ CRLF: files are read and written raw, and patterns are anchored \r?\n.
import { readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const MUTATIONS = [
  {
    name: 'the emailed link goes back to the query form',
    file: 'src/lib/crewInvite.ts',
    from: '`${base}${CREW_WELCOME_PATH}/${encodeURIComponent(hashedToken)}`',
    to: '`${base}${CREW_WELCOME_PATH}?token=${encodeURIComponent(hashedToken)}`',
  },
  {
    name: 'the origin is read raw from the environment again',
    file: 'src/app/api/crew/invite/route.ts',
    from: 'buildSetupUrl(appOrigin(req.nextUrl.origin), hashed)',
    to: "buildSetupUrl((process.env.NEXT_PUBLIC_APP_URL || req.nextUrl.origin).replace(/\\/$/, ''), hashed)",
  },
  {
    // trim() is what strips the BOM (U+FEFF is ECMAScript WhiteSpace). Removing
    // it is therefore the mutation that actually reintroduces the broken-link
    // bug — an explicit BOM replace was dead code, proven by this harness.
    name: 'the origin is no longer trimmed (BOM and newlines survive)',
    file: 'src/lib/appOrigin.ts',
    from: "    .trim()\r\n    .replace(/^[\"']|[\"']$/g, '')   // quotes a .env line can carry in",
    to: "    .replace(/^[\"']|[\"']$/g, '')   // quotes a .env line can carry in",
    alt: {
      from: "    .trim()\n    .replace(/^[\"']|[\"']$/g, '')   // quotes a .env line can carry in",
      to: "    .replace(/^[\"']|[\"']$/g, '')   // quotes a .env line can carry in",
    },
  },
  {
    name: 'a trailing slash is no longer stripped',
    file: 'src/lib/appOrigin.ts',
    from: ".replace(/\\/+$/, '')           // trailing slash — every caller appends its own",
    to: '',
  },
  {
    name: 'the invitation claims it was emailed regardless',
    file: 'src/app/api/crew/invite/route.ts',
    from: 'emailed = res.sent',
    to: 'emailed = true',
  },
  {
    name: 'the invitation email is not sent at all',
    file: 'src/app/api/crew/invite/route.ts',
    from: '    const res = await sendEmail(email, msg.subject, msg.html, msg.text)',
    to: '    const res = { sent: false, reason: null, error: null }',
  },
  {
    name: 'a disabled worker is shown the join-code form',
    file: 'src/lib/crewInvite.ts',
    from: "return status === 'disabled' ? 'turned-off' : 'code-form'",
    to: "return 'code-form'",
  },
  {
    name: 'an unknown status asserts "your access is turned off"',
    file: 'src/lib/crewInvite.ts',
    from: "return status === 'disabled' ? 'turned-off' : 'code-form'",
    to: "return status === 'disabled' || status === 'unknown' ? 'turned-off' : 'code-form'",
  },
  {
    name: 'the status engine looks up somebody other than the caller',
    file: 'src/lib/crewSelfStatus.ts',
    from: ".eq('auth_user_id', userId)",
    to: ".eq('auth_user_id', 'not-the-caller')",
  },
  {
    name: 'a failed status read is reported as "never invited"',
    file: 'src/lib/crewSelfStatus.ts',
    from: "if (error) return 'unknown'",
    to: "if (error) return 'none'",
  },
  {
    name: 'a missing service key is reported as "never invited"',
    file: 'src/lib/crewSelfStatus.ts',
    from: "if (!admin) return 'unknown'",
    to: "if (!admin) return 'none'",
  },
  {
    name: 'the join page reads the roster itself again (crew screen touches an owner table)',
    file: 'src/app/crew/join/page.tsx',
    from: '  const status = await readCrewSelfStatus(supabase, user.id)',
    to: "  const status = (await (await import('@/lib/supabase/admin')).createAdminClient()?.from('technicians').select('is_active').eq('auth_user_id', user.id).maybeSingle())?.data ? 'disabled' : 'none'",
  },
  {
    name: 'sign-in stops resolving the role (owner dashboard for everyone)',
    file: 'src/app/login/page.tsx',
    from: 'const role = await resolveAppRole(supabase)\r\n    router.push(next ?? landingFor(role))',
    to: "router.push(next ?? '/dashboard')",
    alt: {
      from: 'const role = await resolveAppRole(supabase)\n    router.push(next ?? landingFor(role))',
      to: "router.push(next ?? '/dashboard')",
    },
  },
  {
    name: 'a worker lands on the owner dashboard',
    file: 'src/lib/crewAccess.ts',
    from: "return role === 'crew' ? CREW_ROOT : OWNER_ROOT",
    to: 'return OWNER_ROOT',
  },
  {
    name: 'the resend uses the roster free-text address again',
    file: 'src/components/dispatch/CrewAccessControl.tsx',
    from: 'onClick={() => invite(access?.email ?? tech.email ?? undefined)}',
    to: 'onClick={() => invite()}',
  },
  {
    name: 'the setup link is logged on a failed send',
    file: 'src/app/api/crew/invite/route.ts',
    from: "if (!res.sent) console.error('[crew-invite] provider rejected the send:', res.reason, res.error ?? '')",
    to: "if (!res.sent) console.error('[crew-invite] failed, link was', setupUrl)",
  },
  {
    name: 'the business name is read with the service role instead of RLS',
    file: 'src/app/api/crew/invite/route.ts',
    from: "const { data: settings } = await supabase\r\n    .from('business_settings')",
    to: "const { data: settings } = await admin\r\n    .from('business_settings')",
    alt: {
      from: "const { data: settings } = await supabase\n    .from('business_settings')",
      to: "const { data: settings } = await admin\n    .from('business_settings')",
    },
  },
  {
    name: 'the owner-supplied business name is no longer HTML-escaped',
    file: 'src/lib/crewInviteServer.ts',
    from: 'const subject = business ? `${business}: set up your work login` : ',
    to: 'const subject = business ? `${business}: set up your work login` : ',
    // escape() removal, applied separately below
    replaceAll: { from: 'esc(opener)', to: 'opener' },
  },
  {
    name: 'a worker who resets their password lands on the owner dashboard',
    file: 'src/components/auth/ResetPasswordForm.tsx',
    from: "router.replace(role === 'crew' ? landingFor(role) : RESET_DESTINATION)",
    to: 'router.replace(RESET_DESTINATION)',
  },
  {
    name: 'the privileged link write loses its tenant scope',
    file: 'src/app/api/crew/invite/route.ts',
    from: "    .eq('id', tech.id)\r\n    .eq('user_id', user.id)",
    to: "    .eq('id', tech.id)",
    alt: { from: "    .eq('id', tech.id)\n    .eq('user_id', user.id)", to: "    .eq('id', tech.id)" },
  },
]

const hash = s => createHash('sha256').update(s).digest('hex').slice(0, 12)
let caught = 0, escaped = 0, misfired = 0

for (const m of MUTATIONS) {
  const original = readFileSync(m.file, 'utf8')
  let mutated = original

  if (m.replaceAll) {
    mutated = original.split(m.replaceAll.from).join(m.replaceAll.to)
  } else if (original.includes(m.from)) {
    mutated = original.replace(m.from, m.to)
  } else if (m.alt && original.includes(m.alt.from)) {
    mutated = original.replace(m.alt.from, m.alt.to)
  }

  if (hash(mutated) === hash(original)) {
    // A mutation that did not apply looks EXACTLY like a guard that caught it if
    // you only watch the exit code. Report it as loudly as an escape.
    console.log(`  ⚠️  MISFIRED (pattern not found): ${m.name}`)
    misfired++
    continue
  }

  writeFileSync(m.file, mutated)
  let failed = false
  try {
    execSync('npx tsx scripts/verify-crew-auth.ts', { stdio: 'pipe' })
  } catch { failed = true }
  writeFileSync(m.file, original)

  if (failed) { console.log(`  ✅ caught: ${m.name}`); caught++ }
  else { console.log(`  ❌ ESCAPED: ${m.name}`); escaped++ }
}

console.log(`\n${escaped === 0 && misfired === 0 ? '✅' : '❌'} ${caught} caught, ${escaped} escaped, ${misfired} misfired`)
process.exit(escaped === 0 && misfired === 0 ? 0 : 1)
