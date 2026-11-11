import { greeting } from "@acme/shared";
import { Hono } from "hono";

const app = new Hono();
app.get("/", (c) => c.json({ message: greeting("web") }));

export default { port: 3000, fetch: app.fetch };
