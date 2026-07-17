// ── Communications message templates ───────────────────────────────────────────
// Channel-agnostic copy with {{variables}}. Owners can override any template's
// wording in Settings (stored on business_settings.message_templates); when a
// type isn't overridden the professional default below is used. Rendering is pure
// (no I/O). **bold** markers render as <strong> in email and are stripped to plain
// text for SMS. SENDING lives in ./send and stays DISABLED until provider creds.

export type MsgType =
  | 'on_my_way' | 'running_late' | 'arrived' | 'job_complete' | 'thanks'
  | 'review_request' | 'reminder' | 'quote' | 'invoice'
  // Scheduler communication actions.
  | 'eta' | 'rain_delay' | 'rescheduled' | 'early_arrival' | 'confirm'
  // Follow-up / reminder templates.
  | 'estimate_reminder' | 'payment_reminder' | 'estimate_followup'
  // Payment receipt — auto-sent after a successful (AutoPay) payment.
  | 'receipt'
  // Booking confirmation — auto-sent to the CUSTOMER the moment they book online.
  // Transactional (it confirms a request they just made), not marketing.
  | 'booking_received'
  // CRM growth campaigns (lib/crm/campaigns — driven by /api/cron/campaigns).
  | 'birthday' | 'anniversary' | 'win_back' | 'marketing'
  // Asks a happy customer to refer a neighbour, and a seasonal service offer.
  // Both are CEMs — see msgCategory(), which files them under marketing/seasonal.
  | 'referral_request' | 'seasonal_offer'
  // The BULK review chase (the `review` campaign kind). Same words as
  // review_request, different consent meaning — see msgCategory().
  | 'review_chase'
  // Standard business announcement — introduction / new phone number.
  | 'introduction'
  // Free-form one-off message (the shared Send Message dialog's blank slate).
  | 'custom'

export const MSG_LABELS: Record<MsgType, string> = {
  on_my_way: 'On my way',
  running_late: 'Running late',
  arrived: 'Arrived',
  job_complete: 'Job complete',
  thanks: 'Thanks',
  review_request: 'Review request',
  reminder: 'Day-before reminder',
  quote: 'Send quote',
  invoice: 'Send invoice',
  eta: 'ETA / arrival window',
  rain_delay: 'Weather delay',
  rescheduled: 'Rescheduled',
  early_arrival: 'Finished early',
  confirm: 'Confirm visit',
  estimate_reminder: 'Estimate reminder',
  payment_reminder: 'Payment reminder',
  estimate_followup: 'Estimate follow-up',
  receipt: 'Payment receipt',
  booking_received: 'Booking confirmation',
  birthday: 'Birthday greeting',
  anniversary: 'Anniversary greeting',
  win_back: 'Win-back / re-engagement',
  marketing: 'Marketing check-in',
  referral_request: 'Referral request',
  seasonal_offer: 'Seasonal offer',
  review_chase: 'Review chase (campaign)',
  introduction: 'Introduction / new number',
  custom: 'Custom message',
}

// The variables a template may reference, with a short hint for the editor.
export const MSG_VARIABLES: { key: string; hint: string }[] = [
  { key: 'first_name', hint: "the customer's first name" },
  { key: 'business_name', hint: 'your company name' },
  { key: 'eta', hint: 'minutes (on-my-way / running-late / finished-early)' },
  { key: 'time_window', hint: 'estimated arrival window (ETA message)' },
  { key: 'date', hint: 'the visit / new date' },
  { key: 'old_date', hint: 'the original date (reschedule / rain delay)' },
  { key: 'address', hint: 'the property address' },
  { key: 'review_link', hint: 'your Google review link' },
  { key: 'portal_link', hint: 'their private portal link' },
  { key: 'quote_link', hint: 'link to the quote (portal)' },
  { key: 'invoice_link', hint: 'link to the invoice (portal)' },
  { key: 'amount', hint: 'invoice amount' },
  { key: 'confirmation_number', hint: 'their booking reference (booking confirmation)' },
  { key: 'direct_phone', hint: 'your business phone (Settings → Business Information)' },
]

