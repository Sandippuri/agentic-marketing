-- Migration 0026: backfill workspace_id on every tenant table.
--
-- Strategy:
--   1. Ensure the Legacy workspace exists (fixed uuid 00…01). If
--      scripts/bootstrap-saas.ts has already run, the owner is already a
--      real auth.users.id and we leave it alone. Otherwise we pick the
--      first auth.users row as a placeholder owner — bootstrap-saas.ts
--      can be re-run safely after this migration to upgrade memberships
--      and admin_users.
--   2. Walk the dependency graph in topological order and cascade
--      workspace_id from the parent. Tables with no parent (audit_log,
--      metrics, embeddings standalone, kb_*, brand_documents, etc.)
--      default to the Legacy workspace.
--
-- Idempotent: every UPDATE includes `WHERE workspace_id IS NULL` so
-- re-applying after partial backfill only touches rows still missing the
-- column.
--
-- Apply with:
--   DATABASE_URL=<url> pnpm --filter @marketing/db exec tsx scripts/apply-sql.ts packages/db/drizzle/0026_backfill_workspace.sql

--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- 1. Ensure Legacy workspace
-- ----------------------------------------------------------------------------

DO $$
DECLARE
  legacy_owner uuid;
BEGIN
  -- Already provisioned by bootstrap-saas.ts? Skip.
  IF EXISTS (
    SELECT 1 FROM public.workspaces
    WHERE id = '00000000-0000-0000-0000-000000000001'::uuid
  ) THEN
    RAISE NOTICE 'legacy workspace already exists, skipping creation';
    RETURN;
  END IF;

  -- Fall back to the first auth.users row. If there isn't one, the
  -- migration aborts — backfill is meaningless on an empty DB anyway, and
  -- the next migration's NOT NULL flip would fail on any row that did
  -- exist without an owner.
  SELECT id INTO legacy_owner FROM auth.users ORDER BY created_at ASC LIMIT 1;

  IF legacy_owner IS NULL THEN
    -- Truly empty database (fresh deploy, no users yet). The next migration
    -- will succeed because every tenant table is also empty. Nothing to
    -- backfill; leave the Legacy workspace uncreated and exit.
    RAISE NOTICE 'no auth.users yet; skipping legacy workspace creation';
    RETURN;
  END IF;

  INSERT INTO public.workspaces (id, slug, name, owner_user_id, plan_id, plan_overridden_until)
  VALUES (
    '00000000-0000-0000-0000-000000000001'::uuid,
    'legacy',
    'Legacy',
    legacy_owner,
    '11111111-1111-1111-1111-000000000005'::uuid,  -- enterprise
    '2099-01-01T00:00:00Z'::timestamptz
  );

  -- Make the bootstrap owner a member too, so they can actually access
  -- the workspace from the UI.
  INSERT INTO public.workspace_members (workspace_id, user_id, role, accepted_at)
  VALUES (
    '00000000-0000-0000-0000-000000000001'::uuid,
    legacy_owner,
    'owner',
    now()
  )
  ON CONFLICT DO NOTHING;
END $$;

--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- 2. Backfill in topological order
-- ----------------------------------------------------------------------------
-- Skip cleanly when there's no Legacy workspace (empty DB case above).

