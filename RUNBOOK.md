# Production Runbook

Last updated: 2026-04-30

---

## Services map

| Service | Platform | URL / ref |
|---|---|---|
| Control Plane (Next.js) | Vercel | `apps/web` |
| Manager (OpenClaw bot) | Railway | `apps/manager` |
| Distributor (BullMQ worker) | Railway | `apps/distributor` |
| Database | Supabase Postgres | ref `ftpmzxkaiaxxcbnvqauy` |
| Redis | Upstash | see Doppler `REDIS_URL` |
| Secrets | Doppler | project `marketing-agent` |

---

## Kill switch — pause all publishing

1. Admin UI → Settings → "Enable kill switch" button.
   - Or: `PATCH /api/settings` with `{ "kill_switch": true }` using internal token.
2. The Distributor worker checks the kill switch at the start of every job. In-flight jobs finish; no new jobs start.
3. To resume: same toggle → "click to disable".

---

## Disaster drill procedures

### Manager killed mid-conversation (thread state survives)

1. Verify `REDIS_URL` is set and Upstash is reachable.
2. Kill the Manager process (Railway: stop → start).
3. Send `@marketing hello` in any monitored channel.
4. Confirm the bot responds without losing thread context.
5. If context is lost: check `REDIS_URL` env var on Railway. The key format is `thread:slack:C{channelId}:T{ts}`.

### Distributor killed mid-job (BullMQ retries)

1. BullMQ persists job state in Redis. On restart, in-progress jobs re-enter the queue with `status = queued`.
2. Kill the Distributor (Railway: stop → start).
3. Verify the paused job resumes: check `publish_jobs` table — row should transition from `running` → `queued` → `running` → `succeeded`.
4. If a job is stuck in `running` after restart: manually `PATCH /api/publish-jobs/:id` with `{ "status": "failed", "error": "manual reset after restart" }` then re-enqueue.

### Next.js app down (Vercel auto-recover)

1. Vercel auto-redeploys from the last successful build within ~30 seconds.
2. No DB state is lost (Supabase is independent).
3. Verify: check Vercel deployment logs, then hit `/api/publish-jobs/today-count` to confirm the API is responding.

---

## Credential rotation

### Rotate all external tokens in Doppler
1. Go to Doppler → project `marketing-agent` → production config.
2. Rotate each token (LinkedIn, X, HubSpot/Mailchimp, Supabase service role, Upstash, Anthropic).
3. Doppler syncs to Railway env vars automatically (if the sync is enabled — verify under Integrations).
4. For Vercel: Doppler sync must be enabled for the `web` service. Verify under Vercel → Settings → Environment Variables.
5. **Verify adapters pick up new credentials without restart**: trigger a test publish to internal_blog after rotation and confirm it succeeds.

### Rotate Supabase service-role key
1. Supabase Dashboard → Settings → API → Roll service-role key.
2. Update `SUPABASE_SERVICE_ROLE_KEY` in Doppler.
3. Doppler → Railway + Vercel sync (see above).
4. Verify: hit `GET /api/campaigns` with the internal token — should return 200.

---

## Backup and restore

### Supabase PITR (Point-in-Time Recovery)
- Supabase Pro and above includes PITR. Verify it is enabled:
  - Dashboard → Settings → Database → Point-in-Time Recovery → confirm "Enabled".
- To restore: Dashboard → Settings → Database → Restore → select timestamp.
- Document last restore test date here: `___________`

### Daily pg_dump to Supabase Storage
- Script: `packages/db/scripts/pg-dump-backup.sh`
- Runs via Railway cron or GitHub Actions scheduled workflow.
- Output: `backups/YYYY-MM-DD.pgdump` in the `backups` Supabase Storage bucket.
- To restore from a dump:
  ```bash
  pg_restore --no-owner -d "$DATABASE_URL" backups/YYYY-MM-DD.pgdump
  ```

### Memory directories
- All `memory/` files are committed to git. The git remote is the backup.
- Run `git log --oneline -- apps/manager/memory/` to see the history of any memory file.

---

## Load smoke test (50 jobs in 5 minutes)

```bash
# From packages/db/scripts — create 50 approved content items and enqueue them.
node packages/db/scripts/load-smoke.mjs
```

Expected behaviour:
- Queue depth rises, then drains within ~2 minutes at concurrency 4.
- No duplicate publishes (verified by checking `publish_jobs` for duplicate `externalId`).
- Channel caps engage for channels with caps set (job status → `failed`, error contains "channel cap reached").
- Kill switch halts the queue if activated mid-run.

---

## Full campaign dry run (Phase 10 Day 5)

1. `@marketing plan a campaign for [product feature]` → Strategist produces brief.
2. `@marketing draft the launch post` → Content sub-agent creates draft.
3. Approve in admin UI → status becomes `approved`.
4. `@marketing publish the launch post to the blog` → Distributor enqueues.
5. Verify blog post live at `/blog/[slug]` within 30 seconds.
6. Verify syndication card posted to Slack thread.
7. (With LinkedIn/X creds): repeat for LinkedIn and X.
8. Wait for Monday cron or trigger `@marketing report on the campaign` manually.
9. Record full-cycle time here: `___________`

---

## Contacts

| Role | Name | Contact |
|---|---|---|
| Primary on-call | | |
| Supabase account | | |
| Doppler admin | | |
| Vercel owner | | |
| Railway owner | | |