// Professional, friendly defaults. **bold** → <strong> in email, stripped for SMS.
export const DEFAULT_TEMPLATES: Record<MsgType, string> = {
  confirm: `Hi {{first_name}},

Just confirming your scheduled service with {{business_name}} on **{{date}}**.

If you have any questions or need to make any changes before your appointment, simply reply to this message and we'll be happy to help.

Thank you—we look forward to seeing you!`,

  reminder: `Hi {{first_name}},

This is a friendly reminder that {{business_name}} is scheduled to service your property on **{{date}}**.

If anything changes before then, simply reply to this message.

We look forward to seeing you then!`,

  introduction: `Hi {{first_name}},

This is {{business_name}}.

Please save this number to your contacts. We'll send appointment reminders, scheduling updates, on-the-way notifications, weather delays, invoices, receipts, and other service updates from this number.

If you ever need to reach us directly, please call or text us at {{direct_phone}}.

Thank you for choosing {{business_name}}!`,

  eta: `Hi {{first_name}},

Your service with {{business_name}} is scheduled for **{{date}}**.

Our estimated arrival window is **{{time_window}}**.

If anything changes with our schedule, we'll keep you updated.

See you soon!`,

  on_my_way: `Hi {{first_name}},

I'm on my way to your property now and should arrive in approximately **{{eta}} minutes**.

See you soon!

— {{business_name}}`,

  running_late: `Hi {{first_name}},

This is {{business_name}} — I just wanted to let you know I'm running a little behind schedule today.

My updated arrival time is approximately **{{eta}} minutes**.

Thank you for your patience—I appreciate your understanding and I'll be there as soon as possible.

— {{business_name}}`,

  arrived: `Hi {{first_name}},

This is {{business_name}} — I've just arrived at your property and will be getting started shortly.

If there's anything you'd like me to know before I begin, just let me know.

Thanks!`,

  early_arrival: `Hi {{first_name}},

This is {{business_name}}. My schedule opened up earlier than expected today.

If it works for you, I can arrive earlier than originally planned.

Just reply to this message and let me know.`,

  rescheduled: `Hi {{first_name}},

Your service with {{business_name}} has been rescheduled to **{{date}}**.

If this new date doesn't work for you, simply reply to this message and we'll be happy to arrange another time.

Thank you for your understanding!

— {{business_name}}`,

  rain_delay: `Hi {{first_name}},

Due to the weather forecast and current conditions, we've had to adjust our schedule to ensure we can provide the highest quality service safely.

Your service has been rescheduled from **{{old_date}}** to **{{date}}**.

If the new date doesn't work for you, simply reply to this message and we'll be happy to arrange another time.

Thank you for your patience and understanding.

— {{business_name}}`,

  job_complete: `Hi {{first_name}},

Your service has now been completed.

Thank you for choosing {{business_name}}. We truly appreciate your business and look forward to helping you keep your property looking its best.

Have a great day!`,

  thanks: `Hi {{first_name}},

Thank you for choosing {{business_name}}.

We appreciate the opportunity to work with you and look forward to helping you again in the future.

Have a wonderful day!`,

  review_request: `Hi {{first_name}},

Thank you for choosing {{business_name}}!

If you were happy with your recent service, we'd really appreciate a quick review.

Your feedback helps our small business grow and helps other homeowners choose a company they can trust.

{{review_link}}

Thank you again—we truly appreciate your support!`,

  // The BULK chase (the `review` campaign). Deliberately NOT tied to a recent
  // visit — it sweeps up customers who never reviewed — which is exactly why
  // msgCategory files it as 'marketing' while review_request stays a service
  // message. Worded for someone whose last visit may be months ago.
  review_chase: `Hi {{first_name}},

We hope you've been happy with the work we've done on your property.

If you have a moment, a quick review would mean a lot — it's how most people find us, and it genuinely helps a small local business.

{{review_link}}

No worries at all if you'd rather not. Thank you either way!`,

  quote: `Hi {{first_name}},

Your quote from {{business_name}} is ready.

You can view and approve it anytime using the secure link below:

{{portal_link}}

If you have any questions about the quote, simply reply to this message and we'll be happy to help.`,

  invoice: `Hi {{first_name}},

Your invoice from {{business_name}} for {{amount}} is ready.

You can securely view and pay it anytime using the link below:

{{portal_link}}

Thank you for choosing {{business_name}}. We appreciate your business!`,

  estimate_reminder: `Hi {{first_name}},

This is a reminder from {{business_name}} about your upcoming estimate on **{{date}}**.

We look forward to meeting with you. If you need to reschedule, simply reply to this message.`,

  payment_reminder: `Hi {{first_name}},

This is a friendly reminder from {{business_name}} that your invoice is still outstanding.

You can securely view and pay it here:

{{invoice_link}}

If you've already made payment, please disregard this message. Thank you!

— {{business_name}}`,

  estimate_followup: `Hi {{first_name}},

Just checking in regarding the quote we recently sent.

If you have any questions or would like to discuss any part of it, we're happy to help.

Whenever you're ready, you can view and accept your quote here:

{{quote_link}}

Thank you for considering {{business_name}}.`,

  // Sent to the CUSTOMER the instant they book online. Until this existed the booking
  // funnel's only send went to the OWNER's inbox, so a homeowner who closed the tab was
  // left with nothing — no reference, no name, no number — after handing over their
  // address and photos. That is the shape of being ghosted, and it was thirty seconds
  // after the happiest moment in the funnel. Deliberately does NOT promise a price: the
  // booking captures an estimate, and the owner confirms the real number.
  booking_received: `Hi {{first_name}},

Thanks for booking with **{{business_name}}** — this is just so you have it in writing.

We've got your request for **{{address}}**, and your confirmation number is **{{confirmation_number}}**.

A real person here will review it and get in touch to confirm your price and pick a day that suits you — usually within one business day. Nothing is charged until you say yes.

Need us sooner, or want to change something? Call or text {{direct_phone}} and quote your confirmation number.

— {{business_name}}`,

  // NOTE: this template is sent by sendPaymentReceipt(), which knows the amount but NOT
  // the remaining balance — so it must not assert one. It used to say "paid in full"
  // unconditionally; if that's ever wrong it's the worst kind of wrong, because the
  // customer stops thinking about the bill and turns up overdue on money they were told
  // they didn't owe. receiptMessageBody() below takes balanceRemaining and CAN say it.
  receipt: `Hi {{first_name}},

Thank you — we've received your payment of {{amount}}.

Your receipt and up-to-date balance are always here:

{{portal_link}}

We appreciate your business!

— {{business_name}}`,

  birthday: `Hi {{first_name}},

Happy birthday from everyone at {{business_name}}!

We hope you have a wonderful day. Thank you for being a valued customer—we truly appreciate you.`,

  anniversary: `Hi {{first_name}},

We just wanted to say thank you. It's been a real pleasure looking after your property as a customer of {{business_name}}.

We appreciate your continued trust and look forward to many more seasons of keeping things looking their best.

If there's ever anything we can do for you, just reply to this message.`,

  win_back: `Hi {{first_name}},

It's been a little while, and we'd love to help keep your property looking its best again.

If you'd like to book a visit or have any questions, simply reply to this message—we're always happy to help.

Thank you, and we hope to see you again soon!

— {{business_name}}`,

  marketing: `Hi {{first_name}},

Just checking in from {{business_name}}.

If there's anything we can help with around your property this season, simply reply to this message and we'll take care of it.

Thank you for being a valued customer!`,

  referral_request: `Hi {{first_name}},

It's been a pleasure looking after your property, and we're glad you're happy with the work.

If you know a neighbour who could use a hand with theirs, we'd be grateful if you passed our name along. Most of our work comes from customers kind enough to do exactly that.

Just reply to this message and we'll take good care of them.

Thank you!

— {{business_name}}`,

  seasonal_offer: `Hi {{first_name}},

It's that time of year again, and we're booking visits now.

If you'd like us to take care of your property this season, simply reply to this message and we'll get you on the schedule.

Thank you for being a valued customer!

— {{business_name}}`,

  custom: `Hi {{first_name}},

`,
}

