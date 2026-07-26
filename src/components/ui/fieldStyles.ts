// ── Shared form-field styling ────────────────────────────────────────────────
// The border + focus-ring state was written out, byte-for-byte identical, in
// Input, Select and Textarea. Three copies of one decision is three chances for
// the error red or the focus accent to drift apart — the exact drift the shared
// primitives exist to prevent. This is the single source for it.
//
// Pure: it returns the same class string the inline ternary produced and is passed
// into cn() in the same position, so it changes no rendered output — only where the
// decision lives. Each primitive keeps its own BASE classes (Input's size variants,
// Textarea's resize/rows, Select's chevron), because only THIS fragment was shared.

/** Border + focus-ring classes for a form field, keyed on whether it has an error. */
export function fieldBorder(error?: string): string {
  return error
    ? 'border-red-500/50 focus:border-red-500 focus:ring-2 focus:ring-red-500/20'
    : 'border-border-strong focus:border-accent focus:ring-2 focus:ring-accent/20'
}