DO $$
DECLARE
  legacy uuid := '00000000-0000-0000-0000-000000000001'::uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.workspaces WHERE id = legacy) THEN
    RAISE NOTICE 'no legacy workspace; skipping backfill';
    RETURN;
  END IF;

  -- Roots (no parent / parentless data) default to Legacy.
  UPDATE public.campaigns        SET workspace_id = legacy WHERE workspace_id IS NULL;
  UPDATE public.brand_documents  SET workspace_id = legacy WHERE workspace_id IS NULL;
  UPDATE public.extraction_runs  SET workspace_id = legacy WHERE workspace_id IS NULL;
  UPDATE public.metrics          SET workspace_id = legacy WHERE workspace_id IS NULL;
  UPDATE public.audit_log        SET workspace_id = legacy WHERE workspace_id IS NULL;
  UPDATE public.embeddings       SET workspace_id = legacy WHERE workspace_id IS NULL;
  UPDATE public.llm_usage        SET workspace_id = legacy WHERE workspace_id IS NULL;

  -- Children of campaigns (1-level).
  UPDATE public.content_items ci
     SET workspace_id = COALESCE(c.workspace_id, legacy)
    FROM public.campaigns c
   WHERE ci.workspace_id IS NULL AND ci.campaign_id = c.id;

  UPDATE public.experiments e
     SET workspace_id = COALESCE(c.workspace_id, legacy)
    FROM public.campaigns c
   WHERE e.workspace_id IS NULL AND e.campaign_id = c.id;

  UPDATE public.goal_events g
     SET workspace_id = COALESCE(c.workspace_id, legacy)
    FROM public.campaigns c
   WHERE g.workspace_id IS NULL AND g.campaign_id = c.id;

  UPDATE public.lifecycle_sequences l
     SET workspace_id = COALESCE(c.workspace_id, legacy)
    FROM public.campaigns c
   WHERE l.workspace_id IS NULL AND l.campaign_id = c.id;

  -- brand_memory / brand_design_system / kb_collections all have a
  -- nullable campaign_id (global default rows). Resolve through campaign
  -- when present, else Legacy.
  UPDATE public.brand_memory bm
     SET workspace_id = CASE
       WHEN bm.campaign_id IS NULL THEN legacy
       ELSE (SELECT workspace_id FROM public.campaigns WHERE id = bm.campaign_id)
     END
   WHERE bm.workspace_id IS NULL;
  UPDATE public.brand_memory SET workspace_id = legacy WHERE workspace_id IS NULL;

  UPDATE public.brand_design_system bds
     SET workspace_id = CASE
       WHEN bds.campaign_id IS NULL THEN legacy
       ELSE (SELECT workspace_id FROM public.campaigns WHERE id = bds.campaign_id)
     END
   WHERE bds.workspace_id IS NULL;
  UPDATE public.brand_design_system SET workspace_id = legacy WHERE workspace_id IS NULL;

  UPDATE public.kb_collections kc
     SET workspace_id = CASE
       WHEN kc.campaign_id IS NULL THEN legacy
       ELSE (SELECT workspace_id FROM public.campaigns WHERE id = kc.campaign_id)
     END
   WHERE kc.workspace_id IS NULL;
  UPDATE public.kb_collections SET workspace_id = legacy WHERE workspace_id IS NULL;

  -- generation_jobs / workflow_runs reference campaigns + content_items
  -- via *nullable* FKs (set null on delete). Backfill via campaign first,
  -- then content's campaign, then Legacy.
  UPDATE public.generation_jobs gj
     SET workspace_id = COALESCE(c.workspace_id, ci.workspace_id, legacy)
    FROM public.campaigns c
   FULL OUTER JOIN public.content_items ci ON ci.campaign_id = c.id
   WHERE gj.workspace_id IS NULL
     AND (gj.campaign_id = c.id OR gj.content_id = ci.id);
  UPDATE public.generation_jobs SET workspace_id = legacy WHERE workspace_id IS NULL;

  UPDATE public.workflow_runs wr
     SET workspace_id = COALESCE(c.workspace_id, ci.workspace_id, legacy)
    FROM public.campaigns c
   FULL OUTER JOIN public.content_items ci ON ci.campaign_id = c.id
   WHERE wr.workspace_id IS NULL
     AND (wr.campaign_id = c.id OR wr.content_id = ci.id);
  UPDATE public.workflow_runs SET workspace_id = legacy WHERE workspace_id IS NULL;

  -- Children of content_items (2-level: content_items already populated).
  UPDATE public.content_revisions cr
     SET workspace_id = COALESCE(ci.workspace_id, legacy)
    FROM public.content_items ci
   WHERE cr.workspace_id IS NULL AND cr.content_id = ci.id;

  UPDATE public.approvals a
     SET workspace_id = COALESCE(ci.workspace_id, legacy)
    FROM public.content_items ci
   WHERE a.workspace_id IS NULL AND a.content_id = ci.id;

  UPDATE public.publish_jobs pj
     SET workspace_id = COALESCE(ci.workspace_id, legacy)
    FROM public.content_items ci
   WHERE pj.workspace_id IS NULL AND pj.content_id = ci.id;

  UPDATE public.assets ass
     SET workspace_id = COALESCE(ci.workspace_id, legacy)
    FROM public.content_items ci
   WHERE ass.workspace_id IS NULL AND ass.content_id = ci.id;
  UPDATE public.assets SET workspace_id = legacy WHERE workspace_id IS NULL;

  UPDATE public.agent_feedback af
     SET workspace_id = COALESCE(ci.workspace_id, legacy)
    FROM public.content_items ci
   WHERE af.workspace_id IS NULL AND af.content_id = ci.id;

  UPDATE public.outcomes o
     SET workspace_id = COALESCE(ci.workspace_id, legacy)
    FROM public.content_items ci
   WHERE o.workspace_id IS NULL AND o.content_id = ci.id;

  -- Children of extraction_runs.
  UPDATE public.brand_memory_drafts bmd
     SET workspace_id = COALESCE(er.workspace_id, legacy)
    FROM public.extraction_runs er
   WHERE bmd.workspace_id IS NULL AND bmd.run_id = er.id;

  -- KB cascade: documents → collections, chunks → documents.
  UPDATE public.kb_documents kd
     SET workspace_id = COALESCE(kc.workspace_id, legacy)
    FROM public.kb_collections kc
   WHERE kd.workspace_id IS NULL AND kd.collection_id = kc.id;

  UPDATE public.kb_chunks kch
     SET workspace_id = COALESCE(kd.workspace_id, legacy)
    FROM public.kb_documents kd
   WHERE kch.workspace_id IS NULL AND kch.document_id = kd.id;

  -- Lifecycle steps inherit from sequences.
  UPDATE public.lifecycle_steps ls
     SET workspace_id = COALESCE(lseq.workspace_id, legacy)
    FROM public.lifecycle_sequences lseq
   WHERE ls.workspace_id IS NULL AND ls.sequence_id = lseq.id;
END $$;

--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- 3. Sanity check: report any still-null rows. Migration 0027's NOT NULL
--    flip will fail on these, so it's better to surface them now.
-- ----------------------------------------------------------------------------

DO $$
DECLARE
  missing_count integer;
  table_name text;
  -- Every table where we expect workspace_id to be NOT NULL after 0027.
  -- audit_log and billing_events stay nullable by design (FK set null).
  tables text[] := ARRAY[
    'campaigns','content_items','content_revisions','approvals','publish_jobs',
    'assets','metrics','agent_feedback','outcomes','embeddings',
    'brand_memory','brand_design_system','brand_documents','extraction_runs',
    'brand_memory_drafts','generation_jobs','workflow_runs','llm_usage',
    'kb_collections','kb_documents','kb_chunks','goal_events','experiments',
    'lifecycle_sequences','lifecycle_steps'
  ];
BEGIN
  FOREACH table_name IN ARRAY tables LOOP
    EXECUTE format('SELECT count(*) FROM public.%I WHERE workspace_id IS NULL', table_name)
      INTO missing_count;
    IF missing_count > 0 THEN
      RAISE WARNING 'table %.workspace_id still null on % rows', table_name, missing_count;
    END IF;
  END LOOP;
END $$;
