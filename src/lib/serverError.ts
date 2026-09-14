type SafeLogValue = string | number | boolean | null

const SENSITIVE_FIELD = /^(?:message|error|stack|origin|ip|token|payload|body|email|phone|address|name|url|user(?:id)?|customer(?:id)?)$/i

function safeFields(fields: Record<string, SafeLogValue>): Record<string, SafeLogValue> {
  const out: Record<string, SafeLogValue> = {}
  for (const [key, value] of Object.entries(fields)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(key) || SENSITIVE_FIELD.test(key)) continue
    if (typeof value === 'string' && !/^[A-Za-z0-9_.:-]{1,80}$/.test(value)) continue
    out[key] = value
  }
  return out
}

function errorShape(error: unknown): { name: string; code?: string } {
  const rawName = error instanceof Error ? error.name : typeof error
  const name = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(rawName) ? rawName : 'Error'
  if (!error || typeof error !== 'object' || !('code' in error)) return { name }
  const raw = String((error as { code?: unknown }).code ?? '')
  return /^[A-Za-z0-9_-]{1,32}$/.test(raw) ? { name, code: raw } : { name }
}

/** Log a server failure without provider text, request data, credentials or stacks. */
export function logSafeServerError(
  context: string,
  error: unknown,
  fields: Record<string, SafeLogValue> = {},
): void {
  console.error(`[server-error] ${context}`, { ...safeFields(fields), ...errorShape(error) })
}

/** Security events deliberately exclude origin, IP, token and submitted form data. */
export function logSecurityEvent(
  event: string,
  fields: Record<string, SafeLogValue> = {},
): void {
  console.warn(`[security-event] ${event}`, safeFields(fields))
}
