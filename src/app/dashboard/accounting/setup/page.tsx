'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import type {
  BusinessSettings, FixedAsset, Liability, FixedAssetFormValues, LiabilityFormValues,
} from '@/types'
import { DEPRECIATION_METHODS, LIABILITY_KINDS } from '@/types'
import {
  listAssets, createAsset, updateAsset, archiveAsset, blankAsset, assetToForm,
  listLiabilities, createLiability, updateLiability, archiveLiability, blankLiability, liabilityToForm,
  openingFromSettings, saveOpening, type OpeningValues,
} from '@/lib/accounting/position'
import { depreciate } from '@/lib/accounting/depreciation'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card, CardBody } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Textarea } from '@/components/ui/Textarea'
import { Modal } from '@/components/ui/Modal'
import { Banner } from '@/components/ui/Banner'
import { Badge } from '@/components/ui/Badge'
import { Tabs } from '@/components/ui/Tabs'
import { InlineEmpty } from '@/components/ui/EmptyState'
import { Th, Td, tableRowHover } from '@/components/ui/Table'
import { Menu } from '@/components/ui/Menu'
import { toast } from '@/lib/toast'
import { confirm } from '@/lib/confirm'
import { formatCurrency, formatDate, localTodayISO } from '@/lib/utils'
import { Plus, Pencil, Trash2, MoreHorizontal, Info, Landmark, Wrench, CreditCard } from 'lucide-react'

// ── Balance sheet setup ──────────────────────────────────────────────────────
// The three inputs a balance sheet can't be derived without: what was in the bank
// when you started, what the business owns, and what it owes.
//
// Every field here is one the app CANNOT work out for itself. That's the whole
// reason this page exists rather than a computed figure: the payment ledger knows
// every movement since it started but not the balance before it, and there's no
// bank feed to ask.

type TabKey = 'opening' | 'assets' | 'liabilities'

export default function SetupPage() {
  const supabase = useMemo(() => createClient(), [])
  const todayISO = useMemo(() => localTodayISO(), [])

  const [tab, setTab] = useState<TabKey>('opening')
  const [userId, setUserId] = useState<string | null>(null)
  const [settings, setSettings] = useState<BusinessSettings | null>(null)
  const [assets, setAssets] = useState<FixedAsset[]>([])
  const [liabilities, setLiabilities] = useState<Liability[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    const { data: auth } = await supabase.auth.getUser()
    const uid = auth.user?.id
    if (!uid) { setLoading(false); return }
    setUserId(uid)
    const [{ data: s }, a, l] = await Promise.all([
      supabase.from('business_settings').select('*').eq('user_id', uid).maybeSingle(),
      listAssets(supabase, uid),
      listLiabilities(supabase, uid),
    ])
    setSettings((s as BusinessSettings) || null)
    setAssets(a)
    setLiabilities(l)
    setLoading(false)
  }, [supabase])

  useEffect(() => { load() }, [load])

  return (
    <div className="rise">
      <PageHeader
        title="Balance sheet setup"
        description="The few things the app can't work out on its own."
        crumb={{ label: 'Accounting', href: '/dashboard/accounting' }}
      />

      <Tabs
        tabs={[
          { key: 'opening', label: 'Opening position', icon: Landmark },
          { key: 'assets', label: 'What you own', icon: Wrench },
          { key: 'liabilities', label: 'What you owe', icon: CreditCard },
        ]}
        active={tab}
        onChange={k => setTab(k as TabKey)}
      />

      {loading ? null : (
        <div className="mt-5">
          {tab === 'opening' && (
            <OpeningPanel supabase={supabase} userId={userId} settings={settings} onSaved={load} />
          )}
          {tab === 'assets' && (
            <AssetsPanel supabase={supabase} userId={userId} assets={assets} todayISO={todayISO} onChanged={load} />
          )}
          {tab === 'liabilities' && (
            <LiabilitiesPanel supabase={supabase} userId={userId} liabilities={liabilities} todayISO={todayISO} onChanged={load} />
          )}
        </div>
      )}
    </div>
  )
}

// ── Opening position ─────────────────────────────────────────────────────────

