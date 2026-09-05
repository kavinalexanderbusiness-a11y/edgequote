-- ══════════════════════════════════════════════════════════════════════════════
-- PROOF OF WORK V1 — what a finished visit LEFT BEHIND
--
-- A visit already answers WHETHER and WHEN it was completed: jobs.status plus
-- jobs.completed_at, stamped in exactly ONE place (lib/jobStatus.completionPatch).
-- ⛔ THIS MIGRATION ADDS NO SECOND COMPLETION STATE. No status, no second
-- timestamp, no completion table, no checklist engine. Two nullable text columns
-- on the row that is already the record, and one typed door for a crew session
-- to write them.
--
-- ⭐ THE VISIBILITY BOUNDARY IS THE POINT OF HAVING TWO COLUMNS:
--     completion_summary  → CUSTOMER-VISIBLE (get_portal_data selects it)
--     completion_issue    → INTERNAL ONLY    (get_portal_data must never select it)
--
-- ⚠️ THE DEFECT THAT FORCED THE SPLIT. jobs.notes is authored as an internal
-- instruction to whoever does the work — the job form describes it as "notes for
-- whoever does the work", and crew_day ships it to the worker's phone labelled
-- "the access note (gate code, where to park)". get_portal_data ALSO selected it
-- and the portal rendered it verbatim in the customer's visit history. 49 of 78
-- completed production visits carried one, including "dog removal, keep gate
-- closed". One field cannot be both audiences. So notes stays internal and
-- LEAVES the portal payload (see CANONICAL-get_portal_data.sql), and the
-- customer gets a field that was written for them.
--
-- Photos are NOT touched: job_photos + the job-photos bucket are already THE
-- catalogue and THE storage, and PhotoKind has carried before/after/general
-- since 2026-06. A parallel upload system would be the mistake this avoids.
--
-- IDEMPOTENT. Safe to re-run.
-- ══════════════════════════════════════════════════════════════════════════════

-- ── 1. The two record columns ───────────────────────────────────────────────
-- Nullable on purpose and forever: completion must NEVER depend on paperwork.
-- A routine mow is finished by one tap and leaves both of these NULL, and that
-- is a complete, honest record — "nothing was said", not "nothing was done".
alter table public.jobs
  add column if not exists completion_summary text,
  add column if not exists completion_issue   text;

-- The boundary, stated in the database itself, so it survives every future
-- reader who never opens lib/completion.ts.
comment on column public.jobs.completion_summary is
  'CUSTOMER-VISIBLE. What was done, written for the person who paid for it. Selected by get_portal_data and rendered verbatim in the portal visit history. Never put internal remarks here.';
comment on column public.jobs.completion_issue is
  'INTERNAL ONLY. What the field found that needs attention (leaking sprinkler head, wants a hedge quote). MUST NOT be selected by get_portal_data or reach any customer surface.';
comment on column public.jobs.notes is
  'INTERNAL ONLY. The access/instruction note for whoever does the work (gate code, where to park). Shipped to the crew by crew_day. Removed from get_portal_data 2026-08-11 — it was being rendered to customers. Customer-facing words go in completion_summary.';

-- Length is bounded in the app (lib/completion normalizes and truncates). A DB
-- constraint is deliberately NOT added: it would turn a long paste into a failed
-- save at the end of a day in the field, and truncation on the way in is the
-- kinder honest answer.

