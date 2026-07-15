// ── THE help content ─────────────────────────────────────────────────────────
// One source for every explanation the app gives about itself: the Help Center
// page, the Cmd/K palette, and every contextual "?" link all read from here.
// Pure data + pure search — no I/O, no backend, no CMS. An article's `id` is its
// permanent address (/dashboard/help#id), so a contextual link can point at a
// section and the Help Center can scroll to it.
//
// WRITING RULES (they are why this reads like a person, not a manual):
//  • Describe what the software ACTUALLY does today. If a behaviour is deliberate
//    and surprising, say so and say why — that's the sentence people are looking
//    for. Never document an intention.
//  • Answer the question someone actually has ("will this charge them?"), not the
//    one the feature name implies.
//  • No screenshots. They rot silently; prose doesn't.

export type HelpCategory = 'start' | 'quotes' | 'schedule' | 'money' | 'messages' | 'customers'

export interface HelpSection { heading: string; body: string[] }
export interface HelpArticle {
  id: string
  title: string
  category: HelpCategory
  /** One line, shown in search results and under the title. */
  summary: string
  /** Extra search terms — the words a user would type that aren't in the title. */
  keywords: string[]
  sections: HelpSection[]
}

export const HELP_CATEGORIES: { key: HelpCategory; label: string; blurb: string }[] = [
  { key: 'start',     label: 'Getting started', blurb: 'Your first week, and the shape of the app.' },
  { key: 'quotes',    label: 'Quotes & pricing', blurb: 'Pricing work, sending quotes, and what expiry means.' },
  { key: 'schedule',  label: 'Scheduling & routes', blurb: 'Days, capacity, routes, and weather.' },
  { key: 'money',     label: 'Invoices & payments', blurb: 'Getting paid, AutoPay, receipts and refunds.' },
  { key: 'messages',  label: 'Messages & consent', blurb: 'What sends automatically, and the rules that stop it.' },
  { key: 'customers', label: 'Customers & the portal', blurb: 'What your customers can see and do.' },
]

