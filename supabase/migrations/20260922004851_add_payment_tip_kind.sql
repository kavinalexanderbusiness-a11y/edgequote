-- Tips are cash received alongside a hosted invoice checkout, but they are not
-- invoice settlement, service revenue, or taxable invoice consideration. A
-- dedicated ledger kind lets existing invoice and revenue queries continue to
-- include only kind='payment'. Existing RLS policies on public.payments apply to
-- tip rows unchanged; no new table or grant is introduced.
alter table public.payments drop constraint if exists payments_kind_check;
alter table public.payments
  add constraint payments_kind_check
  check (kind = any (array['payment'::text, 'credit'::text, 'refund'::text, 'tip'::text]));
