-- Edge Operator V1 — approval/audit foundation.
-- TEMP HIGH VERSION: feature-session migration. S106 MUST re-version from the
-- live ledger before any production apply. No production apply is authorized.
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
create policy "operator_conversations update own" on public.operator_conversations for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id and created_by = (select auth.uid()));

create policy "operator_runs select own" on public.operator_runs for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "operator_runs insert own" on public.operator_runs for insert to authenticated
  with check ((select auth.uid()) = user_id and initiated_by = (select auth.uid()));
create policy "operator_runs update own" on public.operator_runs for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id and initiated_by = (select auth.uid()));

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

revoke all on public.operator_conversations, public.operator_runs, public.operator_tool_calls,
  public.operator_proposed_actions, public.operator_approvals, public.operator_execution_results,
  public.operator_failures from anon;

grant select, insert, update on public.operator_conversations, public.operator_runs to authenticated;
grant select, insert on public.operator_tool_calls, public.operator_proposed_actions, public.operator_failures to authenticated;
grant select on public.operator_approvals, public.operator_execution_results to authenticated;

commit;
