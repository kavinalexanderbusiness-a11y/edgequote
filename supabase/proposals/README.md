# `supabase/proposals/` — designed, NOT applied

⛔ **Nothing in this directory is in the apply path.** It is not
`supabase/migrations/` (which IS applied) and it is not `supabase/archive/`
(which is applied history). `verify:migrations` reads neither of those rules
against this folder, and no tool here will ever run these files.

A file lands here when a session designs schema it is **not authorised to
apply** — the session builds everything that does not need the column, proves
it, and hands the smallest necessary addition to whoever owns landing.

## To adopt a proposal

1. Read the proposal's own header — it states what it is for and what it
   deliberately does *not* do.
2. ⭐ **Take the version at APPLY TIME from the LIVE ledger**, never from a
   number written in a file here. Copy to
   `supabase/migrations/<14-digit-timestamp>_<name>.sql` with a version that
   sorts **after** everything production has already applied.
3. Apply, re-capture the contract, and re-run `npm run verify`.
4. Delete the file from this directory — a proposal that has landed is history,
   and history lives in `supabase/archive/ledger/`.

## Open proposals

| file | from | what it unblocks |
|---|---|---|
| `route_pins_v1.sql` | Session 110 | durable route pins — "keep this stop in this position while optimizing the rest" — for visits **and** estimate appointments |
