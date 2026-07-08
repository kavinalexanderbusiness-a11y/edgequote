# Offline for Scheduling — Session C integration guide

The offline **outbox** and the **`job.update` replay handler** are already built and
registered ([lib/offline/handlers.ts](../src/lib/offline/handlers.ts)). Scheduling code
does **not** import handlers, touch the queue, or build anything offline-specific — it
only wraps its existing `jobs` mutations with `queueOrRun`. Everything below stays inside
`src/components/schedule/*` and `src/app/dashboard/schedule/*` (your files).

## The recipe — per `jobs` mutation

Replace a direct write:

```ts
const { error } = await supabase.from('jobs').update(patch).eq('id', jobId)
```

with:

```ts
import { queueOrRun } from '@/lib/offline/outbox'

const outcome = await queueOrRun(
  { kind: 'job.update', payload: { id: jobId, patch }, label: 'Job update' },
  async () => {
    const { error } = await supabase.from('jobs').update(patch).eq('id', jobId)
    if (error) throw new Error(error.message)   // real error → surfaces (not queued)
  },
)
// outcome === 'ran'  → applied online
// outcome === 'queued' → offline; keep your optimistic UI, it syncs on reconnect
```

That's the whole change. The registered `job.update` handler replays
`supabase.from('jobs').update(payload.patch).eq('id', payload.id)` when the connection
returns.

## What it covers

One handler covers **every** jobs patch, so you never add a second handler:
- **Status changes** → `{ status }`
- **Completion** → `{ status:'completed', completed_at, actual_minutes }`
- **Scheduling / rescheduling** → `{ scheduled_date }` (and `start_time`, etc.)

## Rules

- **payload must be JSON-serializable** — ids, ISO date strings, numbers, `null`. (No
  File/Blob here — that's the photo path.)
- **Keep your optimistic update.** On `'queued'`, leave the optimistic state; the
  bottom-left OfflineStatus pill already tells the user "N will sync."
- **Only queue network failures.** `queueOrRun` queues when offline (or a `fetch`
  `TypeError`); a real validation/permission error still throws so you can surface it.
- **Don't** build a scheduling queue, don't import `lib/offline/handlers` or outbox
  internals, and don't register another `job.update` handler — it already exists.

## Guarantees you inherit (engine-level, already built)

- FIFO replay (oldest first), single-flight, and a **cross-tab Web Lock** so a queued op
  never applies twice even with several tabs open.
- A patch that fails on replay (5xx) stays queued and retries on the next flush.

If you introduce a mutation on a **different table** (not `jobs`), ping me and I'll add a
one-line handler for that `kind` in the shared registry — still one outbox, no new queue.

## Sending SMS/email from the scheduler — pass a `clientMessageId`

Your composer sends ([JobMessages.tsx](../src/components/schedule/JobMessages.tsx),
[RainDelayCenter.tsx](../src/components/schedule/RainDelayCenter.tsx)) `POST /api/comms/send`.
That route is now **idempotent**: add one field so a double-tap / retry / concurrent tab
can never fire the same SMS or email twice.

```ts
import { newClientMessageId } from '@/lib/comms/idempotency'

// generate ONE id per logical send (per click), reuse it on every retry of that send
const clientMessageId = newClientMessageId()
await fetch('/api/comms/send', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ customerId, template, channels, jobId, vars, clientMessageId }),
})
```

The server reserves the id atomically (`message_sends` PK) **before** dispatching; a second
request with the same id returns `{ deduped: true }` without sending. It's optional and
backward-compatible — without it the route behaves exactly as before. `schedule/page.tsx`'s
`job_complete` auto-send already dedupes via `dedupe:true`+`jobId`, so it needs no change.
Requires the `RUN-2026-07-07-message-idempotency.sql` migration.
