import type { TradePack } from './types'

// ── The neutral pack — where every unknown lands ─────────────────────────────
// tradePack() returns this for any business_type it doesn't recognize, and it
// is itself pickable ("General field service") for the trades we haven't named
// yet. That makes the registry fail SAFE: a typo'd or future key degrades to a
// sensible generic setup, never to a crash and never to lawn copy.
//
// Everything here is deliberately trade-agnostic: no seasons (year-round until
// the owner says otherwise), a small honest catalogue an owner reshapes in
// minutes, and campaign presets that never name a season's work.

export const NEUTRAL_PACK: TradePack = {
  key: 'general',
  label: 'General field service',
  blurb: 'Not on the list? Start neutral and shape the catalogue yourself.',

  services: [
    { name: 'Service Call', category: 'Services', default_rate: 120, pricing_display_type: 'starting_from',
      default_description: 'On-site visit, diagnosis, and minor work completed on the spot.' },
    { name: 'Hourly Labour', category: 'Services', default_rate: 85, pricing_display_type: 'hourly',
      default_description: 'General labour billed by the hour for work quoted on site.' },
    { name: 'Standard Service Visit', category: 'Services', default_rate: 150, pricing_display_type: 'starting_from',
      default_description: 'A routine scheduled visit covering the usual scope of work.' },
    { name: 'Maintenance Visit', category: 'Maintenance', default_rate: 130, pricing_display_type: 'starting_from',
      default_description: 'Recurring upkeep on a schedule that suits the property.' },
    { name: 'Emergency Call-Out', category: 'Services', default_rate: 220, pricing_display_type: 'starting_from',
      default_description: 'Same-day response outside normal scheduling, priority dispatch.' },
  ],

  seasons: {},

  seasonalCampaigns: [
    {
      key: 'season_opening',
      label: 'Season opener',
      blurb: 'Fills the calendar before your busy season. Pick the date that starts yours.',
      month: 4, day: 1,
      subject: 'Booking for the season ahead',
      channels: ['email'],
      body: `Hi {{first_name}},

Our busy season is coming up and the calendar is filling in — if there's work you've been putting off, now is the easiest time to get it scheduled.

Reply to this message and we'll find you a spot.

Thank you!

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

As the year winds down, we just wanted to say thank you for trusting us with your home this year. It genuinely means a lot to a small local business.

Wishing you and your family a wonderful holiday.

— {{business_name}}`,
    },
  ],

  // Quick-add chips that fit any trade — surcharges and extras, not lawn work.
  // Every pack with `addons: []` falls back to this list. 'hauling' reuses the
  // founding key (same concept, BI continuity); 'custom' is required by the editor.
  addons: [
    { key: 'extra_work', label: 'Extra work' },
    { key: 'materials', label: 'Materials' },
    { key: 'hauling', label: 'Haul-away' },
    { key: 'travel_surcharge', label: 'Travel surcharge' },
    { key: 'custom', label: 'Custom' },
  ],
}
