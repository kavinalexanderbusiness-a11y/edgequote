import Link from 'next/link'
import { StatTile } from '@/components/ui/StatTile'
import { formatCurrency } from '@/lib/utils'
import type { SalesSnapshot as Snapshot } from '@/lib/sales/analytics'
import { FileText, Hourglass, Trophy, XCircle, ClipboardCheck, Receipt, Banknote } from 'lucide-react'

// ── The sales snapshot ───────────────────────────────────────────────────────
// ⚖️ Five money figures, five tiles, and NONE of them is called "revenue".
//
// Every tile carries a sub-line saying what the figure MEANS, because these
// numbers are close enough in size to be mistaken for each other and far enough
// apart in meaning that mistaking them is expensive. "Quoted $31,200" next to
// "Collected $7,850" is only honest if the owner can see why they differ.
//
// ⛔ There is deliberately no "expected revenue" tile. EdgeQuote has no
// defensible model for what an open quote will become, so it states what IS
// ($9,600 in open quotes awaiting a decision) rather than what might be.

export function SalesSnapshot({ s }: { s: Snapshot }) {
  const money = (n: number) => formatCurrency(n)

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        <StatTile
          icon={FileText}
          label="Quoted"
          value={money(s.quoted)}
          sub={`${s.quotedCount} quote${s.quotedCount === 1 ? '' : 's'} sent${s.draftCount > 0 ? ` · ${s.draftCount} still draft` : ''}`}
        />
        <StatTile
          icon={Hourglass}
          label="Still open"
          value={money(s.open)}
          tone={s.openCount > 0 ? 'info' : undefined}
          sub={`${s.openCount} awaiting a decision`}
        />
        <StatTile
          icon={Trophy}
          label="Won"
          value={money(s.won)}
          tone={s.wonCount > 0 ? 'success' : undefined}
          sub={
            s.winRate != null
              ? `${s.wonCount} accepted · ${Math.round(s.winRate * 100)}% of decided`
              : `${s.wonCount} accepted · too few decided for a rate`
          }
        />
        <StatTile
          icon={XCircle}
          label="Lost"
          value={money(s.lost)}
          sub={`${s.lostCount} declined`}
        />
        <StatTile
          icon={ClipboardCheck}
          label="Authorized now"
          value={money(s.authorized)}
          sub={
            s.approvedChanges > 0
              ? `won + ${money(s.approvedChanges)} approved changes`
              : 'won work, no change orders approved'
          }
        />
        <StatTile
          icon={Receipt}
          label="Invoiced"
          value={money(s.invoiced)}
          sub={`${s.invoicedCount} invoice${s.invoicedCount === 1 ? '' : 's'} issued${s.invoiceDraftCount > 0 ? ` · ${s.invoiceDraftCount} draft` : ''}`}
        />
      </div>

      {/* Collected gets the hero surface: it is the only figure on this page that
          is money the business actually has. */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        <StatTile
          accent
          icon={Banknote}
          label="Collected"
          value={money(s.netCollected)}
          sub={s.refunded > 0 ? `${money(s.collected)} in, ${money(s.refunded)} refunded` : 'money that actually arrived'}
        />
        <StatTile
          label="Still owed"
          value={money(s.outstanding)}
          tone={s.outstanding > 0 ? 'warn' : undefined}
          sub={s.outstanding > 0
            ? <Link href="/dashboard/invoices" className="underline hover:text-accent-text">on issued invoices</Link>
            : 'nothing outstanding'}
        />
        {/* A pending change order is the CUSTOMER's move, and is not authorized
            money. It only earns a tile when one exists. */}
        {s.pendingChangeCount > 0 && (
          <StatTile
            label="Awaiting approval"
            value={money(s.pendingChanges)}
            sub={`${s.pendingChangeCount} change order${s.pendingChangeCount === 1 ? '' : 's'} · not yet authorized`}
          />
        )}
      </div>

      {/* Say out loud what the tiles cannot: which figures were deliberately
          excluded, and why a number is missing rather than zero. */}
      {(s.cancelledCount > 0 || s.draftCount > 0 || s.invoiceDraftCount > 0) && (
        <p className="text-[11px] text-ink-faint leading-relaxed">
          {[
            s.draftCount > 0 && `${s.draftCount} draft quote${s.draftCount === 1 ? '' : 's'} (${formatCurrency(s.draft)}) ${s.draftCount === 1 ? 'is' : 'are'} not counted as quoted — nobody has seen ${s.draftCount === 1 ? 'it' : 'them'}`,
            s.invoiceDraftCount > 0 && `${formatCurrency(s.invoiceDraft)} sits in draft invoices, not yet asked for`,
            s.cancelledCount > 0 && `${s.cancelledCount} cancelled invoice${s.cancelledCount === 1 ? '' : 's'} excluded from invoiced and from what you're owed`,
          ].filter(Boolean).join(' · ')}.
        </p>
      )}
    </div>
  )
}
