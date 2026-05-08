import postgres from 'postgres';
import { readFileSync } from 'fs';

// Load .env.local manually
const env = readFileSync('/Users/itspuri/Code/Ibriz/marketing-agent/apps/web/.env.local', 'utf8');
for (const line of env.split('\n')) {
  const m = line.match(/^([A-Z_]+)\s*=\s*"?(.*?)"?\s*$/);
  if (m) process.env[m[1]] = m[2];
}

const sql = postgres(process.env.DATABASE_URL, { prepare: false });
try {
  const totalAssets = await sql`select count(*)::int as n from assets`;
  const linkedAssets = await sql`select count(*)::int as n from assets where content_id is not null`;
  const recentContent = await sql`
    select c.id, substring(c.title, 1, 50) as title, c.type, c.status, c.created_at::date as date,
      (select count(*)::int from assets a where a.content_id = c.id) as asset_count
    from content_items c
    order by c.created_at desc
    limit 12`;
  const recentAssets = await sql`
    select id, content_id, kind, status, substring(storage_path, 1, 60) as path, created_at::date
    from assets
    order by created_at desc
    limit 10`;
  console.log('Total assets:', totalAssets[0].n);
  console.log('Assets linked to content_id:', linkedAssets[0].n);
  console.log('\nRecent content items:');
  console.table(recentContent);
  console.log('\nRecent assets:');
  console.table(recentAssets);
} finally {
  await sql.end();
}
