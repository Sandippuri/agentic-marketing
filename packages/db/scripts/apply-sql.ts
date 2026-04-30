// Apply a SQL file (policies, seed, views) against DATABASE_URL.
// Used because we don't have psql installed locally.
//
//   pnpm exec tsx scripts/apply-sql.ts infra/supabase/policies.sql
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";

const file = process.argv[2];
if (!file) {
  console.error("usage: tsx scripts/apply-sql.ts <path-to-sql>");
  process.exit(1);
}
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const sql = readFileSync(resolve(file), "utf8");
const client = postgres(url, { prepare: false, max: 1 });

try {
  console.log(`applying ${file}…`);
  await client.unsafe(sql);
  console.log(`✓ applied ${file}`);
} catch (err) {
  console.error(`✗ failed to apply ${file}`);
  console.error(err);
  process.exit(1);
} finally {
  await client.end();
}