-- ── 2. The crew door ────────────────────────────────────────────────────────
-- A crew session holds NO table grants at all — that is crew-mode's founding
-- rule (RLS is ROW-level, so any policy letting a worker patch `jobs` would also
-- expose jobs.price). So the worker's record goes through a SECURITY DEFINER
-- RPC with TYPED PARAMETERS, exactly like crew_set_visit_status: there is no
-- jsonb patch a client could stuff `price` into, and the only columns this
-- function can write are the two it names.
--
-- ⛔ It writes NO lifecycle field. status, completed_at, actual_minutes and the
-- invoice remain the business of crew_set_visit_status / /api/crew/complete.
-- Recording what happened is not a transition, and a visit already billed must
-- not be re-billed because a photo caption arrived an hour later.
--
-- Authorization is re-checked HERE (DEFINER runs past RLS): same employer, same
-- crew, not cancelled — the same predicate the status door enforces. The roster
-- switches remain the access control, so a deactivated worker fails mid-shift
-- with an unexpired JWT.
create or replace function public.crew_set_completion_record(
  p_job_id  uuid,
  p_summary text default null,
  p_issue   text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_employer uuid := public.crew_employer();
  v_crew     uuid := public.crew_crew_id();
  v_summary  text := nullif(btrim(coalesce(p_summary, '')), '');
  v_issue    text := nullif(btrim(coalesce(p_issue, '')), '');
  v_prev     text;
  v_job      record;
begin
  if v_employer is null or v_crew is null then
    raise exception 'you are not on an active crew' using errcode = '42501';
  end if;

  -- Bound the text here too. The app truncates on the way in; this is the
  -- backstop for anything that reaches the RPC by another route.
  v_summary := left(v_summary, 500);
  v_issue   := left(v_issue, 500);

  select j.completion_issue into v_prev
    from public.jobs j
   where j.id = p_job_id and j.user_id = v_employer and j.crew_id = v_crew
     and j.status <> 'cancelled';

  update public.jobs j
     set completion_summary = v_summary,
         completion_issue   = v_issue
   where j.id = p_job_id
     and j.user_id = v_employer
     and j.crew_id = v_crew
     and j.status <> 'cancelled'
  returning j.id, j.title, j.customer_id into v_job;

  if v_job.id is null then
    -- Not this crew's visit, or it was cancelled underneath them. Never a
    -- silent success: the phone must say the note did not save.
    return jsonb_build_object('ok', false, 'reason', 'not_yours');
  end if;

  -- ── The office learns about a problem, through the primitive that already
  -- exists ──────────────────────────────────────────────────────────────────
  -- ⛔ NOT a new reminder system, and NOT a follow-up: `follow_ups` is Session
  -- 14's primitive and is unreferenced by any code on main, so nothing here
  -- writes it. This is the SAME notifications bell /api/crew/complete already
  -- rings for an uninvoiced crew completion, so a worker's "sprinkler head is
  -- leaking" reaches the one place the owner already looks.
  --
  -- Fires only on the transition into having an issue (null → text), and only
  -- when no bell for this visit is already up: a retried save, or a typo fix,
  -- must not stack notifications. The visit itself always carries the CURRENT
  -- text, so the record stays right even when the bell doesn't ring twice.
  if v_issue is not null and v_prev is distinct from v_issue then
    insert into public.notifications (user_id, type, title, body, customer_id, entity_type, entity_id, href)
    select v_employer, 'crew_visit_issue', 'Your crew flagged something',
           coalesce(v_job.title, 'A visit') || ': ' || v_issue,
           v_job.customer_id, 'job', v_job.id, '/dashboard/dispatch'
     where not exists (
       select 1 from public.notifications n
        where n.user_id = v_employer and n.type = 'crew_visit_issue' and n.entity_id = v_job.id
     );
  end if;

  return jsonb_build_object('ok', true);
end
$$;

-- Supabase's DEFAULT PRIVILEGES grant EXECUTE on every new public function to
-- anon AND authenticated at CREATE time, and `revoke ... from public` does NOT
-- remove that. Revoke by role name, then grant back only the role that may call
-- it. (Harmless either way — crew_employer() is NULL for anon, so the function
-- fails closed — but the grant should still say what is true.)
revoke all on function public.crew_set_completion_record(uuid, text, text) from anon;
revoke all on function public.crew_set_completion_record(uuid, text, text) from public;
grant execute on function public.crew_set_completion_record(uuid, text, text) to authenticated;

comment on function public.crew_set_completion_record(uuid, text, text) is
  'Crew Mode: record what was done (customer-visible) and what needs attention (internal) on an assigned, non-cancelled visit. Typed parameters only — writes exactly two columns and no lifecycle field. Re-checks employer + crew because DEFINER runs past RLS.';
