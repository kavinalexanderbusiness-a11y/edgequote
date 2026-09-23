# Native contact reconciliation

EdgeHQ already has one canonical customer identity rule in `src/lib/customers.ts`:
match a complete phone number before email/address and never merge on name alone.
It does not have, and should not pretend to have, permission to edit Apple Contacts
from its Vercel runtime.

For an authorized local Messages audit, use the local-only reconciler:

```sh
pnpm contacts:reconcile -- --first Janine --phone '+1 403-473-5107' --lifecycle lead
pnpm contacts:reconcile -- --first Janine --phone '+1 403-473-5107' --lifecycle lead --apply
```

The first command is a dry run. The second applies the reviewed result. The tool:

- keys idempotently on the normalized 10-digit phone number;
- creates only when no card matches, updates only when exactly one matches, and
  fails closed if duplicate cards or conflicting verified names exist;
- preserves every field except the two structured name fields it owns;
- renders `First (Lead)` until a verified surname is supplied, then
  `First Last (Lead)` on the same card;
- never demotes `(Client)` to `(Lead)`;
- requires both `--lifecycle client` and `--verified-active-client` for promotion;
- sends nothing over the network and never prints names or phone numbers.

This is the safe handoff point for future message-audit automation. The audit must
first verify the phone and first name from the actual conversation. A surname stays
blank until verified. Active/accepted work evidence must be checked before a Client
promotion. EdgeHQ customer creation remains in its existing phone-first dedup seam;
the native label is local presentation metadata and is not copied into customer names.
