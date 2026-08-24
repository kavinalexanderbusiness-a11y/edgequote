# Google sign-in — the configuration only a human can do

> ✅ **Configured and verified in production on 2026-08-23.** The provider is
> enabled and the live sweep passes 33/33. What follows is the record of what
> was set, and the runbook for re-doing it (new domain, new project, rotated
> secret) — not outstanding work.

Nothing in this repository can turn Google sign-in on: it needs an OAuth client
that belongs to the business, and a client secret that belongs in exactly one
place. With the two dashboards below unfilled, the button is present and every
attempt ends on the login screen saying the sign-in could not be completed —
which is the intended failure, not a bug.

> ⛔ **Never paste the client secret into a chat, a commit, an issue, a log,
> or a `.env` file.** It goes in one field, in the Supabase dashboard, and
> nowhere else. EdgeHQ's own code never reads it — Supabase holds it and
> performs the token exchange server-side.

---

## The two URLs everything hinges on

| what | value |
|---|---|
| Production app origin | `https://app.edgehq.ca` |
| Supabase project | `https://syhjarpnmpywatadhblu.supabase.co` |
| **Google → Authorized redirect URI** | `https://syhjarpnmpywatadhblu.supabase.co/auth/v1/callback` |
| **Supabase → Redirect allow list** | `https://app.edgehq.ca/auth/callback` |

⚠️ These are two *different* URLs and swapping them is the single most common
way this is misconfigured. Google redirects to **Supabase**; Supabase then
redirects to **EdgeHQ**. Google never sends the browser to `app.edgehq.ca`
directly, so `app.edgehq.ca` must not appear in Google's redirect field.

⛔ `app.edgepropertyservicesyyc.ca` is retired. It must not appear in either
dashboard. Every link EdgeHQ generates comes from `lib/appOrigin`, which reads
`NEXT_PUBLIC_APP_URL`; if that variable is wrong or carries an invisible BOM,
sign-in breaks the same way emailed links did on 2026-08-15.

---

## 1. Google Cloud console

1. Go to **console.cloud.google.com** → pick (or create) the EdgeHQ project.
2. **APIs & Services → OAuth consent screen**
   - User type: **External**.
   - App name: `EdgeHQ`. Support email: your own.
   - Authorized domains: `edgehq.ca` **and** `supabase.co`.
   - Scopes: add **`openid`**, **`.../auth/userinfo.email`**,
     **`.../auth/userinfo.profile`** — nothing else. EdgeHQ reads no Google
     data after sign-in, so any further scope is a permission asked for and
     never used.
   - While the app is in **Testing**, only accounts on the test-user list can
     sign in. For a private beta that is a feature, not a limitation — add
     each beta owner's Google address here. Publish only when the beta opens.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**
   - Application type: **Web application**.
   - Name: `EdgeHQ web`.
   - **Authorized JavaScript origins:** `https://app.edgehq.ca`
     (add `http://localhost:3000` if you want Google sign-in to work in local dev).
   - **Authorized redirect URIs:**
     `https://syhjarpnmpywatadhblu.supabase.co/auth/v1/callback`
   - Create. Google shows a **Client ID** and a **Client secret**.
   - Keep that tab open; the next step is where both go.

## 2. Supabase dashboard

1. **Authentication → Providers → Google** → enable it.
2. Paste the **Client ID** into *Client IDs*.
3. Paste the **Client secret** into *Client Secret (for OAuth)*.
   ⛔ This is the only field that secret ever goes in.
4. Save.
5. **Authentication → URL Configuration**
   - *Site URL*: `https://app.edgehq.ca`
   - *Redirect URLs* — add:
     - `https://app.edgehq.ca/auth/callback`
     - `http://localhost:3000/auth/callback` (local dev only)

## 3. Vercel

No new environment variable is required. Confirm the existing one is right —
a wrong origin here produces a redirect Supabase will refuse:

```
NEXT_PUBLIC_APP_URL = https://app.edgehq.ca
```

⚠️ Set it by typing, or verify it afterwards. Piping it in from PowerShell has
written an invisible UTF-8 BOM into this variable before. `lib/appOrigin`
sanitises what it can and `/api/health` reports when it had to, but a value
that looks correct in the dashboard and fails in production is exactly the
failure mode that cost a day in August.