const SUBJECTS: Record<MsgType, string> = {
  on_my_way: 'On my way', running_late: 'Running a little behind', arrived: "We've arrived",
  job_complete: 'Your service is complete', thanks: 'Thank you!', review_request: 'How did we do?',
  reminder: 'Service reminder', quote: 'Your quote', invoice: 'Your invoice',
  eta: 'Your upcoming service', rain_delay: 'Weather reschedule', rescheduled: 'Your service has been rescheduled',
  early_arrival: 'We can come earlier today', confirm: 'Confirming your service',
  estimate_reminder: 'Your upcoming estimate', payment_reminder: 'Invoice reminder', estimate_followup: 'Following up on your quote',
  receipt: 'Payment received — thank you',
  booking_received: 'We’ve got your request',
  birthday: 'Happy birthday!', anniversary: 'Thank you', win_back: 'We’d love to see you again', marketing: 'A quick hello',
  referral_request: 'A small favour?', seasonal_offer: 'Booking now for the season',
  review_chase: 'Would you leave us a review?',
  introduction: 'Our new number — please save it',
  custom: '', // falsy → renderMessage falls back to "A message from {business}"
}

export interface MsgVars {
  firstName: string
  businessName: string
  eta?: string | number
  reviewLink?: string
  portalLink?: string
  quoteLink?: string
  invoiceLink?: string
  dateLabel?: string
  amount?: string
  timeWindow?: string
  oldDateLabel?: string
  address?: string
  directPhone?: string
  // The booking/quote reference a customer can quote back at us on the phone.
  confirmationNumber?: string
  // Email-shell branding — straight from Business Settings (logo_url / website).
  logoUrl?: string
  website?: string
  // CASL: a commercial message must identify the sender with a physical mailing
  // address and carry a working unsubscribe. Both are rendered by the email shell
  // for marketing/seasonal templates only — see renderBody.
  mailingAddress?: string
}

