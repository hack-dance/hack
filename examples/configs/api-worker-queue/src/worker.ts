import { RedisClient } from "bun";

// A blocking pop holds its connection, so the worker uses its own client.
const queue = new RedisClient(process.env.REDIS_URL);

while (true) {
  const popped = await queue.send("BRPOP", ["jobs", "0"]);
  const job = JSON.parse(popped[1]);
  await queue.set(`result:${job.id}`, job.text.toUpperCase());
  console.log(`processed ${job.id}`);
}
