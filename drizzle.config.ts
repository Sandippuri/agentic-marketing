import { defineConfig } from "drizzle-kit";

// `drizzle-kit generate` only diffs the schema and does not need DATABASE_URL.
// `drizzle-kit migrate` / `push` / `studio` do need it; they will error on a
// stub URL when actually run, which is the right time to fail loudly.
const databaseUrl = process.env.DATABASE_URL ?? "postgres://stub:stub@localhost:5432/stub";

export default defineConfig({
  schema: "./packages/db/src/schema.ts",
  out: "./packages/db/drizzle",
  dialect: "postgresql",
  dbCredentials: { url: databaseUrl },
  strict: true,
  verbose: true,
});
