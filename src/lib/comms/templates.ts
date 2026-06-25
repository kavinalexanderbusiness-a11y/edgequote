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

We look forward to seeing you tomorrow!`,

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

I just wanted to let you know I'm running a little behind schedule today.

My updated arrival time is approximately **{{eta}} minutes**.

Thank you for your patience—I appreciate your understanding and I'll be there as soon as possible.`,

  arrived: `Hi {{first_name}},

I've just arrived at your property and will be getting started shortly.

If there's anything you'd like me to know before I begin, just let me know.

Thanks!`,

  early_arrival: `Hi {{first_name}},

My schedule opened up earlier than expected today.

If it works for you, I can arrive earlier than originally planned.

Just reply to this message and let me know.`,

  rescheduled: `Hi {{first_name}},

Your service has been rescheduled to **{{date}}**.

If this new date doesn't work for you, simply reply to this message and we'll be happy to arrange another time.

Thank you for your understanding!`,

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

If you were happy with today's service, we'd really appreciate a quick Google review.

Your feedback helps our small business grow and helps other homeowners choose a company they can trust.

{{review_link}}

Thank you again—we truly appreciate your support!`,

  quote: `Hi {{first_name}},

Your quote from {{business_name}} is ready.

You can view, approve, or decline it anytime using the secure link below:

{{portal_link}}

If you have any questions about the quote, simply reply to this message and we'll be happy to help.`,

  invoice: `Hi {{first_name}},

Your invoice from {{business_name}} is now ready{{amount}}.

You can securely view and pay it anytime using the link below:

{{portal_link}}

Thank you for choosing {{business_name}}. We appreciate your business!`,

  estimate_reminder: `Hi {{first_name}},

This is a reminder about your upcoming estimate on **{{date}}**.

We look forward to meeting with you. If you need to reschedule, simply reply to this message.`,

  payment_reminder: `Hi {{first_name}},

This is a friendly reminder that your invoice is still outstanding.

You can securely view and pay it here:

{{invoice_link}}

If you've already made payment, please disregard this message. Thank you!`,

  estimate_followup: `Hi {{first_name}},

Just checking in regarding the quote we recently sent.

If you have any questions or would like to discuss any part of it, we're happy to help.

Whenever you're ready, you can view and accept your quote here:

{{quote_link}}

Thank you for considering {{business_name}}.`,
}

const SUBJECTS: Record<MsgType, string> = {
  on_my_way: 'On my way', running_late: 'Running a little behind', arrived: "We've arrived",
  job_complete: 'Your service is complete', thanks: 'Thank you!', review_request: 'How did we do?',
  reminder: 'Service reminder', quote: 'Your quote', invoice: 'Your invoice',
  eta: 'Your upcoming service', rain_delay: 'Weather reschedule', rescheduled: 'Your service has been rescheduled',
  early_arrival: 'We can come earlier today', confirm: 'Confirming your service',
  estimate_reminder: 'Your upcoming estimate', payment_reminder: 'Invoice reminder', estimate_followup: 'Following up on your quote',
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
}

export interface RenderedMessage { sms: string; subject: string; html: string; text: string }

function interpolate(tpl: string, v: MsgVars): string {
  const sub: Record<string, string> = {
    first_name: (v.firstName || '').trim().split(/\s+/)[0] || 'there',
    business_name: v.businessName || 'us',
    eta: String(v.eta ?? '15'),
    review_link: v.reviewLink || '',
    portal_link: v.portalLink || '',
    quote_link: v.quoteLink || v.portalLink || '',
    invoice_link: v.invoiceLink || v.portalLink || '',
    date: v.dateLabel || 'soon',
    old_date: v.oldDateLabel || 'your original date',
    time_window: v.timeWindow || 'your scheduled window',
    address: v.address || 'your property',
    amount: v.amount ? ` for ${v.amount}` : '',
  }
  // Substitute, collapse runs of spaces/tabs (NOT newlines — paragraphs stay), trim.
  return tpl.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_m, key: string) => (key in sub ? sub[key] : '')).replace(/[ \t]{2,}/g, ' ').trim()
}

// Resolve the owner's custom template (if any) else the default, and fill it in.
export function renderMessage(type: MsgType, custom: Partial<Record<MsgType, string>> | null | undefined, vars: MsgVars): RenderedMessage {
  const tpl = (custom && custom[type] && custom[type]!.trim()) ? custom[type]! : DEFAULT_TEMPLATES[type]
  const raw = interpolate(tpl, vars)
  // SMS/plain: strip the **bold** markers. Email: render them as <strong>.
  const sms = raw.replace(/\*\*(.+?)\*\*/g, '$1')
  const subject = SUBJECTS[type] || `A message from ${vars.businessName || 'your service provider'}`
  const htmlBody = raw.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>')
  const html = `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;font-size:15px;line-height:1.55;color:#1A2333">${htmlBody}</div>`
  return { sms, subject, html, text: sms }
}
