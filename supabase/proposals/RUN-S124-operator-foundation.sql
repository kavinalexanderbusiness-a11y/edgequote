-- Edge Operator V1 — approval/audit foundation. PROPOSAL, NOT A MIGRATION.
-- Lives under supabase/proposals/ (the S122 RUN-* pattern) so a from-zero
-- rebuild stays faithful to the production contract: nothing here has been
-- applied anywhere. At landing, S106 versions this from the live ledger into
-- supabase/migrations/ and applies it there. No production apply is authorized
-- from this branch.
--
-- EdgeQuote's current tenant key is auth.users.id == public.*.user_id. Policies
-- intentionally derive that identity from auth.uid(); no model/client tenant id
-- can widen access. Phase 1 exposes read-only business tools; these tables hold
-- operator metadata and the future approval contract only.

begin;

create table public.operator_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  created_by uuid not null references auth.users(id),
  title text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id)
);

create table public.operator_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  initiated_by uuid not null references auth.users(id),
  conversation_id uuid,
  idempotency_key text not null,
  question text,
  answer text,
  tools_used jsonb not null default '[]'::jsonb,
  -- Cost/audit trail: WHICH brain answered, at what token spend. 'deterministic'
  -- means no model was called (no key, provider off, or the model answer failed
  -- validation and the deterministic floor shipped). Never stores keys, prompts,
  -- or provider error text — those stay in server logs.
  provider text not null default 'deterministic' check (provider in ('deterministic','anthropic')),
  model text,
  tokens_in integer,
  tokens_out integer,
  status text not null default 'running' check (status in ('running','completed','failed')),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (id, user_id),
  unique (user_id, idempotency_key),
  foreign key (conversation_id, user_id) references public.operator_conversations(id, user_id) on delete restrict
);

create table public.operator_tool_calls (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  run_id uuid not null,
  tool_name text not null,
  input jsonb not null default '{}'::jsonb,
  output_summary jsonb,
  status text not null default 'completed' check (status in ('started','completed','failed')),
  created_at timestamptz not null default now(),
  unique (id, user_id),
  foreign key (run_id, user_id) references public.operator_runs(id, user_id) on delete cascade
);

create table public.operator_proposed_actions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  initiating_user_id uuid not null references auth.users(id),
  run_id uuid,
  action_type text not null,
  target_records jsonb not null default '[]'::jsonb,
  preview text not null,
  before_state_hash text not null,
  idempotency_key text not null,
  expires_at timestamptz not null,
  status text not null default 'proposed' check (status in ('proposed','approved','rejected','expired','executed','failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id),
  unique (user_id, idempotency_key),
  foreign key (run_id, user_id) references public.operator_runs(id, user_id) on delete restrict
);

create table public.operator_approvals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  proposed_action_id uuid not null,
  decision text not null check (decision in ('approved','rejected')),
  decided_by uuid not null references auth.users(id),
  decided_at timestamptz not null default now(),
  note text,
  created_at timestamptz not null default now(),
  unique (id, user_id),
  foreign key (proposed_action_id, user_id) references public.operator_proposed_actions(id, user_id) on delete cascade
);

create table public.operator_execution_results (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  proposed_action_id uuid not null,
  status text not null check (status in ('executed','failed')),
  result jsonb,
  executed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (id, user_id),
  foreign key (proposed_action_id, user_id) references public.operator_proposed_actions(id, user_id) on delete cascade
);

create table public.operator_failures (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  run_id uuid,
  tool_call_id uuid,
  error_code text,
  error_message text not null,
  context jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (id, user_id),
  foreign key (run_id, user_id) references public.operator_runs(id, user_id) on delete cascade,
  foreign key (tool_call_id, user_id) references public.operator_tool_calls(id, user_id) on delete cascade
);

create index operator_conversations_user_updated_idx on public.operator_conversations(user_id, updated_at desc);
create index operator_runs_user_created_idx on public.operator_runs(user_id, created_at desc);
create index operator_runs_user_status_created_idx on public.operator_runs(user_id, status, created_at desc);
create index operator_tool_calls_user_run_created_idx on public.operator_tool_calls(user_id, run_id, created_at);
create index operator_proposed_actions_user_status_created_idx on public.operator_proposed_actions(user_id, status, created_at desc);
create index operator_approvals_user_action_decided_idx on public.operator_approvals(user_id, proposed_action_id, decided_at desc);
create index operator_execution_results_user_action_idx on public.operator_execution_results(user_id, proposed_action_id, executed_at desc);
create index operator_failures_user_created_idx on public.operator_failures(user_id, created_at desc);

