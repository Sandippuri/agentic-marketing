import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1 });
try {
  const types = await sql`select typname from pg_type where typnamespace = 'public'::regnamespace and typtype = 'e' order by 1`;
  const tables = await sql`select tablename from pg_tables where schemaname = 'public' order by 1`;
  const drizzleMig = await sql`select hash, created_at from drizzle.__drizzle_migrations order by created_at`.catch(() => []);
  console.log(JSON.stringify({
    enums: types.map((t) => t.typname),
    tables: tables.map((t) => t.tablename),
    drizzleMigrations: drizzleMig,
  }, null, 2));
} finally {
  await sql.end();
}
