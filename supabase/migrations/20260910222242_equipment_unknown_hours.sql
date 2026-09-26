-- Unknown/not-applicable hours are not a zero-hour meter reading.
-- Preserve every existing value: old zeroes cannot safely be inferred as unknown.
-- Apply before deploying the UI that saves a blank Engine hours field as NULL.
alter table public.equipment
  alter column hours drop not null,
  alter column hours drop default;