-- Every FK column set gets a covering index (the Supabase unindexed_foreign_keys
-- advisor rule, and real delete-path performance): the composite tenant FKs that
-- the leading-user_id indexes above don't already prefix-cover, plus the four
-- actor columns referencing auth.users — without these, deleting an auth user
-- seq-scans each operator table per FK.
create index operator_runs_conversation_fk_idx on public.operator_runs(conversation_id, user_id);
create index operator_proposed_actions_run_fk_idx on public.operator_proposed_actions(run_id, user_id);
create index operator_failures_run_fk_idx on public.operator_failures(run_id, user_id);
create index operator_failures_tool_call_fk_idx on public.operator_failures(tool_call_id, user_id);
create index operator_conversations_created_by_idx on public.operator_conversations(created_by);
create index operator_runs_initiated_by_idx on public.operator_runs(initiated_by);
create index operator_proposed_actions_initiating_idx on public.operator_proposed_actions(initiating_user_id);
create index operator_approvals_decided_by_idx on public.operator_approvals(decided_by);

alter table public.operator_conversations enable row level security;
alter table public.operator_runs enable row level security;
alter table public.operator_tool_calls enable row level security;
alter table public.operator_proposed_actions enable row level security;
alter table public.operator_approvals enable row level security;
alter table public.operator_execution_results enable row level security;
alter table public.operator_failures enable row level security;

create policy "operator_conversations select own" on public.operator_conversations for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "operator_conversations insert own" on public.operator_conversations for insert to authenticated
  with check ((select auth.uid()) = user_id and created_by = (select auth.uid()));
-- Deliberately NO update policy in Phase 1: nothing edits a conversation yet,
-- and an unused mutable surface is where audit integrity quietly leaks. Phase 2
-- adds a reviewed update seam (title rename) when a code path needs one.

create policy "operator_runs select own" on public.operator_runs for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "operator_runs insert own" on public.operator_runs for insert to authenticated
  with check ((select auth.uid()) = user_id and initiated_by = (select auth.uid()));
-- Deliberately NO update policy in Phase 1: the route records runs with
-- INSERT ... ON CONFLICT DO NOTHING only, so run history is append-only for the
-- app role — a run row that can be rewritten is telemetry, not a record. The
-- Phase-2 approval seam decides which columns (if any) become updatable.

create policy "operator_tool_calls select own" on public.operator_tool_calls for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "operator_tool_calls insert own" on public.operator_tool_calls for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "operator_failures select own" on public.operator_failures for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "operator_failures insert own" on public.operator_failures for insert to authenticated
  with check ((select auth.uid()) = user_id);

-- Phase 1 proposed actions are PREVIEWS ONLY. They can be created as proposed and
-- read, but there is deliberately NO UPDATE policy that could advance status.
create policy "operator_proposed_actions select own" on public.operator_proposed_actions for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "operator_proposed_actions insert proposed own" on public.operator_proposed_actions for insert to authenticated
  with check ((select auth.uid()) = user_id and initiating_user_id = (select auth.uid()) and status = 'proposed');

-- Approval and execution tables are readable foundations only in Phase 1.
-- NO INSERT/UPDATE/DELETE policy exists; Phase 2 must add an explicitly reviewed
-- mutation seam before either table can receive rows from an authenticated app.
create policy "operator_approvals select own" on public.operator_approvals for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "operator_execution_results select own" on public.operator_execution_results for select to authenticated
  using ((select auth.uid()) = user_id);

-- Revoke from PUBLIC and authenticated as well as anon: the project's default
-- privileges pre-grant broad rights to authenticated on new tables, and a
-- revoke aimed only at anon leaves that whole surface standing — including
-- INSERT/UPDATE/DELETE on the two tables whose contract is fail-closed. The
-- narrow grants below are then the COMPLETE grant surface, not a decoration
-- on top of an inherited one.
revoke all on public.operator_conversations, public.operator_runs, public.operator_tool_calls,
  public.operator_proposed_actions, public.operator_approvals, public.operator_execution_results,
  public.operator_failures from public, anon, authenticated;

grant select, insert on public.operator_conversations, public.operator_runs to authenticated;
grant select, insert on public.operator_tool_calls, public.operator_proposed_actions, public.operator_failures to authenticated;
grant select on public.operator_approvals, public.operator_execution_results to authenticated;

commit;
