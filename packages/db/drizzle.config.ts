import { defineConfig } from "drizzle-kit";

const DEFAULT_DATABASE_URL =
  "postgresql://postgres:postgres@127.0.0.1:5432/hack";

/**
 * Drizzle CLI configuration for Neon/Postgres schema generation and migrations.
 *
 * Override DATABASE_URL per environment before running push/migrate commands.
 */
export default defineConfig({
  schema: "./src/schema/*.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
  },
  strict: true,
  verbose: true,
});
