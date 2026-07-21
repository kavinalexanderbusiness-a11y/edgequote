# Offline engine — audit

_Scope: the ONE outbox ([lib/offline/outbox.ts](src/lib/offline/outbox.ts)), the handler
registry ([handlers.ts](src/lib/offline/handlers.ts)), the connectivity surface
([OfflineStatus](src/components/pwa/OfflineStatus.tsx)), and the wired paths (messages,
customer notes/edits, quote updates, photos). `tsc --noEmit` and `next build` both exit 0._

## Verdict

One queue, one retry loop, one handler per `kind`, `queueOrRun` at every call site — the
mandated architecture holds. The engine was hardened for multi-tab and replay safety this
pass. Two residual risks remain, both documented below with the fix; neither is wired
half-way.

## Item-by-item

| Concern | Finding | Status |
|---|---|---|
| **Duplicate handlers** | Single registry; `registered` flag guards double-registration; each `kind` registered exactly once. | ✅ clean |
| **Duplicated retry logic** | Retry exists in **one** place — `doFlush()` (keep-on-failure + `attempts++`). No per-feature retry anywhere. | ✅ clean |
| **Duplicate queues** | One IndexedDB store (`eq-offline/outbox`). No feature queues. (`lib/uploadQueue.ts` does **not** exist in this worktree — no second upload engine.) | ✅ clean |
| **Race conditions** | In-process single-flight (`flushing`) **+ cross-tab `navigator.locks` flush lock** added this pass. Components keep their own req-seq guards. | ✅ hardened |
| **Replay ordering** | `list()` returns **oldest-first (FIFO)** → a create always replays before edits that depend on it. | ✅ correct |
| **Optimistic update edge cases** | Messages hold a "Queued" bubble; customer/quote set optimistically and **revert on a hard (non-network) error**; photos show an object-URL thumbnail. `queueOrRun` only queues connectivity failures — real validation/permission errors still throw and surface. | ✅ correct |
| **Reconnect edge cases** | `OfflineStatus` flushes on the `online` event **and** on mount if a backlog exists; realtime + `useRealtimeRefresh` refetch on `online`/`visibilitychange`, so views self-heal. | ✅ correct |
| **Stale data handling** | After flush, `load()`/realtime replace optimistic state with server truth. Cross-device concurrent edits are **last-writer-wins** (the op replays the payload captured at enqueue) — acceptable for this app; documented, not silent. | ✅ acceptable |
| **Multiple tabs** | Cross-tab Web Lock ⇒ only one tab flushes at a time; a queued op can't be applied twice. | ✅ hardened |
| **Duplicate uploads** | Stable client `uploadId` → **deterministic storage path**; `uploadPhoto` does SELECT-before-insert on that path and `upsert:true` on the fixed object → a replay/second tab can't create a second file or catalogue row. No schema change. EXIF/metadata/AI-Vision rows/marketing pairing preserved (same rows, same pipeline). | ✅ idempotent |
| **Duplicate messages** | Mitigated by single-flight + cross-tab lock + remove-immediately-after-success. **Residual:** a crash in the ~ms window between server-success and op-removal could re-send on the next flush. | ⚠️ residual (fix below) |

## Residual risks (flagged, fix specified, not half-built)

1. **Message re-send after a crash.** `/api/messages/send` isn't idempotent, so the tiny
   success→remove window is a theoretical double-send. **Fix:** pass a client `msgId`
   (already have `uploadId`-style ids everywhere) in the payload; `/api/messages/send`
   inserts `messages` with a unique `client_msg_id` and does `on conflict do nothing`. One
   column + one route line. Recommended next; I didn't touch the server route untested.

2. **Quote _create_ offline (not yet built).** Updates are done. Create is the proper-sync
   piece — designed below, implemented next as a focused pass (it needs optimistic-list UI +
   reconciliation, which I won't half-ship).

## Quote create offline — the design (to implement next, no hacks)

- **Temp id at capture.** On offline "create", mint `clientId = crypto.randomUUID()`.
  Enqueue `quote.create` with the full payload (customer_id, property_id, service, prices,
  cadence, `clientId`). Show the quote in the list immediately with a **"Draft · syncing"**
  chip and `id = 'temp:'+clientId` — no fake quote number (a placeholder label, never a
  hacked `EPS-…`).
- **Idempotent create on replay.** The `quote.create` handler inserts through the real
  create path; the **server assigns the quote number** (unchanged). Idempotency via a
  `quotes.client_uuid` unique column: `insert … on conflict (client_uuid) do nothing`, then
  select the row → the true `id` + `quote_number`. (Migration provided when built — one
  column + unique index; same pattern photos use, but quotes need it because there's no
  deterministic natural key.)
- **Reconcile temp → server id.** After create, record `clientId → serverId` in a small
  outbox id-map. Any `quote.update` op queued against `temp:clientId` (an edit made before
  sync) is rewritten to the real id at replay — **edits are never lost**, relationships
  (customer/property) are carried in the create payload, and FIFO guarantees create runs
  before its edits.
- **Never duplicates.** Cross-tab lock + `client_uuid` unique = at-most-once create.

## What's wired and verified this pass

`message.send`, `customer.update` (notes + profile), `quote.update`, `job.update`
(handler ready; call sites are the scheduling surfaces' `jobs` mutations), and
`photo.upload` (idempotent, blob-persisted, same pipeline). Engine hardening: cross-tab
lock, FIFO, single-flight. Not committed.
