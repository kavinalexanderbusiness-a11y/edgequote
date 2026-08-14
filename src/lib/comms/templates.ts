// ── Communications message templates ───────────────────────────────────────────
// Channel-agnostic copy with {{variables}}. Owners can override any template's
// wording in Settings (stored on business_settings.message_templates); when a
// type isn't overridden the professional default below is used. Rendering is pure
// (no I/O). **bold** markers render as <strong> in email and are stripped to plain
// text for SMS. SENDING lives in ./send and stays DISABLED until provider creds.

export type MsgType =
  | 'on_my_way' | 'running_late' | 'arrived' | 'job_complete' | 'thanks'
  | 'review_request' | 'reminder' | 'quote' | 'invoice'
  // Upfront deposit asked for BEFORE the work — a partial payment of an existing
  // invoice, so it is an invoice-category (transactional) message. Deliberately
  // NOT the 'invoice' template: that one says "your invoice for {{amount}} is
  // ready", which would name the deposit as the whole bill.
  | 'deposit_request'
  // Extra scope priced AFTER the original approval, sent for the customer's
  // decision. Its own template because none of the others can say the one thing
  // that matters: this is an ADDITION, the original approval is untouched, and
  // nothing is authorised until they answer. msgCategory files it under
  // 'estimates' — it is a quote for extra work, not a bill for it.
  | 'change_order'
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
  deposit_request: 'Request deposit',
  change_order: 'Approve extra work',
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
  confirm: `Hi {{first_name}}, confirming your booking with {{business_name}} on **{{date}}**.

Need to change anything? Just reply. See you then!`,

  reminder: `Hi {{first_name}}, a reminder that {{business_name}} is booked for **{{date}}** at {{address}}.

If anything changes, just reply. See you then!`,

  introduction: `Hi {{first_name}}, this is {{business_name}} — please save this number.

We'll use it for reminders, arrival updates, invoices and receipts. You can call or text us here any time on {{direct_phone}}.

Thanks for choosing us!`,

  eta: `Hi {{first_name}}, {{business_name}} here. We're booked for **{{date}}**, arriving between **{{time_window}}**.

We'll let you know if anything changes. See you then!`,

  on_my_way: `Hi {{first_name}},

I'm on my way to your property now and should arrive in approximately **{{eta}} minutes**.

See you soon!

— {{business_name}}`,

  running_late: `Hi {{first_name}}, {{business_name}} here — running a little behind today. We should be with you in about **{{eta}} minutes**.

Thanks for your patience!`,

  arrived: `Hi {{first_name}}, this is {{business_name}} — we've arrived and are getting started.

If there's anything we should know first, just reply.`,

  early_arrival: `Hi {{first_name}},

This is {{business_name}}. My schedule opened up earlier than expected today.

If it works for you, I can arrive earlier than originally planned.

Just reply to this message and let me know.`,

  rescheduled: `Hi {{first_name}}, your visit from {{business_name}} has moved to **{{date}}**.

If that doesn't suit, just reply and we'll find another time.`,

  rain_delay: `Hi {{first_name}}, the weather has forced {{business_name}} to move your visit from **{{old_date}}** to **{{date}}**.

If that doesn't suit, just reply and we'll find another time. Thanks for your patience!`,

  job_complete: `Hi {{first_name}}, we've finished up at {{address}} — thanks for choosing {{business_name}}.

Anything not right? Just reply and we'll sort it out.`,

  thanks: `Hi {{first_name}},

Thank you for choosing {{business_name}}.

We appreciate the opportunity to work with you and look forward to helping you again in the future.

Have a wonderful day!`,

  review_request: `Hi {{first_name}}, thanks for choosing {{business_name}}!

If you were happy with the work, a quick review would mean a lot to a small business:
{{review_link}}

Thank you!`,

  // The BULK chase (the `review` campaign). Deliberately NOT tied to a recent
  // visit — it sweeps up customers who never reviewed — which is exactly why
  // msgCategory files it as 'marketing' while review_request stays a service
  // message. Worded for someone whose last visit may be months ago.
  review_chase: `Hi {{first_name}},

We hope you've been happy with the work we've done on your property.

If you have a moment, a quick review would mean a lot — it's how most people find us, and it genuinely helps a small local business.

{{review_link}}

No worries at all if you'd rather not. Thank you either way!`,

  // "for {{address}}" mirrors the invoice template's "for {{amount}}" below — the same
  // idiom, and it is what tells six quotes apart. A landlord with six properties got six
  // byte-identical "Your quote is ready" messages and had to open every link to find the
  // one they cared about. `address` was already a registered variable and already
  // threaded through SendMessageDialog and the scheduled-message cron; only the quote
  // template never asked for it. Degrades to "your property" when unset (templates.ts's
  // resolver), which reads correctly rather than leaving a dangling "for ".
  quote: `Hi {{first_name}}, your quote from {{business_name}} for {{address}} is ready.

View and approve it here:
{{portal_link}}

Questions? Just reply.`,

  invoice: `Hi {{first_name}}, your invoice from {{business_name}} for {{amount}} is ready.

View and pay it securely here:
{{portal_link}}

Thanks for your business!`,

  // The deposit ASK. {{amount}} is the deposit, not the invoice total — the words
  // have to say so, or the customer reads their $1,500 deposit as the whole job.
  // The portal link shows the full invoice (total, deposit paid, what's left), so
  // the message stays short and the complete picture is one tap away.
  deposit_request: `Hi {{first_name}}, thanks for choosing {{business_name}}! To get you booked in we ask for a deposit of **{{amount}}**.

Pay it securely here:
{{portal_link}}

The balance is due once the work is done. Questions? Just reply.`,

  // The ASK for extra work. Two things must survive any owner's edit of this
  // template, which is why they are also written into changeOrderMessageBody()
  // (the override every send actually uses): the original approval is UNCHANGED,
  // and nothing is authorised until they answer. A message that only names a new
  // number reads as a price rise on work they already agreed.
  change_order: `Hi {{first_name}}, we've priced some extra work on your job with {{business_name}}: **{{amount}}**.

This is in addition to what you already approved — that stays exactly as it was, and nothing goes ahead until you say so.

Approve or decline here:
{{portal_link}}

Questions? Just reply.`,

  estimate_reminder: `Hi {{first_name}},

This is a reminder from {{business_name}} about your upcoming estimate on **{{date}}**.

We look forward to meeting with you. If you need to reschedule, simply reply to this message.`,

  // {{amount}} is what is ACTUALLY collectable right now: its only sender
  // (api/cron/invoice-reminders) fills it from depositChargeAmount(), never a raw
  // invoice total. It already computed that figure — this template simply never
  // printed it, so the reminder asked for money without naming the sum.
  // ⚠️ The token is inline in the sentence, so it must always be supplied. It is:
  // the cron always passes it, MessageTemplateEditor's preview passes a sample,
  // and payment_reminder is deliberately not in SendMessageDialog's DEFAULT_SET.
  // A future caller that adds it there must pass `amount` too.
  payment_reminder: `Hi {{first_name}}, a reminder from {{business_name}} — {{amount}} is still outstanding on your invoice.

View and pay it here:
{{invoice_link}}

Already paid? Please ignore this. Thank you!`,

  estimate_followup: `Hi {{first_name}}, just checking in on the quote we sent you.

Happy to answer anything, or you can approve it here whenever you're ready:
{{quote_link}}

Thanks for considering {{business_name}}.`,

  // Sent to the CUSTOMER the instant they book online. Until this existed the booking
  // funnel's only send went to the OWNER's inbox, so a homeowner who closed the tab was
  // left with nothing — no reference, no name, no number — after handing over their
  // address and photos. That is the shape of being ghosted, and it was thirty seconds
  // after the happiest moment in the funnel. Deliberately does NOT promise a price: the
  // booking captures an estimate, and the owner confirms the real number.
  booking_received: `Hi {{first_name}}, thanks for booking with **{{business_name}}**.

We've got your request for **{{address}}** — your confirmation number is **{{confirmation_number}}**.

We'll be in touch within one business day to confirm your price and pick a day. Nothing is charged until you say yes.

To change anything, call or text {{direct_phone}} and quote that number.`,

  // NOTE: this template is sent by sendPaymentReceipt(), which knows the amount but NOT
  // the remaining balance — so it must not assert one. It used to say "paid in full"
  // unconditionally; if that's ever wrong it's the worst kind of wrong, because the
  // customer stops thinking about the bill and turns up overdue on money they were told
  // they didn't owe. receiptMessageBody() below takes balanceRemaining and CAN say it.
  receipt: `Hi {{first_name}}, thanks — {{business_name}} has received your payment of {{amount}}.

Your receipt and current balance:
{{portal_link}}`,

  birthday: `Hi {{first_name}},

Happy birthday from everyone at {{business_name}}!

We hope you have a wonderful day. Thank you for being a valued customer—we truly appreciate you.`,

  anniversary: `Hi {{first_name}},

We just wanted to say thank you. It's been a real pleasure looking after your property as a customer of {{business_name}}.

We appreciate your continued trust, and we look forward to working with you for a long time yet.

If there's ever anything we can do for you, just reply to this message.`,

  win_back: `Hi {{first_name}},

It's been a little while, and we'd be glad to help with your property again.

If you'd like to book a visit or have any questions, simply reply to this message—we're always happy to help.

Thank you, and we hope to see you again soon!

— {{business_name}}`,

  marketing: `Hi {{first_name}},

Just checking in from {{business_name}}.

If there's anything we can help with around your property this season, simply reply to this message and we'll take care of it.

Thank you for being a valued customer!`,

  referral_request: `Hi {{first_name}},

It's been a pleasure looking after your property, and we're glad you're happy with the work.

If you know a neighbour who could use the same, we'd be grateful if you passed our name along. Most of our work comes from customers kind enough to do exactly that.

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
  deposit_request: 'Deposit to get you booked in',
  change_order: 'Extra work — your approval needed',
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

// ── GSM-7 typography flattening, SMS ONLY ────────────────────────────────────
// An SMS is GSM-7 only if EVERY character is in that alphabet; ONE stray
// character forces the WHOLE message to UCS-2, which cuts a segment from 160
// characters to 70. A single em dash therefore costs real money on every send:
// `on_my_way` is 139 characters — comfortably one GSM-7 segment — and its
// "— {{business_name}}" sign-off made it THREE. Fifteen of the app's defaults
// were paying that tax, and it is the most-sent message in the product.
//
// These substitutions are lossless in a text message: an em dash and a hyphen
// read the same on a phone, and nobody has ever noticed a straight apostrophe in
// an SMS. Email keeps the real punctuation, because there it costs nothing and
// looks better — which is exactly why this lives on the SMS branch of renderBody
// rather than in the templates.
//
// ⚠️ This runs on OWNER-AUTHORED copy too (campaigns, edited sends), which is
// where it earns the most: text pasted from Word or Google Docs arrives full of
// smart quotes and would silently double the owner's bill with no visible cause.
//
// Emoji are deliberately NOT stripped. They also force UCS-2, but an owner who
// typed one chose it — removing content is not this function's job, and the
// composer already shows the segment count and cost before sending.
const SMS_TYPOGRAPHY: [RegExp, string][] = [
  [/[‘’‚‛]/g, "'"],      // ' ' ‚ ‛  → '
  [/[“”„‟]/g, '"'],      // " " „ ‟  → "
  [/[‐-―]/g, '-'],                 // ‐ ‑ ‒ – — ― → -
  [/[•·‧]/g, '-'],            // • · ‧      → -
  [/…/g, '...'],                        // …
  [/→/g, '->'],                         // →
  [/⁄/g, '/'],                          // ⁄
  [/[     ]/g, ' '],// non-breaking / thin spaces
  [/[​‌‍️]/g, ''],       // zero-width joiners + emoji variation selector
]
export function smsSafe(s: string): string {
  let out = s
  for (const [re, to] of SMS_TYPOGRAPHY) out = out.replace(re, to)
  return out
}

// Render an arbitrary body string (a default template OR owner-authored campaign
// copy) into the per-channel shapes. Interpolation, **bold** handling and the
// email wrapper are identical to renderMessage, so manual and automated sends
// look the same in the customer's thread/inbox.
export function renderBody(rawBody: string, vars: MsgVars, subject: string, template?: MsgType): RenderedMessage {
  const raw = interpolate(rawBody, vars)
  // SMS/plain: strip the **bold** markers, then flatten typographic punctuation
  // to its GSM-7 equivalent. Email: render the markers as <strong> and KEEP the
  // real punctuation — see smsSafe for why the two channels diverge here.
  const sms = smsSafe(raw.replace(/\*\*(.+?)\*\*/g, '$1'))
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

// The change-order ask, with the scope and the price in the words themselves.
// Sent as `bodyOverride` on the 'change_order' template — the same shape the
// receipt uses — so the customer reads WHAT the extra work is, not just a number,
// while {{first_name}}/{{portal_link}}/{{business_name}} stay for the server (the
// only side that knows the portal token) to fill in.
//
// ⭐ "in addition to" and "nothing … until you approve" are load-bearing, not
// padding: this feature exists so that added scope is never mistaken for a
// revision of what was already agreed.
export function changeOrderMessageBody(p: {
  number: string; description: string; amount: string; originalTotal: string | null
}): string {
  const original = p.originalTotal
    ? `Your original approved total of **${p.originalTotal}** does not change.`
    : 'What you already approved does not change.'
  return `Hi {{first_name}},

We've priced some extra work on your job:

${p.description} — **${p.amount}** (${p.number})

${original} This is in addition to it, and nothing goes ahead until you approve.

Approve or decline here:

{{portal_link}}

Questions? Just reply.

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
    // A deposit request is money owed on a real invoice for work the customer
    // asked for — transactional, same category as the invoice itself. It must
    // never ride the marketing preference.
    case 'invoice': case 'deposit_request': case 'payment_reminder': case 'receipt': return 'invoices'
    // A change order is a QUOTE for extra work — priced, unapproved, and the
    // customer's to accept or refuse. It belongs with the other estimates, not
    // with the invoices: nothing is owed until they say yes.
    case 'quote': case 'estimate_reminder': case 'estimate_followup': case 'change_order': return 'estimates'
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
