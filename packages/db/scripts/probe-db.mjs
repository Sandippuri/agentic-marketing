import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1 });
try {
  const [r] = await sql`select current_database() as db, current_user as usr`;
  console.log(JSON.stringify(r));
} finally {
  await sql.end();
}
