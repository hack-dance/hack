import { sql } from "bun";
import { Hono } from "hono";

// Bun's SQL client reads DATABASE_URL from the environment Hack injects.
const app = new Hono();

app.get("/", async (c) => {
  const [row] = await sql`select current_database() as database`;
  return c.json({ ok: true, database: row.database });
});

export default { port: 3000, fetch: app.fetch };
