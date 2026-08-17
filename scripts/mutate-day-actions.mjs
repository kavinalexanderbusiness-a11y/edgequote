// ── Mutation harness for verify:day-actions ──────────────────────────────────
//   node scripts/mutate-day-actions.mjs        (run by hand, clean tree only)
//
// Breaks each Session-80 rule in the real source, one at a time, and requires
// the guard to go RED for every one. A guard that stays green under these is
// decoration. Restores every file from git afterwards.

import { execSync, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const run = (cmd) => execSync(cmd, { encoding: 'utf8' })
if (run('git status --porcelain').trim() !== '') {
  console.error('✗ working tree is dirty — commit or stash first (this harness rewrites source files)')
  process.exit(2)
}

const guard = () => spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'verify:day-actions'], { encoding: 'utf8', shell: true })

console.log('baseline: guard must be green before mutating…')
if (guard().status !== 0) { console.error('✗ baseline is already red — fix that first'); process.exit(2) }
console.log('  ✓ baseline green\n')

const MUTATIONS = [
  {
    name: 'an ESTIMATE record is granted the Complete door',
    file: 'src/lib/dayActions.ts',
    from: "canComplete: r.kind === 'visit' && active,",
    to: 'canComplete: active,',
  },
  {
    name: 'DayOpsPanel Complete buttons ungated from the doors module',
    file: 'src/components/schedule/DayOpsPanel.tsx',
    from: "{job.status === 'in_progress' && doors.canComplete && (",
    to: "{job.status === 'in_progress' && (",
  },
  {
    name: 'completeJob stops consulting the completion-message plan',
    file: 'src/app/dashboard/schedule/page.tsx',
    from: 'const plan = completionMessagePlan(',
    to: 'const plan = ((..._a) => ({ configured: false, channels: [], wouldSend: false, contactKnown: true, reason: null }))(',
  },
  {
    name: 'the job_complete send loses its idempotency id',
    file: 'src/app/dashboard/schedule/page.tsx',
    from: 'clientMessageId: newClientMessageId(),',
    to: '',
  },
  {
    name: "'reply' unregistered — owner replies govern as commercial again",
    file: 'src/lib/comms/templates.ts',
    from: "  reply: 'Reply',",
    to: '',
  },
  {
    name: 'the duplicate-review warning is deleted from the composer',
    file: 'src/components/schedule/JobMessages.tsx',
    from: 'A review request already went out',
    to: 'FYI',
  },
  {
    name: 'the review ladder forgets the declined state',
    file: 'src/lib/dayActions.ts',
    from: "if (status === 'declined') return { state: 'declined', ...none }",
    to: '',
  },
]

let caught = 0
for (const m of MUTATIONS) {
  const src = readFileSync(m.file, 'utf8')
  if (!src.includes(m.from)) {
    console.log(`  ✗ NOT APPLIED — anchor drifted for “${m.name}” (${m.file})`)
    continue
  }
  writeFileSync(m.file, src.replace(m.from, m.to))
  const r = guard()
  execSync(`git checkout -- "${m.file}"`)
  if (r.status !== 0) { caught++; console.log(`  ✓ caught: ${m.name}`) }
  else console.log(`  ✗ SURVIVED: ${m.name} — the guard is blind to this`)
}

console.log(`\n${caught}/${MUTATIONS.length} mutations caught`)
process.exit(caught === MUTATIONS.length ? 0 : 1)
