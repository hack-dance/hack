import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";

import { authBrokerSchema } from "./db/schema.ts";

export function createDbClient(input: { readonly databaseUrl: string }) {
  return drizzle(neon(input.databaseUrl), { schema: authBrokerSchema });
}
