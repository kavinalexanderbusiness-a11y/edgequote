// Shared contract between the website-lead sender and the owner-facing health card.
// Keep this in a client-safe module: importing lib/intake.ts into the Settings UI
// would pull server-only email and service-role code into the browser bundle.
export const WEBSITE_LEAD_OWNER_ALERT_TEMPLATE = 'website_lead_owner_alert'

