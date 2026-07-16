import type { TradePack } from './types'

// ── The Lawn & Landscaping pack — EdgeQuote's founding trade ─────────────────
// VERBATIM data. The seasons (dates + match hints) are copied character-for-
// character from lib/seasons.ts, and the seasonal campaigns from
// lib/crm/campaigns.ts SEASONAL_TEMPLATES. They are COPIES on purpose: this
// module imports nothing, so the engines can never grow a dependency on it —
// and scripts/verify-trades.ts deep-equals every copied value against the live
// engine constants, so the copy cannot drift without failing CI.
//
// Existing lawn businesses never read this pack (they already have their own
// service_templates and service_seasons). It exists so a NEW lawn business is
// useful on day one.

export const LAWN_PACK: TradePack = {
  key: 'lawn_landscaping',
  label: 'Lawn & Landscaping',
  blurb: 'Mowing, cleanups, beds and snow — recurring outdoor work.',

  // Starter catalogue for a NEW lawn business (seed data, owner-edited after).
  // Shaped on the real catalogue the founding business runs: same category
  // names, customer-recognizable service names, Canadian rates.
  services: [
    { name: 'Lawn Mowing', category: 'Lawn Care', default_rate: 45, pricing_display_type: 'starting_from',
      default_description: 'Cut, string-trim and edge, with clippings blown off walks and drives.' },
    { name: 'Weekly Mowing', category: 'Lawn Care', default_rate: 40, pricing_display_type: 'starting_from',
      default_description: 'Season-long weekly cut on a set day, trimmed and edged every visit.' },
    { name: 'Bi-Weekly Mowing', category: 'Lawn Care', default_rate: 48, pricing_display_type: 'starting_from',
      default_description: 'Every-two-weeks cut for slower lawns, trimmed and edged every visit.' },
    { name: 'Fertilization', category: 'Lawn Care', default_rate: 65, pricing_display_type: 'starting_from_materials',
      default_description: 'Seasonal feeding matched to the lawn and time of year.' },
    { name: 'Core Aeration', category: 'Lawn Care', default_rate: 95, pricing_display_type: 'starting_from',
      default_description: 'Relieves compaction so water and nutrients reach the roots. Best in fall.' },
    { name: 'Overseeding', category: 'Lawn Care', default_rate: 85, pricing_display_type: 'starting_from_materials',
      default_description: 'Thickens thin or patchy turf. Pairs well with aeration.' },
    { name: 'Spring Cleanup', category: 'Cleanups', default_rate: 160, pricing_display_type: 'starting_from',
      default_description: 'Winter debris out, first cut, beds tidied — the season opener.' },
    { name: 'Fall Cleanup', category: 'Cleanups', default_rate: 190, pricing_display_type: 'starting_from',
      default_description: 'Leaves cleared, final cut, beds put to bed before the freeze.' },
    { name: 'Hedge & Shrub Trimming', category: 'Landscaping', default_rate: 70, pricing_display_type: 'hourly',
      default_description: 'Shaping and health pruning, with all trimmings hauled away.' },
    { name: 'Mulch Installation', category: 'Landscaping', default_rate: 130, pricing_display_type: 'starting_from_materials',
      default_description: 'Beds edged, weeded and dressed with fresh mulch.' },
    { name: 'Snow Clearing (Per Visit)', category: 'Winter Services', default_rate: 45, pricing_display_type: 'starting_from',
      default_description: 'Driveway and walks cleared after each snowfall, salt available on request.' },
    { name: 'Snow Clearing (Seasonal)', category: 'Winter Services', default_rate: 450, pricing_display_type: 'starting_from',
      default_description: 'One price for the whole winter — cleared every snowfall, no per-visit billing.' },
  ],

  // VERBATIM from lib/seasons.ts — DEFAULT_LAWN_SEASON, DEFAULT_SNOW_SEASON,
  // LAWN_HINTS, SNOW_HINTS. Golden-tested against the engine in CI.
  //
  // snow is declared BEFORE lawn on purpose: the engine's serviceCategory checks
  // SNOW_HINTS first, so on the (pathological) name matching both, snow wins.
  // Insertion order here IS the match precedence a consumer must honour.
  seasons: {
    snow: {
      label: 'Snow',
      match: ['snow', 'ice', 'plow', 'plough', 'salt', 'shovel'],
      startMonth: 11, startDay: 1, endMonth: 3, endDay: 31,
    },
    lawn: {
      label: 'Lawn',
      match: ['mow', 'lawn', 'fertiliz', 'fertilis', 'grass', 'aerat', 'trim', 'edge'],
      startMonth: 4, startDay: 15, endMonth: 10, endDay: 31,
    },
  },

  // VERBATIM from lib/crm/campaigns.ts SEASONAL_TEMPLATES — every string, date
  // and channel identical. CI deep-equals this array against that export.
  seasonalCampaigns: [
    {
      key: 'spring_cleanup',
      label: 'Spring cleanup',
      blurb: 'Books spring cleanups as the snow goes. Sends April 1.',
      month: 4, day: 1,
      subject: 'Booking spring cleanups now',
      channels: ['email'],
      body: `Hi {{first_name}},

Spring is here and we're booking cleanups now — winter debris, first cut, and a tidy edge to start the season right.

Reply to this message and we'll get you on the schedule before the rush.

Thank you!

— {{business_name}}`,
    },
    {
      key: 'summer_check',
      label: 'Mid-summer check-in',
      blurb: 'Catches heat-stress and upsells extras. Sends July 1.',
      month: 7, day: 1,
      subject: 'How’s the lawn holding up?',
      channels: ['email'],
      body: `Hi {{first_name}},

We're into the hot stretch of summer — the time of year lawns start to show stress.

If anything's looking dry, patchy, or overgrown, reply to this message and we'll take a look on our next visit.

— {{business_name}}`,
    },
    {
      key: 'fall_cleanup',
      label: 'Fall cleanup & aeration',
      blurb: 'The biggest seasonal earner. Sends September 15.',
      month: 9, day: 15,
      subject: 'Fall cleanup & aeration — booking now',
      channels: ['sms', 'email'],
      body: `Hi {{first_name}},

Leaf season is nearly here. We're booking fall cleanups and aeration now — aerating before the freeze is the single best thing you can do for next spring's lawn.

Reply to this message and we'll reserve a spot for you.

Thank you!

— {{business_name}}`,
    },
    {
      key: 'winter_prep',
      label: 'Winter / snow booking',
      blurb: 'Locks in snow customers before the first fall. Sends October 15.',
      month: 10, day: 15,
      subject: 'Booking snow clearing for this winter',
      channels: ['sms', 'email'],
      body: `Hi {{first_name}},

Before the first snow catches us all out — we're booking winter clearing now.

Spots are limited and go to existing customers first. Reply to this message if you'd like yours held.

— {{business_name}}`,
    },
    {
      key: 'holiday_thanks',
      label: 'Holiday thank-you',
      blurb: 'A warm, no-ask thank-you. Sends December 15.',
      month: 12, day: 15,
      subject: 'Thank you for a great year',
      channels: ['email'],
      body: `Hi {{first_name}},

As the year winds down, we just wanted to say thank you for trusting us with your property this season. It genuinely means a lot to a small local business.

Wishing you and your family a wonderful holiday.

— {{business_name}}`,
    },
  ],
}
