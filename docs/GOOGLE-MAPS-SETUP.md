# Google Maps configuration — EdgeHQ

Written 2026-08-23 (Session 107), after production carried **two unrelated Maps
faults at once, on two different keys**. Each one's symptom hid the other's, so
the first rule is:

> ⚠️ EdgeHQ uses **TWO** Google API keys. They fail independently, they are fixed
> independently, and neither fix helps the other.

Run the diagnostic before believing anything in this file is still true:

```
node scripts/maps-diagnose.mjs https://app.edgehq.ca --server
node scripts/maps-diagnose.mjs https://edgehq.ca
```

It reads the key the site *actually ships* (NEXT_PUBLIC_* is inlined at build
time, so a value in a `.env` file the deploy wasn't built with proves nothing),
loads a real map at a real origin, and reports Google's own words.

---

## The two keys

| | `NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY` | `GOOGLE_MAPS_API_KEY` |
|---|---|---|
| Where it runs | The browser | The server only |
| Visible to users | **Yes, by design** — it ships in the JS bundle | No. Never expose it |
| Protected by | HTTP referrer restrictions + a narrow API list | Never leaving the server |
| Used for | The Maps JavaScript API: every map, and `geometry` (the polygon area engine) | Geocoding, Distance Matrix, Directions, Places (New) |
| Breaks | Maps show Google's grey "Oops!" panel | `/api/geocode`, `/api/distance`, `/api/route`, `/api/places/*` |
| Applied by | **A redeploy** (build-time inlined) | A redeploy (Vercel env vars apply to new deployments) |

A browser key is *supposed* to be public. Its security is entirely the referrer
allowlist plus the short API list — not secrecy. Never put a server key, service
account, or any secret in client code.

---

## Which APIs must be enabled

Only what the code actually calls:

**Browser key** — `Maps JavaScript API`. That is all.
The loader requests `libraries=geometry` and nothing else. It used to also ask for
`places`, which was dead weight: address autocomplete has gone through
`/api/places/*` on the *server* key since `lib/places.ts` landed. Dropping it
means the browser key needs no Places entitlement at all.

**Server key** — `Geocoding API`, `Distance Matrix API`, `Directions API`,
`Places API (New)`.

Restrict the browser key to *Maps JavaScript API* under **API restrictions**. An
unrestricted browser key is a billable resource anyone can copy out of the bundle
and use.

---

## Referrer allowlist (browser key)

**Both of these serve the CRM.** Verified 2026-08-23: `edgehq.ca` and
`app.edgehq.ca` each answer `/dashboard/*` with their own `307 → /login`, so a
signed-in owner can be on either.

```
https://app.edgehq.ca/*
https://edgehq.ca/*
```

- ⛔ Do **not** re-add `app.edgepropertyservicesyyc.ca` — that host is retired.
- ⛔ Do **not** add `www.edgehq.ca` — it does not resolve.
- ⛔ Never use `*` or a bare `*.vercel.app` on the production key. A wildcard on a
  billable key means anyone can point a page at it.

Restrictions take effect within a minute or two and need **no redeploy** — they
live on the key, not in the bundle. (Changing the key's *value* does need a
redeploy, because it is inlined at build time.)

### Previews and local development

Preview deploys and `localhost` are not on the production key's allowlist, and
should not be. Use a **second, development-only key**, restricted to:

```
http://localhost:3000/*
https://*-kavinalexanderbusiness-a11y.vercel.app/*
```

Put that key in Vercel's **Preview** and **Development** environments under the
same variable name, and leave Production pointing at the restricted production
key. That way a leaked preview key cannot spend against the production project,
and nobody is ever tempted to loosen the real one to unblock a branch.

---

## Current status (2026-08-23, measured)

| Check | Result |
|---|---|
| Browser key present in the shipped bundle | ✅ |
| `https://app.edgehq.ca` authorised | ✅ (fixed by the owner during Session 107) |
| `https://edgehq.ca` authorised | ✅ (same) |
| `geometry` library loads, `spherical.computeArea` present | ✅ — polygon area maths is healthy |
| **`GOOGLE_MAPS_API_KEY` (server)** | ❌ **EXPIRED** |

### ❌ Outstanding owner action — the server key is expired

Google's exact words, from production:

```
/api/geocode            → 422  {"error":"Google: REQUEST_DENIED — The provided API key is expired. "}
/api/distance           → 422  {"error":"Google: REQUEST_DENIED — The provided API key is expired. "}
/api/places/autocomplete→ 502  {"error":"autocomplete failed","suggestions":[]}
```

**What is broken right now, in production:** address autocomplete everywhere
(quote builder, properties, settings, the public booking funnel), travel-distance
and travel-fee calculation, route optimisation — and Measure & Price cannot centre
the map on a property, because it geocodes the address to find it.

**Fix:**

1. Google Cloud Console → **APIs & Services → Credentials**.
2. Find the server key (the one **without** referrer restrictions). If it shows an
   expiry, either extend it or **create a replacement key**.
3. Restrict the replacement under **API restrictions** to: Geocoding API,
   Distance Matrix API, Directions API, Places API (New).
   Under **Application restrictions** choose **None** — this key is called from
   the server, so it has no referrer, and an IP restriction is impractical on
   Vercel's shifting egress addresses. Its protection is that it never leaves the
   server.
4. Vercel → project **kavinalexanderbusiness-a11y-edgequote** → Settings →
   Environment Variables → set `GOOGLE_MAPS_API_KEY` for **Production**.
5. **Redeploy.**
6. Re-run `node scripts/maps-diagnose.mjs https://app.edgehq.ca --server` and
   expect three ✓.

Also confirm billing is enabled on the project and that the key belongs to the
project the billing account is attached to — a key from a different project fails
the same way for a completely different reason.

---

## Reading the failures

| Google says | Meaning | Fix |
|---|---|---|
| `RefererNotAllowedMapError` | This origin is not in the browser key's allowlist. The message names the exact URL. | Add that origin as `https://host/*` |
| `ApiNotActivatedMapError` | Maps JavaScript API not enabled on the project | Enable it |
| `InvalidKeyMapError` | The key does not exist / was deleted | Reissue, redeploy |
| `BillingNotEnabledMapError` | No billing on the project | Enable billing |
| `REQUEST_DENIED — expired` | The **server** key expired | Replace it (above) |
| `REQUEST_DENIED — referer restrictions` | A *browser* key was put in `GOOGLE_MAPS_API_KEY` | Use an unrestricted server key |

### Why the app used to sit on a broken map forever

An auth refusal is **not** a load failure. The script tag returns 200,
`importLibrary` attaches, and the `Map` constructor *succeeds* — so
`loadGoogleMaps()` resolved and every component believed it had a map. Google
reports the refusal out of band, by calling `window.gm_authFailure`, and nothing
was listening.

`lib/googleMaps.ts` now installs that hook **before** injecting the script,
remembers the refusal even when it arrives long after the promise resolved, and
lets surfaces `onMapsUnavailable(...)` subscribe. Every map renders
`<MapUnavailable>` *instead of* the map div — never over it.

⚠️ `<MapUnavailable audience="customer">` (the public booking funnel) shows one
neutral sentence and **never** the diagnostic detail: a stranger must not be told
this business's API key is misconfigured, nor be shown the origin or project.
Owner-facing surfaces get the detail, collapsed.
