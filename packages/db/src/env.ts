import { z } from "zod";

const dbEnvSchema = z.object({
  DATABASE_URL: z.string().min(1).optional(),
  NEON_PROJECT_ID: z.string().min(1).optional(),
  NEON_AUTH_API_URL: z.string().url().optional(),
  NEON_AUTH_CLIENT_ID: z.string().min(1).optional(),
  NEON_AUTH_CLIENT_SECRET: z.string().min(1).optional(),
});

export type DbEnv = z.infer<typeof dbEnvSchema>;

/**
 * Read and validate DB/auth environment variables used by the db package.
 */
export function readDbEnv(): DbEnv {
  return dbEnvSchema.parse({
    DATABASE_URL: process.env.DATABASE_URL,
    NEON_PROJECT_ID: process.env.NEON_PROJECT_ID,
    NEON_AUTH_API_URL: process.env.NEON_AUTH_API_URL,
    NEON_AUTH_CLIENT_ID: process.env.NEON_AUTH_CLIENT_ID,
    NEON_AUTH_CLIENT_SECRET: process.env.NEON_AUTH_CLIENT_SECRET,
  });
}
