// ── Mutation harness for verify:job-forms ────────────────────────────────────
// Breaks each load-bearing rule ON PURPOSE and proves the guard turns red.
// Run by hand: node scripts/mutate-job-forms.mjs   (never a verify: entry —
// that would break the runner's parity contract).
//
// Rules of the harness (learned the hard way elsewhere in this repo):
//   · REFUSES to run on a dirty tree — reverts use `git checkout --`, which
//     destroys uncommitted work indiscriminately.
//   · Every mutation PROVES it applied (content must change) — a splice whose
//     anchor drifted reports NOT APPLIED, never "caught".
//   · A baseline run must be green first; a red baseline proves nothing.
import { execSync, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const MIG = 'supabase/archive/ledger/20260815120000_job_forms_v1.sql'
const MUTATIONS = [
  {
    file: MIG,
    why: 'required enforcement — the gate trigger stops firing on the completed transition',
    from: "new.status = 'completed' and old.status is distinct from 'completed'",
    to: "new.status = 'zz-never' and old.status is distinct from 'completed'",
  },
  {
    file: MIG,
    why: 'tenant scope — the instance→visit wall drops to a single-column FK',
    from: 'foreign key (job_id, user_id) references public.jobs (id, user_id) on delete cascade',
    to: 'foreign key (job_id) references public.jobs (id) on delete cascade',
  },
  {
    file: MIG,
    why: 'assignment authorization — crew_save_form_response stops re-proving the crew',
    from: 'select * into v_job from public.jobs\n  where id = v_form.job_id and user_id = v_employer and crew_id = v_crew;',
    to: 'select * into v_job from public.jobs\n  where id = v_form.job_id and user_id = v_employer;',
  },
  {
    file: MIG,
    why: 'snapshot behaviour — the freeze guard lets the snapshot be rewritten',
    from: 'if new.fields is distinct from old.fields',
    to: 'if false and new.fields is distinct from old.fields',
  },
  {
    file: MIG,
    why: 'completed freeze — post-completion edits stop demanding a correction',
    from: "raise exception 'this visit is completed — a change to its checklist must be an explicit correction with a reason';",
    to: "null;",
  },
  {
    file: MIG,
    why: 'photo ownership — a photo of another visit satisfies the requirement',
    from: "raise exception 'a checklist photo must be a photo of this visit, not another one';",
    to: 'null;',
  },
  {
    file: MIG,
    why: 'attribution — answered_by stops being checked against the session',
    from: "raise exception 'an answer must be attributed to the session that wrote it';",
    to: 'null;',
  },
  {
    file: 'src/app/api/crew/complete/route.ts',
    why: 'required enforcement (app door) — the crew completion route stops pre-checking',
    from: 'if (Array.isArray(checklist) && checklist.length > 0) {',
    to: 'if (false && Array.isArray(checklist) && checklist.length > 0) {',
  },
  {
    file: 'src/app/api/crew/photos/route.ts',
    why: 'photo rollback — a failed link leaves the orphan upload standing',
    from: "await admin.from('job_photos').delete().eq('id', photoId).eq('user_id', j.user_id)",
    to: "void 0 // await admin.from('job_photos').delete().eq('id', photoId).eq('user_id', j.user_id)",
  },
  {
    file: 'src/lib/jobForms.ts',
    why: 'waive honesty — an empty reason sails through the client',
    from: "if (!trimmed) return { ok: false, error: 'Say why the checklist is being waived.' }",
    to: "if (false) return { ok: false, error: 'Say why the checklist is being waived.' }",
  },
  {
    file: 'src/components/crew/CrewToday.tsx',
    why: 'refusal UX — the gate list never reaches the card',
    from: '{gateBlocked[stop.id]?.length ? (',
    to: '{false && gateBlocked[stop.id]?.length ? (',
  },
]

const md5 = (s) => createHash('md5').update(s).digest('hex')
// Resolve tsx's real cli from its package.json, the way verify-all does —
// the .bin shim breaks under spawnSync on Windows.
const tsxPkg = JSON.parse(readFileSync('node_modules/tsx/package.json', 'utf8'))
const TSX_CLI = 'node_modules/tsx/' + (typeof tsxPkg.bin === 'string' ? tsxPkg.bin : tsxPkg.bin.tsx)
const run = () => spawnSync(process.execPath, [TSX_CLI, 'scripts/verify-job-forms.ts'], { encoding: 'utf8' })

const dirty = execSync('git status --porcelain -- ' + MUTATIONS.map(m => `"${m.file}"`).join(' '), { encoding: 'utf8' }).trim()
if (dirty) {
  console.error('✗ refusing to run: mutation targets have uncommitted changes\n' + dirty)
  process.exit(2)
}

const baseline = run()
if (baseline.status !== 0) {
  console.error('✗ baseline is already red — a mutation proves nothing. Fix the guard first.')
  console.error((baseline.stdout || '').split('\n').filter(l => l.includes('✗')).join('\n'))
  process.exit(2)
}
console.log('baseline green — mutating\n')

let caught = 0, missed = 0, notApplied = 0
for (const m of MUTATIONS) {
  const original = readFileSync(m.file, 'utf8')
  const normalized = original.replace(/\r\n/g, '\n')          // CRLF disarms literal anchors
  const mutated = normalized.replace(m.from, m.to)
  if (md5(mutated) === md5(normalized)) {
    notApplied++
    console.log(`  ⚠ NOT APPLIED — ${m.why}\n      anchor not found in ${m.file}`)
    continue
  }
  writeFileSync(m.file, mutated, 'utf8')
  const res = run()
  execSync(`git checkout -- "${m.file}"`)
  if (res.status !== 0) { caught++; console.log(`  ✓ caught — ${m.why}`) }
  else { missed++; console.log(`  ✗ MISSED — ${m.why}`) }
}

console.log(`\n${caught}/${MUTATIONS.length} mutations caught` +
  (missed ? ` · ${missed} MISSED` : '') + (notApplied ? ` · ${notApplied} NOT APPLIED` : ''))
process.exit(missed || notApplied ? 1 : 0)
