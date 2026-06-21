// ── Communications message templates ───────────────────────────────────────────
// Channel-agnostic copy for the four automated/manual messages. Rendering is pure
// (no I/O), so it's testable and the same text feeds SMS + email. SENDING lives in
// ./send and stays DISABLED until Twilio/Resend credentials are set.

export type CommTemplate = 'reminder' | 'on_my_way' | 'job_complete' | 'review_request'

export const COMM_TEMPLATE_LABELS: Record<CommTemplate, string> = {
  reminder: 'Tomorrow reminder',
  on_my_way: 'On my way',
  job_complete: 'Job complete',
  review_request: 'Review request',
}

export interface TemplateVars {
  customerName: string
  businessName: string
  dateLabel?: string   // e.g. "tomorrow (Sat, Jun 21)"
  portalUrl?: string   // the customer's magic-link portal
  reviewUrl?: string   // Google review link (business setting, later)
}

export interface RenderedMessage {
  sms: string
  subject: string
  html: string
  text: string
}

function firstName(name: string): string { return (name || '').trim().split(/\s+/)[0] || 'there' }

export function renderTemplate(t: CommTemplate, v: TemplateVars): RenderedMessage {
  const fn = firstName(v.customerName)
  const biz = v.businessName || 'your service provider'
  const portal = v.portalUrl ? `\n\nView details: ${v.portalUrl}` : ''
  const review = v.reviewUrl ? ` ${v.reviewUrl}` : ''

  let sms = '', subject = '', body = ''
  switch (t) {
    case 'reminder':
      subject = `Reminder: your service is ${v.dateLabel || 'coming up'}`
      sms = `Hi ${fn}, a friendly reminder that ${biz} is scheduled to visit ${v.dateLabel || 'soon'}. Reply with any questions!`
      body = `Hi ${fn},\n\nThis is a friendly reminder that ${biz} is scheduled to visit ${v.dateLabel || 'soon'}.\n\nReply with any questions — see you then!${portal}`
      break
    case 'on_my_way':
      subject = `${biz} is on the way`
      sms = `Hi ${fn}, ${biz} is on the way to your property now. See you soon!`
      body = `Hi ${fn},\n\n${biz} is on the way to your property now. See you soon!`
      break
    case 'job_complete':
      subject = `Your service is complete`
      sms = `Hi ${fn}, ${biz} has finished your service today. Thank you!${v.portalUrl ? ` View details & photos: ${v.portalUrl}` : ''}`
      body = `Hi ${fn},\n\n${biz} has finished your service today. Thank you for your business!${portal}`
      break
    case 'review_request':
      subject = `How did we do?`
      sms = `Hi ${fn}, thanks for choosing ${biz}! If you have a moment, we'd really appreciate a quick review.${review}`
      body = `Hi ${fn},\n\nThanks for choosing ${biz}! If you have a moment, we'd really appreciate a quick review${v.reviewUrl ? `:\n${v.reviewUrl}` : '.'}\n\nIt helps a small local business a lot.`
      break
  }
  const html = `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1A2333">${body.replace(/\n/g, '<br>')}</div>`
  return { sms, subject, html, text: body }
}
