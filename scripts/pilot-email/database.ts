// Only the GitHub PostgreSQL17 disposable service is a valid target. No URL API.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { splitStatements } from '../lib/pg-sql'

export interface Database {
  exec(sql: string): Promise<unknown>
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>
}
export interface TestResult { name: string; pass: boolean; error?: string }
export const DISPOSABLE_MARKER = 'EDGEHQ_LOCAL_PG17_PILOT_TEST_ONLY'
export const DATABASE_COMMENT = 'edgehq disposable pilot schema proof; never production'

export function assertDisposableEnvironment(env: Readonly<Record<string, string | undefined>>): void {
  if (env.PILOT_EMAIL_DISPOSABLE !== DISPOSABLE_MARKER) throw new Error('Explicit disposable database marker required')
  for (const [key, value] of Object.entries({ PGHOST: '127.0.0.1', PGPORT: '5432', PGDATABASE: 'pilot_test', PGUSER: 'postgres' })) {
    if (env[key] && env[key] !== value) throw new Error('Refusing non-synthetic PostgreSQL target: ' + key)
  }
  for (const key of ['DATABASE_URL', 'SUPABASE_DB_URL', 'PGSERVICE', 'PGSERVICEFILE', 'PGPASSFILE']) {
    if (env[key]) throw new Error('Refusing external database configuration: ' + key)
  }
}

function literal(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Non-finite SQL fixture parameter')
    return String(value)
  }
  if (typeof value !== 'string' || value.includes('\0')) throw new Error('Unsupported SQL fixture parameter')
  return "'" + value.replace(/'/g, "''") + "'"
}

// A SQL lexer avoids replacing $1 inside strings, identifiers, comments or
// dollar-quoted function bodies. This is fixture binding, not an app DB driver.
export function bindParameters(sql: string, params: unknown[]): string {
  let out = '', i = 0
  while (i < sql.length) {
    if (sql.startsWith('--', i)) {
      const end = sql.indexOf('\n', i); const n = end < 0 ? sql.length : end
      out += sql.slice(i, n); i = n; continue
    }
    if (sql.startsWith('/*', i)) {
      let j = i + 2, depth = 1
      while (j < sql.length && depth) {
        if (sql.startsWith('/*', j)) { depth++; j += 2 }
        else if (sql.startsWith('*/', j)) { depth--; j += 2 }
        else j++
      }
      if (depth) throw new Error('Unterminated SQL comment')
      out += sql.slice(i, j); i = j; continue
    }
    if (sql[i] === "'" || sql[i] === '"') {
      const q = sql[i], escaped = q === "'" && /(?:^|[^\w])E$/i.test(sql.slice(0, i))
      let j = i + 1, closed = false
      while (j < sql.length) {
        if (escaped && sql[j] === '\\') { j += 2; continue }
        if (sql[j] === q && sql[j + 1] === q) { j += 2; continue }
        if (sql[j] === q) { j++; closed = true; break }
        j++
      }
      if (!closed) throw new Error('Unterminated SQL literal')
      out += sql.slice(i, j); i = j; continue
    }
    if (sql[i] === '$') {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))?.[0]
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length)
        if (end < 0) throw new Error('Unterminated dollar-quoted SQL')
        out += sql.slice(i, end + tag.length); i = end + tag.length; continue
      }
      const parameter = /^\$([1-9][0-9]*)/.exec(sql.slice(i))
      if (parameter) {
        const index = Number(parameter[1]) - 1
        if (index >= params.length) throw new Error('Missing SQL fixture parameter')
        out += literal(params[index]); i += parameter[0].length; continue
      }
    }
    out += sql[i++]
  }
  return out
}

export class SqlStateError extends Error {
  constructor(readonly code: string, readonly detail: string) {
    super('PostgreSQL ' + code + ': ' + detail.slice(0, 1000))
  }
}

