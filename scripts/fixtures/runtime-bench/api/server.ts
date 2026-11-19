// Benchmark fixture API: one Postgres table and one Redis counter.
import { RedisClient, SQL } from "bun";

const sql = new SQL(
  process.env.DATABASE_URL ?? "postgres://bench@db:5432/bench"
);
const redis = new RedisClient(process.env.REDIS_URL ?? "redis://cache:6379");

await sql`create table if not exists marks (id serial primary key, mark text not null)`;

Bun.serve({
  hostname: "0.0.0.0",
  port: Number(process.env.PORT ?? 3001),
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      await sql`select 1`;
      await redis.ping();
      return Response.json({ ok: true });
    }
    if (url.pathname === "/mark" && request.method === "POST") {
      const mark = await request.text();
      if (!/^[a-f0-9]{32}$/.test(mark)) {
        return new Response("invalid", { status: 400 });
      }
      await sql`insert into marks (mark) values (${mark})`;
      return Response.json({ hits: await redis.incr("hits") });
    }
    if (url.pathname === "/marks") {
      const rows = await sql`select mark from marks order by id`;
      return Response.json({
        marks: rows.map((row: { mark: string }) => row.mark),
      });
    }
    return new Response("not found", { status: 404 });
  },
});
