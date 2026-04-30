import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export function createDb(connectionString?: string) {
  const url = connectionString ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is required to create a Drizzle client.");
  }
  const queryClient = postgres(url, { prepare: false });
  return drizzle(queryClient, { schema });
}

export type Database = ReturnType<typeof createDb>;

let cached: Database | undefined;

// Lazy singleton for app-side reads. Worker processes that need short-lived
// clients should call createDb() directly.
export function getDb(): Database {
  if (!cached) cached = createDb();
  return cached;
}

export { schema };