export interface RenderedMessage { sms: string; subject: string; html: string; text: string }

function interpolate(tpl: string, v: MsgVars): string {
  const sub: Record<string, string> = {
    first_name: (v.firstName || '').trim().split(/\s+/)[0] || 'there',
    business_name: v.businessName || 'your service provider',
    eta: String(v.eta ?? '15'),
    review_link: v.reviewLink || '',
    portal_link: v.portalLink || '',
    quote_link: v.quoteLink || v.portalLink || '',
    invoice_link: v.invoiceLink || v.portalLink || '',
    date: v.dateLabel || 'soon',
    old_date: v.oldDateLabel || 'your original date',
    time_window: v.timeWindow || 'your scheduled window',
    address: v.address || 'your property',
    // The VALUE, not a phrase. This token used to expand to " for $180" so that
    // `payment{{amount}}` degraded to `payment` when unset — but a fragment can
    // only be written into one sentence shape. Anywhere else ("your balance is
    // {{amount}}") it produced "your balance is  for $180". The connective now
    // lives in the template, where it is visible to whoever writes the sentence.
    amount: v.amount || '',
    confirmation_number: v.confirmationNumber || '',
    // Graceful when no business phone is set: "call or text us at this number".
    direct_phone: (v.directPhone || '').trim() || 'this number',
  }
  // Substitute, collapse runs of spaces/tabs (NOT newlines — paragraphs stay), trim.
  return tpl.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_m, key: string) => (key in sub ? sub[key] : '')).replace(/[ \t]{2,}/g, ' ').trim()
}

