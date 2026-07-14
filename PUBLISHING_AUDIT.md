# Social Publishing — Audit (direct auto-publish)

_Scope requested: direct auto-publish (real OAuth + provider `publish()` to Meta/GBP/etc.); symptoms "published but nothing appears" + silent failures. Date: 2026-06-28._

## Verdict

**Direct auto-publish does not exist.** The publishing layer is a well-structured *stub*: every provider is `planned`/`unavailable`, the OAuth callback never exchanges tokens, and no code path ever calls a real platform API. Selecting a "connected" account and clicking **Publish now** silently falls back to manual copy/open. Separately, a post can be marked **`published` with nothing actually posted** because the piece status is set on the owner's say-so without proof. Both reported symptoms are explained — and neither is a flaky bug; they're the predictable result of an unbuilt integration presented as if it were live.

## Live evidence (production)

| Object | State | Meaning |
|---|---|---|
| `social_connections` (1 row) | `platform=facebook`, **`mode=manual`**, `status=connected`, account_url = `/profile.php?id=…` | The "connected" account is **manual**, and is a **personal profile** (not a Page). `api_connections = 0`. |
| `publish_jobs` (1 row) | **`status=queued`, `mode=manual`**, 0 attempts, no `external_post_id`, no error | The post was enqueued as manual and is sitting "ready to copy" — **nothing was sent to any API**. |
| `content_pieces` | 7 total, **1 `status=published`** | A piece is labelled *published* while no job reached `published` and no external post id exists → "published but nothing appears." |

## Root cause — four layers, all stubbed

1. **No provider is live.** [`providers.ts`](website-int/src/lib/marketing/providers.ts): facebook/instagram/gbp/linkedin/threads are all `apiStatus:'planned'`; nextdoor is `'unavailable'`. A `planned` provider's `publish()` **throws** `ProviderError('api_unavailable')`.
2. **`effectiveMode` can only return `'manual'`.** It returns `'api'` only when `apiStatus==='available'` — which is never true. So even an `api`-mode connection is downgraded to manual.
3. **The OAuth round-trip is a no-op.** [`connect/callback`](website-int/src/app/api/marketing/connect/callback/route.ts) validates CSRF state and then **returns `connect=pending`** — it never exchanges the `code` for tokens and never inserts an `api`-mode connection. (Comment: *"Not yet wired → pending."*)
4. **The dispatch is never reached.** In [`publishQueue.processJobNow`](website-int/src/lib/marketing/publishQueue.ts), `mode==='manual'` short-circuits to "queued + copy/open" before `dispatchPublish`. The real publish branch is dead code in practice.

## How that produces the exact symptoms

- **"Published but nothing appears."** [`PublishPanel`](website-int/src/components/grow/marketing/PublishPanel.tsx) → manual path copies the caption, `window.open`s the platform, then the owner clicks **Mark as posted** → `markManualPublished` sets the **piece + job to `published` with no proof** (no external URL required). If the owner clicks it without actually pasting (easy to do — it looks like it published), the piece reads *Published* while the platform has nothing. Picking the "connected" Facebook account behaves **identically to Copy & paste** — the account selection is cosmetic.
- **Silent failures.** Because the API branch is never taken, the owner never sees "auto-publish isn't available." The system quietly degrades to manual; a post that the owner believed would auto-post just sits `queued`. The one error that *would* surface (`api_unavailable`) is unreachable.

## Why this isn't a one-line fix

Real direct auto-publish requires, **per platform**, things that are not code I can simply switch on:

- **A registered OAuth app** (Meta App ID/secret, Google client, …) → env vars.
- **Platform App Review + Business Verification.** Meta gates `pages_manage_posts` and `instagram_content_publish` behind App Review — a multi-week business/legal process, not a deploy.
- **A Facebook *Page* (+ linked Instagram Business account).** Personal profiles (like the one currently connected) **cannot** be published to by any API.
- **Code per provider:** token exchange in the callback, token refresh, a real `publish()` (e.g. Meta Graph: create a photo/feed post), and flipping `apiStatus`→`available` (env-gated).

The scaffolding is genuinely good — provider interface, idempotency key, per-account rate limits, the OAuth seam — but the integration and the approvals are absent.

## Remediation

### A. Stop the dishonesty now (no approvals needed — recommended immediately)
1. **Never mark a piece `published` without proof.** For manual completion, require the owner to confirm they posted (and ideally paste the post URL); reconcile `content_pieces.status` to the job so the two can't diverge. A piece is only "Published" when a job is `published`.
2. **Tell the truth about "connected" accounts.** With no `available` provider, a connection is *manual-only*. Label it that way and make selecting it clearly behave as "copy & open" — or hide API "Connect" until a provider is live. Make the `connect=pending` redirect say so plainly.
3. **Warn on personal profiles.** A Facebook profile (`/profile.php?…`) can never auto-publish — surface that at connect time so the owner links a Page instead.
4. **Surface job state**: "Queued — not posted yet" vs "Posted ✓ (view)", never implying auto-posting happened.

### B. Build one real integration (gated on you)
**Meta first** — one Meta app covers **Facebook Pages + Instagram Business** (the two highest-value channels). Once you register the app and complete App Review, I implement: callback token exchange → store `access_token`/page id → Graph `publish()` → env-gated `apiStatus:'available'` → token refresh. GBP/LinkedIn/Threads follow the same pattern, each behind its own app + approval.

## Recommended next step

Ship **A (1–4)** now so the Studio stops reporting posts as published when they aren't — that alone removes the "published but nothing appears" class of failure. In parallel, if you want true auto-publish, start a **Meta app registration**; I'll wire the integration against it. Nextdoor has no public posting API and stays manual permanently.