function OpeningPanel({ supabase, userId, settings, onSaved }: {
  supabase: ReturnType<typeof createClient>; userId: string | null
  settings: BusinessSettings | null; onSaved: () => void | Promise<void>
}) {
  const [v, setV] = useState<OpeningValues>(() => openingFromSettings(settings))
  const [saving, setSaving] = useState(false)
  useEffect(() => { setV(openingFromSettings(settings)) }, [settings])

  async function save() {
    if (!userId || saving) return
    setSaving(true)
    const { error } = await saveOpening(supabase, userId, v)
    setSaving(false)
    if (error) { toast.error(error); return }
    await onSaved()
    toast.success('Opening position saved')
  }

  return (
    <div className="flex flex-col gap-4 max-w-2xl">
      <Banner tone="info" icon={Info}>
        EdgeQuote knows every payment and expense since you started using it — but not what was
        in the bank the day before. Without that, cash is a <em>movement</em>, not a{' '}
        <em>balance</em>, and a balance sheet can&apos;t be worked out at all.
      </Banner>

      <Card>
        <CardBody>
          <div className="flex flex-col gap-4">
            <Input
              label="Bank balance when you started"
              inputMode="decimal"
              placeholder="0.00"
              value={v.opening_bank_balance}
              onChange={e => setV(p => ({ ...p, opening_bank_balance: e.target.value }))}
              hint="What was actually in the business account at the end of the day below."
            />
            <Input
              label="On this date"
              type="date"
              value={v.opening_balance_date}
              onChange={e => setV(p => ({ ...p, opening_balance_date: e.target.value }))}
              hint="Anything that moved on or before this day is already inside the balance above — only what came after counts."
            />
            <Input
              label="What you'd put into the business by then"
              inputMode="decimal"
              placeholder="Leave blank if you're not sure"
              value={v.opening_equity}
              onChange={e => setV(p => ({ ...p, opening_equity: e.target.value }))}
              hint="Your own money, in. Leave it blank if you don't know — the balance sheet will show an unexplained gap rather than invent a number to make itself add up."
            />
            <div className="flex justify-end">
              <Button onClick={save} loading={saving}>Save</Button>
            </div>
          </div>
        </CardBody>
      </Card>
    </div>
  )
}

// ── Assets ───────────────────────────────────────────────────────────────────

