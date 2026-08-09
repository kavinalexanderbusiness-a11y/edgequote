'use client'

import { useMemo, useState } from 'react'
import { Crew, Technician } from '@/types'
import {
  toTeamMember, groupTeam, searchTeam, memberGaps, teamSetupSummary,
  STANDING_LABEL, type TeamMember,
} from '@/lib/workforceTeam'
import { CREW_ACCESS_LABEL, type CrewAccessRow, type CrewAccessState } from '@/lib/crewInvite'
import { crewPalette } from '@/lib/crews'
import { Card, CardBody } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { SearchInput } from '@/components/ui/SearchInput'
import { EmptyState } from '@/components/ui/EmptyState'
import { cn } from '@/lib/utils'
import { UserPlus, HardHat, ChevronRight, Smartphone, Phone } from 'lucide-react'

// ── Who works here ───────────────────────────────────────────────────────────
// The answer to the first question an owner has about their team, on the page
// named after it. Until now Workforce was hours and payroll only, and the list
// of PEOPLE — plus every way to change one — lived in a modal behind a query
// parameter on the dispatch board. You could not see who worked for you on the
// Workforce page.
//
// One row per person, and the row carries what you'd otherwise have to open
// them to learn: their crew, whether they can use the app, and what setup is
// still missing. Tapping anywhere on the row opens the one editor.
//
// Working first, then anyone paused, then (folded away) anyone who has left —
// because "who works here" should be readable at a glance rather than filtered
// out of a mixed list in your head.

const ACCESS_TONE: Record<CrewAccessState, string> = {
  active: 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10',
  invited: 'text-accent-text border-accent/30 bg-accent/10',
  disabled: 'text-amber-400 border-amber-500/30 bg-amber-500/10',
  none: 'text-ink-faint border-border bg-bg-tertiary',
}

export function TeamPanel({ technicians, crews, accessById, onAdd, onOpen }: {
  /** Everyone, archived included — this panel does the grouping. */
  technicians: Technician[]
  crews: Crew[]
  accessById: Record<string, CrewAccessRow>
  onAdd: () => void
  onOpen: (t: Technician) => void
}) {
  const [query, setQuery] = useState('')
  const [showFormer, setShowFormer] = useState(false)

  const members = useMemo(
    () => technicians.map(t => toTeamMember(t, crews, accessById[t.id])),
    [technicians, crews, accessById],
  )
  const groups = useMemo(() => groupTeam(searchTeam(members, query)), [members, query])
  const setup = useMemo(() => teamSetupSummary(groupTeam(members)), [members])
  const total = groups.working.length + groups.paused.length
  const searching = query.trim().length > 0

  if (members.filter(m => m.standing !== 'former').length === 0 && !searching) {
    return (
      <Card>
        <CardBody className="p-0">
          <EmptyState
            icon={HardHat}
            className="py-14"
            title="Nobody on the team yet"
            description="Add the people who work for you. Once they're here you can put them on a crew, give them the app, clock their hours and run payroll."
            action={{ label: 'Add your first employee', onClick: onAdd }}
          />
        </CardBody>
      </Card>
    )
  }

  return (
    <Card>
      <CardBody className="p-0">
        <div className="px-4 sm:px-5 py-3 border-b border-border flex items-center gap-3 flex-wrap">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-ink">Team</h2>
            <p className="text-[11px] text-ink-faint">
              {groups.working.length} active
              {groups.paused.length > 0 && ` · ${groups.paused.length} inactive`}
              {setup && <span className="text-amber-400"> · {setup}</span>}
            </p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {total > 5 && (
              <SearchInput value={query} onChange={e => setQuery(e.target.value)} fieldSize="sm"
                aria-label="Find someone on the team" placeholder="Find someone…" className="w-36 sm:w-52" />
            )}
            <Button size="sm" onClick={onAdd}>
              <UserPlus className="w-3.5 h-3.5" /> <span className="hidden sm:inline">Add </span>employee
            </Button>
          </div>
        </div>

        {searching && total === 0 && (
          <p className="px-5 py-6 text-center text-sm text-ink-muted">Nobody matches “{query}”.</p>
        )}

        <ul className="divide-y divide-border">
          {groups.working.map(m => <Row key={m.id} m={m} crews={crews} onOpen={onOpen} />)}
        </ul>

        {groups.paused.length > 0 && (
          <>
            <p className="px-4 sm:px-5 py-1.5 bg-bg-tertiary/40 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint border-y border-border">
              Not working right now
            </p>
            <ul className="divide-y divide-border">
              {groups.paused.map(m => <Row key={m.id} m={m} crews={crews} onOpen={onOpen} />)}
            </ul>
          </>
        )}

        {groups.former.length > 0 && (
          <div className="border-t border-border">
            <button
              type="button"
              onClick={() => setShowFormer(v => !v)}
              aria-expanded={showFormer}
              className="w-full px-4 sm:px-5 py-2.5 text-left text-[11px] font-medium text-ink-faint hover:text-ink transition-colors"
            >
              {showFormer ? 'Hide' : 'Show'} {groups.former.length} former team member{groups.former.length !== 1 ? 's' : ''}
              <span className="text-ink-faint"> — their hours and pay history are kept</span>
            </button>
            {showFormer && (
              <ul className="divide-y divide-border border-t border-border">
                {groups.former.map(m => <Row key={m.id} m={m} crews={crews} onOpen={onOpen} />)}
              </ul>
            )}
          </div>
        )}
      </CardBody>
    </Card>
  )
}

