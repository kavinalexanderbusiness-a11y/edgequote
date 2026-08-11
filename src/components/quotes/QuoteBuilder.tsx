'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useForm, useFieldArray, Controller } from 'react-hook-form'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Input } from '@/components/ui/Input'
import { AddressAutocomplete } from '@/components/ui/AddressAutocomplete'
import { CustomerPicker } from '@/components/ui/CustomerPicker'
import { ServicePicker } from '@/components/ui/ServicePicker'
import { useAutosave } from '@/hooks/useAutosave'
import { AutosaveStatus, DraftRestoreBanner } from '@/components/ui/Autosave'
import { QuoteMeasure } from '@/components/quotes/QuoteMeasure'
import { Select } from '@/components/ui/Select'
import { Textarea } from '@/components/ui/Textarea'
import { Button } from '@/components/ui/Button'
import { Toggle } from '@/components/ui/Toggle'
import { Card, CardHeader, CardBody } from '@/components/ui/Card'
import { StickyActionBar } from '@/components/ui/StickyActionBar'
import { Banner } from '@/components/ui/Banner'
import { Collapsible } from '@/components/ui/Collapsible'
import { Modal } from '@/components/ui/Modal'
import { AssistButton, AiStop, AiUndo, AiError, AiNote, AI_CHECK_FIRST } from '@/components/ai/ui'
import { useAiAssist } from '@/hooks/useAiAssist'
import { QuoteFormValues, Customer, ServiceTemplate, TravelFeeTier, BusinessSettings } from '@/types'
import { sumServiceLines, serviceLineTotals, emptyServiceLine } from '@/lib/quoteServices'
import { MATERIAL_SUGGESTIONS, emptyMaterialLine } from '@/lib/quoteMaterials'
import { QuoteOptionsEditor } from '@/components/quotes/QuoteOptionsEditor'
import {
  EXAMPLE_OPTION_NAMES, OPTIONS_VS_LINES_MESSAGE, headlineOptionPrice, optionProblemMessage,
  optionSetProblem, optionsConflictWithLines, recommendedOption,
} from '@/lib/quoteOptions'
import { loadServiceUnits, SYSTEM_UNITS, type ServiceUnit } from '@/lib/units'
import { formatCurrency, formatDate, suggestTravelFee, cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
// formatServicePrice is no longer called here: pricing a catalogue row is the
// picker's job now, through the same one seam. This file kept it only to build
// the flattened <select> labels the picker replaced.
import { servicePricingKind, serviceRecommendation } from '@/lib/servicePricing'
import { laborSuggestion, pricingConfigFromSettings, latestSavedRecommendation, recommendationIsStale, pricingPackage } from '@/lib/pricing'
import { evaluatePrice, PriceGuardrail } from '@/lib/priceGuardrails'
import { PriceGuardrailNote } from '@/components/pricing/PriceGuardrailNote'
import { findCustomerMatch } from '@/lib/customers'
import { createClient } from '@/lib/supabase/client'
import type { MeasurementSnapshot, SavedRecommendation } from '@/types'
import { BestDaySuggestions } from '@/components/schedule/BestDaySuggestions'
import { SmartLaborField } from '@/components/labor/SmartLaborField'
import { PriceIntelligence } from '@/components/pricing/PriceIntelligence'
import { Clock, Car, Calculator, AlertTriangle, MapPin, Repeat, Ruler, Sparkles, FileText, CheckCircle2, Users, Layers, Plus, Trash2, ChevronUp, ChevronDown, Package } from 'lucide-react'

interface QuoteBuilderProps {
  customers: Customer[]
  templates: ServiceTemplate[]
  /** Template ids from the owner's most recent quotes, newest first — the "Recent"
      block at the top of the service picker. Read back out of rows they already
      saved (quotes.service_template_id); nothing new is recorded to produce it, and
      an omitted prop simply means the picker opens straight into the catalogue. */
  recentTemplateIds?: string[]
  tiers: TravelFeeTier[]
  settings?: BusinessSettings | null
  defaultCustomerId?: string
  // When opened from a SPECIFIC property (per-property Quote button), load that
  // property's address + saved lawn size instead of the customer's primary.
  defaultPropertyId?: string
  defaultValues?: Partial<QuoteFormValues>
  /** Return `false` to signal "nothing was saved" — the autosave draft is kept so a
      refresh after the failure toast can still restore everything the owner typed.
      Returning void/undefined (or true) means saved: the draft is cleared as before. */
  onSubmit: (values: QuoteFormValues) => Promise<void | boolean>
  isEdit?: boolean
  /** Autosave key — defaults per new/edit; pass a precise one (e.g. `quote:${id}`). */
  autosaveKey?: string
  /** Server record's updated_at — drafts older than this are never offered. */
  autosaveBaselineUpdatedAt?: string | null
  /** The name of the option the customer already approved, when this quote's
   *  alternatives are settled. Present → the options editor goes read-only: the
   *  approved row can't be deleted (ON DELETE RESTRICT) and rewriting the others
   *  would change what the record says the customer was shown. */
  optionsLockedName?: string | null
  /** Where Cancel goes. The EDIT flow is a same-route state toggle (the detail
      page flips `editing`), so its Cancel must return to the quote VIEW — the
      default router.back() pops history right out of the quote (or the app
      section, on a deep link), leaving "did it save?" uncertainty plus a stale
      draft banner on the next Edit. New-quote callers omit it and keep back(). */
  onCancel?: () => void
}

// Where the price in the field came from. NEVER inferred by comparing the field to
// a recommendation — two numbers being equal is not consent, and that inference is
// exactly what made a fabricated price render as "✓ Applied" on a form nobody had
// touched. Only a real user action moves this to 'applied' or 'manual'.
//   empty     → we have no honest basis for a price. The field stays blank.
//   suggested → an engine's recommendation is sitting in the field, unconfirmed.
//   applied   → the owner tapped Accept / a plan tile / Use measured prices.
//   manual    → the owner typed their own number (or we loaded a saved quote).
type PriceOrigin = 'empty' | 'suggested' | 'applied' | 'manual'

// Seeds an EMPTY input where a `0` seed painted a literal zero into every numeric
// field of a fresh form — eight zeros posing as data, placeholders ("e.g. 5,000")
// permanently hidden, and "type your price" meaning select-the-0-then-retype.
// Typed as number to satisfy QuoteFormValues, but the cast only states the existing
// runtime: react-hook-form number inputs hold STRINGS once touched ('' when the
// owner clears one — a state every reader already survives today), and every
// consumer normalizes via Number(...) / `|| 0`, where Number('') === 0 — so maths,
// autosave and submitted writes are byte-identical to the 0 seed. NEVER swap this
// for undefined: an untouched field would then submit NaN through the pages'
// Number(values.x) wrappers, changing the DB write.
const BLANK = '' as unknown as number

// The cadences the owner can lead a quote with — the plan tiles and the "which one
// did you pitch" highlight. Monthly is deliberately absent: it's off the standard
// lawn menu (a month of growth is a rough cut) and never a picked lead, so it isn't
// one of these. The full four-cadence set (incl. monthly) is priceGuardrails' Cadence.
type PitchCadence = 'one_time' | 'weekly' | 'biweekly'

export function QuoteBuilder({
  customers, templates, recentTemplateIds, tiers, settings, defaultCustomerId, defaultPropertyId, defaultValues, onSubmit, isEdit,
  autosaveKey, autosaveBaselineUpdatedAt, optionsLockedName, onCancel,
}: QuoteBuilderProps) {
  const router = useRouter()
  const { register, handleSubmit, watch, setValue, getValues, reset, control, setFocus, formState: { errors, isSubmitting } } =
    useForm<QuoteFormValues>({
      defaultValues: {
        customer_id: defaultCustomerId || '',
        customer_name: '',
        customer_phone: '',
        customer_email: '',
        address: '',
        service_type: '',
        service_template_id: '',
        // BLANK, not 0 (see the constant above): a fresh form must LOOK empty.
        // Edit/lead/measurement flows spread real numbers over these via
        // `...defaultValues` below, so only the untouched-field display changes.
        // (Restored 2026-07-28 — this fix shipped in PR #60, then the 07-26
        // 12-commit replay silently took the pre-fix side; the zeros returned.)
        initial_price: BLANK,
        weekly_price: BLANK,
        biweekly_price: BLANK,
        monthly_price: BLANK,
        measured_sqft: BLANK,
        // Not BLANK: never rendered as an input — hidden form data, 0 is its "none".
        suggested_price: 0,
        // ADR-002: null until an engine recommendation is applied. Never a default
        // grade — "nobody computed one" and "grade F" are different facts.
        value_grade: null,
        nearby_count: null,
        overgrowth_multiplier: 1,
        distance_km: BLANK,
        // Hours has NO default. It used to be 2 — a number nobody entered, about a
        // job nobody had described yet, which multiplied out into a fabricated
        // price the form then badged as confirmed. Unknown hours is not 2 hours.
        // It fills from the learned estimator below (SmartLaborField) the moment
        // that engine has real history for this service, and stays empty when it
        // doesn't. Empty hours ⇒ no labour recommendation ⇒ no price. That is the
        // correct behaviour, not a gap.
        hours: BLANK,
        // 1 is the structural floor, not a guess: crew_size has min=1, you cannot
        // send zero people, and with hours empty it multiplies into nothing anyway.
        // (business_settings.default_crew_size exists in the DB but is not in the
        // TS type and has no Settings UI — plumbing it through would change no
        // outcome today. Noted in the audit rather than half-built here.)
        crew_size: 1,
        // The owner's OWN configured rate. Settings has had a "Default Labour Rate
        // ($/man-hour)" field all along (settings/page.tsx) and this form ignored
        // it, hardcoding 50 — so a business that set its rate to $95 still got
        // quotes suggested from $50. Both pages gate rendering on `loading`, so
        // settings is always resolved before this form mounts. No settings ⇒ 0 ⇒
        // no labour recommendation, which is honest rather than invented.
        rate: Number(settings?.default_rate) || 0,
        travel_fee: BLANK,
        notes: '',
        status: 'draft',
        services: [],
        // Off, and empty. A normal quote never touches either of these, and the
        // save paths write no option rows while `has_options` is false — so
        // every existing quote and every new plain one behaves byte-identically.
        has_options: false,
        options: [],
        ...defaultValues,
      },
    })

  // Additional lines beyond the primary one. ONE field array holds both services
  // and materials — they are the same species of line (qty × unit_price through
  // the one quote-services engine) and a second array would mean a second sum.
  // The two sections below are a VIEW over it, split by `kind`; the real index is
  // carried through so register() still addresses the right row.
  const serviceLines = useFieldArray({ control, name: 'services' })
  // Declared HERE, above its first reader. It used to be declared ~150 lines
  // below, so `kindAt` — called synchronously by the two filters underneath —
  // reached a `const` still in its temporal dead zone. With no lines that is
  // invisible (the filters never run); with ONE line it is a hard
  // `ReferenceError: Cannot access 'watchedServices' before initialization`,
  // i.e. tapping "Add service"/"Add material", or opening any saved quote that
  // has extra lines, blanked the whole builder. tsconfig targets ES2017, so
  // there is no var-hoisting to soften it. Nothing else moved.
  const watchedServices = watch('services')
  const indexedLines = serviceLines.fields.map((f, i) => ({ f, i }))
  const kindAt = (i: number) => watchedServices?.[i]?.kind ?? 'service'
  const serviceIdx = indexedLines.filter(({ i }) => kindAt(i) !== 'material')
  const materialIdx = indexedLines.filter(({ i }) => kindAt(i) === 'material')
  // Per-section subtotals are DISPLAY ONLY — `extras` remains the ONE figure that
  // feeds the quote total, and it already sums every line regardless of kind.
  // Both go through sumServiceLines rather than a hand-rolled reduce: a second
  // adder here is how two totals start disagreeing.
  const linesAt = (idx: { i: number }[]) =>
    idx.map(({ i }) => watchedServices?.[i]).filter(Boolean) as NonNullable<typeof watchedServices>
  const serviceExtras = sumServiceLines(linesAt(serviceIdx))
  const materialsSum = sumServiceLines(linesAt(materialIdx))
  const serviceExtrasNet = serviceExtras.net

  // Autosave the whole quote — survives refresh / crash / accidental close (shared engine).
  const formValues = watch()
  const autosave = useAutosave<QuoteFormValues>({
    key: autosaveKey || (isEdit ? 'quote:edit' : 'quote:new'),
    value: formValues,
    baselineUpdatedAt: autosaveBaselineUpdatedAt ?? null,
    // "Empty" has to mean empty. Additional service and material lines weren't
    // counted, so a quote whose content was its LINES ("Mulch, 6 yd, $55") looked
    // blank to the autosave and was never drafted — the one kind of quote that
    // takes the most typing to rebuild.
    isEmpty: v => !v.customer_id && !v.customer_name?.trim() && !v.address?.trim() && !v.service_type?.trim()
      && !(Number(v.initial_price) > 0)
      && !(v.services || []).some(s => s?.service_type?.trim() || Number(s?.unit_price) > 0),
  })
  // Which disclosure sections are open. Held here (not inside each Collapsible)
  // because a BLOCKED submit has to be able to open the one hiding the problem.
  // Labour / Plan pricing / Travel were three Collapsibles NESTED inside an
  // "Advanced Pricing" Collapsible — two disclosure taps to the first labour
  // field on every manually-priced quote, and (worse) with the outer section
  // closed all three state summaries UNMOUNTED, so "Absorbing travel — no fee"
  // vs "Charging travel fee" rode along unseen to Save. Flattened to top-level
  // siblings (the pattern Additional services already follows), each CONTROLLED
  // so the error handler can open the exact section hiding an invalid field
  // (main's parallel pass made them controlled for the same reason — a cleared
  // crew_size two doors deep defeated focus-on-error; the flatten removes the
  // outer door entirely).
  // Same content-starts-open rule as services/materials below: a saved quote's
  // plan prices, travel fee and labour inputs start on screen when they exist.
  const [laborOpen, setLaborOpen] = useState(
    () => !!isEdit && (Number(defaultValues?.hours) > 0 || Number(defaultValues?.rate) > 0),
  )
  const [planOpen, setPlanOpen] = useState(
    () => !!isEdit && (Number(defaultValues?.weekly_price) > 0 || Number(defaultValues?.biweekly_price) > 0 || Number(defaultValues?.monthly_price) > 0),
  )
  const [travelOpen, setTravelOpen] = useState(
    () => !!isEdit && (Number(defaultValues?.travel_fee) > 0 || Number(defaultValues?.distance_km) > 0),
  )
  // A section that ALREADY HAS content starts open. Opening a saved quote showed
  // "Additional services · 2 lines · $180" as one collapsed row, so the money most
  // likely to be wrong was the money you had to go looking for — and a quote can
  // be edited, re-saved and sent without its extra lines ever being on screen. A
  // new quote has nothing to reveal and starts closed exactly as before.
  const [servicesOpen, setServicesOpen] = useState(
    () => (defaultValues?.services || []).some(s => (s?.kind ?? 'service') !== 'material'),
  )
  const [materialsOpen, setMaterialsOpen] = useState(
    () => (defaultValues?.services || []).some(s => s?.kind === 'material'),
  )

  // Which section owns each pricing field — a validation error routes to (and
  // opens) exactly the section holding the invalid input. Union of the three ==
  // the old single PRICING_DETAIL_FIELDS list; no field orphaned.
  const LABOR_FIELDS = ['hours', 'crew_size', 'rate', 'overgrowth_multiplier']
  const PLAN_FIELDS = ['weekly_price', 'biweekly_price', 'monthly_price']
  const TRAVEL_FIELDS = ['travel_fee', 'distance_km']

  // Armed by a Save attempt on a $0 first-visit total (see submit below) — flips
  // both save buttons to "Save anyway" behind a persistent explanatory note, and
  // disarms the moment a price exists.
  const [zeroTotalArmed, setZeroTotalArmed] = useState(false)

  const submit = handleSubmit(
    // The draft is the owner's only copy until the row exists. It used to be
    // cleared the moment onSubmit RETURNED — and both pages catch their own
    // Supabase error, toast it, and return normally, so a save that failed (RLS,
    // network, a constraint) threw the draft away too: "Could not save quote",
    // then refresh, and a quote that took minutes to build is gone. Clear it only
    // on a save that actually happened. Same rule handleOpenPdf already applies
    // to marking a quote Sent.
    async v => {
      // ── Options: BLOCK, don't warn ────────────────────────────────────────
      // Unlike the $0 note below, these two are not judgement calls the owner
      // may override — the database refuses both, so "Save anyway" would mean
      // "watch a constraint violation". Say the sentence while the fields that
      // caused it are still on screen, which is the only cheap moment.
      if (v.has_options) {
        if (optionsConflictWithLines(true, (v.services || []).length)) {
          setServicesOpen(true); setMaterialsOpen(true)
          toast.error(OPTIONS_VS_LINES_MESSAGE)
          return
        }
        const p = optionSetProblem(v.options || [])
        if (p) { toast.error(optionProblemMessage(p)); return }
      }
      // Warn-never-block on a $0 first-visit total. Saving it is LEGAL (a
      // weekly-only pitch deliberately has no first-visit price) — but it saves
      // as a quote that Send/PDF/invoice will hard-block one screen later as
      // "no price", and the only cheap moment to say so is while the pricing
      // fields are still on screen. First tap: don't save — arm a PERSISTENT
      // note above both save buttons and relabel them "Save anyway" (a toast
      // alone would make Save silently do nothing, this file's own documented
      // bug DNA). Second tap saves unchanged. Arming resets the moment a price
      // exists, so a fixed quote is back to one-tap Save.
      if (effectiveTotal <= 0 && !zeroTotalArmed) { setZeroTotalArmed(true); return }
      if (await onSubmit(v) !== false) autosave.clear()
    },
    // Save used to fail SILENTLY. `crew_size` is required and lives inside a
    // collapsed section, so clearing it meant tapping Save did visibly nothing:
    // react-hook-form blocked the submit and then tried to focus a field that
    // wasn't mounted. Say what's wrong, and open the section holding it.
    errs => {
      const keys = Object.keys(errs)
      if (!keys.length) return
      if (keys.some(k => LABOR_FIELDS.includes(k))) setLaborOpen(true)
      if (keys.some(k => PLAN_FIELDS.includes(k))) setPlanOpen(true)
      if (keys.some(k => TRAVEL_FIELDS.includes(k))) setTravelOpen(true)
      if (errs.services) {
        const bad = (errs.services as unknown[]).map((e, i) => (e ? i : -1)).filter(i => i >= 0)
        if (bad.some(i => kindAt(i) === 'material')) setMaterialsOpen(true)
        if (bad.some(i => kindAt(i) !== 'material')) setServicesOpen(true)
      }
      const first = errs[keys[0] as keyof typeof errs] as { message?: string } | undefined
      toast.error(first?.message || 'Some fields still need filling in — we’ve opened the section holding them.')
    },
  )

  const [calcLoading, setCalcLoading] = useState(false)
  // `settingsLink` renders a live link to the page the message names — a first-run
  // dead end ("Set your base address in Settings first") must hand over the door,
  // not just the direction (§15: the last of the three first-run dead ends).
  const [calcMsg, setCalcMsg] = useState<{ text: string; error?: boolean; settingsLink?: boolean } | null>(null)
  const [showMeasure, setShowMeasure] = useState(false)
  // Mobile-only: the desktop preview card is lg-only, so the phone needs a way in.
  const [showPreview, setShowPreview] = useState(false)
  // Derived from the quote being edited, not assumed. It was hardcoded `true`, so
  // reopening a quote whose travel the owner had deliberately absorbed showed the
  // toggle reading "Charging travel fee" over a $0 fee — the control stating the
  // opposite of the document it belongs to. Worse than the label: with the flag on,
  // a later "Calculate distance" re-applies the tier fee, silently adding money to
  // a quote that was written without any. A NEW quote still starts as "charging"
  // (nothing to infer from, and charging is the right default posture).
  const [includeTravel, setIncludeTravel] = useState(!isEdit || (Number(defaultValues?.travel_fee) || 0) > 0)
  // Loading a saved quote → EVERY loaded price state is the owner's own past
  // decision — including a price they deliberately left ABSENT. The seed used to
  // check only `initial_price > 0`, so a weekly-only quote (initial_price null in
  // the DB, hours/rate saved with it) opened as 'empty'/unlocked, the
  // reconciliation effect below immediately wrote hours×crew×rate into the field,
  // and Update persisted it: a quote gained a first-visit price — changing
  // quotes.total and re-stamping ADR-002 provenance — from an edit that only
  // touched the notes. On edit the field starts 'manual' whatever it holds; the
  // "Use suggested" button still re-enables the engine with one explicit tap.
  const [priceOrigin, setPriceOrigin] = useState<PriceOrigin>(
    isEdit ? 'manual' : (defaultValues?.initial_price ?? 0) > 0 ? 'manual' : 'empty',
  )
  // The suggestion engine stops writing to the field once the owner owns the
  // number — by accepting one or by typing one. Both used to be the single
  // `initialManual` boolean, which is why an Accept and a hand-typed override were
  // indistinguishable in the header badge.
  const priceLocked = priceOrigin === 'applied' || priceOrigin === 'manual'
  const [showBestDays, setShowBestDays] = useState(false)
  // Recurring plan prices are revealed, not presented. See the note on the
  // "Offer recurring pricing" button in Pricing help below.
  const [offerRecurring, setOfferRecurring] = useState(
    () => Number(defaultValues?.weekly_price) > 0 || Number(defaultValues?.biweekly_price) > 0 || Number(defaultValues?.monthly_price) > 0,
  )
  // §2.4 — the measured area renders as a full field only when it PRICES this
  // service (lawn cadence / per-area) or a figure already exists; for labour
  // trades it collapses to an opt-in link instead of a full-width input whose
  // caption explains its own irrelevance.
  const [showAreaField, setShowAreaField] = useState(false)
  // Saved recommendation from the customer's latest property measurement — the
  // source of truth for suggested prices (no re-measuring needed).
  const [savedRec, setSavedRec] = useState<{ rec: SavedRecommendation; sqft: number; date: string } | null>(null)
  // Which suggested price the owner tapped — drives the compact "Suggested Pricing"
  // highlight. Cleared the moment a price is edited (manual override).
  const [pickedCadence, setPickedCadence] = useState<PitchCadence | null>(null)

  const hours = watch('hours') || 0
  const crewSize = watch('crew_size') || 1
  // No `|| DEFAULT_RATE` backstop: a missing rate must stay 0 so the labour
  // recommendation goes silent, rather than quietly reappearing at $50/hr.
  const rate = watch('rate') || 0
  const travelFee = watch('travel_fee') || 0
  const customerId = watch('customer_id')
  const templateId = watch('service_template_id')
  const overgrowth = Number(watch('overgrowth_multiplier')) || 1
  const distanceKm = Number(watch('distance_km')) || 0
  const address = watch('address')
  const showTravelSeparately = watch('show_travel_separately')
  const customTravelRequired = watch('custom_travel_required')
  const initialPrice = Number(watch('initial_price')) || 0
  const weeklyPrice = Number(watch('weekly_price')) || 0
  const biweeklyPrice = Number(watch('biweekly_price')) || 0
  const monthlyPrice = Number(watch('monthly_price')) || 0

  const manualName = watch('customer_name')
  const manualPhone = watch('customer_phone')
  const manualEmail = watch('customer_email')
  const notes = watch('notes')
  // AI scope writer for the Notes field — words only; pricing never comes from it.
  const aiScope = useAiAssist()
  // What the field held before the assistant replaced it — powers Undo, and
  // doubles as "this text came from the assistant" for the explanation note.
  const [aiScopePrior, setAiScopePrior] = useState<string | null>(null)
  const measuredSqft = Number(watch('measured_sqft')) || 0

  // Smart Price Guardrails — per-cadence, never-block warnings (measured lawn +
  // crew cost). Each filled cadence is judged against ITS own recommended price.
  const priceGuardrails = useMemo<PriceGuardrail[]>(() => {
    const cfg = pricingConfigFromSettings(settings)
    const crewCost = settings?.crew_cost_per_hour && settings.crew_cost_per_hour > 0 ? settings.crew_cost_per_hour : 40
    const out: PriceGuardrail[] = []
    const add = (cadence: 'one_time' | 'weekly' | 'biweekly' | 'monthly', price: number) => {
      // PR-1: pass the real overgrowth so an overgrown job is judged against ITS
      // own (higher) recommended price, not a normal-condition one. valueGrade is
      // null because the builder prices neutrally — the grade curve is applied in
      // the measure tool, not here. Both are now REQUIRED by evaluatePrice.
      if (price > 0) out.push(evaluatePrice({ cadence, price, sqft: measuredSqft, cfg, crewCost, valueGrade: null, overgrowth }))
    }
    add('one_time', initialPrice); add('weekly', weeklyPrice); add('biweekly', biweeklyPrice); add('monthly', monthlyPrice)
    return out
  }, [settings, measuredSqft, initialPrice, weeklyPrice, biweeklyPrice, monthlyPrice, overgrowth])

  // Live duplicate detection — when entering a brand-new lead, surface a likely
  // existing customer so we link instead of creating a duplicate. Reuses the
  // single matching engine (phone/email/address confident, name not).
  const isManualEntry = !customerId || customerId === '__manual'
  // The linked customer's id, or undefined during manual entry — the pricing panels
  // below take an optional customerId and the '__manual' sentinel must never reach
  // them as a real id. Derived once from isManualEntry so the two call sites can't drift.
  const activeCustomerId = isManualEntry ? undefined : customerId
  const likelyMatch = useMemo(
    () => (isManualEntry ? findCustomerMatch(customers, { name: manualName, phone: manualPhone, email: manualEmail, address }) : null),
    [isManualEntry, customers, manualName, manualPhone, manualEmail, address],
  )
  const suggestedInitial = laborSuggestion(Number(hours), Number(crewSize), Number(rate), overgrowth || 1)
  // Additional service lines — summed by the ONE quote-services engine (same
  // discount semantics as invoices). The first-visit total = primary + extras + travel.
  // (`watchedServices` is declared at the top of the component — see the note there.)
  const extras = useMemo(() => sumServiceLines(watchedServices), [watchedServices])

  // ── Alternatives ────────────────────────────────────────────────────────────
  // `has_options` is the owner's declared intent, held separately from the array
  // so switching off doesn't discard what they typed (see QuoteFormValues).
  const optionsOn = !!watch('has_options')
  const watchedOptions = watch('options') || []
  const optionsLocked = !!optionsLockedName
  // ⭐ The ONE money rule, asked of the ONE engine — never re-derived here. This
  // is the same figure `initial_price` is saved as and the same one the approval
  // RPC would set: the recommended option, else the first. Nothing sums.
  const optionsHeadline = headlineOptionPrice(watchedOptions)
  // (What's WRONG with the set is asked in two places that both need it at the
  // moment they act — the editor's inline note as the owner types, and the submit
  // handler over the values actually being saved. A third copy held here would be
  // a stale render away from disagreeing with the one that blocks the save.)
  const optionsClashWithLines = optionsConflictWithLines(optionsOn, watchedServices?.length ?? 0)
  const recommended = recommendedOption(watchedOptions)

  // With options on, the quote's value IS one option's price plus travel —
  // additive lines cannot coexist (the DB refuses them), so `extras` is not part
  // of this branch by construction rather than by being left out of a sum.
  const effectiveTotal = optionsOn
    ? (optionsHeadline ?? 0) + Number(travelFee || 0)
    : initialPrice + extras.net + Number(travelFee || 0)
  // A price arriving disarms the $0-save warning — Save is one tap again.
  useEffect(() => { if (zeroTotalArmed && effectiveTotal > 0) setZeroTotalArmed(false) }, [zeroTotalArmed, effectiveTotal])

  // Which pricing STRUCTURE this service uses — the one seam that decides which
  // engine recommends and which fields an Accept fills (lawn cadences vs area
  // rate vs labour). Template display type wins; else the serviceKey normalizer.
  const svcTemplate = templates.find(t => t.id === templateId) ?? null
  const pricingKind = servicePricingKind(watch('service_type'), svcTemplate)
  // The name is "settled" while it still equals the adopted template's own. Any
  // edit is a rename FOR THIS QUOTE — the template id deliberately survives it
  // (it is what decides which engine may recommend), so the picker says so in
  // words rather than silently showing a name its catalogue doesn't have.
  const serviceNameValue = watch('service_type')
  const nameSettledByTemplate = !!svcTemplate && serviceNameValue === svcTemplate.name
  // §2.4 — does the measured area PRICE this service? (Everything else only
  // feeds the labour estimate, and gets the opt-in link instead of the field.)
  const areaPricesService = pricingKind === 'lawn_recurring' || pricingKind === 'per_area'

  // Favourites first, then the business's own sort_order within each group.
  // THIS is what a favourite is for: the settings toggle promises "shown first in
  // the quote builder", and this is the only place that promise can be kept — the
  // picker is the sole reader of display order. Stable within groups (the queries
  // already order by sort_order), so a business with no favourites sees the exact
  // order it saw before. Declared HERE, above its first reader (noRecReason) —
  // the same TDZ rule §1 exists to enforce.
  const activeTemplates = useMemo(
    () => templates.filter(t => t.is_active)
      .slice()   // never sort the shared store's array in place
      .sort((a, b) => Number(!!b.is_favorite) - Number(!!a.is_favorite)),
    [templates],
  )

  // WHICH SERVICE the accepted price was accepted for. "Applied" is a claim that
  // the owner agreed to an engine's recommendation — and it survived changing the
  // service, so measuring a lawn, tapping Accept and then switching to "Furnace
  // Repair" left a green ✓ Applied badge next to a mowing price on a furnace
  // quote. Equal numbers aren't consent (this file's own rule); neither is consent
  // given for one service consent for the next.
  // Trimmed + lowercased so fixing a typo in a free-text name doesn't read as
  // switching service; a template-backed one compares by id anyway.
  const [appliedFor, setAppliedFor] = useState<string | null>(null)
  const serviceKey = templateId || String(watch('service_type') || '').trim().toLowerCase()
  const currentServiceKey = () => getValues('service_template_id') || String(getValues('service_type') || '').trim().toLowerCase()
  // THE one road to "Applied" — every accept path goes through here so none of
  // them can forget to record what was accepted, and for what.
  function markApplied() {
    setPriceOrigin('applied')
    setAppliedFor(currentServiceKey())
  }
  // The service changed under an accepted price. The number STAYS (it may still be
  // what the owner wants, and silently zeroing their price would be the worse bug)
  // but it stops claiming to be an engine recommendation anyone agreed to. Still
  // "locked", so no suggestion overwrites it.
  useEffect(() => {
    if (priceOrigin !== 'applied' || appliedFor === null || appliedFor === serviceKey) return
    setPriceOrigin('manual')
    setPickedCadence(null)
    setAppliedFor(null)
  }, [serviceKey, priceOrigin, appliedFor])

  // Live suggested prices straight from the measured lawn — the compact one-tap
  // pricing. Same engine as everywhere else; ONLY for lawn-cadence services (a
  // hedge job or mulch install must never be priced as that many ft² of grass).
  const suggested = useMemo(() => {
    if (pricingKind !== 'lawn_recurring' || measuredSqft <= 0) return null
    const cfg = pricingConfigFromSettings(settings)
    const pkg = pricingPackage(measuredSqft, cfg, { overgrowth: overgrowth || 1, nearbyCount: 0 })
    return {
      one_time: pkg.oneTime,
      weekly: pkg.options.find(o => o.cadence === 'weekly')?.price ?? 0,
      biweekly: pkg.options.find(o => o.cadence === 'biweekly')?.price ?? 0,
      monthly: pkg.options.find(o => o.cadence === 'monthly')?.price ?? 0,
      recommended: pkg.recommended.cadence,
    }
  }, [pricingKind, measuredSqft, overgrowth, settings])

  // The cadence Pricing Intelligence leads with — the engine's pick, or one_time
  // when there's no live suggestion yet. Falls back BEFORE the '?' checks below so
  // "no suggestion" reads as one_time everywhere, exactly as spelled out inline before.
  const recommendedCadence = suggested?.recommended ?? 'one_time'

  // The service's own recommendation, from the ONE seam in lib/servicePricing.
  // It returns null when we have no honest basis — and null is load-bearing: the
  // old code fell back to `hours × crew × rate` using defaults nobody entered, so
  // there was ALWAYS a number, and the card always rendered. Now silence is a
  // possible answer, and the UI says so (see the "no recommendation" card below).
  const serviceRec = useMemo(() => serviceRecommendation({
    kind: pricingKind,
    template: svcTemplate ? { ...svcTemplate, name: svcTemplate.name } : null,
    measuredSqft,
    // The labour figure exists ONLY when hours AND rate are real. laborSuggestion
    // is still the one labour engine — we just refuse to feed it invented inputs.
    labour: hours > 0 && rate > 0
      ? { price: suggestedInitial, hours: Number(hours), crewSize: Number(crewSize), rate: Number(rate) }
      : null,
  }), [pricingKind, svcTemplate, measuredSqft, hours, rate, crewSize, suggestedInitial])

  // Why we can't recommend anything — shown verbatim to the owner instead of a
  // number. Ordered by what they'd do next.
  // Deliberately NOT memoized: this was a useMemo over [watch, pricingKind, rate],
  // and it went stale. watch is referentially stable, and servicePricingKind maps
  // '' and any free-text non-lawn name both to 'labour' — so typing a service name
  // changed NO dep, and the card kept saying "Pick a service and we'll recommend a
  // price." AFTER the owner typed one: telling them to do the thing they'd just
  // done. It's a four-way string pick; recomputing each render costs nothing and
  // the whole form is already watched (autosave), so every keystroke re-renders.
  // The two first-run dead ends here LINK to the page they name (§11.2): a first
  // quote is exactly where a business discovers it hasn't set a rate or built a
  // catalogue, and a message that names a page but doesn't open it is a chore.
  const settingsLink = (label: string) => (
    <Link href="/dashboard/settings" className="underline text-accent-text hover:text-ink">{label}</Link>
  )
  const noRecReason: React.ReactNode = !watch('service_type')?.trim()
    ? (activeTemplates.length === 0
      ? <>Type the service name — or {settingsLink('set up your service catalogue in Settings')} to pick from it here.</>
      : 'Pick a service and we’ll recommend a price.')
    : pricingKind === 'lawn_recurring'
      ? 'Measure the property to see recommended pricing for this service.'
      : rate <= 0
        ? <>No recommendation yet — {settingsLink('set your Default Labour Rate in Settings')}, or type a price.</>
        : 'No recommendation yet — add hours in the Labour calculator, or type a price. EdgeQuote won’t guess.'

  // Accept for one-off services: fill the one price that makes sense and CLEAR
  // the lawn cadence fields (weekly mulch makes no sense on a quote).
  function applyServiceRec() {
    if (!serviceRec) return
    setValue('initial_price', serviceRec.price)
    setValue('weekly_price', 0)
    setValue('biweekly_price', 0)
    setValue('monthly_price', 0)
    setValue('suggested_price', serviceRec.price)
    markApplied()   // a real tap — the ONLY road to "Applied"
    setPickedCadence(null)
  }

  // Monthly is off the standard lawn-care menu (a month of growth is a rough cut) —
  // it stays blank unless the owner explicitly enables it. Editing loads it as
  // enabled when the quote already has a monthly price.
  const [includeMonthly, setIncludeMonthly] = useState<boolean>((defaultValues?.monthly_price ?? 0) > 0)

  // Tap a suggestion → fill One-Time + Weekly + Bi-Weekly TOGETHER (the customer
  // sees every option, no re-typing); the tapped cadence is just the one you'd
  // pitch. Monthly fills only when enabled. All fields stay editable after.
  function applySuggested(c: PitchCadence) {
    if (!suggested) return
    setValue('initial_price', suggested.one_time)
    setValue('weekly_price', suggested.weekly)
    setValue('biweekly_price', suggested.biweekly)
    setValue('monthly_price', includeMonthly ? suggested.monthly : 0)
    setValue('suggested_price', suggested.one_time)
    markApplied()   // tapping a plan tile IS an accept
    setPickedCadence(c)
  }

  // One-line summaries so collapsed sections still reveal their state.
  const recSummary = [
    weeklyPrice > 0 && `Wk ${formatCurrency(weeklyPrice)}`,
    biweeklyPrice > 0 && `Bi ${formatCurrency(biweeklyPrice)}`,
    monthlyPrice > 0 && `Mo ${formatCurrency(monthlyPrice)}`,
  ].filter(Boolean).join(' · ')
  const travelSummary = Number(travelFee) > 0
    ? `${formatCurrency(Number(travelFee))}${distanceKm > 0 ? ` · ${distanceKm} km` : ''}`
    : (includeTravel ? 'No fee yet' : 'Absorbing travel')
  // "0 hr · 1 crew · $0.00/hr" is not a summary, it's a fabricated fact — the $0.00
  // asserts the owner's rate IS zero on the very form whose doctrine is "unknown
  // stays unknown". Until something real is entered, say so in words, like the
  // travel ('No fee yet') and plan ('One-time quote') summaries already do.
  const laborSummary = Number(hours) > 0 || Number(rate) > 0 || Number(crewSize) > 1
    ? `${Number(hours) || 0} hr · ${crewSize} crew · ${formatCurrency(Number(rate))}/hr`
    : 'Not estimated yet'

  // The cadence inputs are on screen whenever they hold — or are about to hold —
  // a real number, so the reveal can never hide money. A price arriving from ANY
  // engine path (plan tile, measured lawn, saved quote, "Use measured prices")
  // opens them by itself, because every one of those writes through setValue and
  // these are the same watched values the breakdown reads.
  const showPlanFields = offerRecurring || weeklyPrice > 0 || biweeklyPrice > 0 || monthlyPrice > 0
    || !!(errors.weekly_price || errors.biweekly_price || errors.monthly_price)

  // ── Summaries for the three drawers that replaced seven ─────────────────────
  // A closed drawer earns its place only by answering "is there anything in here
  // for me?" without being opened. Seven doors each answering for one section was
  // seven questions; three doors have to answer for the same content.
  // Empty reads as OPTIONAL, not as an unanswered question. "Work out a price
  // from hours or plans" is an instruction, and an instruction on a shut door is
  // a task; the price field above already works without any of this.
  const pricingHelpSummary = [
    Number(hours) > 0 || Number(rate) > 0 || Number(crewSize) > 1 ? laborSummary : null,
    recSummary || null,
  ].filter(Boolean).join(' · ') || 'Optional — estimate from hours, or add repeat prices'
  const linesSummary = serviceIdx.length + materialIdx.length > 0
    ? [
      serviceIdx.length ? `${serviceIdx.length} service${serviceIdx.length !== 1 ? 's' : ''}` : null,
      materialIdx.length ? `${materialIdx.length} material${materialIdx.length !== 1 ? 's' : ''}` : null,
    ].filter(Boolean).join(' · ') + ` · ${formatCurrency(serviceExtrasNet + materialsSum.net)}`
    : 'Add cleanup, hedges, mulch…'
  // Every part states where it stands, so a shut door reads as answered rather
  // than as two more questions. "Best days to schedule" is deliberately NOT in
  // here: it is a lookup, not a setting — nothing about it is stored on the
  // quote, and listing it as "not specified" would invent a field that a reader
  // would then go looking for on the saved row.
  const moreSummary = [
    Number(travelFee) > 0 ? `Travel ${formatCurrency(Number(travelFee))}` : (includeTravel ? 'No travel fee' : 'Travel absorbed'),
    notes && String(notes).trim() ? 'Notes added' : 'No notes',
  ].join(' · ')

  // Each drawer now fronts more than one former section, so opening it must set
  // every flag the invalid-handler and the edit-path seeding still write
  // individually. Those callers are UNTOUCHED — `laborOpen || planOpen` reads
  // them, so "open the section holding the error" keeps working unchanged.
  const setPricingHelp = (o: boolean) => { setLaborOpen(o); setPlanOpen(o) }
  const setLinesOpen = (o: boolean) => { setServicesOpen(o); setMaterialsOpen(o) }

  // What WE last auto-filled into the address. The rule everywhere else in this
  // file is "fill it when it's empty, never overwrite what the owner typed"; this
  // effect was the exception and overwrote unconditionally. So: type the service
  // address for a rental, a second property, or the job site — then pick the
  // existing customer, and the address you typed was silently replaced by their
  // home address. Nothing said so. The quote goes out for the wrong property.
  // It also clobbered the two prefilled paths that exist to save typing — a
  // website lead's stated address and the measure-tool handoff — because both
  // arrive WITH a customer_id attached. Remembering our own fill keeps switching
  // customers working (their address IS still ours to replace) while a typed
  // address is now untouchable.
  const autoFilledAddress = useRef<string | null>(null)
  // Same contract for the lawn size the property effect fills: remember OUR fill
  // so switching customers can replace (or clear) it, while a typed or measured
  // figure is untouchable. Without this the fill-only-when-0 guard meant customer
  // A's 5,000 ft² kept driving the plan tiles after the owner switched to
  // customer B — the one-tap prices quoted the wrong property.
  const autoFilledSqft = useRef<number | null>(null)

  useEffect(() => {
    if (!customerId || customerId === '__manual') return
    const customer = customers.find(c => c.id === customerId)
    if (customer) {
      setValue('customer_name', customer.name)
      if (!isEdit && customer.address) {
        const full = [customer.address, customer.city, customer.province].filter(Boolean).join(', ')
        const current = String(getValues('address') || '')
        if (!current.trim() || current === autoFilledAddress.current) {
          setValue('address', full)
          autoFilledAddress.current = full
        }
      }
    }
  }, [customerId, customers, setValue, getValues, isEdit])

  // Pull the latest measurement recommendation for the relevant property — the
  // SPECIFIC property when one was requested (per-property Quote button), else the
  // customer's primary. Measured prices become the suggestion, no re-measuring.
  useEffect(() => {
    if (!customerId || customerId === '__manual') { setSavedRec(null); return }
    // defaultPropertyId is a STATIC prop from the URL, but this effect re-runs on
    // every customerId change — so after the owner switched away from the customer
    // the property arrived with, it kept re-fetching the ORIGINAL property and,
    // because its address write was unconditional on that branch, stomped the new
    // customer's freshly-filled address back to the old property's (this async
    // effect resolves after the customer effect's sync write, so it always won).
    // The prop only speaks for the customer it came with.
    const propertyStillApplies = !!defaultPropertyId && (!defaultCustomerId || customerId === defaultCustomerId)
    let active = true
    async function load() {
      const supabase = createClient()
      const cols = 'lawn_sqft, measurement_history, address, city, province'
      const res = propertyStillApplies
        ? await supabase.from('properties').select(cols).eq('id', defaultPropertyId!).limit(1).maybeSingle()
        : await supabase.from('properties').select(cols).eq('customer_id', customerId).order('is_primary', { ascending: false }).limit(1).maybeSingle()
      if (!active) return
      const row = res.data as { lawn_sqft: number | null; measurement_history: MeasurementSnapshot[]; address: string | null; city: string | null; province: string | null } | null
      setSavedRec(latestSavedRecommendation(row?.measurement_history))
      // Default the Lawn Size from the property's saved size when it's still empty
      // OR still holding our own previous fill — don't clobber an edit, a
      // website-measurement handoff, or a manual entry, but DO follow a customer
      // switch (see autoFilledSqft above). When the new property has no saved size
      // and the field still holds the OLD property's auto-fill, clear it: a lawn
      // size nothing backs must not keep pricing the plan tiles.
      const lawn = Number(row?.lawn_sqft) || 0
      const currentSqft = Number(getValues('measured_sqft')) || 0
      if (!isEdit && lawn > 0 && (currentSqft === 0 || currentSqft === autoFilledSqft.current)) {
        setValue('measured_sqft', lawn)
        autoFilledSqft.current = lawn
      } else if (!isEdit && lawn === 0 && currentSqft > 0 && currentSqft === autoFilledSqft.current) {
        setValue('measured_sqft', 0)
        autoFilledSqft.current = null
      }
      // Targeting a specific property → its address wins. Otherwise the primary
      // property's address fills the field only when it's still EMPTY or still
      // holds OUR OWN previous fill (imported customers and website leads often
      // carry the address on the property, not the customer record — never make
      // the owner retype data we just fetched, and never overwrite what they typed:
      // the same autoFilledAddress contract the customer effect above enforces).
      if (!isEdit && row?.address) {
        const full = [row.address, row.city, row.province].filter(Boolean).join(', ')
        const current = String(getValues('address') || '')
        if (full && (propertyStillApplies || !current.trim() || current === autoFilledAddress.current)) {
          setValue('address', full)
          autoFilledAddress.current = full
        }
      }
    }
    load()
    return () => { active = false }
  }, [customerId, defaultPropertyId, defaultCustomerId, isEdit, getValues, setValue])

  // Same rule for the notes a template pre-fills. Changing service used to
  // REPLACE whatever was in the Notes field — including a scope the owner had
  // just written by hand, and including AI-written text whose Undo (aiScopePrior)
  // knows nothing about this write, so it restores the pre-assistant text rather
  // than what the template ate. Switching between templates still swaps their
  // canned descriptions (that text is ours), but typed notes now survive.
  const autoFilledNotes = useRef<string | null>(null)

  useEffect(() => {
    if (!templateId) return
    const t = templates.find(s => s.id === templateId)
    if (t) {
      setValue('service_type', t.name)
      // Only an HOURLY template's rate is a labour rate — a per-sqft or
      // starting-from figure is a PRICE and must never become $/man-hour.
      if (t.pricing_display_type === 'hourly' || t.pricing_display_type === 'hourly_materials') {
        setValue('rate', t.default_rate)
      }
      if (!isEdit && t.default_description) {
        const current = String(getValues('notes') || '')
        if (!current.trim() || current === autoFilledNotes.current) {
          setValue('notes', t.default_description)
          autoFilledNotes.current = t.default_description
        }
      }
    }
  }, [templateId, templates, setValue, getValues, isEdit])

  // The recommendation stays live in the price field until the owner owns the
  // number. What changed: it can now be ABSENT. This effect used to run on mount
  // with `suggestedInitial` = 2 × 1 × $50 and write $100 into a form with no
  // customer, no address and no service — which then rendered as "✓ Applied".
  // Now serviceRec is null unless something real backs it, and a field that was
  // only ever holding a suggestion is cleared again when that basis disappears
  // (e.g. the owner clears the hours) rather than stranding a stale number.
  useEffect(() => {
    if (priceLocked || pickedCadence) return
    const price = serviceRec?.price ?? 0
    if (price > 0) {
      setValue('initial_price', price)
      setPriceOrigin('suggested')
    } else if (priceOrigin === 'suggested') {
      // BLANK, not 0: 'empty' means the field LOOKS empty (its documented contract),
      // not that it holds a zero the owner must delete before typing.
      setValue('initial_price', BLANK)
      setPriceOrigin('empty')
    }
  }, [serviceRec, priceLocked, priceOrigin, pickedCadence, setValue])

  // Gated on tiers existing: with ZERO tiers configured (every first-run account),
  // suggestTravelFee's no-match fallback is { fee: 0, tierLabel: 'Unknown' }, which
  // rendered as a fabricated suggestion — "Unknown: $0.00" — plus an "Apply
  // suggested travel fee" button whose only possible effect was wiping the owner's
  // hand-typed fee to $0. No tiers ⇒ no suggestion to speak of, so say nothing.
  // Memoised on (distanceKm, tiers): built inline, this was a FRESH object every
  // render, and it's a dependency of the effect below — so a form that re-renders
  // on every keystroke ran a setValue on every keystroke too. Same function, same
  // arguments, same result, no longer a new object.
  const travelSuggestion = useMemo(
    () => (distanceKm > 0 && tiers.length > 0 ? suggestTravelFee(distanceKm, tiers) : null),
    [distanceKm, tiers],
  )

  useEffect(() => {
    if (travelSuggestion?.isCustom) {
      setValue('custom_travel_required', true)
    } else if (distanceKm > 0) {
      setValue('custom_travel_required', false)
    }
  }, [travelSuggestion, distanceKm, setValue])

  function applySuggestedTravel() {
    if (travelSuggestion && !travelSuggestion.isCustom && travelSuggestion.fee !== null) {
      setValue('travel_fee', travelSuggestion.fee)
    }
  }

  async function calculateDistance(addr?: string) {
    setCalcMsg(null)
    const base = settings?.base_address
    const dest = addr || address
    if (!base) { setCalcMsg({ text: 'Set your base address in Settings first.', error: true, settingsLink: true }); return }
    if (!dest) { setCalcMsg({ text: 'Enter a service address first.', error: true }); return }
    setCalcLoading(true)
    try {
      const res = await fetch('/api/distance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ origin: base, destination: dest }),
      })
      const data = await res.json()
      if (res.ok && typeof data.km === 'number') {
        setValue('distance_km', data.km)
        // Same rule as travelSuggestion above: with zero tiers, suggestTravelFee
        // only has its fabricated { fee: 0 } fallback to offer, and auto-applying
        // it here silently WIPED a typed or saved travel fee to $0 whenever the
        // address changed (AddressAutocomplete onSelect calls this) — worst on
        // edit, where the fee was already on the quote and the Travel section sat
        // collapsed out of sight. (Restored 2026-07-28 — lost in the 07-26 replay.)
        if (tiers.length > 0 && includeTravel) {
          const sugg = suggestTravelFee(data.km, tiers)
          if (!sugg.isCustom && sugg.fee !== null) setValue('travel_fee', sugg.fee)
        }
        setCalcMsg({ text: `${data.km} km${data.durationText ? ` · ${data.durationText} drive` : ''}` })
      } else {
        setCalcMsg({ text: data.error || 'Could not calculate distance.', error: true })
      }
    } catch {
      setCalcMsg({ text: 'Distance lookup failed.', error: true })
    } finally {
      setCalcLoading(false)
    }
  }

  function toggleIncludeTravel(on: boolean) {
    setIncludeTravel(on)
    if (!on) {
      setValue('travel_fee', 0)
    } else if (distanceKm > 0 && tiers.length > 0) {
      // tiers.length gate completes the invariant: suggestTravelFee is never
      // consulted without tiers anywhere in this file. (Here it was near-harmless —
      // toggling off already zeroed the fee — but one rule beats three cases.)
      const s = suggestTravelFee(distanceKm, tiers)
      if (!s.isCustom && s.fee !== null) setValue('travel_fee', s.fee)
    }
  }

  // Memoized: the builder re-renders on every keystroke (many watch() subscriptions),
  // so without this these O(n) arrays would be rebuilt — and handed as fresh refs to the
  // Select children — on each character typed. Recompute only when the source lists change.
  // The unit vocabulary (service_units): the nine system units plus this owner's
  // custom ones. It replaces a hardcoded four-value list, which is the whole
  // reason a plumber can now quote 6 fixtures and a painter 3 rooms — the line
  // maths was always qty × unit_price and never needed to change.
  //
  // Seeded with the system nine so the picker is never empty and never SHRINKS on
  // a failed read — loadServiceUnits() falls back to the same nine, so the only
  // thing a failure costs is this owner's custom units. It used to fall back to a
  // four-value constant, which silently dropped fixture/room/zone/equipment/flat.
  const [units, setUnits] = useState<ServiceUnit[]>(SYSTEM_UNITS)
  useEffect(() => {
    let alive = true
    loadServiceUnits(createClient()).then(u => { if (alive) setUnits(u) })
    return () => { alive = false }
  }, [])
  const unitOptions = useMemo(() => units.map(u => ({ value: u.code, label: u.label })), [units])

  // What an EXTRA line may pick from: active services only, plus whichever
  // template this line already points at, so editing an older quote never blanks
  // its own selection just because the service was retired since. The RAW list
  // would offer switched-off services at stale rates, one tap from the total.
  // Returns templates (not {value,label}) because the line's control is the same
  // ServicePicker as the primary one — it prices each row through the same
  // formatServicePrice seam, so there is nothing left to pre-format here.
  const lineTemplateOptions = (currentId?: string | null) => {
    const own = currentId ? templates.filter(t => t.id === currentId && !t.is_active) : []
    return [...activeTemplates, ...own]
  }

  // ── Line-pricing clarity (Additional services + Materials) ───────────────────
  // The Qty field wears the UNIT's name. A static "Qty" made hourly pricing
  // invisible: picking a "$95/hr" template filled Unit price and flipped the unit
  // to hours, but the line still read "Qty 1 × $95" — so a 3-hour hedge job went
  // out at a third of its price unless the owner guessed that Qty meant hours.
  // "Hours: 3" is unmistakable; same for "Square feet: 1,200" and "Cubic yards".
  // Each/flat keep the plain "Qty" (their quantity really is just a count).
  const unitFor = (code: string | null | undefined) => units.find(u => u.code === (code || 'each'))
  const qtyLabelFor = (code: string | null | undefined) => {
    const u = unitFor(code)
    return u && u.code !== 'each' && u.code !== 'flat' ? u.label : 'Qty'
  }
  // How this line's price forms, spelled out by the SAME engine that sums it
  // (serviceLineTotals — never a second multiplication here). Shown only when it
  // says something the header net doesn't: a quantity in play or a discount at
  // work. Mirrors the engine's qty ≤ 0 → 1 rule so the equation can never
  // disagree with the money it explains.
  const lineEquation = (line: (Parameters<typeof serviceLineTotals>[0] & { unit?: string | null }) | undefined) => {
    if (!line) return null
    const qty = Number(line.quantity) > 0 ? Number(line.quantity) : 1
    const price = Number(line.unit_price) || 0
    if (price <= 0) return null
    const t = serviceLineTotals(line)
    if (qty === 1 && t.discountAmount <= 0) return null   // header net already says it all
    const u = unitFor(line.unit)
    const unitBit = u && u.code !== 'each' && u.code !== 'flat' ? ` ${u.abbrev}` : ''
    return `${qty}${unitBit} × ${formatCurrency(price)}${t.discountAmount > 0 ? ` − ${formatCurrency(t.discountAmount)} off` : ''} = ${formatCurrency(t.net)}`
  }

  // (activeTemplates is declared above, before its first reader — see §1's TDZ rule.)
  // The flattened `templateOptions` list a native <select> needed is gone with it:
  // ServicePicker takes the templates themselves, so the star, the name and the
  // price are three fields of a row instead of one concatenated string.
  // QL-1: there is no status dropdown here, on purpose. QuoteStatusControl (on the
  // quote detail page) is the ONE status writer — it routes sent→markSentPatch and
  // accepted→markWonPatch, so sent_at/valid_until and the acceptance snapshot are
  // always set. A raw status write from this form was a second, incomplete writer:
  // setting 'Sent' here left sent_at/valid_until null, so the quote could never
  // expire (the 0-of-55 bug) and entered the follow-up queue as a lie. The builder
  // edits quote CONTENT only; status transitions happen through the control.
  const showManualName = !customerId || customerId === '__manual'
  // A first-ever quote has nobody to search: with zero customers the picker's only
  // dropdown rows are an empty-state whose copy ("add one to start a conversation")
  // sends a brand-new owner AWAY from the form that saves the customer automatically,
  // and "+ Enter manually" — the state the form is ALREADY in (the manual fields
  // render below whenever no customer is linked). A search box whose every outcome
  // is the state you're already in is pure friction, so it's hidden and the form
  // leads with the manual fields. Kept whenever a customer IS linked, so editing can
  // always re-point. Same rule as the catalogue picker: hidden until there's
  // something to pick. '' vs '__manual' changes nothing — every reader (submit,
  // likelyMatch, activeCustomerId) treats them identically.
  const showCustomerPicker = customers.length > 0 || !showManualName

  // ── The discount / value / notes row, defined ONCE ───────────────────────────
  // A service line and a material line end in the identical trio — same fields,
  // same registers, same layout — because both are the same species of line (one
  // `services` array, one totals engine). Rendered from both editors below so the
  // two can't drift, the same reason `previewBreakdown` exists. `i` is the real
  // field-array index the row registers against.
  const lineDiscountRow = (i: number) => {
    // applyDiscount deliberately ignores a half-specified discount (a Value with
    // no $/% picked, a type with no Value) — correct maths, silent trap: the
    // owner promised "$20 off", the line kept charging full price, and the save
    // dropped the orphan half without a trace. Say so in the moment instead —
    // warn-never-block, and the lineEquation above confirms once it applies.
    const dv = Number(watch(`services.${i}.discount_value`)) || 0
    const dt = watch(`services.${i}.discount_type`)
    const halfSpecified = dv > 0 && !dt
      ? 'Pick “$ off” or “% off” — this discount isn’t applied yet.'
      : dt && dv <= 0 ? 'Enter a discount amount — nothing is taken off yet.' : null
    return (
      <>
        <div className="grid grid-cols-2 sm:grid-cols-[auto_auto_1fr] gap-3 items-end">
          <Select label="Discount" placeholder="None"
            options={[{ value: 'amount', label: '$ off' }, { value: 'percent', label: '% off' }]}
            {...register(`services.${i}.discount_type` as const)} />
          <Input label="Value" type="number" step="1" min="0"
            {...register(`services.${i}.discount_value` as const, { min: 0 })} />
          <Input label="Notes" placeholder="Optional"
            {...register(`services.${i}.notes` as const)} />
        </div>
        {halfSpecified && <p className="text-[11px] text-amber-400">{halfSpecified}</p>}
      </>
    )
  }

  // ── The price breakdown, defined ONCE ────────────────────────────────────────
  // Rendered by the desktop preview card AND the mobile sheet below. It used to
  // live only inside `hidden lg:block`, so a contractor quoting from a phone in
  // someone's driveway saw a single number — no hours, no travel, no discount,
  // and no Weekly/Bi-Weekly/Monthly prices, which for a mowing business ARE the
  // product. "What's it per cut if I go weekly?" was unanswerable without a
  // laptop. Same JSX both places: one breakdown, no second copy to drift.
  const previewBreakdown = (
    <>
      {/* Only when there ARE hours. `Number(hours).toFixed(1)` rendered unknown
          hours as "0.0 hrs · 1 crew" — a confident claim that the job takes no
          time, in the one place the owner checks their numbers, on a form whose
          doctrine is "unknown stays unknown". The labour SUMMARY one section up
          already says "Not estimated yet" for exactly this state; the breakdown
          was still asserting the zero. */}
      {Number(hours) > 0 && (
        <div className="flex items-center justify-between text-sm">
          <span className="flex items-center gap-2 text-ink-muted"><Clock className="w-3.5 h-3.5" /> Hours</span>
          <span className="text-ink font-medium tabular-nums">{Number(hours).toFixed(1)} hrs · {crewSize} crew</span>
        </div>
      )}
      <div className="border-t border-border pt-3 space-y-2">
        {/* ⭐ With options on, this list is the one place the owner can be
            misread into thinking the alternatives combine — so it prints each
            option's OWN customer-facing figure and no subtotal, and the total
            row below names which single option the quote is currently worth.
            There is no row here that adds two options together. */}
        {optionsOn ? (
          watchedOptions.length > 0 ? watchedOptions.map((o, i) => (
            <div key={o.id || `p-${i}`} className="flex items-center justify-between text-sm gap-3">
              <span className={cn('truncate', o.is_recommended ? 'text-accent-text font-medium' : 'text-ink-muted')}>
                {o.name?.trim() || `Option ${i + 1}`}{o.is_recommended ? ' · recommended' : ''}
              </span>
              <span className="text-ink font-medium tabular-nums shrink-0">
                {formatCurrency((Number(o.price) || 0) + Number(travelFee || 0))}
              </span>
            </div>
          )) : <p className="text-sm text-ink-faint">No options yet.</p>
        ) : (
        <div className="flex items-center justify-between">
          <span className="text-sm text-ink-muted">First visit{priceOrigin === 'manual' ? ' (manual)' : ''}</span>
          <span className="text-ink font-semibold tabular-nums">{initialPrice > 0 ? formatCurrency(initialPrice) : '—'}</span>
        </div>
        )}
        {/* Split, and counted correctly. ONE row labelled "Additional services
            (N)" used serviceLines.fields.length — the length of the array holding
            BOTH kinds — over a figure that also included materials. One hedge trim
            plus two yards of mulch read "Additional services (3)". Both subtotals
            come from the same sumServiceLines engine as `extras`, and
            serviceExtras.net + materialsSum.net === extras.net, so the total below
            is untouched. */}
        {serviceExtras.net > 0 && (
          <div className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-2 text-ink-muted"><Layers className="w-3.5 h-3.5" /> Additional services ({serviceIdx.length})</span>
            <span className="text-ink font-medium tabular-nums">{formatCurrency(serviceExtras.net)}</span>
          </div>
        )}
        {materialsSum.net > 0 && (
          <div className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-2 text-ink-muted"><Package className="w-3.5 h-3.5" /> Materials ({materialIdx.length})</span>
            <span className="text-ink font-medium tabular-nums">{formatCurrency(materialsSum.net)}</span>
          </div>
        )}
        {/* A $0.00 travel line on a quote with no travel fee is a row that only
            ever says "nothing here"; the Travel section's own summary already
            reports "No fee yet" / "Absorbing travel". */}
        {Number(travelFee) > 0 && (
          <div className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-2 text-ink-muted"><Car className="w-3.5 h-3.5" /> Travel{showTravelSeparately ? ' (shown)' : ''}</span>
            <span className="text-ink font-medium tabular-nums">{formatCurrency(Number(travelFee))}</span>
          </div>
        )}
        <div className="flex items-center justify-between pt-2 border-t border-border">
          <span className="text-sm font-semibold text-ink">
            {optionsOn ? 'Quote value' : 'First visit total'}
          </span>
          <span className="text-2xl font-bold text-accent-text tabular-nums">{effectiveTotal > 0 ? formatCurrency(effectiveTotal) : '—'}</span>
        </div>
        {/* Which of the two things that number means — the reporting semantics,
            said where the owner sets the numbers. */}
        {optionsOn && effectiveTotal > 0 && (
          <p className="text-[11px] text-ink-faint">
            {optionsLocked
              ? `${optionsLockedName} — the option the customer approved.`
              : `Your ${recommended ? recommended.name : 'first'} option. The customer pays for the ONE they choose — never the total of all ${watchedOptions.length}.`}
          </p>
        )}
        {/* §14 — the mistake the product can't undo: a priceless quote saves
            happily and afterwards looks identical to a priced one, in the list,
            on the PDF and in the portal. Say so BEFORE the tap, next to the
            total, in both breakdowns (this JSX renders in the desktop card AND
            the mobile sheet). Warns, never blocks: a placeholder quote the
            owner will price later is legitimate. */}
        {effectiveTotal <= 0 && !(weeklyPrice > 0 || biweeklyPrice > 0 || monthlyPrice > 0) && (
          <p className="text-[11px] text-amber-400 flex items-start gap-1.5 leading-snug">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
            No price yet — saving now creates a $0 quote. You can price it later.
          </p>
        )}
        {/* Same predicate and promise as QuotePDF's "Plus GST (X%) — added on your
            invoice". The owner's checking surface was the ONLY totals surface not
            disclosing it — so a registered owner read "$180" here, said "$180
            all-in" at the door, and the first invoice arrived at $189. */}
        {Number(settings?.gst_percent) > 0 && effectiveTotal > 0 && (
          <p className="text-xs text-ink-faint text-right">Plus GST ({Number(settings?.gst_percent)}%) — added on the invoice</p>
        )}
      </div>
      {(weeklyPrice > 0 || biweeklyPrice > 0 || monthlyPrice > 0) && (
        <div className="border-t border-border pt-3 space-y-1.5">
          <p className="text-xs font-semibold text-ink-muted uppercase tracking-wide">Plan options</p>
          {weeklyPrice > 0 && <div className="flex justify-between text-sm"><span className="text-ink-muted">Weekly</span><span className="text-ink font-medium tabular-nums">{formatCurrency(weeklyPrice)}/visit</span></div>}
          {biweeklyPrice > 0 && <div className="flex justify-between text-sm"><span className="text-ink-muted">Bi-Weekly</span><span className="text-ink font-medium tabular-nums">{formatCurrency(biweeklyPrice)}/visit</span></div>}
          {monthlyPrice > 0 && <div className="flex justify-between text-sm"><span className="text-ink-muted">Monthly</span><span className="text-ink font-medium tabular-nums">{formatCurrency(monthlyPrice)}/visit</span></div>}
        </div>
      )}
    </>
  )

  // The persistent $0-save note + relabeled button — rendered beside BOTH save
  // controls, never a toast (a toast fades, and the withheld first save would
  // read as Save silently doing nothing — this file's own documented bug DNA).
  const zeroSaveNote = zeroTotalArmed && effectiveTotal <= 0 ? (
    <p className="text-xs text-amber-400 font-medium">
      No first-visit price — this saves as a draft, but it can&rsquo;t be sent, PDF&rsquo;d or invoiced until it has one.
    </p>
  ) : null
  const saveLabel = zeroTotalArmed && effectiveTotal <= 0 ? 'Save anyway' : isEdit ? 'Update quote' : 'Save quote'

  return (
    <form onSubmit={submit} className="pb-24 lg:pb-0">
      {autosave.draft && (
        <div className="mb-4">
          <DraftRestoreBanner
            savedAt={autosave.savedAt}
            label="unsaved quote"
            onRestore={() => {
              const v = autosave.restore()
              if (!v) return
              reset(v)
              // reset() restores the VALUES but not the ownership state, and the
              // draft never persisted priceOrigin/includeMonthly. Left at 'empty',
              // the reconciliation effect immediately overwrote a restored
              // hand-typed price with the live labour suggestion — then the
              // debounced autosave wrote that wrong price back over the draft too.
              // Same inference the saved-quote load path already makes (a loaded
              // non-zero price is the owner's own decision → 'manual'; a non-zero
              // monthly means monthly was enabled).
              if ((Number(v.initial_price) || 0) > 0) setPriceOrigin('manual')
              if ((Number(v.monthly_price) || 0) > 0) setIncludeMonthly(true)
              // includeTravel too — it was seeded at mount from the SERVER record,
              // so restoring an absorbed-travel draft over a quote that charged
              // travel left the toggle ON: the next "Calculate distance" (or
              // toggle cycle) re-applied the tier fee to a draft written without
              // any. Re-run the mount seed's EXACT formula over the draft's fee:
              // a new quote keeps its charging default; an edit reads the draft.
              setIncludeTravel(!isEdit || (Number(v.travel_fee) || 0) > 0)
            }}
            onDiscard={autosave.discard}
          />
        </div>
      )}
      <div className="grid lg:grid-cols-3 gap-6">
        {/* ⚠️ min-w-0 — a grid item defaults to `min-width: auto`, so this column
            refuses to be narrower than its content's MIN-CONTENT, and the widest
            min-content in here is a Collapsible header row: icon + title +
            summary + chevron, with the summary counted UN-WRAPPED even though it
            has `truncate min-w-0` (measured; a zero flex-basis doesn't change it
            either). At 390px the page had no horizontal overflow only because
            the longest summary happened to fit — lengthening one by seventeen
            characters pushed this column to 423px inside a 390px viewport, and
            the phone got a sideways scroll on the quote form. With min-w-0 the
            column takes the viewport's width and the summary truncates, which is
            what a truncating one-liner was always for. */}
        <div className="lg:col-span-2 space-y-4 min-w-0">
          {/* ── FAST PATH — Customer → Property → Service → Price → Save ── */}
          <Card>
            <CardHeader className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-ink">{isEdit ? 'Quote details' : 'New quote'}</h2>
              <div className="flex items-center gap-2">
                <AutosaveStatus status={autosave.status} savedAt={autosave.savedAt} />
                {/* Three states, three words. This badge used to read "Manual price"
                    for BOTH a hand-typed number and an accepted recommendation —
                    the single boolean behind it couldn't tell them apart, which
                    undersold every price the engines got right. */}
                {priceOrigin === 'suggested' && (
                  <span className="text-[10px] uppercase tracking-wide text-ink-muted border border-border-strong rounded px-1.5 py-0.5">Suggested</span>
                )}
                {priceOrigin === 'applied' && (
                  <span className="text-[10px] uppercase tracking-wide text-emerald-400 border border-emerald-500/30 bg-emerald-500/10 rounded px-1.5 py-0.5">Applied</span>
                )}
                {priceOrigin === 'manual' && (
                  <span className="text-[10px] uppercase tracking-wide text-amber-400 border border-amber-500/30 bg-amber-500/10 rounded px-1.5 py-0.5">Manual price</span>
                )}
              </div>
            </CardHeader>
            <CardBody className="space-y-4">
              {/* Customer — type-to-search picker (scales past a giant <select>).
                  Hidden on a first-ever quote (see showCustomerPicker); the form
                  keeps customer_id in state while unmounted (no shouldUnregister). */}
              {showCustomerPicker && (
                <Controller name="customer_id" control={control}
                  render={({ field }) => (
                    <CustomerPicker label="Customer" customers={customers} value={field.value || ''} onChange={field.onChange}
                      // The typed search IS the new customer's name — carry it into
                      // the manual Name field instead of making the owner type it
                      // twice. Fill-when-empty only (the file's own overwrite rule):
                      // a name already entered is never replaced.
                      onManual={typed => { if (typed && !String(getValues('customer_name') || '').trim()) setValue('customer_name', typed) }} />
                  )} />
              )}
              {showManualName && (
                <div className="space-y-3 rounded-xl border border-accent/20 bg-accent/5 p-3">
                  <p className="text-[11px] text-ink-muted flex items-center gap-1.5">
                    <CheckCircle2 className="w-3.5 h-3.5 text-accent-text" /> New person — we&apos;ll save them as a customer &amp; property automatically when you save.
                  </p>
                  <Input label="Customer Name *" placeholder="Jane Smith"
                    error={errors.customer_name?.message}
                    {...register('customer_name', { required: 'Customer name is required' })} />
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <Input label="Phone" type="tel" placeholder="(403) 555-0100"
                      hint="Used to avoid duplicates" {...register('customer_phone')} />
                    <Input label="Email" type="email" placeholder="jane@example.com"
                      {...register('customer_email')} />
                  </div>

                  {/* Likely-match prompt — use the existing customer instead of duplicating */}
                  {likelyMatch && (
                    <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5 space-y-2">
                      <p className="text-xs text-ink flex items-start gap-1.5">
                        <Users className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
                        <span>
                          {likelyMatch.confident
                            ? <>Looks like an existing customer — <span className="font-semibold">{likelyMatch.customer.name}</span> (same {likelyMatch.reason}).</>
                            : <>Possible existing customer — <span className="font-semibold">{likelyMatch.customer.name}</span> (same name).</>}
                          {' '}<span className="text-ink-muted">Use them to avoid a duplicate?</span>
                        </span>
                      </p>
                      <div className="flex items-center gap-2">
                        <Button type="button" variant="secondary" size="sm" onClick={() => setValue('customer_id', likelyMatch.customer.id)}>
                          Use {likelyMatch.customer.name.split(' ')[0]}
                        </Button>
                        <span className="text-[10px] text-ink-faint">or keep typing to save as new</span>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Property */}
              <Controller name="address" control={control}
                rules={{ required: 'Address is required' }}
                render={({ field }) => (
                  <AddressAutocomplete
                    label="Service Address *"
                    placeholder="123 Main Street, Calgary, AB"
                    value={field.value || ''}
                    onChange={field.onChange}
                    onSelect={(p) => { field.onChange(p.formatted); calculateDistance(p.formatted) }}
                    error={errors.address?.message}
                  />
                )} />

              {/* Service FIRST (owner directive) — measurement, suggested pricing,
                  intelligence, duration and profitability below are all specific to
                  the selected service. */}
              {/* ── ONE service control ──────────────────────────────────────────
                  This was two: a catalogue <select> (a wrapped chip row at ≤6
                  services) and then "Service Name *" underneath, which the select
                  auto-filled. Two labels, one question — and the required one is
                  the one that looks unanswered. The select could only ever offer
                  catalogue rows, which is the whole reason the second field had to
                  exist: custom work has to be typeable somewhere.
                  ServicePicker is that somewhere. It IS the service_type input —
                  same register, same `required` rule, same errors, same setFocus
                  target — with the catalogue hanging off it. Type to filter, pick
                  a row to adopt a service, or type anything at all and it's a
                  custom service that is already named. Nothing downstream knows
                  which one happened.
                  service_template_id moves to a hidden registered input for the
                  same reason `services.${i}.kind` is one: an unregistered field is
                  dropped at submit, and that id is what tells the pricing seam
                  which engine may recommend. */}
              <input type="hidden" {...register('service_template_id')} />
              {activeTemplates.length > 0 ? (
                <ServicePicker
                  label="Service *"
                  templates={activeTemplates}
                  templateId={templateId}
                  recentIds={recentTemplateIds}
                  placeholder={`Search or type — e.g. ${activeTemplates[0]?.name || 'Weekly Service'}`}
                  hint={svcTemplate && !nameSettledByTemplate
                    ? <>Renamed on this quote — from your <span className="text-ink-muted">{svcTemplate.name}</span> service.</>
                    : 'Pick one of yours, or type any name for custom work.'}
                  error={errors.service_type?.message}
                  onPick={t => {
                    // The picker sets the ID and lets the template effect derive
                    // name, rate and canned description — the ONE road in, the
                    // same one QuoteMeasure's onServiceChange takes. Re-picking
                    // the service you already have is how a rename is undone, and
                    // that effect only fires on a CHANGE, so say the name here.
                    const same = getValues('service_template_id') === t.id
                    setValue('service_template_id', t.id)
                    if (same) setValue('service_type', t.name)
                  }}
                  // Only the LINK is dropped — the name the owner typed is the
                  // quote's, and clearing it would empty a required field. The
                  // template effect returns early on an empty id, so nothing
                  // refills behind this.
                  onDetach={() => setValue('service_template_id', '')}
                  {...register('service_type', { required: 'Service is required' })} />
              ) : (
                // No catalogue yet — a picker with nothing to pick is a door onto a
                // wall. The plain field, and a hint that names the page that fills it.
                <Input label="Service *" placeholder="e.g. Weekly Service"
                  hint="The name of this service, as it appears on the quote."
                  error={errors.service_type?.message}
                  {...register('service_type', { required: 'Service is required' })} />
              )}

              {/* §2.4 — the fast path leads with the fast input: the satellite
                  Measure button sits ABOVE the manual area field, not after it. */}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <Button type="button" variant="secondary" size="sm"
                  onClick={() => {
                    // Immediate feedback where the tap happened — a message inside
                    // the collapsed Travel section is a silent failure.
                    if (!address) { toast.error('Enter a service address first.'); return }
                    setShowMeasure(true)
                  }}>
                  {/* Only the lawn cadence engine prices FROM the satellite trace, so
                      only it may promise a price on the button that opens the map. */}
                  <Ruler className="w-3.5 h-3.5" /> {pricingKind === 'lawn_recurring' ? 'Measure & price from satellite' : 'Measure from satellite'}
                </Button>
                {measuredSqft > 0 && (
                  <span className="inline-flex items-center gap-1 text-xs text-emerald-400">
                    <CheckCircle2 className="w-3.5 h-3.5" /> {Math.round(measuredSqft).toLocaleString()} sq ft measured
                  </span>
                )}
              </div>

              {/* A measured AREA — a core property attribute (powers pricing, labour
                  & future analytics). Auto-filled from a website/satellite measurement
                  or the property's saved size; always editable, and synced back to the
                  property on save. The stored column stays `measured_sqft` /
                  `lawn_sqft` (read in ~74 places — renaming it is a migration, not a
                  label fix), only the words change.
                  §2.4 — rendered as a full field only when the area PRICES this
                  service or a figure already exists; for labour trades a full-width
                  numeric input whose caption explains its own irrelevance collapses
                  to an opt-in link. The field stays registered either way. */}
              {(areaPricesService || measuredSqft > 0 || showAreaField) ? (
                <Input label="Measured Area (ft²)" type="number" step="1" min="0"
                  placeholder="e.g. 5,000"
                  hint={pricingKind === 'lawn_recurring'
                    ? 'Powers pricing & labour. Auto-filled from a measurement or the saved property size — edit to correct.'
                    : pricingKind === 'per_area'
                      ? 'Multiplied by your per-unit rate to price this service. Auto-filled from a measurement or the saved property size.'
                      : 'Optional for this service — it feeds the labour estimate, not the price. Auto-filled from a measurement or the saved property size.'}
                  {...register('measured_sqft', { min: 0 })} />
              ) : (
                <button type="button" onClick={() => setShowAreaField(true)}
                  className="self-start text-xs font-medium text-accent-text hover:underline rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                  + Enter measured area (optional — feeds the labour estimate)
                </button>
              )}

              {/* ── THE recommended price ─────────────────────────────────────
                  ONE primary recommendation per service kind; everything below
                  it supports that number instead of competing with it.
                  • Lawn cadence services → Pricing Intelligence (engine anchor +
                    win-history + minimum floor) is the primary; the cadence
                    tiles below are the supporting structure it fills.
                  • Everything else (mulch, cleanups, hedges…) → one card from
                    the service-appropriate engine (area rate or labour). */}
              {pricingKind === 'lawn_recurring' && measuredSqft > 0 && (
                <PriceIntelligence
                  sqft={measuredSqft}
                  serviceType={watch('service_type')}
                  cadence={recommendedCadence}
                  overgrowth={overgrowth}
                  propertyId={defaultPropertyId}
                  customerId={activeCustomerId}
                  currentPrice={recommendedCadence === 'one_time' ? initialPrice
                    : recommendedCadence === 'weekly' ? weeklyPrice
                      : recommendedCadence === 'biweekly' ? biweeklyPrice : monthlyPrice}
                  onApply={(price) => {
                    // Accept = fill the FULL lawn structure in one tap: the learned
                    // price takes the recommended cadence's slot, the engine fills
                    // the rest (monthly only when enabled). Everything stays editable.
                    if (!suggested) {
                      setValue('initial_price', price); setValue('suggested_price', price); markApplied()
                      return
                    }
                    const c = suggested.recommended
                    setValue('initial_price', c === 'one_time' ? price : suggested.one_time)
                    setValue('weekly_price', c === 'weekly' ? price : suggested.weekly)
                    setValue('biweekly_price', c === 'biweekly' ? price : suggested.biweekly)
                    setValue('monthly_price', includeMonthly ? (c === 'monthly' ? price : suggested.monthly) : 0)
                    setValue('suggested_price', suggested.one_time)
                    markApplied()
                    setPickedCadence(c === 'monthly' ? null : c)
                  }}
                />
              )}

              {/* One-off / area services: the single service-appropriate price. */}
              {pricingKind !== 'lawn_recurring' && serviceRec && (
                <div className="rounded-xl border border-accent/30 bg-accent/[0.06] p-3 animate-fade">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Recommended price</p>
                      <p className="text-xl font-bold text-ink leading-tight mt-0.5 tabular-nums">{formatCurrency(serviceRec.price)}</p>
                      <p className="text-[11px] text-ink-muted mt-0.5">
                        {serviceRec.basis}{serviceRec.materials ? ' · plus materials' : ''}
                      </p>
                    </div>
                    {/* "Applied" means the owner accepted it — nothing else. This
                        used to be `|initialPrice − serviceRec.price| < 0.5`, which
                        is true by construction the instant the form loads (the
                        field is filled FROM this number), so a price nobody had
                        looked at rendered as confirmed. Equal values are not
                        consent; only priceOrigin === 'applied' is. */}
                    {priceOrigin === 'applied'
                      ? <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-400 shrink-0 animate-fade"><CheckCircle2 className="w-3.5 h-3.5" /> Applied</span>
                      : (
                        <Button type="button" size="sm" onClick={applyServiceRec} className="shrink-0">
                          <CheckCircle2 className="w-3.5 h-3.5" /> Accept
                        </Button>
                      )}
                  </div>
                  <p className="text-[10px] text-ink-faint mt-1.5">
                    {serviceRec.source === 'area_rate'
                      ? 'One-time job — Accept fills the price; recurring fields stay empty.'
                      : serviceRec.source === 'catalog_price'
                        ? 'Your own starting price for this service — add hours in the Labour calculator to price the actual job.'
                        : 'Priced from labour — fine-tune hours & crew in Advanced Pricing below.'}
                    {serviceRec.materials ? ' Add materials as Additional services or into the price.' : ''}
                  </p>
                </div>
              )}

              {/* ── Nothing honest to recommend ──────────────────────────────────
                  Still said out loud — "we don't know yet" is the state this
                  builder exists to be able to express, and an owner trusts the
                  numbers that ARE shown only because the product is willing to
                  show none. What changed is its WEIGHT. It was a bordered panel
                  headed NO RECOMMENDED PRICE, sitting above the price field and
                  shouting an absence; the same sentence now rides the price
                  field's own hint line, where it reads as help for the box the
                  owner is about to type in. Same words (noRecReason, unchanged),
                  same links to the Settings page they name, one less panel. */}

              {/* Supporting cadence structure (lawn services) — Accept above fills
                  these together; tap one to lead with a different frequency. */}
              {suggested && (
                <div>
                  {/* §2.5 — the heading already says "one tap fills all"; the
                      14-word restatement it used to carry underneath is gone, and
                      the Monthly pill rides the heading row instead. */}
                  <div className="flex items-center justify-between gap-2 mb-1.5">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Plan options — one tap fills all</p>
                    <button type="button"
                      aria-pressed={includeMonthly}
                      onClick={() => {
                        const next = !includeMonthly
                        setIncludeMonthly(next)
                        // Off always clears; on fills ONLY an empty field. The old
                        // guard (`priceOrigin !== 'manual'`) let one pill cycle
                        // overwrite a hand-typed monthly price while the origin
                        // still read 'applied' — and could claim "Monthly: on"
                        // over a field it had declined to fill.
                        if (!next) setValue('monthly_price', 0)
                        else if (suggested && !(Number(getValues('monthly_price')) > 0)) setValue('monthly_price', suggested.monthly)
                      }}
                      className={cn('shrink-0 text-[10px] font-semibold rounded-full px-2 py-0.5 border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                        includeMonthly ? 'text-accent-text border-accent/40 bg-accent/10' : 'text-ink-faint border-border hover:text-ink')}>
                      {includeMonthly ? 'Monthly: on' : '+ Monthly'}
                    </button>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    {([
                      { c: 'weekly', label: 'Weekly', price: suggested.weekly, per: '/visit' },
                      { c: 'biweekly', label: 'Bi-Weekly', price: suggested.biweekly, per: '/visit' },
                      { c: 'one_time', label: 'One-Time', price: suggested.one_time, per: '' },
                    ] as const).map(opt => {
                      const active = pickedCadence === opt.c && priceOrigin === 'applied'
                      return (
                        // aria-pressed (§7): the selection ring is visual-only, so
                        // without it a screen reader hears three identical price
                        // buttons and no way to tell which plan is picked.
                        <button key={opt.c} type="button" aria-pressed={active} onClick={() => applySuggested(opt.c)}
                          className={cn('rounded-xl border p-2.5 text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50', // transition-all so the selection ring eases in too
                            active ? 'border-accent bg-accent/10 ring-1 ring-accent' : 'border-border bg-surface hover:border-border-strong')}>
                          <span className="flex items-center justify-between gap-1">
                            <span className="text-[11px] font-medium text-ink-muted">{opt.label}</span>
                            {/* ONE recommendation on screen: when Pricing Intelligence is
                                the primary card, the tile badge would be a second,
                                differently-priced "Rec". */}
                            {!(pricingKind === 'lawn_recurring' && measuredSqft > 0) && suggested.recommended === opt.c && <span className="text-[10px] font-bold uppercase tracking-wide text-accent-text">Rec</span>}
                          </span>
                          <span className="block text-base font-bold text-ink mt-0.5 leading-tight tabular-nums">
                            {formatCurrency(opt.price)}<span className="text-[10px] font-normal text-ink-faint">{opt.per}</span>
                          </span>
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}

              {/* ── THE PRICE ────────────────────────────────────────────────────
                  The number the whole document is about, and it lived one
                  disclosure deep inside a COLLAPSED "Advanced Pricing" — directly
                  under a card that says, in this very card body, "No recommended
                  price · …type a price." There was no price field on screen to
                  type it into. That is the DEFAULT state for every trade the lawn
                  engine can't price and for every business with no history yet,
                  and editing a saved quote to change its price was the same hunt.
                  It is one field; it belongs under whatever recommendation is (or
                  isn't) offered. Same registration, same hint states, same
                  priceOrigin tracking — only its position changed. */}
              {/* ── One price, or a choice of them ────────────────────────────
                  A normal quote must stay exactly as simple as it was, so this
                  is a switch and not a mode the form is always half in: off (the
                  default, and the state of every quote that exists) renders the
                  single Price field below and nothing else changes. On, the
                  alternatives editor takes its place — not sits beside it, because
                  `initial_price` can hold one or the other and a form showing both
                  would be asking which of two numbers is the price. */}
              <div className={cn('rounded-xl border px-3 py-2.5', optionsOn ? 'border-accent/30 bg-accent/[0.03]' : 'border-border bg-bg-secondary/50')}>
                <Toggle
                  checked={optionsOn}
                  onChange={on => {
                    setValue('has_options', on)
                    // Seed on FIRST use only. Flipping off and back on returns the
                    // owner to what they typed — re-seeding would silently discard it.
                    if (on && (getValues('options') || []).length === 0) {
                      setValue('options', EXAMPLE_OPTION_NAMES.map(e => ({
                        name: e.name, description: '', price: 0, is_recommended: e.is_recommended,
                      })))
                    }
                  }}
                  label="Offer multiple options"
                  disabled={optionsLocked}
                />
                <p className="text-[11px] text-ink-faint mt-1">
                  {optionsOn
                    ? 'The customer picks one and approves it. Options replace the single price and the line-by-line breakdown.'
                    : 'Give the customer a choice of scopes — Budget / Standard / Premium — instead of one price.'}
                </p>
              </div>

              {optionsOn ? (
                <>
                  <QuoteOptionsEditor
                    options={watchedOptions}
                    onChange={next => setValue('options', next, { shouldDirty: true })}
                    travelFee={Number(travelFee) || 0}
                    lockedSelectedName={optionsLockedName ?? null}
                  />
                  {/* The database refuses a quote holding both, so say it here
                      rather than let Save produce a constraint error. */}
                  {optionsClashWithLines && (
                    <Banner tone="warn" icon={AlertTriangle}>{OPTIONS_VS_LINES_MESSAGE}</Banner>
                  )}
                </>
              ) : (
              <>
              <div>
                <Input label="Price ($, first visit)" type="number" step="1" min="0"
                  className="text-lg font-semibold tabular-nums"
                  hint={
                    priceOrigin === 'manual'
                      // An EMPTY manual field is a real state now (an edited quote
                      // that never had a first-visit price) — "overrides the
                      // recommendation" would be describing a number that isn't there.
                      ? (initialPrice <= 0
                        ? (serviceRec ? `No first-visit price on this quote — type one, or Use suggested (${formatCurrency(serviceRec.price)}) below.` : 'No first-visit price on this quote — recurring prices below carry it.')
                        : serviceRec ? `Manual — overrides the ${formatCurrency(serviceRec.price)} recommendation.` : 'Manual — no recommendation available for this service.')
                      : priceOrigin === 'applied'
                        ? 'Applied from the recommendation. Type to override.'
                        : serviceRec
                          ? `Suggested ${formatCurrency(serviceRec.price)} — ${serviceRec.basis}. Type to override.`
                          // No recommendation. This used to be `undefined` because a
                          // bordered "NO RECOMMENDED PRICE" panel above the field was
                          // already saying it — two notices sandwiching the one input
                          // the owner came here to fill. The panel is gone and the
                          // reason moved here, next to the box it is about.
                          : (pricingKind === 'lawn_recurring' && measuredSqft > 0)
                            ? 'No recommendation for this service yet — enter your price.'
                            : noRecReason
                  }
                  {...register('initial_price', { min: 0, onChange: () => { setPriceOrigin('manual'); setPickedCadence(null) } })} />
                {/* Only offer "use the recommendation" when one actually exists. */}
                {priceOrigin === 'manual' && serviceRec && (
                  <Button type="button" variant="ghost" size="sm" onClick={() => setPriceOrigin('empty')} className="mt-1.5">
                    Use suggested ({formatCurrency(serviceRec.price)})
                  </Button>
                )}
              </div>

              {/* Additional lines exist → say so RIGHT HERE, where the owner is
                  looking at a price that is no longer the whole first visit. The
                  extra services/materials live in sections below this card, so
                  without this the only clue the field wasn't the total was a
                  different number in the sticky bar. Tapping it opens the section
                  that holds the money. */}
              {extras.net > 0 && (
                <button type="button"
                  onClick={() => { if (serviceExtras.net > 0) setServicesOpen(true); if (materialsSum.net > 0) setMaterialsOpen(true) }}
                  className="text-left text-xs text-ink-muted rounded px-1 -mx-1 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                  Plus <span className="font-semibold text-ink tabular-nums">{formatCurrency(extras.net)}</span> in additional
                  {serviceExtras.net > 0 ? ' services' : ''}{serviceExtras.net > 0 && materialsSum.net > 0 ? ' &' : ''}{materialsSum.net > 0 ? ' materials' : ''} below
                  {' '}— first visit total <span className="font-semibold text-accent-text tabular-nums">{formatCurrency(effectiveTotal)}</span>
                </button>
              )}

              {/* Guardrails follow the price they judge. They rendered inside the
                  "Plan pricing" sub-section, so a warning that the FIRST-VISIT
                  price is below the crew-cost floor waited for someone to open a
                  section about recurring plans. A never-block warning nobody sees
                  is not a warning. Moved, not copied.
                  With options on there is no single first-visit price for them to
                  judge — `initial_price` is blank and the guardrails would report
                  a $0 job as below the floor, which is true of a number nobody
                  entered. Silence is the honest answer, not a warning about zero. */}
              <PriceGuardrailNote guardrails={priceGuardrails} />
              </>
              )}

            </CardBody>
          </Card>

          {/* ── The pricing engine sections — Labour · Plan pricing · Travel ────
              These were three Collapsibles NESTED inside an "Advanced Pricing"
              shell: two disclosure taps to the first labour field, and with the
              shell closed (the default) all three live summaries — including
              "Absorbing travel — no fee" vs "Charging travel fee" — were
              unmounted entirely. Now top-level siblings like Additional services
              below: one tap each, and every section's state is readable while
              collapsed. The price FIELD stays in the fast path above; these
              sections hold the engine that feeds it. ── */}
          {/* Saved measurement — the pricing source of truth for this property.
              Shown ONLY when there's no LIVE suggestion (same numbers, same
              engine — never two copies of the price list on screen).
              …and ONLY for a lawn-cadence service. A SavedRecommendation is built by
              buildSavedRecommendation(pricingPackage(...)) — it is a grass cadence
              price list and carries no record of the service it was computed for. So
              a customer whose lawn was measured last spring would, on a "Furnace
              Repair" quote, be shown "Measured property · 5,000 ft² · $73/visit
              recommended · Weekly $55…" plus a one-tap "Use measured prices" that
              filled MOWING cadence prices into a furnace quote. P0 stopped WRITING
              lawn recs onto non-lawn measurements; this is the read side of the same
              bug, and every property measured before that fix still carries one. */}
          {savedRec && !suggested && pricingKind === 'lawn_recurring' && (
            <div className="rounded-xl border border-accent/30 bg-accent/5 p-3 space-y-2">
              <p className="text-[11px] font-semibold text-accent-text uppercase tracking-wide">
                Measured property · {savedRec.sqft.toLocaleString()} ft² · {formatCurrency(savedRec.rec[savedRec.rec.cadence])}/{savedRec.rec.cadence === 'one_time' ? 'visit' : savedRec.rec.cadence} recommended
              </p>
              <p className="text-xs text-ink-muted">
                One-Time <span className="text-ink font-semibold">${savedRec.rec.one_time}</span> · Weekly <span className="text-ink font-semibold">${savedRec.rec.weekly}</span> · Bi-Weekly <span className="text-ink font-semibold">${savedRec.rec.biweekly}</span> · Monthly <span className="text-ink font-semibold">${savedRec.rec.monthly}</span>
              </p>
              <p className="text-[11px] text-ink-faint">Calculated {formatDate(savedRec.date)}</p>
              <Button type="button" variant="secondary" size="sm"
                onClick={() => {
                  setValue('initial_price', savedRec.rec.one_time)
                  setValue('weekly_price', savedRec.rec.weekly)
                  setValue('biweekly_price', savedRec.rec.biweekly)
                  setValue('monthly_price', savedRec.rec.monthly)
                  setValue('measured_sqft', savedRec.sqft)
                  setValue('suggested_price', savedRec.rec.one_time)
                  markApplied()   // an explicit tap on a real recommendation
                }}>
                <CheckCircle2 className="w-3.5 h-3.5" /> Use measured prices
              </Button>
              {recommendationIsStale(savedRec.date, Date.now()) && (
                <p className="text-[11px] text-amber-400">⚠ Pricing recommendations may be outdated. Consider recalculating.</p>
              )}
            </div>
          )}

          {/* The price field itself lives in the fast path above — see the note
              there. These sections hold the engine that FEEDS it. */}

          {/* ── Pricing help — EdgeQuote working out a number, not the number ──
              Labour and plan pricing were two of the seven drawers, ranked beside
              Notes and Scheduling as if they were the same kind of decision. They
              are not: they are the internal arithmetic BEHIND the customer price
              that already sits in the fast path above. One drawer, two labelled
              blocks — not nested collapsibles, which an earlier audit removed here
              for good reason. ── */}
          <Collapsible title="Pricing help" icon={Calculator} summary={pricingHelpSummary}
            open={laborOpen || planOpen} onOpenChange={setPricingHelp}>
            <p className="text-[11px] text-ink-faint">
              This is how EdgeQuote works out a suggestion. The customer never sees any of it — they see the price above.
            </p>
            <div className="rounded-xl border border-border bg-bg-secondary p-3 space-y-3">
            {/* "Labour" named the accounting concept; this names the job the block
                does. Nothing under it changed — same fields, same engine. */}
            <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Estimate from hours</p>
            <p className="text-xs text-ink-faint">Hours × crew × rate — what the suggested price is built from when there’s no measurement to price against.</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* NOT required, and no minimum. Unknown hours must be expressible —
                  it is the honest state of a job nobody has estimated yet, and
                  `required` here would have forced the fabricated 2 back in through
                  validation the moment the default was removed. */}
              <Input label="Estimated Hours" type="number" step="0.25" min="0"
                hint="Blank until you or the estimate below fill it — no price is suggested from labour without it."
                error={errors.hours?.message}
                {...register('hours', { min: { value: 0, message: 'Cannot be negative' } })} />
              <Input label="Crew Size" type="number" min="1" max="20"
                error={errors.crew_size?.message}
                {...register('crew_size', { required: 'Required', min: { value: 1, message: 'Min 1' } })} />
            </div>
            {/* THE learned estimator — the same engine, model and DB-trigger-fed
                history that fills the duration when you SCHEDULE a job (JobForm).
                It was mounted here readOnly with an `onApply` no-op and captioned
                "Reference only", so the trained estimate sat one line above a field
                hardcoded to 2. It auto-fills only when est.enoughData is true —
                i.e. when this service has real history — and says "not enough data"
                otherwise. That refusal to guess is why it can be trusted with the
                price: it fills the HOURS, the hours drive the suggestion, and the
                suggestion still needs an Accept. */}
            <SmartLaborField
              affectsPrice
              sqft={measuredSqft}
              serviceType={watch('service_type')}
              crewSize={Number(crewSize) || 1}
              propertyId={defaultPropertyId}
              overgrowth={overgrowth}
              price={initialPrice || weeklyPrice || biweeklyPrice || monthlyPrice || 0}
              value={hours > 0 ? Math.round(Number(hours) * 60) : null}
              onApply={(minutes) => setValue('hours', Math.round((minutes / 60) * 100) / 100)}
            />
            {/* "Adjustment Multiplier" is the variable's name, not the owner's
                question. The question is how hard this job is. Field name, stored
                column and maths are untouched — `overgrowth_multiplier` is read in
                the pricing engine, the guardrails and the measure tool, and this
                is a label. */}
            <Input label="How hard is this job?" type="number" step="0.05" min="0"
              hint="Multiplies your rate for this quote. 0.75 easy · 1.0 standard · 1.25 overgrown."
              {...register('overgrowth_multiplier', { min: 0 })} />
            <Input label="Your rate ($ per person, per hour)" type="number" step="5" min="0"
              hint={Number(settings?.default_rate) > 0
                ? `Your Default Labour Rate from Settings (${formatCurrency(Number(settings?.default_rate))}/hr). Change it here for this quote only.`
                : 'Set a Default Labour Rate in Settings so quotes can suggest a labour price.'}
              error={errors.rate?.message}
              {...register('rate', { min: { value: 0, message: 'Rate cannot be negative' } })} />
            </div>

            {/* ── Repeat plans — asked for, not presented ──────────────────────
                Three cadence prices sat here permanently, so every one-visit
                quote — hedge trim, mulch drop, a cleanup — opened this drawer to
                three empty money fields about a schedule that will never exist.
                Most quotes are one visit; a repeating one is a deliberate offer,
                so make it a deliberate tap.
                Nothing about the DATA moved: the three fields register exactly as
                before, hold the same four cadence columns the portal reads, and
                reveal themselves whenever any of them already carries a price —
                a saved recurring quote, a plan tile, a measured lawn's Accept, or
                a validation error on one of them. Off-screen only ever means all
                three are empty, which is what saving one used to write anyway. */}
            <div className="rounded-xl border border-border bg-bg-secondary p-3 space-y-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Repeat plans</p>
            {showPlanFields ? (
              <>
                <p className="text-xs text-ink-faint">Fill any cadence you want to offer — they appear on the quote as options the customer can pick.</p>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  {/* Typing a plan price is the same act of ownership as typing the
                      first-visit price, and only initial_price used to demote the
                      origin — so hand-editing a weekly price left the header reading
                      "✓ Applied" over numbers the engine no longer stands behind, and
                      left the Monthly pill licensed to overwrite a typed monthly. */}
                  <Input label="Weekly ($/visit)" type="number" step="1" min="0" {...register('weekly_price', { min: 0, onChange: () => { setPriceOrigin('manual'); setPickedCadence(null) } })} />
                  <Input label="Bi-Weekly ($/visit)" type="number" step="1" min="0" {...register('biweekly_price', { min: 0, onChange: () => { setPriceOrigin('manual'); setPickedCadence(null) } })} />
                  <Input label="Monthly ($/visit)" type="number" step="1" min="0" {...register('monthly_price', { min: 0, onChange: () => { setPriceOrigin('manual'); setPickedCadence(null) } })} />
                </div>
              </>
            ) : (
              <>
                <p className="text-xs text-ink-faint">This quote is for one visit. Add per-visit prices if you want the customer to be able to pick a repeating schedule instead.</p>
                <Button type="button" variant="secondary" size="sm" onClick={() => setOfferRecurring(true)}>
                  <Repeat className="w-3.5 h-3.5" /> Offer recurring pricing
                </Button>
              </>
            )}
            {/* The guardrail note moved up beside the price it judges (fast path).
                One instance, so the two can't disagree about what's warned. */}
            </div>
          </Collapsible>

          {/* ── Additional services — a quote can hold one OR many services. Sits
              right after the pricing sections so the primary flow reads Address →
              Measure → Recommended price → Accept → fine-tune → extras. Each line
              has qty × unit price − discount; totals sum via the one
              quote-services engine. The primary service above stays untouched. ── */}
          {/* ⛔ Hidden entirely while options are on, and not merely disabled: a
              service line ADDS to the quote total, an option's price IS it, and
              the database refuses a quote holding both. A drawer offering rows
              that cannot be saved is an invitation to lose typing. Any lines
              already present stay in the form (the switch is reversible) and the
              banner beside the editor names them. */}
          {!optionsOn && (
          <Collapsible title="Services & materials" icon={Layers} summary={linesSummary}
            open={servicesOpen || materialsOpen} onOpenChange={setLinesOpen}>
            <div className="space-y-3">
              {serviceIdx.map(({ f, i }, n) => {
                const line = watchedServices?.[i]
                const net = line ? serviceLineTotals(line).net : 0
                return (
                  <div key={f.id} className="rounded-xl border border-border bg-bg-secondary p-3 space-y-3">
                    {/* kind is form state, not a visible field — register it so it
                        survives submit rather than being dropped as unregistered. */}
                    <input type="hidden" {...register(`services.${i}.kind` as const)} />
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Service {n + 2}</p>
                      <div className="flex items-center gap-3">
                        <span className="text-sm font-semibold text-ink tabular-nums">{formatCurrency(net)}</span>
                        {/* Was a bare 16px icon with no padding — a fraction of the
                            44px the app's own .tap-target-y standard asks for, on a
                            control that deletes a priced line instantly. Padding gives
                            it a real hit area on a phone; the ring makes it reachable
                            by keyboard like every other control here. */}
                        <button type="button" onClick={() => serviceLines.remove(i)} aria-label="Remove service"
                          className="tap-target-y flex items-center justify-center -m-1 p-2 rounded-lg text-ink-faint hover:text-red-400 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                    {/* Same one control as the primary service, for the same
                        reason: "Service *" and "From template" were two fields
                        asking one question, on every extra line, and the second
                        one was a 24-option dropdown per line.
                        A line already pointing at a RETIRED template keeps it in
                        its own list (otherwise editing an old quote would blank
                        the selection); everyone else sees active services only,
                        so a switched-off service and its stale rate are no longer
                        one tap from the total. */}
                    <input type="hidden" {...register(`services.${i}.service_template_id` as const)} />
                    {lineTemplateOptions(line?.service_template_id).length > 0 ? (
                      <ServicePicker label="Service *" placeholder="Search or type — e.g. Hedge Trimming"
                        templates={lineTemplateOptions(line?.service_template_id)}
                        templateId={watch(`services.${i}.service_template_id`) || ''}
                        recentIds={recentTemplateIds}
                        error={errors.services?.[i]?.service_type ? 'Service is required' : undefined}
                        onPick={t => {
                          setValue(`services.${i}.service_template_id`, t.id)
                          setValue(`services.${i}.service_type`, t.name)
                          if (Number(t.default_rate) > 0) setValue(`services.${i}.unit_price`, Number(t.default_rate))
                          const d = (t.pricing_display_type || '').toLowerCase()
                          setValue(`services.${i}.unit`, d.includes('hour') ? 'hour' : d.includes('linear') ? 'linear_ft' : d.includes('sq') ? 'sqft' : 'each')
                        }}
                        onDetach={() => setValue(`services.${i}.service_template_id`, '')}
                        {...register(`services.${i}.service_type` as const, { required: true })} />
                    ) : (
                      <Input label="Service *" placeholder="e.g. Hedge Trimming"
                        error={errors.services?.[i]?.service_type ? 'Service is required' : undefined}
                        {...register(`services.${i}.service_type` as const, { required: true })} />
                    )}
                    <div className="grid grid-cols-3 gap-3">
                      {/* The label follows the unit ("Hours: 3", "Square feet: 1,200")
                          and the step follows the unit's own granularity (0.25 hr). */}
                      <Input label={qtyLabelFor(line?.unit)} type="number" step={unitFor(line?.unit)?.step ?? 0.5} min="0"
                        {...register(`services.${i}.quantity` as const, { min: 0 })} />
                      <Select label="Unit" options={unitOptions}
                        {...register(`services.${i}.unit` as const)} />
                      <Input label="Unit price ($)" type="number" step="1" min="0"
                        {...register(`services.${i}.unit_price` as const, { min: 0 })} />
                    </div>
                    {lineEquation(line) && (
                      <p className="text-[11px] text-ink-muted tabular-nums">{lineEquation(line)}</p>
                    )}
                    <details className="group/line">
                      <summary className="tap-target-y flex items-center gap-1.5 cursor-pointer list-none text-[11px] font-medium text-ink-faint hover:text-ink transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 rounded">
                        <ChevronDown className="w-3.5 h-3.5 transition-transform group-open/line:rotate-180" />
                        Duration, discount &amp; notes
                      </summary>
                      <div className="pt-2 space-y-3">
                        <Input label="Duration (min)" type="number" step="5" min="0"
                          hint="Only affects scheduling — not the price."
                          {...register(`services.${i}.est_minutes` as const, { min: 0 })} />
                        {lineDiscountRow(i)}
                      </div>
                    </details>
                  </div>
                )
              })}
              {/* Land the cursor IN the new line's name field. Appending left focus on
                  the button below the row, so every extra line cost a wasted tap — and
                  on a phone a scroll-hunt before the keyboard even appeared. Focusing
                  also scrolls the new card into view for free. */}
              <Button type="button" variant="secondary" size="sm"
                onClick={() => {
                  const n = serviceLines.fields.length
                  serviceLines.append(emptyServiceLine())
                  requestAnimationFrame(() => setFocus(`services.${n}.service_type`))
                }}>
                <Plus className="w-3.5 h-3.5" /> Add service
              </Button>
              {/* Service-only figures: `extras` sums materials too, so using it
                  here would file mulch under "Additional services total". */}
              {serviceExtras.net > 0 && (
                <p className="text-xs text-ink-muted">
                  Additional services total <span className="font-semibold text-ink">{formatCurrency(serviceExtras.net)}</span>
                  {serviceExtras.discountAmount > 0 && <> (after {formatCurrency(serviceExtras.discountAmount)} discounts)</>}
                  {serviceExtras.minutes > 0 && <> · ≈{serviceExtras.minutes} min</>}
                </p>
              )}
            </div>
          {/* ── Materials — goods you SUPPLY, priced like any other line.
              This section knows what you CHARGE and deliberately nothing about
              what you PAY: no cost, no margin, no stock, no reservation. What a
              material costs the business is the one canonical cost model's
              question (Pricing V2 Phase 1 / Inventory D1), and a cost field here
              would pre-empt it. Lines live in the SAME array as services and sum
              through the SAME engine — this is a view, not a second system. ── */}
            <div className="space-y-3 pt-1">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint flex items-center gap-1.5">
                <Package className="w-3.5 h-3.5" /> Materials
              </p>
              {materialIdx.map(({ f, i }, n) => {
                const line = watchedServices?.[i]
                const net = line ? serviceLineTotals(line).net : 0
                return (
                  <div key={f.id} className="rounded-xl border border-border bg-bg-secondary p-3 space-y-3">
                    <input type="hidden" {...register(`services.${i}.kind` as const)} />
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Material {n + 1}</p>
                      <div className="flex items-center gap-3">
                        <span className="text-sm font-semibold text-ink tabular-nums">{formatCurrency(net)}</span>
                        <button type="button" onClick={() => serviceLines.remove(i)} aria-label="Remove material"
                          className="tap-target-y flex items-center justify-center -m-1 p-2 rounded-lg text-ink-faint hover:text-red-400 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                    <Input label="Material *" placeholder="e.g. Mulch" list="eq-material-suggestions"
                      error={errors.services?.[i]?.service_type ? 'Material is required' : undefined}
                      hint="Pick a suggestion or type your own."
                      {...register(`services.${i}.service_type` as const, { required: true })} />
                    {/* Suggestions prefill the unit too — the point is that mulch
                        arrives already measured in cubic yards, not 'each'. They
                        retire once the line is NAMED (§2.5): eight chips repeated
                        under every filled line forever was pure noise, and the
                        datalist on the input still offers them while typing. */}
                    {!line?.service_type?.trim() && (
                      <div className="flex flex-wrap gap-2">
                        {MATERIAL_SUGGESTIONS.map(s => (
                          <button key={s.label} type="button"
                            onClick={() => {
                              setValue(`services.${i}.service_type`, s.label, { shouldDirty: true })
                              setValue(`services.${i}.unit`, s.unit, { shouldDirty: true })
                            }}
                            title={s.hint}
                            // tap-target-y is coarse-pointer-gated (globals.css), so the
                            // desktop chip is unchanged while the phone gets a real 44px
                            // target; the ring is the same one every other chip here uses.
                            className="tap-target-y inline-flex items-center text-[11px] rounded-full border border-border px-2.5 py-1 text-ink-muted hover:text-ink hover:border-accent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                            {s.label}
                          </button>
                        ))}
                      </div>
                    )}
                    {/* No Duration field: spreading the mulch is the SERVICE line's
                        minutes. Minutes here would inflate the scheduled job twice. */}
                    <div className="grid grid-cols-3 gap-3">
                      {/* Same rule as the services grid: the label and step follow
                          the unit — "Cubic yards: 3.5", not "Qty: 3.5". */}
                      <Input label={qtyLabelFor(line?.unit)} type="number" step={unitFor(line?.unit)?.step ?? 0.5} min="0"
                        {...register(`services.${i}.quantity` as const, { min: 0 })} />
                      <Select label="Unit" options={unitOptions}
                        {...register(`services.${i}.unit` as const)} />
                      <Input label="Price per unit ($)" type="number" step="1" min="0"
                        {...register(`services.${i}.unit_price` as const, { min: 0 })} />
                    </div>
                    {lineEquation(line) && (
                      <p className="text-[11px] text-ink-muted tabular-nums">{lineEquation(line)}</p>
                    )}
                    <details className="group/line">
                      <summary className="tap-target-y flex items-center gap-1.5 cursor-pointer list-none text-[11px] font-medium text-ink-faint hover:text-ink transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 rounded">
                        <ChevronDown className="w-3.5 h-3.5 transition-transform group-open/line:rotate-180" />
                        Discount &amp; notes
                      </summary>
                      <div className="pt-2">{lineDiscountRow(i)}</div>
                    </details>
                  </div>
                )
              })}
              <datalist id="eq-material-suggestions">
                {MATERIAL_SUGGESTIONS.map(s => <option key={s.label} value={s.label} />)}
              </datalist>
              <Button type="button" variant="secondary" size="sm"
                onClick={() => {
                  const n = serviceLines.fields.length
                  serviceLines.append(emptyMaterialLine())
                  requestAnimationFrame(() => setFocus(`services.${n}.service_type`))
                }}>
                <Plus className="w-3.5 h-3.5" /> Add material
              </Button>
              {materialsSum.net > 0 && (
                <p className="text-xs text-ink-muted">
                  Materials total <span className="font-semibold text-ink">{formatCurrency(materialsSum.net)}</span>
                  {materialsSum.discountAmount > 0 && <> (after {formatCurrency(materialsSum.discountAmount)} discounts)</>}
                  {' '}— included in the quote total.
                </p>
              )}
            </div>
          </Collapsible>
          )}


          {/* ── More options — the set-it-and-forget-it end of a quote ──
              Travel, notes and scheduling were three separate drawers. Each is a
              thing an owner touches on the occasional quote, and three shut doors
              read as three unanswered questions. ── */}
          <Collapsible title="More options" icon={FileText} summary={moreSummary}
            open={travelOpen} onOpenChange={setTravelOpen}>
            <div className="rounded-xl border border-border bg-bg-secondary p-3 space-y-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint flex items-center gap-1.5">
              <Car className="w-3.5 h-3.5" /> Travel
            </p>
            <div className="flex justify-end">
              <Button type="button" variant="secondary" size="sm" onClick={() => calculateDistance()} loading={calcLoading}>
                <MapPin className="w-3.5 h-3.5" /> Calculate distance
              </Button>
            </div>
            {calcMsg && (
              <p className={cn('text-xs', calcMsg.error ? 'text-red-400' : 'text-accent-text')}>
                {calcMsg.text}
                {calcMsg.settingsLink && <> <Link href="/dashboard/settings" className="underline hover:text-ink">Open Settings →</Link></>}
              </p>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-end">
              <Input label="Distance (km)" type="number" step="0.1" min="0" {...register('distance_km', { min: 0 })} />
              <Input label="Travel Fee ($)" type="number" step="5" min="0" {...register('travel_fee', { min: 0 })} />
            </div>
            {travelSuggestion && (
              <div className="text-sm">
                {travelSuggestion.isCustom ? (
                  <span className="text-amber-400">{travelSuggestion.tierLabel}: custom fee required</span>
                ) : (
                  <span className="text-ink-muted">{travelSuggestion.tierLabel}: <span className="text-accent-text font-semibold">{formatCurrency(travelSuggestion.fee || 0)}</span></span>
                )}
              </div>
            )}
            {/* Gated on actually charging travel (§10.3): this kept demanding a
                custom fee after the owner switched to "Absorbing travel — no fee". */}
            {customTravelRequired && includeTravel && (
              <Banner tone="warn" icon={AlertTriangle} className="text-xs">
                Beyond your furthest travel tier — enter a custom travel fee above.
              </Banner>
            )}
            {travelSuggestion && !travelSuggestion.isCustom && (
              <Button type="button" variant="secondary" size="sm" onClick={applySuggestedTravel}>
                <CheckCircle2 className="w-3.5 h-3.5" /> Apply suggested travel fee
              </Button>
            )}
            <div className="pt-1 space-y-2">
              <Toggle checked={includeTravel} onChange={toggleIncludeTravel}
                label={includeTravel ? 'Charging travel fee' : 'Absorbing travel — no fee'} />
              <Controller name="show_travel_separately" control={control}
                render={({ field }) => (
                  <Toggle checked={field.value} onChange={field.onChange}
                    label={field.value ? 'Show travel as separate line on PDF' : 'Travel rolled into total on PDF'} />
                )} />
            </div>

            </div>

            <div className="rounded-xl border border-border bg-bg-secondary p-3 space-y-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint flex items-center gap-1.5">
              <FileText className="w-3.5 h-3.5" /> Notes
            </p>
            <Textarea label="Notes" placeholder="Job-specific details, access instructions, gate codes…"
              {...register('notes')} />
            {aiScope.enabled === true && (
              <div className="mt-2 space-y-1.5">
              <div className="flex items-center gap-1.5">
                <AssistButton
                  label={notes && String(notes).trim() ? 'Polish' : 'Write'}
                  busyLabel="Writing…"
                  busy={aiScope.running}
                  title="Turns the services on this quote (and your rough notes) into customer-ready scope-of-work text — never touches pricing"
                  onClick={async () => {
                    const prior = String(notes || '')
                    aiScope.clearError()
                    setValue('notes', '')
                    const full = await aiScope.run({
                      task: 'quote_scope',
                      // Lets the scope reference real history ("the same work we did in
                      // April"). Facts are re-derived server-side from this id, as ever.
                      customerId: watch('customer_id') || undefined,
                      serviceType: watch('service_type') || undefined,
                      services: (watchedServices || []).map(s => ({ name: s?.service_type, notes: s?.notes })),
                      propertyId: defaultPropertyId || undefined,
                      measuredSqft: measuredSqft || undefined,
                      address: address || undefined,
                      draft: prior,
                    }, { onDelta: d => setValue('notes', String(watch('notes') || '') + d) })
                    if (full === null) { setValue('notes', prior); return }
                    setAiScopePrior(prior)
                    // This field's replace is destructive and had no way back —
                    // the composer had undo, the two Notes fields did not.
                    if (prior.trim()) toast.undo('Replaced your notes.', () => { setValue('notes', prior); setAiScopePrior(null) })
                  }} />
                {aiScope.running && <AiStop onClick={aiScope.cancel} />}
                {!aiScope.running && aiScopePrior !== null && (
                  <AiUndo onClick={() => { setValue('notes', aiScopePrior); setAiScopePrior(null) }} />
                )}
              </div>
              <AiError message={aiScope.error} />
              {!aiScope.running && aiScopePrior !== null && (
                <AiNote caution={AI_CHECK_FIRST}
                  explain="Written from this quote's line items and your notes on them, plus what you've done for this customer before. It never sees or states a price." />
              )}
              </div>
            )}

          {/* Sparkles, not SlidersHorizontal: sharing Advanced Pricing's icon made
              the first and last sections in the stack wear the same glyph, so the
              icon column stopped working as a map. Sparkles already brands the
              best-days content inside. The summary line brings it in line with
              every other collapsed section (all the rest reveal their state). */}
            </div>

            <div className="rounded-xl border border-border bg-bg-secondary p-3 space-y-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5" /> Best days to schedule
            </p>
            <div className="pt-1">
              <p className="text-xs font-semibold text-ink-muted uppercase tracking-wide flex items-center gap-2 mb-2">
                <Sparkles className="w-3.5 h-3.5 text-accent-text" /> Best days to schedule
              </p>
              {!address ? (
                <p className="text-xs text-ink-faint">Enter a service address to see the best days near your existing jobs.</p>
              ) : !showBestDays ? (
                <Button type="button" variant="secondary" size="sm" onClick={() => setShowBestDays(true)}>
                  <Sparkles className="w-3.5 h-3.5" /> Find best days
                </Button>
              ) : (
                <BestDaySuggestions address={address} />
              )}
            </div>
            </div>
          </Collapsible>
        </div>

        <div className="hidden lg:block space-y-4">
          <Card className="sticky top-6">
            <CardHeader className="flex items-center gap-2">
              <Calculator className="w-4 h-4 text-accent-text" />
              {/* §3.4 — the mobile sheet already says "Quote breakdown" for this
                  same JSX, and neither is a preview of the quote document. */}
              <h2 className="text-sm font-semibold text-ink">Quote breakdown</h2>
            </CardHeader>
            <CardBody className="space-y-3">
              {previewBreakdown}
              <div className="pt-2 space-y-2">
                {zeroSaveNote}
                <Button type="submit" className="w-full" size="lg" loading={isSubmitting}>
                  {saveLabel}
                </Button>
                <Button type="button" variant="ghost" className="w-full" onClick={onCancel ?? (() => router.back())}>Cancel</Button>
              </div>
            </CardBody>
          </Card>
        </div>
      </div>

      {/* Mobile sticky save bar — always reachable without scrolling */}
      <StickyActionBar fixed className="lg:hidden">
        {zeroSaveNote && <div className="pb-2">{zeroSaveNote}</div>}
        <div className="flex items-center justify-between gap-3">
          {/* The total is the handle for the breakdown on mobile — the desktop
              preview card is the only other place it exists, and it's lg-only. */}
          <button type="button" onClick={() => setShowPreview(true)}
            className="leading-tight min-w-0 text-left rounded-lg -m-1 p-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            aria-label="Show the price breakdown">
            <p className="text-[10px] uppercase tracking-wide text-ink-faint flex items-center gap-1">
              First visit total <ChevronUp className="w-3 h-3" />
            </p>
            {/* Matches the breakdown it opens: an unpriced quote reads "—", not a
                confident $0.00 sitting where the price goes. */}
            <p className="text-xl font-bold text-accent-text leading-none tabular-nums">{effectiveTotal > 0 ? formatCurrency(effectiveTotal) : '—'}</p>
          </button>
          <div className="flex items-center gap-2 shrink-0">
            <Button type="button" variant="ghost" size="sm" onClick={onCancel ?? (() => router.back())}>Cancel</Button>
            <Button type="submit" size="lg" loading={isSubmitting}>{saveLabel}</Button>
          </div>
        </div>
      </StickyActionBar>

      {/* Mobile breakdown — the SAME previewBreakdown the desktop card renders,
          in the shared Modal (which is a bottom sheet on phones). */}
      <Modal open={showPreview} onClose={() => setShowPreview(false)} title="Quote breakdown" icon={Calculator} size="sm">
        <div className="space-y-3">{previewBreakdown}</div>
      </Modal>

      {showMeasure && (
        <QuoteMeasure
          address={address}
          travelFee={Number(travelFee) || 0}
          cfg={pricingConfigFromSettings(settings)}
          serviceType={watch('service_type')}
          pricingKind={pricingKind}
          propertyId={defaultPropertyId}
          customerId={activeCustomerId}
          services={activeTemplates.map(t => t.name).filter((n): n is string => !!n)}
          // Setting the NAME alone left service_template_id stale, so svcTemplate
          // stayed null and pricingKind fell back to matching the name — which is a
          // guess about the trade, not the owner's answer. A "Lawn Mowing" template
          // the owner configured as hourly still name-matched to lawn_recurring and
          // re-opened the cadence gate two lines below. Set the id and let the
          // template effect above derive name/rate/notes: the picker's one path,
          // not a second one. Free text (no template) clears the id for the same reason.
          onServiceChange={(n) => {
            const t = activeTemplates.find(s => s.name === n)
            if (t) setValue('service_template_id', t.id)
            else { setValue('service_template_id', ''); setValue('service_type', n) }
          }}
          onClose={() => setShowMeasure(false)}
          onApply={(sel) => {
            // The measured AREA is a fact about the property and applies to every
            // trade — a traced roof is a traced roof. The PRICES in `sel` are not:
            // they come from pricingPackage(), the grass cadence engine, whose
            // signature never sees a service. Applying them to a pressure-washing
            // or furnace quote put a mowing price on it AND (via the old
            // setInitialManual(true)) locked out the correct labour suggestion, so
            // the one-tap default was the wrong number. The area always applies;
            // the lawn structure only applies to lawn-cadence services.
            setValue('measured_sqft', sel.totalSqft)
            if (pricingKind !== 'lawn_recurring') { setShowMeasure(false); return }

            // Fill the WHOLE pricing structure in one apply — first visit at the
            // one-time price plus every recurring option, so the customer sees all
            // choices with zero re-typing. Monthly stays blank unless enabled (or
            // the measure flow explicitly recommended monthly).
            setValue('initial_price', sel.oneTime)
            setValue('weekly_price', sel.weekly)
            setValue('biweekly_price', sel.biweekly)
            if (includeMonthly || sel.cadence === 'monthly') {
              setValue('monthly_price', sel.monthly)
              if (sel.cadence === 'monthly') setIncludeMonthly(true)
            }
            setValue('suggested_price', sel.suggested)
            // ADR-002: record the derived state that PRICED these numbers, alongside
            // the numbers themselves. Set here rather than above the early return on
            // purpose — for a non-lawn service the prices are never applied, so no
            // grade priced anything and recording one would be a fabrication.
            setValue('value_grade', sel.valueGrade)
            setValue('nearby_count', sel.nearbyCount)
            markApplied()   // they tapped a tier in the modal
            setShowMeasure(false)
          }}
        />
      )}
    </form>
  )
}