function AssetsPanel({ supabase, userId, assets, todayISO, onChanged }: {
  supabase: ReturnType<typeof createClient>; userId: string | null
  assets: FixedAsset[]; todayISO: string; onChanged: () => void | Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<FixedAsset | null>(null)
  const [values, setValues] = useState<FixedAssetFormValues>(() => blankAsset(todayISO))
  const [saving, setSaving] = useState(false)

  function openNew() { setEditing(null); setValues(blankAsset(todayISO)); setOpen(true) }
  function openEdit(a: FixedAsset) { setEditing(a); setValues(assetToForm(a)); setOpen(true) }
  const set = (k: keyof FixedAssetFormValues, val: string) => setValues(p => ({ ...p, [k]: val }))

  async function save() {
    if (!userId || saving) return
    setSaving(true)
    const res = editing ? await updateAsset(supabase, editing.id, values) : await createAsset(supabase, { userId, values })
    setSaving(false)
    if (res.error) { toast.error(res.error); return }
    await onChanged()
    setOpen(false)
    toast.success(editing ? 'Asset updated' : `Added ${values.name.trim()}`)
  }

  async function archive(a: FixedAsset) {
    const go = await confirm({
      title: `Remove ${a.name}?`,
      message: 'It comes off the balance sheet. If you sold it, edit it and set a disposal date instead — that keeps the history and the cost basis your accountant needs.',
    })
    if (!go) return
    const { error } = await archiveAsset(supabase, a.id)
    if (error) { toast.error(error); return }
    await onChanged()
    toast.success('Removed')
  }

  return (
    <div className="flex flex-col gap-4">
      <Banner tone="info" icon={Info}>
        Gear that lasts years — a mower, a trailer, a truck. It isn&apos;t a cost the day you buy
        it; it&apos;s worth something, and it wears out over time. These are book figures for your
        balance sheet, not a CRA capital cost allowance calculation — your accountant does that
        from the cost basis in the export.
      </Banner>

      <div className="flex justify-end">
        <Button variant="secondary" size="sm" onClick={openNew}><Plus className="w-4 h-4" /> Add asset</Button>
      </div>

      {assets.length === 0 ? (
        <InlineEmpty icon={Wrench}>Nothing recorded — so the balance sheet says the business owns nothing.</InlineEmpty>
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <Th>Asset</Th>
                  <Th className="text-right">Cost</Th>
                  <Th className="text-right">Written off</Th>
                  <Th className="text-right">Worth now</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {assets.map(a => {
                  const d = depreciate(a, todayISO)
                  return (
                    <tr key={a.id} className={tableRowHover}>
                      <Td>
                        <span className="flex items-center gap-2 flex-wrap">
                          <span className="text-ink font-medium">{a.name}</span>
                          {a.disposed_at && <Badge tone="neutral">sold {formatDate(a.disposed_at)}</Badge>}
                          {d.fullyDepreciated && !a.disposed_at && <Badge tone="neutral">fully written off</Badge>}
                        </span>
                        <span className="block text-xs text-ink-faint">
                          {formatDate(a.in_service_date)} ·{' '}
                          {a.method === 'straight_line' ? `straight line over ${a.useful_life_years}yr`
                            : a.method === 'declining_balance' ? `${a.declining_rate}% declining`
                            : 'not depreciated'}
                        </span>
                      </Td>
                      <Td className="text-right tabular-nums text-ink-muted">{formatCurrency(d.cost)}</Td>
                      <Td className="text-right tabular-nums text-ink-muted">{formatCurrency(d.accumulated)}</Td>
                      <Td className="text-right tabular-nums text-ink font-medium">{formatCurrency(d.bookValue)}</Td>
                      <Td className="text-right">
                        <Menu
                          align="end" width={180} ariaLabel="Asset actions"
                          items={[
                            { key: 'edit', label: 'Edit', icon: Pencil, onSelect: () => openEdit(a) },
                            { key: 'archive', label: 'Remove', icon: Trash2, danger: true, onSelect: () => archive(a) },
                          ]}
                        >
                          {({ toggle, triggerProps }) => (
                            <Button variant="ghost" size="sm" onClick={toggle} {...triggerProps} aria-label="Asset actions">
                              <MoreHorizontal className="w-4 h-4" />
                            </Button>
                          )}
                        </Menu>
                      </Td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={editing ? 'Edit asset' : 'Add asset'}
        size="lg"
        onSubmit={save}
        footer={
          <div className="flex gap-2 justify-end">
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={saving}>Cancel</Button>
            <Button onClick={save} loading={saving}>{editing ? 'Save' : 'Add asset'}</Button>
          </div>
        }
      >
        <div className="flex flex-col gap-3">
          <Input label="What is it?" value={values.name} onChange={e => set('name', e.target.value)} autoFocus placeholder="Zero-turn mower" />
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Input label="What it cost" inputMode="decimal" value={values.cost} onChange={e => set('cost', e.target.value)} placeholder="0.00" />
            <Input label="Tax included" inputMode="decimal" value={values.tax_amount} onChange={e => set('tax_amount', e.target.value)} placeholder="0.00" />
            <Input label="In service from" type="date" value={values.in_service_date} onChange={e => set('in_service_date', e.target.value)} />
          </div>

          <Select
            label="How should it wear out?"
            options={DEPRECIATION_METHODS}
            value={values.method}
            onChange={e => set('method', e.target.value)}
          />
          {values.method === 'straight_line' && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Input label="Useful life (years)" inputMode="decimal" value={values.useful_life_years} onChange={e => set('useful_life_years', e.target.value)} hint="Required — nothing is assumed for you." />
              <Input label="Worth at the end" inputMode="decimal" value={values.salvage_value} onChange={e => set('salvage_value', e.target.value)} placeholder="0.00" hint="It never writes below this." />
            </div>
          )}
          {values.method === 'declining_balance' && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Input label="Rate (% a year)" inputMode="decimal" value={values.declining_rate} onChange={e => set('declining_rate', e.target.value)} placeholder="20" hint="A share of what's left each year, not of the original cost." />
              <Input label="Worth at the end" inputMode="decimal" value={values.salvage_value} onChange={e => set('salvage_value', e.target.value)} placeholder="0.00" />
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input label="Sold or scrapped on" type="date" value={values.disposed_at} onChange={e => set('disposed_at', e.target.value)} hint="Leave blank if you still have it." />
            {values.disposed_at && (
              <Input label="What you got for it" inputMode="decimal" value={values.disposal_proceeds} onChange={e => set('disposal_proceeds', e.target.value)} placeholder="0.00" />
            )}
          </div>
          <Textarea label="Notes" rows={2} value={values.notes} onChange={e => set('notes', e.target.value)} />
        </div>
      </Modal>
    </div>
  )
}

// ── Liabilities ──────────────────────────────────────────────────────────────

function LiabilitiesPanel({ supabase, userId, liabilities, todayISO, onChanged }: {
  supabase: ReturnType<typeof createClient>; userId: string | null
  liabilities: Liability[]; todayISO: string; onChanged: () => void | Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<Liability | null>(null)
  const [values, setValues] = useState<LiabilityFormValues>(() => blankLiability(todayISO))
  const [saving, setSaving] = useState(false)

  function openNew() { setEditing(null); setValues(blankLiability(todayISO)); setOpen(true) }
  function openEdit(l: Liability) { setEditing(l); setValues(liabilityToForm(l)); setOpen(true) }
  const set = (k: keyof LiabilityFormValues, val: string) => setValues(p => ({ ...p, [k]: val }))

  async function save() {
    if (!userId || saving) return
    setSaving(true)
    const res = editing ? await updateLiability(supabase, editing.id, values) : await createLiability(supabase, { userId, values })
    setSaving(false)
    if (res.error) { toast.error(res.error); return }
    await onChanged()
    setOpen(false)
    toast.success(editing ? 'Updated' : `Added ${values.name.trim()}`)
  }

  async function archive(l: Liability) {
    const { error } = await archiveLiability(supabase, l.id)
    if (error) { toast.error(error); return }
    await onChanged()
    toast.success('Removed')
  }

  // A balance the owner stated months ago is not today's balance. Say how old it is
  // rather than presenting a stale figure as current.
  const stale = liabilities.filter(l => monthsSince(l.as_of_date, todayISO) >= 3)

  return (
    <div className="flex flex-col gap-4">
      <Banner tone="info" icon={Info}>
        Loans, cards, anything the business still owes. There&apos;s no bank feed here, so these
        are the figures <em>you</em> tell us — we show the date you last updated each one rather
        than pretending it&apos;s live.
      </Banner>

      {stale.length > 0 && (
        <Banner tone="warn">
          {stale.length} balance{stale.length === 1 ? ' is' : 's are'} more than three months old.
          The balance sheet is only as current as {stale.length === 1 ? 'it' : 'they'} are.
        </Banner>
      )}

      <div className="flex justify-end">
        <Button variant="secondary" size="sm" onClick={openNew}><Plus className="w-4 h-4" /> Add</Button>
      </div>

      {liabilities.length === 0 ? (
        <InlineEmpty icon={CreditCard}>Nothing recorded. If the business owes money, the balance sheet is currently overstating what it&apos;s worth.</InlineEmpty>
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <Th>What</Th>
                  <Th>Last updated</Th>
                  <Th className="text-right">Owed</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {liabilities.map(l => (
                  <tr key={l.id} className={tableRowHover}>
                    <Td>
                      <span className="text-ink font-medium">{l.name}</span>
                      <span className="block text-xs text-ink-faint">
                        {LIABILITY_KINDS.find(k => k.value === l.kind)?.label ?? l.kind}
                        {l.interest_rate != null && ` · ${l.interest_rate}%`}
                      </span>
                    </Td>
                    <Td className="text-ink-muted">
                      {formatDate(l.as_of_date)}
                      {monthsSince(l.as_of_date, todayISO) >= 3 && <Badge tone="warn" className="ml-2">stale</Badge>}
                    </Td>
                    <Td className="text-right tabular-nums text-ink font-medium">{formatCurrency(Number(l.current_balance))}</Td>
                    <Td className="text-right">
                      <Menu
                        align="end" width={180} ariaLabel="Actions"
                        items={[
                          { key: 'edit', label: 'Update balance', icon: Pencil, onSelect: () => openEdit(l) },
                          { key: 'archive', label: 'Remove', icon: Trash2, danger: true, onSelect: () => archive(l) },
                        ]}
                      >
                        {({ toggle, triggerProps }) => (
                          <Button variant="ghost" size="sm" onClick={toggle} {...triggerProps} aria-label="Actions">
                            <MoreHorizontal className="w-4 h-4" />
                          </Button>
                        )}
                      </Menu>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={editing ? 'Update balance' : 'Add what you owe'}
        onSubmit={save}
        footer={
          <div className="flex gap-2 justify-end">
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={saving}>Cancel</Button>
            <Button onClick={save} loading={saving}>{editing ? 'Save' : 'Add'}</Button>
          </div>
        }
      >
        <div className="flex flex-col gap-3">
          <Input label="What is it?" value={values.name} onChange={e => set('name', e.target.value)} autoFocus placeholder="Truck loan" />
          <Select label="Kind" options={LIABILITY_KINDS} value={values.kind} onChange={e => set('kind', e.target.value)} />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input label="Still owed" inputMode="decimal" value={values.current_balance} onChange={e => set('current_balance', e.target.value)} placeholder="0.00" />
            <Input label="As at" type="date" value={values.as_of_date} onChange={e => set('as_of_date', e.target.value)} hint="When was that the balance?" />
          </div>
          <Input label="Interest rate (%)" inputMode="decimal" value={values.interest_rate} onChange={e => set('interest_rate', e.target.value)} placeholder="Optional" />
          <Textarea label="Notes" rows={2} value={values.notes} onChange={e => set('notes', e.target.value)} />
        </div>
      </Modal>
    </div>
  )
}

/** Whole months between two ISO dates. String arithmetic — no Date parsing. */
function monthsSince(fromISO: string, toISO: string): number {
  const fy = Number(fromISO.slice(0, 4)), fm = Number(fromISO.slice(5, 7))
  const ty = Number(toISO.slice(0, 4)), tm = Number(toISO.slice(5, 7))
  return (ty - fy) * 12 + (tm - fm)
}