type Pending = { marker: string; output: string[]; resolve: (value: string[]) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
export class DisposableSession implements Database {
  private process: ChildProcessWithoutNullStreams
  private pending: Pending | null = null
  private outputBuffer = ''
  private stderr = ''
  private stderrTail = ''
  private stderrBytes = 0
  private queue: Promise<unknown> = Promise.resolve()
  private ended = false
  private closing = false
  private closePromise: Promise<void> | null = null
  pid = 0
  private constructor(name: string) {
    assertDisposableEnvironment(process.env)
    if (!/^[a-z0-9_-]{1,40}$/.test(name)) throw new Error('Invalid synthetic session name')
    this.process = spawn('psql', ['--no-psqlrc', '--no-password', '--quiet', '--no-align', '--tuples-only',
      '--host=127.0.0.1', '--port=5432', '--username=postgres', '--dbname=pilot_test',
      '--set=ON_ERROR_STOP=off', '--set=VERBOSITY=verbose', '--pset=pager=off'], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      // No inherited credentials, service files, URL, startup commands or SSL
      // target. The password below exists only for the disposable CI service.
      env: { NODE_ENV: 'test', PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
        PGPASSWORD: 'pilot_disposable_password_not_a_secret', PGPASSFILE: '/dev/null',
        PGSSLMODE: 'disable', PGCLIENTENCODING: 'UTF8', PGAPPNAME: 'pilot-test-' + name,
        PGOPTIONS: '-c statement_timeout=25000 -c lock_timeout=20000 -c standard_conforming_strings=on' },
    })
    this.process.stdout.setEncoding('utf8')
    this.process.stderr.setEncoding('utf8')
    this.process.stderr.on('data', (chunk: string) => {
      // Keep the primary ERROR/LINE as well as the final native context. Large
      // PL/pgSQL diagnostics can otherwise replace the error with body text.
      this.stderrBytes += chunk.length
      this.stderr = (this.stderr + chunk).slice(0, 6000)
      this.stderrTail = (this.stderrTail + chunk).slice(-2000)
    })
    this.process.stdout.on('data', (chunk: string) => this.onOutput(chunk))
    this.process.on('error', (error) => {
      if (this.process.pid === undefined) this.ended = true // spawn failed; no child exists to await
      this.fail(error)
    })
    this.process.on('exit', (code) => { this.ended = true; this.fail(new Error('Disposable psql exited: ' + code)) })
  }
  static async open(name: string): Promise<DisposableSession> {
    const db = new DisposableSession(name)
    try {
      const result = await db.query<{ database: string; version: number; marker: string; pid: number }>(`select current_database() as database,
        current_setting('server_version_num')::int as version,
        (select shobj_description(oid,'pg_database') from pg_database where datname=current_database()) as marker,
        pg_backend_pid() as pid`)
      const row = result.rows[0]
      if (row?.database !== 'pilot_test' || row.version < 170000 || row.version >= 180000 || row.marker !== DATABASE_COMMENT) {
        throw new Error('Refusing unmarked database or non-PostgreSQL17 server')
      }
      db.pid = row.pid
      return db
    } catch (error) { await db.close(); throw error }
  }
  private fail(error: Error) {
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(error); this.pending = null }
  }
  private onOutput(chunk: string) {
    this.outputBuffer += chunk
    let newline: number
    while ((newline = this.outputBuffer.indexOf('\n')) >= 0) {
      const line = this.outputBuffer.slice(0, newline).replace(/\r$/, '')
      this.outputBuffer = this.outputBuffer.slice(newline + 1)
      const pending = this.pending
      if (!pending) continue
      if (line.startsWith(pending.marker + ' ')) {
        const parts = line.slice(pending.marker.length + 1).trim().split(/\s+/)
        clearTimeout(pending.timer); this.pending = null
        if (parts[0] === 'false' && parts[1] === '00000') pending.resolve(pending.output)
        else if (parts[0] === 'true' && /^[0-9A-Z]{5}$/.test(parts[1] ?? '')) pending.reject(new SqlStateError(parts[1],
          (this.stderrBytes > 6000 ? this.stderr + '\n[bounded diagnostic tail]\n' + this.stderrTail : this.stderr) || 'statement refused'))
        else pending.reject(new Error('Unexpected psql result marker'))
      } else pending.output.push(line)
    }
  }
  private raw(sql: string): Promise<string[]> {
    const operation = this.queue.then(() => new Promise<string[]>((resolve, reject) => {
      if (this.ended || this.closing) { reject(new Error('Disposable session is closed')); return }
      this.stderr = ''
      this.stderrTail = ''
      this.stderrBytes = 0
      const marker = 'PILOT_' + randomUUID().replace(/-/g, '')
      const timer = setTimeout(() => { this.fail(new Error('Disposable SQL timeout')); this.process.kill() }, 30000)
      this.pending = { marker, output: [], resolve, reject, timer }
      this.process.stdin.write(sql + '\n\\echo ' + marker + ' :ERROR :SQLSTATE\n')
    }))
    this.queue = operation.catch(() => undefined)
    return operation
  }
  async exec(sql: string): Promise<void> {
    for (const statement of splitStatements(sql)) await this.raw(statement + ';')
  }
  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
    const statements = splitStatements(bindParameters(sql, params))
    if (statements.length !== 1) throw new Error('query requires one SQL statement')
    const statement = statements[0]
    let wrapped: string
    if (/^\s*(select|with)\b/i.test(statement)) {
      wrapped = `select coalesce(json_agg(row_to_json(pilot_rows)),'[]'::json)::text from (${statement}) as pilot_rows;`
    } else if (/\breturning\b/i.test(statement) && /^\s*(update|insert|delete)\b/i.test(statement)) {
      wrapped = `with pilot_rows as (${statement}) select coalesce(json_agg(row_to_json(pilot_rows)),'[]'::json)::text from pilot_rows;`
    } else {
      await this.exec(statement); return { rows: [] }
    }
    const lines = (await this.raw(wrapped)).filter(line => line.trim())
    if (lines.length !== 1) throw new Error('Unexpected SQL result framing')
    const rows: unknown = JSON.parse(lines[0])
    if (!Array.isArray(rows)) throw new Error('SQL query did not return row array')
    return { rows: rows as T[] }
  }
  async close(): Promise<void> {
    if (this.ended) return
    if (this.closePromise) return this.closePromise
    this.closing = true
    this.fail(new Error('Disposable session closed'))
    this.closePromise = new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(killTimer)
        clearTimeout(exitDeadline)
        this.process.removeListener('exit', exited)
      }
      const exited = () => { cleanup(); resolve() }
      const killTimer = setTimeout(() => this.process.kill('SIGKILL'), 1000)
      const exitDeadline = setTimeout(() => {
        cleanup()
        reject(new Error('Disposable psql did not confirm exit within five seconds'))
      }, 5000)
      this.process.once('exit', exited)
      if (this.ended) exited()
      else if (!this.process.stdin.destroyed) this.process.stdin.end('\\q\n')
    })
    return this.closePromise
  }
}