function Row({ m, crews, onOpen }: { m: TeamMember; crews: Crew[]; onOpen: (t: Technician) => void }) {
  const gaps = memberGaps(m)
  const crewIdx = m.crewId ? crews.findIndex(c => c.id === m.crewId) : -1
  const pal = crewIdx >= 0 ? crewPalette(crews[crewIdx].color, crewIdx) : null
  const faded = m.standing !== 'working'

  return (
    <li>
      {/* The whole row is the target — 56px+ tall, so a thumb hits it. */}
      <button
        type="button"
        onClick={() => onOpen(m.tech)}
        className={cn(
          'w-full text-left px-4 sm:px-5 py-3 flex items-center gap-3 transition-colors hover:bg-bg-tertiary/50',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40',
          faded && 'opacity-60',
        )}
      >
        {/* Everything about this person WRAPS in one column, so a 360px phone
            gets the same facts as a desktop instead of an icon whose meaning it
            has to guess. An earlier version pinned the badges to a right-hand
            column and hid the access label behind an `xs:` breakpoint that does
            not exist in this Tailwind config — so on every phone it rendered as
            a bare icon. */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-ink truncate">{m.name}</span>
            {m.role && <span className="text-[11px] text-ink-faint truncate">{m.role}</span>}
            {m.standing === 'paused' && (
              <span className="text-[10px] font-semibold uppercase tracking-wide rounded px-1.5 py-0.5 border border-border bg-bg-tertiary text-ink-faint">
                {STANDING_LABEL.paused}
              </span>
            )}
          </div>
          <div className="mt-1.5 flex items-center gap-1.5 flex-wrap text-[11px]">
            {/* Crew, in the crew's own colour — the same identity the board uses. */}
            {m.crewName ? (
              <span className={cn('inline-flex items-center gap-1 rounded px-1.5 py-0.5 border', pal?.chip)}>
                <span className={cn('w-1.5 h-1.5 rounded-full', pal?.dot)} aria-hidden />
                {m.crewName}
              </span>
            ) : (
              <span className="rounded px-1.5 py-0.5 border border-border bg-bg-tertiary text-ink-faint">No crew</span>
            )}
            <span className={cn('inline-flex items-center gap-1 rounded px-1.5 py-0.5 border font-medium', ACCESS_TONE[m.access])}>
              <Smartphone className="w-3 h-3" aria-hidden />
              {CREW_ACCESS_LABEL[m.access]}
            </span>
            {/* What's still missing, so the row says what to do next — minus the
                two the row has already said. The crew chip reads "No crew" and
                the badge reads "No access", so repeating them as gap chips
                printed "New Start · No crew · No access · No crew · No wage". */}
            {gaps.filter(g => g.kind !== 'access' && g.kind !== 'crew').map(g => (
              <span key={g.kind} className="rounded px-1.5 py-0.5 border border-amber-500/30 bg-amber-500/10 text-amber-400 font-medium">
                {g.label}
              </span>
            ))}
            {m.phone && (
              <span className="text-ink-faint inline-flex items-center gap-1 tabular-nums">
                <Phone className="w-3 h-3" aria-hidden />{m.phone}
              </span>
            )}
          </div>
        </div>

        <ChevronRight className="w-4 h-4 shrink-0 text-ink-faint" aria-hidden />
      </button>
    </li>
  )
}
