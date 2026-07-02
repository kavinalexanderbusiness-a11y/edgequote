-- ════════════════════════════════════════════════════════════
-- RUN THIS in the Supabase SQL editor BEFORE deploying.
-- Manual route order (drag-and-drop day sequencing). Idempotent.
-- ════════════════════════════════════════════════════════════
--
-- jobs.route_order: the owner's manual visit sequence for the day.
--   null = automatic (the route optimizer orders the day, as before)
--   1..N = the owner's drag-and-drop order — ETAs, finish time, drive legs and
--          "Open in Maps" all follow it via the same route engine.
alter table public.jobs add column if not exists route_order int;

-- When a job MOVES to a different date (manual move, optimizer, rain delay,
-- calendar drag — any path), its manual sequence position is meaningless on the
-- new day. Clear it AT THE SOURCE so no app path can forget to: the job simply
-- appends to the target day's order (or rejoins the optimizer's order).
create or replace function public.clear_route_order_on_move() returns trigger
language plpgsql as $$
begin
  if new.scheduled_date is distinct from old.scheduled_date then
    new.route_order := null;
  end if;
  return new;
end $$;
drop trigger if exists trg_jobs_clear_route_order on public.jobs;
create trigger trg_jobs_clear_route_order before update of scheduled_date on public.jobs
  for each row execute function public.clear_route_order_on_move();
