import { useId } from 'react'

// ── Shared form-field a11y ids ───────────────────────────────────────────────
// Input, Select and Textarea each derived the same three ids by hand — a useId()
// fallback plus `${id}-error` / `${id}-hint` for the aria-describedby wiring that
// makes a screen reader read the error/hint on focus. Three copies of the same
// a11y contract is three chances for one control to spell it differently. This is
// the single source.
//
// Pure: the returned strings are byte-identical to the inline derivation (a caller
// `id` still wins over the generated one), and each control keeps computing its own
// aria-describedby/aria-invalid from these — so no rendered attribute changes, only
// where the ids come from. useId is called once here, exactly as each control
// called it once before, so the generated value and hook-call order are unchanged.
export function useFieldIds(id?: string): { id: string; errorId: string; hintId: string } {
  const generated = useId()
  const fieldId = id ?? generated
  return { id: fieldId, errorId: `${fieldId}-error`, hintId: `${fieldId}-hint` }
}