export const HELP_ARTICLES: HelpArticle[] = [
  // ── Getting started ────────────────────────────────────────────────────────
  {
    id: 'first-week',
    title: 'Your first week',
    category: 'start',
    summary: 'The shortest path from empty app to getting paid.',
    keywords: ['setup', 'onboarding', 'begin', 'new', 'start here'],
    sections: [
      {
        heading: 'Do these four things first',
        body: [
          '**1. Fill in Business Settings.** Your company name, phone and logo appear on every quote, invoice, receipt and email your customers receive. Until they’re set, those documents go out looking anonymous.',
          '**2. Set your pricing.** Settings → Pricing is where your base charge, mow rate and travel rate live. Every quote is built from these, so getting them roughly right now saves re-pricing later.',
          '**3. Add one real customer and quote them.** The whole app is downstream of a quote — jobs, invoices and payments all trace back to one. Doing it once end-to-end teaches you more than reading.',
          '**4. Turn on payments.** Settings → Payments connects Stripe and sets your e-transfer address. Without it, customers can still be invoiced, but they can’t pay you from the portal.',
        ],
      },
      {
        heading: 'The shape of the app',
        body: [
          'Work flows in one direction: **quote → approved → job on the calendar → visit completed → invoice → payment**. Each step creates the next, which is why the app rarely asks you to enter the same thing twice.',
          'A **quote** is the price. A **job** is a visit on a specific day. An **invoice** is a bill for work already done. The app drafts the invoice for you when you complete a visit — you review it, you send it.',
          'Anything recurring (weekly mowing, say) is a **plan**: one recurrence that generates many visits. Change the plan and future visits follow; past visits keep the price they were billed at.',
        ],
      },
    ],
  },
  {
    id: 'what-sends-itself',
    title: 'What the app does without asking',
    category: 'start',
    summary: 'Every automatic action, in one list — so nothing surprises you.',
    keywords: ['automatic', 'automation', 'auto', 'sends itself', 'without me', 'surprise'],
    sections: [
      {
        heading: 'Messages that send on their own',
        body: [
          'Only these, and only when the customer has opted in to that channel. You can turn each one off in **Settings → Automated messages**.',
          '**Booking confirmation** — the moment someone books through your booking link, they get their confirmation number in writing. This one is transactional: it confirms a request they just made, so it isn’t affected by marketing preferences.',
          '**Day-before reminder** — the evening before a scheduled visit.',
          '**Job complete** — attempted when you tap Complete on a visit.',
          '**Review request** — the day after a completed visit.',
          '**Quote follow-up** — chases a quote the customer hasn’t answered. It stops on its own the moment the quote is accepted, declined, invoiced or expired, and it never chases more times than you set.',
          '**Invoice reminder** — chases an invoice past its due date. It stops the moment the invoice is paid or cancelled.',
          '**Payment receipt** — automatically after a card payment (including AutoPay). Cash and e-transfer receipts are sent by you, from the payment row.',
          'Both chasers have their own cadence — how long to wait, and how many times to try — set right underneath their switch. Turning one on also picks up work that’s *already* sitting there: quotes already gone quiet, invoices already overdue.',
        ],
      },
      {
        heading: 'Things that happen quietly, on purpose',
        body: [
          '**A draft invoice is created when you complete a visit.** It is not sent. It sits in Invoices as a draft until you review and send it — your customer cannot see it.',
          '**Route order is recalculated when you change a day.** If you’ve dragged stops into a manual order, moving a job to another day clears that day’s manual order, because the old sequence no longer describes the day.',
          '**Prices flow down, not backwards.** Changing a plan’s price re-prices its future visits and their draft invoices. Visits you’ve already billed keep the price they were billed at — that’s deliberate, and it’s why your history stays trustworthy.',
        ],
      },
    ],
  },

  // ── Quotes & pricing ───────────────────────────────────────────────────────
  {
    id: 'quote-lifecycle',
    title: 'How a quote moves',
    category: 'quotes',
    summary: 'Draft, sent, approved — and what the customer sees at each step.',
    keywords: ['draft', 'sent', 'accepted', 'approved', 'declined', 'status'],
    sections: [
      {
        heading: 'The states',
        body: [
          '**Draft** — yours alone. Your customer cannot see a draft quote in their portal, so you can leave one half-finished without worrying.',
          '**Sent** — it’s in their portal and they can approve it. Their portal calls this *"Awaiting your approval"*.',
          '**Approved** — they said yes. Nothing has been charged; approving a quote never takes money.',
          '**Scheduled / Completed** — the work is on the calendar, or done. The quote’s job is finished at this point.',
        ],
      },
      {
        heading: 'What the customer actually sees',
        body: [
          'They get a private portal link — no password, no account. It shows the quote total, any ongoing plan price per visit, and a plain-English explanation of what’s behind the number: their measured lawn size, the time the work takes, and any travel charge.',
          'Before they can approve, they’re asked to confirm the amount, and told that approving doesn’t charge them. That’s deliberate — it’s the fear that stops people tapping.',
        ],
      },
    ],
  },
  {
    id: 'quote-expiry',
    title: 'Why quotes expire — and how to honour an old price',
    category: 'quotes',
    summary: 'A sent quote stands for 30 days. Nothing is deleted when it lapses.',
    keywords: ['expire', 'expired', 'valid until', 'extend', '30 days', 'lapsed', 'old price'],
    sections: [
      {
        heading: 'What expiry actually does',
        body: [
          'When you send a quote, it’s stamped valid for **30 days**. Long enough to think it over; short enough that your costs haven’t moved under you.',
          'When it lapses: the follow-up chaser stops, your quote list shows an **Expired** badge, and the customer’s portal replaces the Approve button with *"This quote has expired. Please contact us for an updated quote."*',
          '**Nothing is deleted and nothing is decided.** Expiry is a display state derived from the date — it isn’t written into the quote. The price, the measurements and the history are all still there.',
        ],
      },
      {
        heading: 'Honouring the price anyway',
        body: [
          'Open the quote and **Extend** it. That pushes the date out and the quote goes straight back to live — the badge disappears, the chaser resumes, and the customer can approve at the original price.',
          'Extending is the honest counterpart to expiry: expiry protects you from a price you no longer want to stand behind, and Extend is you choosing to stand behind it anyway.',
        ],
      },
      {
        heading: 'Quotes sent before this existed',
        body: [
          'Quotes that went out before expiry was introduced have no date stamped on them, and they never expire. They were not retroactively expired — a customer holding an old quote won’t suddenly be told it’s dead.',
        ],
      },
    ],
  },
  {
    id: 'gst-and-totals',
    title: 'GST, travel and what the customer is quoted',
    category: 'quotes',
    summary: 'A quote total is before GST. An invoice total includes it.',
    keywords: ['gst', 'tax', 'total', 'travel fee', 'discount', 'before tax'],
    sections: [
      {
        heading: 'The one thing to know',
        body: [
          'Quote totals are shown **before GST**. Invoice totals **include** it. Both the quote PDF and the customer’s portal say so on the quote itself — *"+ GST (5%) — added on your invoice"* — because the alternative is a first bill that looks like a bait-and-switch.',
          'Your GST percentage lives in Settings. Set it to 0 if you don’t charge GST and the notes disappear everywhere.',
        ],
      },
      {
        heading: 'Per visit vs. per month',
        body: [
          'Plan prices are always **per visit**, including the monthly plan. The portal and the PDF both label them that way. A "monthly plan" at $65 means $65 each time you visit, not $65 for the month — if that isn’t what you mean, price the plan differently rather than relying on the label.',
        ],
      },
    ],
  },

  // ── Scheduling & routes ────────────────────────────────────────────────────
  {
    id: 'day-capacity',
    title: 'How a day fills up',
    category: 'schedule',
    summary: 'Capacity is crew size × working hours — and the app warns, never blocks.',
    keywords: ['capacity', 'overbooked', 'full', 'crew size', 'hours', 'utilisation', 'workload'],
    sections: [
      {
        heading: 'What capacity means',
        body: [
          'A day’s capacity is your **crew size × working hours**, set in Settings and overridable per-day from the Day Settings bar. The app compares your booked work (visit durations plus drive time) against it.',
          'You’ll see a day read as **room**, **full** or **overloaded**. Overloaded is a warning, not a wall — the app will never refuse to book work you’ve decided to do. It just refuses to pretend the day is fine.',
        ],
      },
      {
        heading: 'Blocking a day',
        body: [
          'Mark a day Rain, Holiday, Vacation, Sick or Equipment and it stops accepting work: the optimiser won’t route onto it, and rain-delay moves will skip over it when finding a new date. Clearing the status opens it again immediately.',
        ],
      },
    ],
  },
  {
    id: 'routes-and-order',
    title: 'Route order, ETAs and finish time',
    category: 'schedule',
    summary: 'The app sequences your day; you can override it and it will remember.',
    keywords: ['route', 'order', 'drag', 'eta', 'finish', 'optimise', 'optimize', 'drive time', 'sequence'],
    sections: [
      {
        heading: 'Who decides the order',
        body: [
          'By default the app sequences each day to minimise driving, starting and ending at your base address. Every stop gets an arrival estimate, and the day gets a finish estimate.',
          '**Drag a stop to override it.** Your manual order sticks, and the ETAs recalculate around it — the app won’t quietly re-sort your day behind you. **Reset to best route** hands sequencing back to the optimiser.',
        ],
      },
      {
        heading: 'When the order clears itself',
        body: [
          'Moving a job to a different day clears that day’s manual order. This is deliberate: a sequence you built for six stops doesn’t describe the day once one of them leaves, and a stale order is worse than no order.',
        ],
      },
      {
        heading: 'How accurate the times are',
        body: [
          'Arrival and finish times are estimates built from real road distances between your stops plus each visit’s duration. They assume you leave at your configured start time and don’t account for how long you actually spend chatting at stop three.',
        ],
      },
    ],
  },
  {
    id: 'rain-delay',
    title: 'Rain: moving a day and telling everyone',
    category: 'schedule',
    summary: 'Block the day, move the work, notify the customers — in one pass.',
    keywords: ['rain', 'weather', 'delay', 'reschedule', 'move day', 'storm'],
    sections: [
      {
        heading: 'What Weather Ops does',
        body: [
          'It marks the day unavailable, finds the next workable day for each visit (skipping days you’ve blocked and days that are already full), and offers to message every affected customer with their new date.',
          'Nothing is claimed until it’s saved. If the moves can’t be written, you’ll be told, **and no one is messaged** — a text telling a customer their visit moved is impossible to unsend, so it only goes out once the move is real.',
        ],
      },
      {
        heading: 'Undo',
        body: [
          'The moves land with an Undo on the schedule. Undo puts every visit back on its original date and restores your manual route order for those days. It does not un-send the messages — if you’ve already notified, tell them.',
        ],
      },
    ],
  },

  // ── Invoices & payments ────────────────────────────────────────────────────
  {
    id: 'invoice-lifecycle',
    title: 'From completed visit to money in the bank',
    category: 'money',
    summary: 'The app drafts the invoice. You send it. The ledger tracks the rest.',
    keywords: ['invoice', 'draft', 'send', 'paid', 'balance', 'overdue', 'due date'],
    sections: [
      {
        heading: 'The draft',
        body: [
          'Completing a visit drafts an invoice for it automatically, priced from the job. **It is not sent, and your customer cannot see it.** Review it, adjust it, then send.',
          'If a visit has no price, no invoice is drafted — the app won’t invent a $0 bill. You’ll be told, so the visit doesn’t quietly go unbilled.',
        ],
      },
      {
        heading: 'What the customer sees',
        body: [
          'An issued invoice appears in their portal with its total (GST included), its due date, and a Pay button. Past the due date it shows **Past due** — and stays payable, because the point is to let them fix it.',
          'Partial payments show on the row, so a customer who has paid some of it doesn’t see a bill that looks untouched.',
        ],
      },
      {
        heading: 'The balance is always derived',
        body: [
          'An invoice’s balance is its total minus every payment recorded against it. It is never typed in. That’s why refunds, credits, partial payments and AutoPay charges all agree with each other — they’re all reading the same ledger.',
        ],
      },
    ],
  },
  {
    id: 'autopay',
    title: 'AutoPay: what it charges, and when',
    category: 'money',
    summary: 'Only recurring invoices, only after the visit, only for that visit.',
    keywords: ['autopay', 'auto pay', 'card on file', 'automatic payment', 'saved card', 'recurring'],
    sections: [
      {
        heading: 'The rules',
        body: [
          'AutoPay charges the invoice from a **recurring visit**, **after that visit is complete**, for **that visit’s amount**. That’s the whole of it.',
          '**One-off jobs and extra work are never charged automatically.** Those always wait for the customer to pay, or for you to take payment.',
          'Every AutoPay charge sends the customer a receipt and appears in their portal payment history.',
        ],
      },
      {
        heading: 'Turning it on',
        body: [
          'The customer saves a card themselves from their portal, or you can send them the card-setup link. Their card is held by Stripe — it never touches this app, and neither you nor we can see the number.',
          'Either of you can turn AutoPay off at any time, and it takes effect immediately.',
        ],
      },
      {
        heading: 'Removing a card',
        body: [
          'Removing a saved card turns AutoPay off in the same action. It has to — AutoPay with no card would just fail every time, and a customer who asked you to delete their card should not see another charge attempt.',
        ],
      },
    ],
  },
  {
    id: 'getting-paid',
    title: 'Card, e-transfer and cash',
    category: 'money',
    summary: 'Three ways to get paid, and which ones need you to do something.',
    keywords: ['payment', 'stripe', 'etransfer', 'e-transfer', 'interac', 'cash', 'cheque', 'receipt'],
    sections: [
      {
        heading: 'Card',
        body: [
          'Fully automatic. The customer pays from their portal through Stripe’s hosted checkout, the invoice marks itself paid, and the receipt sends itself. You do nothing.',
        ],
      },
      {
        heading: 'E-transfer',
        body: [
          'The customer sees your Interac address (set it in **Settings → Payments** — it’s the only address the portal will ever show, because a generic contact email usually isn’t registered for e-transfers) and is asked to include the invoice number.',
          'When it arrives, **you record it** on the invoice. The portal then shows it in their payment history with a downloadable receipt.',
        ],
      },
      {
        heading: 'Cash',
        body: [
          'Same as e-transfer: you record it, and it appears in their history with a receipt.',
          'For cash and e-transfer the customer’s receipt is sent by you, from the payment row — it isn’t automatic the way a card receipt is. If they’re expecting one, send it.',
        ],
      },
      {
        heading: 'Receipts never go stale',
        body: [
          'Receipts aren’t stored files — they’re rebuilt from the ledger each time. So a receipt downloaded a year from now still matches the money that actually moved, and nothing can drift.',
        ],
      },
    ],
  },

  // ── Messages & consent ─────────────────────────────────────────────────────
  {
    id: 'consent',
    title: 'Why a message didn’t send',
    category: 'messages',
    summary: 'Almost always consent. Here’s the order the app checks things.',
    keywords: ['opt in', 'opt-in', 'consent', 'unsubscribe', 'stop', 'not sending', 'blocked', 'casl'],
    sections: [
      {
        heading: 'The checks, in order',
        body: [
          '**1. Do you have the channel set up?** No Twilio credentials means no SMS; no Resend means no email. Settings will tell you.',
          '**2. Has the customer opted in to that channel?** SMS and email consent are separate. A customer can be happy to get texts and not emails.',
          '**3. Do their preferences allow this kind of message?** Consent is per-category — reminders, invoices, estimates, marketing, seasonal. Someone can accept visit reminders and refuse marketing.',
          '**4. Do you have a phone number / email address for them?**',
          'Every attempt is logged on the customer’s timeline with the reason, including the ones that were skipped. If a message didn’t go, the timeline says why.',
        ],
      },
      {
        heading: '"Sent" means accepted, not delivered',
        body: [
          'When a message shows **Sent**, it means the provider accepted it for delivery. It does not confirm it reached the handset — carriers can still reject or drop a message afterwards, and the app is not currently told when that happens.',
          'So treat Sent as "we handed it over successfully", not "they definitely got it". If something matters, a phone call is still a phone call.',
        ],
      },
    ],
  },
  {
    id: 'templates',
    title: 'Making the messages sound like you',
    category: 'messages',
    summary: 'Every automatic message is editable, and previews with real formatting.',
    keywords: ['template', 'wording', 'edit message', 'variables', 'personalise', 'customise'],
    sections: [
      {
        heading: 'Editing',
        body: [
          '**Settings → Message templates.** Every automatic message is there. Leave one blank to use the default wording — you’re not forced to write anything.',
          'Variables like `{{first_name}}` and `{{date}}` fill themselves in per customer. The editor lists every one you can use, and previews exactly what the customer receives.',
          'Wrap words in `**double asterisks**` to bold them in emails. Texts strip the asterisks automatically, so the same template works on both.',
        ],
      },
      {
        heading: 'Cost',
        body: [
          'Every composer shows the SMS segment count as you type. A long text is billed as several segments — the counter is there so a wordy template doesn’t quietly cost you three times as much on every send.',
        ],
      },
    ],
  },

  // ── Customers & the portal ─────────────────────────────────────────────────
  {
    id: 'the-portal',
    title: 'What your customers can see',
    category: 'customers',
    summary: 'Their private link, and exactly what’s behind it.',
    keywords: ['portal', 'customer link', 'what they see', 'privacy', 'login', 'password'],
    sections: [
      {
        heading: 'The link',
        body: [
          'Every customer has one private portal link. No password, no account — the link is the key, which is why it’s only ever sent to them. It doesn’t expire, and it’s the same link every time.',
        ],
      },
      {
        heading: 'What’s behind it',
        body: [
          'Their quotes and invoices, their payment history with downloadable receipts, their next visit, their plan and when it renews, photos of their property, and a timeline of everything that’s happened.',
          'They can approve a quote, pay an invoice, save a card, manage AutoPay, set their own message preferences, and send you a request.',
        ],
      },
      {
        heading: 'What’s hidden from them',
        body: [
          '**Draft quotes and draft invoices** — your unfinished work stays yours.',
          '**Your rates, margins and costs.** The portal explains a price in terms of *their* property — the size of their lawn, the time it takes — and never exposes your hourly rate or what you make on the job.',
          '**Internal notes and pricing intelligence.** None of it reaches them.',
        ],
      },
    ],
  },
  {
    id: 'booking-link',
    title: 'Your booking link',
    category: 'customers',
    summary: 'How strangers become customers without you touching anything.',
    keywords: ['booking', 'website', 'lead', 'online', 'instant quote', 'book online'],
    sections: [
      {
        heading: 'How it works',
        body: [
          'Turn it on in **Settings → Booking link** and you get a public URL to put on your website or in your bio. A homeowner enters their address, the app measures their lawn from satellite, shows them a price, and books.',
          'The result lands as a **sent quote** plus a lead in Messages. Nothing is charged and nothing is scheduled — you confirm the price and pick the day.',
        ],
      },
      {
        heading: 'What they get, and what you must do',
        body: [
          'They get a confirmation email with their confirmation number the moment they book, so they have something in writing.',
          'That email promises a real person will get in touch **within one business day**. The app cannot keep that promise for you — it’s the one part of this flow that is entirely yours.',
        ],
      },
    ],
  },
]

