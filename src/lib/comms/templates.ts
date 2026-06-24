// ── Communications message templates ───────────────────────────────────────────
// Channel-agnostic copy with {{variables}}. Owners can override any template's
// wording in Settings (stored on business_settings.message_templates); when a
// type isn't overridden the default below is used. Rendering is pure (no I/O).
// SENDING lives in ./send and stays DISABLED until provider credentials are set.

export type MsgType =
  | 'on_my_way' | 'running_late' | 'arrived' | 'job_complete' | 'thanks'
  | 'review_request' | 'reminder' | 'quote' | 'invoice'
  // Scheduler communication actions (2026-06-24): editable one-tap messages on a
  // scheduled job. Same engine, same send pipeline — just more templates.
  | 'eta' | 'rain_delay' | 'rescheduled' | 'early_arrival' | 'confirm'

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
  rain_delay: 'Rain delay',
  rescheduled: 'Rescheduled',
  early_arrival: 'Finished early',
  confirm: 'Confirm visit',
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

export const DEFAULT_TEMPLATES: Record<MsgType, string> = {
  on_my_way: "Hi {{first_name}}, this is {{business_name}}. I'm on my way and should arrive in approximately {{eta}} minutes.",
  running_late: "Hi {{first_name}}, I'm running a little behind schedule today. My updated ETA is approximately {{eta}} minutes. Thanks for your patience.",
  arrived: "Hi {{first_name}}, I've just arrived at your property to start your service.",
  job_complete: 'Hi {{first_name}}, your service has been completed. Thank you for choosing {{business_name}}.',
  thanks: 'Hi {{first_name}}, thank you for choosing {{business_name}}!',
  review_request: "Hi {{first_name}}, thank you for choosing {{business_name}}. If you were happy with the service, I'd greatly appreciate a Google review: {{review_link}}",
  reminder: 'Hi {{first_name}}, a friendly reminder that {{business_name}} is scheduled to visit {{date}}. Reply with any questions!',
  quote: "Hi {{first_name}}, here's your quote from {{business_name}}. View and accept it any time here: {{portal_link}}",
  invoice: 'Hi {{first_name}}, your invoice from {{business_name}} is ready{{amount}}. View it here: {{portal_link}}',
  eta: "Hi {{first_name}}, {{business_name}} is scheduled to service your property on {{date}}. Our estimated arrival window is {{time_window}}. If anything changes we'll keep you updated. Thanks!",
  rain_delay: 'Hi {{first_name}}, due to weather conditions your scheduled service has been moved from {{old_date}} to {{date}}. Thank you for your understanding.',
  rescheduled: 'Hi {{first_name}}, your service has been rescheduled to {{date}}.',
  early_arrival: 'Hi {{first_name}}, we have an opening today and can arrive earlier than originally scheduled if that works for you. Just reply to let us know!',
  confirm: 'Hi {{first_name}}, just confirming your upcoming service on {{date}}. Please reply if you have any questions.',
}

const SUBJECTS: Record<MsgType, string> = {
  on_my_way: 'On my way', running_late: 'Running a little behind', arrived: "We've arrived",
  job_complete: 'Your service is complete', thanks: 'Thank you!', review_request: 'How did we do?',
  reminder: 'Service reminder', quote: 'Your quote', invoice: 'Your invoice',
  eta: 'Your upcoming service', rain_delay: 'Weather reschedule', rescheduled: 'Your service has been rescheduled',
  early_arrival: 'We can come earlier today', confirm: 'Confirming your service',
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
    amount: v.amount ? ` for ${v.amount}` : '',
  }
  return tpl.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_m, key: string) => (key in sub ? sub[key] : '')).replace(/[ \t]{2,}/g, ' ').trim()
}

// Resolve the owner's custom template (if any) else the default, and fill it in.
export function renderMessage(type: MsgType, custom: Partial<Record<MsgType, string>> | null | undefined, vars: MsgVars): RenderedMessage {
  const tpl = (custom && custom[type] && custom[type]!.trim()) ? custom[type]! : DEFAULT_TEMPLATES[type]
  const sms = interpolate(tpl, vars)
  const subject = SUBJECTS[type] || `A message from ${vars.businessName || 'your service provider'}`
  const html = `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;font-size:15px;line-height:1.55;color:#1A2333">${sms.replace(/\n/g, '<br>')}</div>`
  return { sms, subject, html, text: sms }
}
