import postgres from "postgres";
import { config } from "dotenv";
config({ path: "./.env" });
const sql = postgres(process.env.DATABASE_URL);
const items = await sql`SELECT id, title, type, status, created_at FROM content_items ORDER BY created_at DESC LIMIT 5`;
console.log("RECENT CONTENT ITEMS:");
for (const it of items) console.log(`  ${it.id} type=${it.type} status=${it.status} title=${(it.title??'').slice(0,60)}`);
console.log("\nASSETS:");
for (const it of items) {
  const assets = await sql`SELECT id, kind, status, storage_path, prompt_used, created_at FROM assets WHERE content_id = ${it.id}`;
  console.log(`  content ${it.id}: ${assets.length} assets`);
  for (const a of assets) console.log(`    - ${a.kind} ${a.storage_path} prompt=${(a.prompt_used??'').slice(0,80)}`);
}
console.log("\nRECENT WORKFLOW RUNS:");
const runs = await sql`SELECT id, engine, kind, status, error, content_id, created_at, completed_at FROM workflow_runs ORDER BY created_at DESC LIMIT 5`;
for (const r of runs) console.log(`  ${r.id} engine=${r.engine} kind=${r.kind} status=${r.status} content_id=${r.content_id} error=${(r.error??'').slice(0,80)}`);
await sql.end();
