#!/usr/bin/env tsx
/**
 * Local-only, idempotent Apple Contacts reconciliation for a verified message audit.
 *
 * Defaults to dry-run. `--apply` is required to write. No contact data is sent over
 * the network or printed; output contains only the action and match count.
 */
import { execFileSync } from 'node:child_process'
import { planNativeContactName, nativePhoneKey, type ContactLifecycle } from './lib/native-contact-lifecycle'

type Args = {
  firstName: string
  lastName: string
  phone: string
  lifecycle: ContactLifecycle
  verifiedActiveClient: boolean
  apply: boolean
}

type ContactHit = {
  id: string
  firstName: string
  lastName: string
  organization: string
}

function parseArgs(argv: string[]): Args {
  const value = (flag: string) => {
    const i = argv.indexOf(flag)
    return i >= 0 ? argv[i + 1] || '' : ''
  }
  const lifecycle = (value('--lifecycle') || 'lead').toLowerCase()
  if (lifecycle !== 'lead' && lifecycle !== 'client') throw new Error('lifecycle must be lead or client')
  const args: Args = {
    firstName: value('--first').trim(),
    lastName: value('--last').trim(),
    phone: value('--phone').trim(),
    lifecycle,
    verifiedActiveClient: argv.includes('--verified-active-client'),
    apply: argv.includes('--apply'),
  }
  if (!args.firstName) throw new Error('verified first name is required')
  if (nativePhoneKey(args.phone).length !== 10) throw new Error('a complete North-American phone number is required')
  return args
}

const queryScript = String.raw`
function run(argv) {
  var key = String(argv[0] || '').replace(/\D/g, '').slice(-10)
  var app = Application('Contacts')
  var out = []
  app.people().forEach(function (person) {
    var matched = person.phones().some(function (phone) {
      return String(phone.value() || '').replace(/\D/g, '').slice(-10) === key
    })
    if (matched) out.push({
      id: String(person.id()),
      firstName: String(person.firstName() || ''),
      lastName: String(person.lastName() || ''),
      organization: String(person.organization() || '')
    })
  })
  return JSON.stringify(out)
}`

const writeScript = String.raw`
ObjC.import('Foundation')
function stdinText() {
  var data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile
  return ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding))
}
function run() {
  var input = JSON.parse(stdinText())
  var app = Application('Contacts')
  if (input.mode === 'create') {
    var person = app.Person({ firstName: input.firstName, lastName: input.lastName })
    person.phones.push(app.Phone({ label: 'mobile', value: input.phone }))
    app.people.push(person)
  } else {
    var matches = app.people.whose({ id: input.id })()
    if (matches.length !== 1) throw new Error('contact changed before write')
    matches[0].firstName = input.firstName
    matches[0].lastName = input.lastName
  }
  app.save()
  return JSON.stringify({ ok: true })
}`

function osascript(args: string[], input?: string): string {
  return execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', ...args], {
    encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'],
  }).trim()
}

function report(value: Record<string, unknown>) {
  process.stdout.write(JSON.stringify(value) + '\n')
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const hits = JSON.parse(osascript(['-e', queryScript, nativePhoneKey(args.phone)])) as ContactHit[]
  if (hits.length > 1) {
    report({ ok: false, action: 'conflict', matches: hits.length, reason: 'duplicate_phone_cards' })
    process.exitCode = 2
    return
  }

  const existing = hits[0] || null
  const plan = planNativeContactName({
    firstName: args.firstName,
    lastName: args.lastName || null,
    lifecycle: args.lifecycle,
    verifiedActiveClient: args.verifiedActiveClient,
  }, existing)
  if (!plan.ok) {
    report({ ok: false, action: 'conflict', matches: hits.length, reason: plan.reason })
    process.exitCode = 2
    return
  }

  const unchanged = existing
    && existing.firstName === plan.firstName
    && existing.lastName === plan.lastName
  const action = unchanged ? 'noop' : existing ? 'update' : 'create'
  if (action === 'noop' || !args.apply) {
    report({ ok: true, action, matches: hits.length, dryRun: !args.apply, lifecycle: plan.lifecycle })
    return
  }

  const payload = existing
    ? { mode: 'update', id: existing.id, firstName: plan.firstName, lastName: plan.lastName }
    : { mode: 'create', firstName: plan.firstName, lastName: plan.lastName, phone: args.phone }
  osascript(['-e', writeScript], JSON.stringify(payload))
  report({ ok: true, action, matches: hits.length, dryRun: false, lifecycle: plan.lifecycle })
}

try { main() }
catch {
  // Deliberately omit the raw exception: JXA errors may echo customer data.
  report({ ok: false, action: 'error', reason: 'local_contacts_operation_failed' })
  process.exitCode = 1
}
