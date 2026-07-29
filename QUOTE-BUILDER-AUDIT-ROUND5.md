# Quote Builder audit — round 5: merge status, and what is still live on `main`

> **SUPERSEDED 2026-07-26.** `deploy/main-2026-07-16` has since merged to main
> (`67c5897`); the rounds 1–4 fixes and `QUOTE-BUILDER-UX-AUDIT.md` are now on
> `origin/main`. The merge-status analysis below describes a pre-merge state —
> kept for the audit trail only.

**Date:** 2026-07-26 · **Method:** read-only, against **immutable git objects** (`git show <ref>:<path>`),
not the working tree — see §0 for why that distinction mattered this round.
**Companion:** `QUOTE-BUILDER-UX-AUDIT.md` (rounds 1–4), now on `main` (merged via `67c5897`).
This file is standalone on purpose: it had zero conflict surface with the rebase described below.

---

## §0 · Why this round found no new code to change

Two things were true when this round started, and both are load-bearing:

1. **A rebase of `deploy/main-2026-07-16` onto `origin/main` is in flight in the shared working
   tree**, stopped on a conflict in `src/components/ui/Modal.tsx`. `.git/rebase-merge/head-name`
   is that branch; progress was **5 of 12** commits replayed. The tree is in detached HEAD with
   an unmerged index entry.
2. Because of (1), **the working tree is a partially-applied moving target.** An early pass of
   this audit read the tree directly and produced a *wrong* answer — it reported some of rounds
   1–4 as present on main, because those commits had already been replayed into the tree but not
   into `main`. Everything below was therefore re-derived from `git show origin/main:…`, which
   cannot move under you.

**Consequence:** no code was changed this round. Editing `QuoteBuilder.tsx` while twelve commits
touching that same file are mid-replay would add conflict burden to someone else's in-flight
work, and committing into a detached HEAD would strand it. The correct action is to **finish the
rebase**, not to open a third front on the same file.

---

## §1 · What is live on `origin/main` right now

`origin/main` = **`73466dd`**. Verified marker counts in `src/components/quotes/QuoteBuilder.tsx`
(`0` = the fix is absent from main):

| Fix (round) | Marker | main | `deploy/main-2026-07-16` |
|---|---|---|---|
| TDZ crash (1) | `temporal dead zone` | **0** | 1 |
| Price into fast path (1) | `FieldGroup` | **0** | 7 |
| Blocked-submit feedback (1) | `PRICING_DETAIL_FIELDS` | **0** | 2 |
| "Applied" vs service change (2) | `markApplied` | **0** | 7 |
| Service chips (2) | `serviceChips` | **0** | 2 |
| Typed address preserved (3) | `autoFilledAddress` | **0** | 5 |
| Typed notes preserved (3) | `autoFilledNotes` | **0** | 3 |

### 1.1 The crash is still in `main` ⚠️

```
origin/main:src/components/quotes/QuoteBuilder.tsx
135:  const kindAt = (i: number) => watchedServices?.[i]?.kind ?? 'service'
136:  const serviceIdx  = indexedLines.filter(({ i }) => kindAt(i) !== 'material')
137:  const materialIdx = indexedLines.filter(({ i }) => kindAt(i) === 'material')
…
249:  const watchedServices = watch('services')
```

Unchanged from the day it was found: the filters call `kindAt` synchronously, `kindAt` reaches a
`const` still in its temporal dead zone, and with **one** additional line it throws
`ReferenceError: Cannot access 'watchedServices' before initialization`. Tapping **Add service**
or **Add material**, or opening any saved multi-line quote to edit, blanks the builder on `main`.

**It is fixed on `deploy/main-2026-07-16` and that fix is one of the twelve commits currently
being replayed.** Nobody should fix it a second time — landing the rebase is what ships it.

### 1.2 Still unguarded on main: the two silent overwrites

```
origin/main:364-370   picking a customer → setValue('address', full)      // unconditional
origin/main:418       changing service   → setValue('notes', t.default_description)  // unconditional
```

Type a service address, then pick the existing customer → replaced by their home address. Write
a scope of work, then change the service → replaced by the template's canned text. Both silent,
both still live.

---

## §2 · An independent audit reached two of the same conclusions