// ── Search ───────────────────────────────────────────────────────────────────
// Deliberately simple and forgiving: every word you type must appear SOMEWHERE in
// the article (title, summary, keywords, or body), in any order. Ranked so a title
// hit beats a body hit — someone typing "autopay" wants the AutoPay article, not
// every article that happens to mention it.
export function searchHelp(query: string, articles: HelpArticle[] = HELP_ARTICLES): HelpArticle[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return articles
  const scored = articles.map(a => {
    const title = a.title.toLowerCase()
    const summary = a.summary.toLowerCase()
    const keys = a.keywords.join(' ').toLowerCase()
    const body = a.sections.map(s => s.heading + ' ' + s.body.join(' ')).join(' ').toLowerCase()
    const haystack = `${title} ${summary} ${keys} ${body}`
    if (!terms.every(t => haystack.includes(t))) return { a, score: 0 }
    let score = 0
    for (const t of terms) {
      if (title.includes(t)) score += 8
      else if (keys.includes(t)) score += 5
      else if (summary.includes(t)) score += 3
      else score += 1
    }
    return { a, score }
  })
  return scored.filter(s => s.score > 0).sort((x, y) => y.score - x.score).map(s => s.a)
}

export function helpArticle(id: string): HelpArticle | undefined {
  return HELP_ARTICLES.find(a => a.id === id)
}

/** Deep link to an article (and, optionally, straight to the Help Center). */
export function helpHref(id: string): string {
  return `/dashboard/help#${id}`
}
