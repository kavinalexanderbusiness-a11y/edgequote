# Automatic service pricing and day-request plan

## Current evidence and release state

This branch does not seed, enable, deploy, or publish any automatic pricing.
The owner-approved mowing base prices are recorded in code as the proposed
starting version only: **$45 weekly, $55 biweekly, and $65 one time**.

The repository provides the evidence fields needed for a real pricing review:

- completed jobs: actual duration, crew size and price;
- work sessions and labour observations: worker minutes and labour minutes;
- job-linked expenses and categories;
- property measurement and coordinates;
- quote status, cadence, measured area, pricing version and acceptance history;
- immutable pricing versions and service-template cost fields;
- scheduled jobs, non-job schedule items, day blocks, crew capacity and route evidence.

A current production evidence export could not be completed from this worktree.
The deployment environment values available locally are redacted, so they are
not valid database credentials. The latest reviewed production-safe snapshot
showed no active automatic pricing version, automatic mowing disabled, and
incomplete or conflicting service-template cost bases. Those facts must be
re-queried before activation. No customer PII is included in this plan.

## Price formula

Each service has its own append-only owner-confirmed version. There are no
runtime price defaults.

```text
commercial price before rounding =
  cadence base price
  + ceil(max(0, measured sqft - base sqft) / 1,000) * size increment
  + max(0, measured areas - 1) * disconnected-area increment
  + verified difficult-property increment
  + verified route premium

route premium =
  max(0, allocated route km - included route km) * route customer rate/km
  + isolated-stop premium when verified nearby jobs are below the saved threshold

direct cost =
  loaded labour + materials + equipment + delivery + disposal
  + vehicle/km + allocated overhead

cost before payment fee = direct cost * (1 + contingency %)

margin-floor price =
  (cost before payment fee + fixed payment fee)
  / (1 - payment fee % - minimum contribution margin %)

automatic written estimate =
  round up(max(commercial price, margin-floor price), saved rounding increment)
```

Materials are package-rounded. The version must store each product's package
cost, package quantity, application quantity per 1,000 sq ft, waste allowance
and minimum packages. Missing inputs return their exact configuration gaps
instead of a price.

Calgary quadrant is descriptive metadata, not a rejection rule. A Northwest
property may receive base or premium pricing when verified route economics and
capacity pass. `out_of_route` is returned only when road distance, route premium
or required margin price exceeds an owner-confirmed automatic limit.

## Automatic decision contract

- `priced`: one server-authorized written estimate. The public response shows
  the price, cadence, measured area and `not_booked`. Internal cost and margin
  details remain in EdgeHQ.
- `review_required`: measurement, address, route, cost, margin, version or
  capacity evidence is incomplete or stale. The owner receives exact missing
  configuration codes; the customer sees a simple manual-review message.
- `out_of_route`: the verified route economics exceed the owner-approved
  automatic limits. This is not based on quadrant.

The decision requires:

1. a published service and active immutable owner pricing version;
2. a fresh server measurement from an accepted source and confidence tier;
3. Google place ID or owner-verified canonical address, coordinates and address components;
4. fresh road/base distance, allocated route kilometres and unique nearby EdgeHQ stops;
5. the current route-rule version;
6. an eligible EdgeHQ route day for mowing and snow;
7. full cost inputs and a contribution margin at or above the saved minimum;
8. a server-verified difficult-property multiplier when a surcharge is used.

## Service readiness

| Service | Current release posture | Evidence required before enablement |
| --- | --- | --- |
| Mowing | Proposed bases recorded; still disabled | Base-size threshold, increments, duration/crew bands, full costs, route limits, acceptance evidence |
| Fertilization | Manual review | Product, package size/cost, label rate, waste, labour, travel, equipment, overhead, fees, margin |
| Overseeding | Manual review | Seed product/rate/cost, equipment, labour, preparation scope, travel, overhead, fees, margin |
| Topsoil | Manual review | Supported depth/scope, soil volume conversion, package/bulk and delivery cost, labour, disposal, overhead, fees, margin |
| Weed treatment | Manual review | Product/application method, legal label rate, spot-vs-blanket scope, minimum visit cost, full cost and margin |
| Snow | Manual review | Separate owner authorization, snow route binding, trigger/service limits, visit/month/season economics and capacity |
| Trees, bushes, beds, custom landscaping | Not eligible | Current photos and a custom owner-reviewed quote |

## Day-only reservation

A customer may request a service day only after accepting a current automatic
written estimate and satisfying the existing deposit rule. EdgeHQ's existing
availability function checks minimum notice, booking window, owner work days,
day blocks, live jobs, non-job schedule items, duration, crew and travel buffer.

The new reservation creates:

- one `schedule_items` appointment with `start_time = NULL` so capacity is held
  and the request is visible in EdgeHQ; and
- one `automatic_quote_day_holds` record with `pending_owner_review` status.

It does not create a job, mark the quote scheduled, collect payment, promise an
arrival time or create a recurring series. Tentative hold hours are an explicit
owner setting from 1 to 168 hours. Expiry is a separate server call before the
availability check so the existing `STABLE` availability function sees the
updated capacity snapshot. The owner can confirm or cancel the request; a
confirmed hold still remains a non-job schedule item until the owner deliberately
converts it through the normal EdgeHQ workflow.

## Owner decisions blocking activation

For every service version, confirm:

- accepted measurement sources, confidence tiers and maximum age;
- base sqft, permitted cadences and base prices;
- price per additional 1,000 sq ft and per disconnected area;
- duration/crew bands from completed-job evidence;
- loaded owner/employee labour cost and payroll burden;
- every material package, rate, waste and minimum package;
- equipment, delivery, disposal, vehicle/km and overhead allocations;
- contingency, payment fees, contribution-margin floor and rounding;
- included route km, density threshold, isolated-stop premium and route customer rate/km;
- maximum automatic distance, route premium and automatic price;
- route-rule version and EdgeHQ route-day/capacity rules;
- tentative hold expiry hours;
- separate snow authorization and snow route binding.

## Integration and deployment order

1. Merge canonical Google address evidence first: place ID, components and coordinates.
2. Add server road-distance, route-density and eligible-day evidence using EdgeHQ.
3. Re-query production cost, duration, route and acceptance history without exporting PII.
4. Save disabled pricing versions and run historical shadow estimates against completed work.
5. Review errors, contribution margins and acceptance bands with the owner.
6. Enable one service version at a time; mowing first only after the gates pass.
7. Store the pricing/version/route metadata on the written quote atomically.
8. Enable day holds only after the public scheduling and hold-expiry settings are owner-confirmed.
9. Run the full migration, pricing, quote acceptance, capacity and portal test suites.
10. Show the owner the final release and obtain final review before deployment.
