// ── A PostgREST-shaped transport over PGlite, for exercising REAL route code ──
//
// ⭐⭐ WHY THIS EXISTS. This lane has been bitten three times by guards that
// tested a re-implementation of the thing they were guarding — a classifier
// corpus that agreed with itself, a `reclassifyLikeTheRoute()` helper that missed
// five of twelve mutations, and a file-wide toast count hiding seven gaps. The
// lesson each time: run the REAL code.
//
// A Next route handler is real code, and the only thing standing between it and a
// disposable Postgres is the wire format. So this supplies the WIRE, and nothing
// else: `.from().select().eq()…` becomes SQL, `.rpc()` becomes `select fn(…)`.
//
// ⛔ IT MAKES NO DECISIONS. It holds no rule about acceptance, money, evidence or
// tenancy — every such rule stays where it lives, in the route and in the
// database, and the guard asserts the route's own answers. If you find yourself
// adding a branch here that knows what a quote is, stop: that branch belongs in
// the code under test, and putting it here is how a test comes to agree with
// itself again.
//
// ⚠️ It is NOT PostgREST. It implements exactly the subset the routes under test
// call, and it THROWS on anything else rather than silently returning empty —
// a shim that quietly answers "no rows" would turn an unimplemented method into
// a passing negative result, which is the same failure in a new costume.

type Row = Record<string, unknown>
export type Q = (sql: string, params?: unknown[]) => Promise<{ rows: Row[] }>

interface Filter { op: 'eq' | 'in'; col: string; val: unknown }

const ident = (s: string) => {
  if (!/^[a-z_][a-z0-9_]*$/i.test(s)) throw new Error(`shim: refusing unsafe identifier ${JSON.stringify(s)}`)
  return `"${s}"`
}

class Builder implements PromiseLike<{ data: unknown; error: { message: string } | null; count?: number | null }> {
  private filters: Filter[] = []
  private cols = '*'
  private orderBy: { col: string; asc: boolean } | null = null
  private limitN: number | null = null
  private wantSingle = false
  private headCount = false
  private mode: 'select' | 'update' = 'select'
  private patch: Row | null = null

  constructor(private q: Q, private table: string) {}

  select(cols?: string, opts?: { count?: string; head?: boolean }) {
    if (this.mode === 'select') this.cols = cols && cols.trim() ? cols : '*'
    if (opts?.head) this.headCount = true
    return this
  }
  update(patch: Row) { this.mode = 'update'; this.patch = patch; return this }
  eq(col: string, val: unknown) { this.filters.push({ op: 'eq', col, val }); return this }
  in(col: string, val: unknown[]) { this.filters.push({ op: 'in', col, val }); return this }
  order(col: string, opts?: { ascending?: boolean }) { this.orderBy = { col, asc: opts?.ascending !== false }; return this }
  limit(n: number) { this.limitN = n; return this }
  // ⛔ Only maybeSingle(): .single() is not implemented, so a route that starts
  // using it fails LOUDLY here rather than silently taking a different path.
  maybeSingle() { this.wantSingle = true; return this }

  private where(params: unknown[]): string {
    const parts = this.filters.map(f => {
      if (f.op === 'in') {
        const arr = f.val as unknown[]
        if (arr.length === 0) return 'false'
        return `${ident(f.col)} in (${arr.map(v => `$${params.push(v)}`).join(',')})`
      }
      return `${ident(f.col)} = $${params.push(f.val)}`
    })
    return parts.length ? ` where ${parts.join(' and ')}` : ''
  }

  async run() {
    const params: unknown[] = []
    try {
      if (this.mode === 'update') {
        const sets = Object.entries(this.patch ?? {}).map(([k, v]) => `${ident(k)} = $${params.push(v)}`)
        if (!sets.length) throw new Error('shim: update with no columns')
        const w = this.where(params)
        await this.q(`update public.${ident(this.table)} set ${sets.join(', ')}${w}`, params)
        return { data: null, error: null }
      }
      if (this.headCount) {
        const w = this.where(params)
        const r = await this.q(`select count(*)::int as n from public.${ident(this.table)}${w}`, params)
        return { data: null, error: null, count: Number(r.rows[0]?.n ?? 0) }
      }
      const w = this.where(params)
      const ord = this.orderBy ? ` order by ${ident(this.orderBy.col)} ${this.orderBy.asc ? 'asc' : 'desc'}` : ''
      const lim = this.limitN != null ? ` limit ${Number(this.limitN)}` : ''
      const r = await this.q(`select ${this.cols} from public.${ident(this.table)}${w}${ord}${lim}`, params)
      if (this.wantSingle) return { data: r.rows[0] ?? null, error: null }
      return { data: r.rows, error: null }
    } catch (e) {
      // A transport failure is reported the way PostgREST reports one, because the
      // routes' "a read we could not complete is not an empty read" contracts are
      // written against exactly this shape and must be exercised, not bypassed.
      return { data: null, error: { message: (e as Error).message } }
    }
  }

  then<R1 = { data: unknown; error: { message: string } | null; count?: number | null }, R2 = never>(
    onfulfilled?: ((v: { data: unknown; error: { message: string } | null; count?: number | null }) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((r: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return this.run().then(onfulfilled, onrejected)
  }
}

export interface ShimOptions {
  /** The signed-in tenant for auth.uid() / auth.getUser(). Null = anonymous. */
  uid?: string | null
  /** Forced transport failure, to exercise a route's "could not read" branch. */
  failOn?: (table: string) => boolean
}

/** A client with the surface these routes actually use, and nothing more. */
export function makeSupabaseShim(q: Q, opts: ShimOptions = {}) {
  const uid = opts.uid ?? null
  // Every statement runs with the session claim the real request would carry, so
  // SECURITY DEFINER functions reading auth.uid() see what production shows them.
  const withClaim: Q = async (sql, params) => {
    await q(`select set_config('request.jwt.claim.sub', $1, false)`, [uid ?? ''])
    return q(sql, params)
  }
  return {
    auth: {
      async getUser() {
        return { data: { user: uid ? { id: uid } : null }, error: null }
      },
    },
    from(table: string) {
      if (opts.failOn?.(table)) {
        const failing = new Builder(async () => { throw new Error(`shim: forced transport failure on ${table}`) }, table)
        return failing
      }
      return new Builder(withClaim, table)
    },
    async rpc(name: string, args: Record<string, unknown> = {}) {
      const keys = Object.keys(args)
      const params: unknown[] = []
      // Named notation, so argument ORDER here can never silently disagree with
      // the function's signature — the database resolves the names.
      const call = keys.length
        ? keys.map(k => `${ident(k)} => $${params.push(args[k])}`).join(', ')
        : ''
      try {
        const r = await withClaim(`select public.${ident(name)}(${call}) as out`, params)
        return { data: (r.rows[0] as Row | undefined)?.out ?? null, error: null }
      } catch (e) {
        return { data: null, error: { message: (e as Error).message } }
      }
    },
  }
}
