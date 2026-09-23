# Edge route economics and automatic-pricing configuration

## Release posture

This is an owner-review candidate for the fail-closed engine in commit
`aaecbc91`. It does not activate, seed, deploy, or publish prices. Every number
below is labelled as verified repository evidence, an owner-approved price, or a
planning assumption. `enabled` and `full_cost_basis_confirmed` must remain
`false` until the missing production inputs are verified.

Existing accepted 2026 customer prices are preserved. This configuration is for
new estimates only. Northwest Calgary is not rejected by quadrant: route density,
allocated road travel, capacity, and contribution margin determine whether a
request receives a base price, a travel premium, or manual review. Landscaping
projects may cover wider Calgary and surrounding areas when a manual quote fully
prices travel and all other costs.

## Evidence available now

| Input | Evidence | Status |
| --- | --- | --- |
| Mowing bases | Owner approved $45 weekly, $55 biweekly, $65 one time | Approved proposed prices |
| General service minimum | Operating record says $65; recurring mowing bases are an explicit exception | Historical operating rule |
| Labour | Repository `business_settings.crew_cost_per_hour` default is $40; older operating record says $20/hour pay | $40 is a loaded planning proxy, not verified live cost |
| Vehicle | 2026 CRA reasonable allowance is $0.73/km for the first 5,000 km; the July 2026 CRA Alberta travel rate is $0.59/km | External proxy, not Edge's actual truck cost |
| Mowing size slope | Repository default is $15 per additional 1,000 sq ft | Repository default, not verified production setting |
| Route density | Repository defines dense as at least 3 other stops within 2 km or density score at least 60 | Supported repository rule |
| Capacity | Repository default is 8 labour-hours/day and public scheduling checks both serial route minutes and person-minutes | Default only; not current availability |
| Payment fees | Repository default recovery percentage is 3% | Variable rate only; processor fixed fee is unverified |
| Margin | Dated working framework is 35-45% | Planning range, not a universal rule |
| Duration evidence | 35 of 77 completed visits were timed, across 17 properties; only 5 properties had at least 3 timings; only 2 measurement rows existed in the measured snapshot | Too sparse for activation |

Official proxy sources:

