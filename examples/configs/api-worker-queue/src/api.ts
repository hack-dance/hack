import { redis } from "bun";
import { z } from "zod";

// Bun's Redis client reads REDIS_URL from the environment Hack injects.
const Job = z.object({ text: z.string().min(1) });

Bun.serve({
  port: 3000,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/jobs") {
      const job = Job.parse(await request.json());
      const id = crypto.randomUUID();
      await redis.send("LPUSH", ["jobs", JSON.stringify({ id, ...job })]);
      return Response.json({ id }, { status: 202 });
    }
    if (url.pathname.startsWith("/jobs/")) {
      const result = await redis.get(`result:${url.pathname.slice(6)}`);
      return Response.json({ result });
    }
    return Response.json({ ok: true });
  },
});
