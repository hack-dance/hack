import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";

import { readDbEnv } from "./env.ts";
import * as schema from "./schema/core.ts";

type DbClient = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Build a Drizzle client against Neon/Postgres using the configured URL.
 */
export function createDbClient({
  databaseUrl,
}: {
  readonly databaseUrl?: string;
} = {}): DbClient {
  const env = readDbEnv();
  const resolvedUrl = databaseUrl ?? env.DATABASE_URL;
  if (!resolvedUrl) {
    throw new Error("DATABASE_URL is required to create a DB client.");
  }
  return drizzle(neon(resolvedUrl), { schema });
}
