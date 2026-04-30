-- Row Level Security policies + the publish-gate trigger.
-- Apply via Supabase SQL editor after `pnpm db:push` lands the schema.
-- Plan §3 — RLS is non-negotiable.

-- ---------------------------------------------------------------------------
-- 1. Enable RLS on every table.
-- ---------------------------------------------------------------------------

alter table campaigns          enable row level security;
alter table content_items      enable row level security;
alter table content_revisions  enable row level security;
alter table approvals          enable row level security;
alter table publish_jobs       enable row level security;
alter table assets             enable row level security;
alter table metrics            enable row level security;
alter table audit_log          enable row level security;
alter table settings           enable row level security;

-- ---------------------------------------------------------------------------
-- 2. Authenticated team members can read everything.
--    The service role bypasses RLS implicitly; agents use the service role.
-- ---------------------------------------------------------------------------

create policy "team_read_campaigns"          on campaigns          for select to authenticated using (true);
create policy "team_read_content_items"      on content_items      for select to authenticated using (true);
create policy "team_read_content_revisions"  on content_revisions  for select to authenticated using (true);
create policy "team_read_approvals"          on approvals          for select to authenticated using (true);
create policy "team_read_publish_jobs"       on publish_jobs       for select to authenticated using (true);
create policy "team_read_assets"             on assets             for select to authenticated using (true);
create policy "team_read_metrics"            on metrics            for select to authenticated using (true);
create policy "team_read_audit_log"          on audit_log          for select to authenticated using (true);
create policy "team_read_settings"           on settings           for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- 3. Editable tables — authenticated team members can write subject to the
--    state-machine rules enforced server-side. We do NOT expose
--    publish_jobs / audit_log / settings to client writes.
-- ---------------------------------------------------------------------------

create policy "team_write_campaigns"          on campaigns          for all to authenticated using (true) with check (true);
create policy "team_write_content_items"      on content_items      for all to authenticated using (true) with check (true);
create policy "team_write_content_revisions"  on content_revisions  for all to authenticated using (true) with check (true);
create policy "team_write_approvals"          on approvals          for all to authenticated using (true) with check (true);
create policy "team_write_assets"             on assets             for all to authenticated using (true) with check (true);

-- audit_log, publish_jobs, settings: NO insert/update/delete policy for
-- authenticated. Only the service role can mutate them.

-- ---------------------------------------------------------------------------
-- 4. The publish-gate trigger. Plan §3 — the entire safety story rests on
--    this rule, so we enforce it twice: once in the Route Handler, once here.
-- ---------------------------------------------------------------------------

create or replace function enforce_publish_gate()
returns trigger
language plpgsql
as $$
declare
  current_status content_status;
begin
  select status into current_status
  from content_items
  where id = NEW.content_id;

  if current_status is null then
    raise exception 'publish_jobs: content_id % does not exist', NEW.content_id;
  end if;

  -- approved is the canonical pre-publish state. scheduled is allowed because
  -- the API transitions content_items to scheduled at the same time as
  -- inserting a publish_jobs row.
  if current_status not in ('approved', 'scheduled') then
    raise exception
      'publish_jobs: content % is %, must be approved before scheduling',
      NEW.content_id, current_status
      using errcode = 'check_violation';
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_enforce_publish_gate on publish_jobs;
create trigger trg_enforce_publish_gate
before insert on publish_jobs
for each row
execute function enforce_publish_gate();

-- ---------------------------------------------------------------------------
-- 5. 24-hour same-channel republish guard (Phase 9 Day 2).
--    Belt for the Route Handler check.
-- ---------------------------------------------------------------------------

create or replace function enforce_republish_window()
returns trigger
language plpgsql
as $$
begin
  if exists (
    select 1
    from publish_jobs
    where content_id = NEW.content_id
      and channel = NEW.channel
      and status in ('queued', 'running', 'succeeded')
      and created_at > now() - interval '24 hours'
  ) then
    raise exception
      'publish_jobs: content % already published to % within last 24h',
      NEW.content_id, NEW.channel
      using errcode = 'unique_violation';
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_enforce_republish_window on publish_jobs;
create trigger trg_enforce_republish_window
before insert on publish_jobs
for each row
execute function enforce_republish_window();