`SUPABASE_SERVICE_ROLE_KEY` must already be set — it was needed for crew
invites, and binding a beta invite to a Google account uses it too. Without it
an invited owner signing up with Google gets "we couldn't reach the server",
never a wrong grant.

---

## How to tell it worked

In order, on production:

1. `https://app.edgehq.ca/login` shows **Sign in with Google** above the
   email/password form.
2. Clicking it lands on Google's own consent screen showing **EdgeHQ** and
   asking only for name/email.
3. Approving returns to `app.edgehq.ca` signed in.
4. Cancelling returns to `/login` reading *"Google sign-in was cancelled."*

If step 2 shows **redirect_uri_mismatch**, the URI in Google (§1.3) does not
exactly match the Supabase callback — check for a trailing slash or `http`
vs `https`.

If step 3 lands back on `/login` with *"could not be completed"*, the Supabase
redirect allow list (§2.5) is missing `https://app.edgehq.ca/auth/callback`.

---

## What Google sign-in still does not grant

Worth stating plainly, because "we turned on Google login" sounds like it
loosened something, and it did not:

- **A Google account cannot create a business.** Tenant creation is gated by
  `can_provision_business()`, which requires an owner record or a beta invite
  already redeemed by that exact `auth.uid()`. A brand-new Google user has
  neither, so `business_settings`' INSERT policy refuses them. They are signed
  out with an explanation rather than left stranded on a setup screen.
- **A Google account cannot make itself an employee.** Crew access lives in
  `technicians.auth_user_id`, written only by `crew_redeem_invite()` (a code
  the owner handed out) or the owner's own invite route.
- **An invited worker signing in with Google lands in Crew Mode with no extra
  setup**, because the owner's invite already created their account with a
  confirmed address, and Supabase attaches the Google identity to that same
  user. Someone signing in with a *different* Google account simply becomes a
  new account with no roster row — they reach the join screen, which demands a
  code.
- **Linking a second sign-in method to an existing account is not supported in
  V1.** `linkIdentity()` is never called; `verify:google-auth` fails the build
  if it appears.

`verify:google-auth` pins all of the above, and
`node scripts/mutate-google-auth.mjs` proves the guard can still fail (21
mutations, 21 caught).

---

## The one-command truth test

Before clicking anything, ask Supabase directly whether the provider is on:

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  'https://syhjarpnmpywatadhblu.supabase.co/auth/v1/authorize?provider=google'
```

- **302** → enabled. Follow the `Location` header: it should point at
  `accounts.google.com` with a `client_id` ending `.apps.googleusercontent.com`.
- **400** with `{"error":"validation_failed","error_description":"Unsupported provider: provider is not enabled"}`
  → the provider is off, or the Client ID field is wrong.

⚠️⚠️ **`supabase.auth.signInWithOAuth()` succeeding proves NOTHING.** It only
builds a URL locally and returns it — it never contacts Supabase, so it returns
a perfectly-formed URL for a provider that is disabled. This exact false
positive cost a debugging cycle on 2026-08-23, when the Client IDs field
contained an email address rather than the OAuth client ID. Always probe
`/auth/v1/authorize` over HTTP.

Full sweep (33 checks against the live project):

```bash
node scripts/googleauth-e2e.mjs https://app.edgehq.ca
```

## ⚠️⚠️ Keep the Redirect URLs allow list tight

Measured 2026-08-23: Supabase **does** carry a foreign `redirect_to` all the way
into Google's authorize URL. It does not validate at that step — the **allow
list is enforced when the provider returns**, and anything unlisted falls back
to Site URL.

That makes the allow list the actual control, so:

- ⛔ **No wildcard hosts.** `https://app.edgehq.ca/auth/callback` and the
  localhost entry are all that belong there.
- Removing a stale entry is a security change, not tidying.

EdgeHQ's own code never generates a foreign `redirect_to` — every one is
`appOrigin()` plus a `safeReturnPath`-validated path, and the E2E drives five
hostile `next` shapes through the start route to prove it. But that guarantee
covers links *we* produce; the allow list is what covers links anyone else
hand-crafts.