`main` is not simply "the old file". It carries a **parallel** Quote Builder UX pass (merged as
PR #60, branch `qb/ux3-2026-07-21`) that never saw rounds 1–4 — and it independently arrived at
**two of the same fixes**:

```
origin/main:54    onSubmit: (values: QuoteFormValues) => Promise<void | boolean>
origin/main:162   const submit = handleSubmit(async v => { const ok = await onSubmit(v); if (ok !== false) autosave.clear() })
origin/main:632   if ((Number(v.initial_price) || 0) > 0) setPriceOrigin('manual')     // on draft restore
```

That is round 4's *"a failed save must not delete the draft"* and round 2's *"a restored price is
the owner's decision"*, discovered separately and expressed almost identically.

**Why this matters:** two independent passes converging on the same two defects is evidence the
defect *class* is real and not an artifact of one reviewer's taste. It also means the rebase will
find these two already satisfied on main — those hunks should be resolved in favour of **either**
version (they are equivalent), and the remaining five fixes applied on top.

---

## §3 · New this round: the `quote:new` draft is a single slot

```
key: autosaveKey || (isEdit ? 'quote:edit' : 'quote:new')
```

The edit page passes a precise key (`quote:${id}`), so saved quotes are isolated. **Every
unsaved new quote shares one key.** The consequence is a real, silent loss:

1. Start a quote for Jane — address, service, price typed. Navigate away without saving. The
   draft lives at `eq:autosave:quote:new`.
2. Later, open **New Quote** for Bob. The banner offers Jane's draft — correct so far.
3. Ignore the banner and start typing Bob's details. The autosave effect fires on the first
   edit, `setDraft(null)` dismisses the prompt, and the next debounced write **overwrites Jane's
   draft with Bob's**.

Jane's work is gone, with no prompt and no undo, because the owner did the most natural thing
available: started the next quote. One abandoned new-quote draft can exist at a time, and
beginning another destroys it.

**Not fixed here** — it needs a key *strategy*, not a one-liner (a per-tab id, a
`quote:new:${customerId}` once a customer is chosen, or a short list of recoverable drafts), and
that choice interacts with the same hook used by customers, jobs and invoices. Ready to design;
worth doing before the next round of builder work.

**A smaller sibling, noted not fixed:** opening `/dashboard/quotes/new?customer=…` auto-fills
name, address and measured area, which trips the autosave and writes a draft for content the
owner never typed. Harmless today (the draft holds exactly what the prefill would rebuild), but
it is why "you have an unsaved quote" can appear after a visit in which nothing was typed.

---

## §4 · Ready for the Pricing V2 lane (carried forward, unchanged)

From round 4 §20–§21, still accurate and still deliberately untouched — every remaining item in
the overwrite class is a **pricing input**, which is exactly what the freeze reserves:

1. **A per-quote labour-rate override is lost when the service changes.** The field's own hint
   invites the override (*"Change it here for this quote only"*); picking a different hourly
   template silently reverts it to that template's default.
2. **A hand-entered travel fee is lost when the address is re-picked.** `onSelect` →
   `calculateDistance` → re-applies the tier fee whenever travel is being charged. Set $25, fix
   a typo in the address, and you are back to the tier's $15 with no notice.
3. **`includeTravel` starts `true` on a quote that charges no travel**, so editing a quote whose
   travel was deliberately absorbed shows *"Charging travel fee"* over a $0 fee. The one-line fix
   also changes whether a later **Calculate distance** re-applies a fee — same call as (2).
4. **The crew-cost default is duplicated**: the builder hand-rolls `… > 0 ? … : 40` while
   `lib/economics` exports `DEFAULT_CREW_COST = 40` and `crewCostPerHour()` (what `QuoteMeasure`
   uses). Identical today; a copy that will not follow the constant.
5. **Editing a quote overwrites `overgrowth_multiplier` to 1** — and must keep doing so until a
   base rate is stored separately, because `rate` is persisted already-multiplied. Do not "fix"
   this without the schema change.

All five have known fixes of a few lines each. None should be applied outside the Pricing V2 lane.

---

## §5 · What to do next, in order

1. **Finish the rebase** in the shared tree (resolve `src/components/ui/Modal.tsx`, continue the
   remaining 7 of 12 commits) and land `deploy/main-2026-07-16`. That is what ships the crash fix
   and the two overwrite fixes. Nothing else in this file matters until it does.
2. Where the rebase conflicts on the two fixes main already has (§2), either side is correct —
   they are equivalent. Keep one.
3. Re-run the marker table in §1 against `origin/main` afterwards; every row should read non-zero.
4. Then decide on the `quote:new` key strategy (§3).
5. Pricing V2 lane picks up §4 whenever it opens.
