import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runAcceptanceCallerServerCases, acceptanceCallerServerEvidence } from '../pilot-email/acceptance-caller-server-cases'

// Focused synthetic HTTP/boundary regression only. Real Auth/native revocation
// and portal versioning have separate evidence in the disposable platform run.
async function main() {
  const tests = await runAcceptanceCallerServerCases()
  const pass = tests.length === 24 && tests.every(test => test.pass)
  const report = { pass, scope: 'Synthetic acceptance HTTP and protocol regression; no real Auth or native COMMIT claim',
    tests, evidence: acceptanceCallerServerEvidence }
  const directory = join(process.cwd(), 'outputs/authenticated-quote-acceptance-real-20260911')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'server-authority-proof.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ pass, passed: tests.filter(test => test.pass).length, total: tests.length,
    failed: tests.filter(test => !test.pass) }))
  if (!pass) process.exitCode = 1
}
void main().catch(error => { console.error(String(error)); process.exitCode = 1 })