// Render an arbitrary body string (a default template OR owner-authored campaign
// copy) into the per-channel shapes. Interpolation, **bold** handling and the
// email wrapper are identical to renderMessage, so manual and automated sends
// look the same in the customer's thread/inbox.
export function renderBody(rawBody: string, vars: MsgVars, subject: string, template?: MsgType): RenderedMessage {
  const raw = interpolate(rawBody, vars)
  // SMS/plain: strip the **bold** markers. Email: render them as <strong>.
  const sms = raw.replace(/\*\*(.+?)\*\*/g, '$1')
  const htmlBody = raw
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    // Bare URLs (portal / quote / review links) become real, tappable links —
    // brand-toned, and break-anywhere so long tokens never overflow on phones.
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#0B8C68;font-weight:600;text-decoration:underline;word-break:break-all">$1</a>')
    .replace(/\n/g, '<br>')
  // One email shell for EVERY message the app sends (templates, owner-edited
  // sends, receipts): the business logo (when configured) above the business
  // name, a quiet centered card, and a contact footer — email-safe inline CSS
  // only. Branding values come straight from Business Settings, threaded in via
  // MsgVars by the server senders; nothing is duplicated here.
  const business = vars.businessName || 'Your service provider'
  const logo = (vars.logoUrl || '').trim()
  const header = `${logo ? `<img src="${logo}" alt="${business}" style="display:block;max-height:48px;max-width:220px;margin:0 0 8px" />\n    ` : ''}<p style="margin:0 0 12px;padding:0;font-size:17px;font-weight:700;letter-spacing:.01em;color:#1A2333">${business}</p>`
  const site = (vars.website || '').trim()
  const siteHref = site ? (site.startsWith('http') ? site : `https://${site}`) : ''
  const contactBits = [
    (vars.directPhone || '').trim(),
    site ? `<a href="${siteHref}" style="color:#5B6672;text-decoration:underline">${site.replace(/^https?:\/\//, '')}</a>` : '',
  ].filter(Boolean).join(' &nbsp;·&nbsp; ')
  // ── CASL: commercial messages carry identification + an unsubscribe ─────────
  // A message is commercial if msgCategory() says so — the SAME function the
  // consent gate (prefAllows → reach.ts) uses to decide whether it may be sent at
  // all. Driving both off one definition means a template can never be gated as
  // marketing while shipping without an unsubscribe, or vice versa.
  // The portal's Message preferences card IS the unsubscribe mechanism; the
  // senders mint the token (cron/campaigns does this for every CEM), so the link
  // stays valid well past the 60 days CASL s.6(2)(c) requires.
  const cat = template ? msgCategory(template) : null
  const isCem = cat === 'marketing' || cat === 'seasonal'
  const portal = (vars.portalLink || '').trim()
  const mailing = (vars.mailingAddress || '').trim()
  const casl = !isCem ? '' : `
    <p style="margin:10px 0 0;padding:0 6px;font-size:11px;line-height:1.5;color:#8A94A0">
      You're receiving this because you're a customer of ${business}.${mailing ? ` ${mailing}` : ''}
      ${portal ? `<br><a href="${portal}" style="color:#5B6672;text-decoration:underline">Unsubscribe or choose which messages you get</a>` : ''}
    </p>`
  const footer = `${contactBits ? `<p style="margin:12px 0 0;padding:0 6px;font-size:12px;line-height:1.5;color:#8A94A0">${business} &nbsp;·&nbsp; ${contactBits}</p>` : ''}
    <p style="margin:${contactBits ? '4px' : '12px'} 0 0;padding:0 6px;font-size:12px;line-height:1.5;color:#8A94A0">Reply directly to this email if you have any questions.</p>${casl}`
  const html = `<div style="background:#F4F6F5;padding:24px 12px;font-family:system-ui,'Segoe UI',Arial,sans-serif">
  <div style="max-width:560px;margin:0 auto">
    <div style="padding:0 6px">${header}</div>
    <div style="background:#FFFFFF;border:1px solid #E4E8E6;border-top:3px solid #0B8C68;border-radius:12px;padding:24px 26px;font-size:15px;line-height:1.65;color:#1A2333">${htmlBody}</div>
    ${footer}
  </div>
</div>`
  return { sms, subject, html, text: sms }
}

// Resolve the owner's custom template (if any) else the default, and fill it in.
// `subjectOverride` lets a caller that owns its own subject line (a campaign with
// an owner-written subject) reuse this resolver instead of re-implementing the
// custom-vs-default merge; blank/absent falls back to the type's stock subject.
export function renderMessage(
  type: MsgType,
  custom: Partial<Record<MsgType, string>> | null | undefined,
  vars: MsgVars,
  subjectOverride?: string | null,
): RenderedMessage {
  const tpl = (custom && custom[type] && custom[type]!.trim()) ? custom[type]! : DEFAULT_TEMPLATES[type]
  const subject = subjectOverride?.trim()
    || SUBJECTS[type]
    || `A message from ${vars.businessName || 'your service provider'}`
  return renderBody(tpl, vars, subject, type)
}

// Does this template legally require an unsubscribe + sender identification?
// Exported so a SENDER can guarantee it supplies the portal link a CEM's footer
// needs, rather than discovering at render time that it can't be built.
export function isCommercialMessage(type: MsgType): boolean {
  const cat = msgCategory(type)
  return cat === 'marketing' || cat === 'seasonal'
}