- [CRA 2026 automobile allowance rates](https://www.canada.ca/en/department-finance/news/2026/01/government-announces-the-2026-automobile-deduction-limits-and-expense-benefit-rates-for-businesses.html)
- [CRA Alberta kilometric rate effective July 1, 2026](https://www.canada.ca/en/revenue-agency/corporate/about-canada-revenue-agency-cra/travel-directive/appendix-a-cra-kilometric-rates-july-2026.html)

## Disabled mowing version candidate

The following is the exact shadow-test candidate. Values marked **assumption**
are intentionally not activation-ready.

| Pricing rule key | Candidate | Basis |
| --- | ---: | --- |
| `enabled` | `false` | Required release posture |
| `full_cost_basis_confirmed` | `false` | Live cost audit incomplete |
| `permitted_cadences` | `weekly`, `biweekly` | One-time condition/overgrowth cannot yet be verified automatically |
| `base_prices.weekly` | $45 | Owner approved |
| `base_prices.biweekly` | $55 | Owner approved |
| `base_prices.one_time` | $65, recorded but not permitted yet | Owner approved |
| `base_lawn_sqft` | 1,000 sq ft | Assumption aligned with repository Calgary $35-$45 small-lawn band |
| `additional_price_per_1000_sqft` | $15 | Repository default; shadow-test before use |
| `additional_area_price` | $5 | Assumption for each disconnected lawn after the first |
| `duration_crew_bands` | <=1,000: 27 min; <=2,000: 33 min; <=3,500: 43 min; <=5,000: 53 min; open-ended: 75 min; crew 1 | Repository generic `20 + sqft/150`, rounded at band ceilings; replace with actual medians |
| `loaded_labour_cost_per_hour` | $40 | Repository loaded-cost default; verify owner/payroll burden |
| `materials` | `[]` | No mowing material by default |
| `materials_cost_basis_confirmed` | `true` only if mowing has no consumable material | Owner must confirm |
| `equipment_cost_per_visit` | $3 | Assumption; verify mower/trimmer/blower fuel, wear, repairs, and depreciation |
| `delivery_cost_per_visit` | $0 | Only if no delivery applies |
| `disposal_cost_per_visit` | $0 | Only for mulch/leave-clippings scope; haul-away requires review |
| `overhead_cost_per_visit` | $2 | Assumption; verify insurance, software, phone, storage, and admin allocation |
| `contingency_percent` | 10% | Planning assumption |
| `vehicle_cost_per_km` | $1.73/km shadow proxy | $0.73/km vehicle proxy + $1.00/km travel labour at assumed 40 km/h and $40/hour |
| `included_route_km` | 2 km allocated travel | Assumption consistent with a dense 2 km cluster |
| `route_price_per_additional_km` | $3.25/km | Covers the $1.73/km proxy, 10% contingency, 3% fee, and 35% margin |
| `minimum_nearby_jobs_for_base` | 3 within 2 km | Supported repository density threshold |
| `isolated_stop_premium` | $10 | Assumption for a route-breaking stop even inside included km |
| `maximum_automatic_distance_km` | 20 km road distance from the saved base | Assumption; manual review beyond this, not automatic rejection |
| `maximum_route_premium` | $35 | Assumption; larger detours need owner review |
| `maximum_automatic_price` | $150 per mowing visit | Assumption; larger/complex lawns need manual review |
| `payment_fee_percent` | 3% | Repository default; verify processor contract |
| `payment_fee_fixed` | unknown | Must be verified; do not substitute $0.30 without processor evidence |
| `minimum_margin_percent` | 35% | Bottom of the dated 35-45% planning range |
| `price_rounding_increment` | $5 | Customer-facing pricing convention |
| `maximum_measurement_age_minutes` | 60 | Assumption; remeasure/recheck before showing price |
| accepted measurement confidence | `high` only | Fail closed on ambiguous geometry |
| accepted measurement source | exact server source identifier only | Must match the production City-data implementation; browser text is never evidence |
| `route_rule_version` | new immutable version at activation | Must match server route evidence exactly |

### Why the $45 dense-route base can work only under narrow conditions

Using the shadow candidate for a 1,000 sq ft weekly stop with one allocated route
kilometre:

```text
on-site labour       27/60 * $40 = $18.00
equipment                         $ 3.00
overhead                          $ 2.00
travel + vehicle     1 km * $1.73 = $ 1.73
direct cost                       $24.73
10% contingency                  +$ 2.47
3% + $0.30 fee on $45            +$ 1.65
total cost                        $28.85
profit                            $16.15
contribution margin                 35.9%
```

This does not prove those cost inputs are true. It shows the exact operational
conditions the $45 base requires. If the real visit is longer than 27 minutes,
the allocated travel is greater, or equipment/overhead is higher, the margin
floor raises the price or returns review-required. The one-time $65 value should
remain recorded but unavailable to the automatic path until current condition or
overgrowth can be verified server-side.

## Route rules

1. Resolve and reverify the canonical address on the server. Browser address,
   quadrant, coordinates, and route hints are transport data only.
2. Calculate road distance from the saved Edge base, the allocated detour for
   this stop, unique nearby stops within 2 km, and eligible EdgeHQ route days.
3. Base pricing requires at least 3 unique nearby stops and no more than 2 km of
   allocated route travel. Otherwise add $10 for an isolated stop plus $3.25 for
   every allocated kilometre over 2 km.
4. Recompute the full margin-floor price with the entire allocated route cost.
   Commercial surcharges never override the margin gate.
5. Return `review_required` for stale/ambiguous route evidence or no eligible
   route day. Return `out_of_route` only when verified economics exceed the saved
   20 km, $35 premium, or $150 automatic-price limit.
6. Quadrant is metadata. An NW request may price when the same economics pass.
7. Landscaping/project services use a manual quote anywhere practical:

```text
required project price = round up to $5(
  (loaded on-site labour + loaded travel labour + materials + equipment
   + delivery + disposal + vehicle + allocated overhead) * (1 + contingency)
  + fixed payment fee
) / (1 - payment fee percent - minimum margin percent)
```

No project quote may omit the travel time or return-trip kilometres.

## Capacity and day-only reservation

The repository's 8-hour default is not verified availability and must not be
treated as a public promise. The recommended operating configuration is:

- set global `daily_capacity_hours` to **6.0 sellable labour-hours** only after
  the owner confirms that this is a real full workday;
- use `day_statuses` start/end and crew overrides for each school weekday;
- expose only owner-approved `preferred_work_days`; an unconfigured day has no
  public availability;
- set the public `travel_buffer_minutes_per_visit` to **15 minutes** for a dense
  mowing route as a shadow-test candidate, then replace it with the observed
  median incremental drive/setup time;
- reserve at least **60 minutes per route day** for loading, fueling, disposal,
  delays, and route variance by setting sellable capacity below physical hours;
- block days without a verified after-school window rather than assuming morning
  availability;
- calculate both serial route minutes and person-minutes; never use stop count
  alone.

With 6 sellable hours, a 27-minute small-lawn visit and 15-minute route/setup
buffer has a theoretical ceiling of 8 stops (`floor(360 / 42)`). That is a
planning ceiling, not a promised schedule. Any unknown duration, crew, route
buffer, blocked day, non-job schedule item, or capacity read returns no date.

The current day-hold architecture in `aaecbc91` already creates a day-only
`schedule_items` hold with no start time and `pending_owner_review`; it does not
create a job, promise an arrival time, collect payment, or mark work complete.

## Material services and snow

Fertilization, overseeding, topsoil, and weed treatment must stay manual until
each product version has all of the following current values:

- SKU/product and legal label/application method;
- package cost and package quantity;
- application quantity per 1,000 sq ft;
- package rounding, waste percentage, and minimum packages;
- service-specific duration/crew bands;
- equipment, delivery, disposal, travel, overhead, contingency, and payment fee;
- measured-lawn accuracy and accepted price history.

The engine must return the exact missing configuration instead of a price. Spot
weed treatment should have a separately supported minimum-visit rule rather than
using a blanket lawn rate.

Snow remains disabled until the owner approves an immutable snow route version,
snowfall trigger, service limits, included areas, ice-melt/chipping policy,
monthly/seasonal visit assumptions, extra-visit price, equipment/salt cost,
weather capacity, and cancellation terms. The route can be dense anywhere in
Calgary; there is no NW ban.

## Production evidence still required

Activation is blocked until a read-only production audit verifies:

1. current `business_settings`, public scheduling rules, day overrides, crews,
   preferred days, base coordinates, and current route-rule version;
2. actual truck fuel, maintenance, tires, insurance, registration, depreciation,
   financing, and business kilometres, producing an Edge-specific cost/km;
3. actual travel minutes and road kilometres per route, so vehicle and travel
   labour can be separated instead of using the $1.73/km proxy;
4. payment processor percentage and fixed fee by payment channel;
5. owner labour, employee wage, payroll burden, and workers' compensation costs;
6. equipment purchase/service/fuel data and a per-visit allocation;
7. overhead ledger and a defensible visit/hour allocation;
8. timed completed mowing visits joined to measured lawn area, cadence, crew,
   disconnected areas, slope/gates, route travel, and price;
9. quote acceptance/decline history by size, cadence, route tier, and price;
10. current material receipts, package sizes, application rates, waste, delivery,
    and disposal for every material service;
11. explicit snow scope and route economics.

## Wiring into `aaecbc91`

- Save the reviewed values as one append-only row through
  `save_automatic_service_pricing_version`; the migration validates every key.
- `src/lib/automaticServicePricingServer.ts` maps the JSON rule keys to the pure
  engine and must receive fresh server-produced measurement and route evidence.
- `src/lib/automaticServicePricing.ts` applies the commercial formula, complete
  cost and margin floor, distance/premium/price ceilings, and fail-closed gaps.
- The canonical-address integration must supply `provider`, `placeId`, city,
  province, country, coordinates, `checkedAt`, road/base distance, allocated
  route travel, unique nearby stops, eligible route days, and rule version.
- The quote writer must store pricing/version/rules hash, measurement source,
  route rule, idempotency key, and written-estimate state atomically.
- `public_quote_schedule_availability` reads EdgeHQ capacity, blocks, live jobs,
  schedule items, crew, duration, and configured per-visit buffer.
- `reserve_automatic_quote_day` creates only the reviewable day hold after a
  current accepted automatic written estimate.

Before activation, run historical shadow estimates, compare predicted to actual
cost and duration, review the exceptions with the owner, and create a new
immutable version rather than editing the candidate.
