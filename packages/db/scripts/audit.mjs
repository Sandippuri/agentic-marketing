import postgres from 'postgres';
import { readFileSync } from 'fs';
const env = readFileSync('apps/web/.env.local', 'utf8');
for (const line of env.split('\n')) {
  const m = line.match(/^([A-Z_]+)\s*=\s*"?(.*?)"?\s*$/);
  if (m) process.env[m[1]] = m[2];
}
const sql = postgres(process.env.DATABASE_URL, { prepare: false });
try {
  console.log('--- audit_log: asset/image-related events ---');
  const audit = await sql`
    select created_at::date as date, action, target_type, substring(target_id::text, 1, 8) as target,
           substring(payload::text, 1, 120) as payload_excerpt
    from audit_log
    where action ilike '%asset%' or action ilike '%image%' or action ilike '%generate%' or target_type = 'asset'
    order by created_at desc
    limit 20`;
  console.table(audit);
  console.log('\n--- generation_jobs ---');
  const jobs = await sql`select status, count(*)::int as n from generation_jobs group by status`;
  console.table(jobs);
  console.log('\n--- generation_job_steps that involve asset/image ---');
  const steps = await sql`
    select agent_name, tool_name, status, count(*)::int as n
    from generation_job_steps
    where tool_name ilike '%asset%' or tool_name ilike '%image%' or tool_name ilike '%background%' or tool_name ilike '%template%' or agent_name ilike '%asset%'
    group by agent_name, tool_name, status
    order by n desc`;
  console.table(steps);
  console.log('\n--- workflow_runs ---');
  const wf = await sql`
    select status, count(*)::int as n from workflow_runs group by status`;
  console.table(wf);
} finally {
  await sql.end();
}