// A payment-receipt body with the REAL numbers (invoice #, receipt #, method,
// amount, balance remaining) — sent as a bodyOverride through the ONE comms
// pipeline, so a partial payment never claims "paid in full". {{first_name}},
// {{business_name}} and {{portal_link}} stay as placeholders for the server.
export function receiptMessageBody(p: {
  invoiceNumber: string; receiptNumber: string; amountPaid: string; methodLabel: string; balanceRemaining: string | null
}): string {
  const balanceLine = p.balanceRemaining
    ? `Your remaining balance is **${p.balanceRemaining}**.`
    : 'This invoice is now **paid in full**.'
  return `Hi {{first_name}},

Thank you — we've received your payment of **${p.amountPaid}** (${p.methodLabel}) on invoice ${p.invoiceNumber}.

Receipt ${p.receiptNumber}. ${balanceLine}

View your invoices and payment history anytime:

{{portal_link}}

We appreciate your business!

— {{business_name}}`
}

// ── Message categories (granular consent) ─────────────────────────────────────
// The customer-facing grouping every template falls into. Customers opt in/out
// per CATEGORY (customers.message_prefs jsonb) on the website funnel + portal;
// the ONE dispatch engine (lib/comms/dispatch) enforces it. A missing key means
// "inherit the channel opt-in" — so existing customers behave exactly as before.
export type MsgCategory = 'reminders' | 'invoices' | 'estimates' | 'marketing' | 'seasonal'
export type MessagePrefs = Partial<Record<MsgCategory, boolean>>

export const MSG_CATEGORY_LABELS: Record<MsgCategory, string> = {
  reminders: 'Appointment & service updates',
  invoices: 'Invoices & payments',
  estimates: 'Estimates & quotes',
  marketing: 'Offers & news',
  seasonal: 'Seasonal reminders',
}

// EVERY MsgType is listed explicitly and there is deliberately NO `default:`.
// A default would silently file any new template under 'reminders' — a service
// category no marketing opt-out gates — so a new campaign type could blast
// customers who opted OUT of marketing. Without the default, TypeScript fails
// the build on an unhandled MsgType and forces the choice to be made here.
export function msgCategory(t: MsgType): MsgCategory | null {
  switch (t) {
    case 'invoice': case 'payment_reminder': case 'receipt': return 'invoices'
    case 'quote': case 'estimate_reminder': case 'estimate_followup': return 'estimates'
    // review_chase is the BULK campaign sweep — a list-segmented solicitation
    // asking customers to publicly promote the business, sent with no visit
    // attached. That is a CEM, so it rides the marketing preference. Its twin
    // review_request stays 'reminders' below: that one follows a visit the
    // customer booked, which is what makes it a service message. Same words,
    // different consent — which is precisely why they're separate MsgTypes.
    case 'marketing': case 'introduction': case 'win_back': case 'referral_request':
    case 'review_chase':
      return 'marketing'
    case 'birthday': case 'anniversary': case 'seasonal_offer': return 'seasonal'
    case 'custom': return null // owner-composed one-offs are always deliverable
    // Transactional: it confirms a request the customer just made of us, so it isn't a
    // marketing category they can be opted out of. Channel opt-in still gates the SMS.
    case 'booking_received': return null
    // Service-timing messages: tied to a visit the customer booked, so they ride
    // the channel opt-in rather than the marketing preference.
    case 'on_my_way': case 'running_late': case 'arrived': case 'job_complete':
    case 'thanks': case 'review_request': case 'reminder': case 'eta':
    case 'rain_delay': case 'rescheduled': case 'early_arrival': case 'confirm':
      return 'reminders'
  }
}

// Does this customer's preference set allow this template? Unknown templates and
// null prefs always pass (backward compatible; channel opt-in still gates).
export function prefAllows(prefs: MessagePrefs | null | undefined, template: string): boolean {
  if (!prefs || !(template in MSG_LABELS)) return true
  const cat = msgCategory(template as MsgType)
  return !cat || prefs[cat] !== false
}

// ── Composer display transform for the portal-link token ─────────────────────
// The editable composers show a FRIENDLY placeholder instead of the raw
// {{portal_link}} token; on send it converts back so the server (the only place
// that knows the customer's token) injects the real URL. One pair, both
// composers — never a second rendering engine.
export const PORTAL_LINK_DISPLAY = '[Customer Portal Link]'
export function toDisplayBody(s: string): string {
  return s.replace(/\{\{\s*portal_link\s*\}\}/g, PORTAL_LINK_DISPLAY)
}
export function fromDisplayBody(s: string): string {
  return s.split(PORTAL_LINK_DISPLAY).join('{{portal_link}}')
}
