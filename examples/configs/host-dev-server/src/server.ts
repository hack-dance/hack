import { redis, sql } from "bun";
import { Hono } from "hono";

// Runs on the host. DATABASE_URL and REDIS_URL come from the host scope of
// .hack/hack.env.default.yaml and point at the published loopback ports.
const app = new Hono();

app.get("/", async (c) => {
  const [row] = await sql`select current_database() as database`;
  const visits = await redis.incr("visits");
  return c.json({ database: row.database, visits });
});

export default { port: Number(process.env.PORT ?? 3000), fetch: app.fetch };
