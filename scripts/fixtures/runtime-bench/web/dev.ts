// Benchmark fixture dev server. It exposes a host edit two ways, because dev tools
// differ in how they watch:
//   /token          the imported value; changes only when `bun --watch` restarts
//                   the process (a file-level watcher)
//   /token-watched  re-read by a recursive directory watch (`fs.watch`), the
//                   mechanism bundler dev servers use
import { readFileSync, watch } from "node:fs";
import { TOKEN } from "./src/token";

const api = process.env.API_URL ?? "http://api:3001";
const read = (): string => readFileSync("src/token.ts", "utf8");
let watched = read();
watch("src", { recursive: true }, () => {
  watched = read();
});

Bun.serve({
  hostname: "0.0.0.0",
  port: Number(process.env.PORT ?? 3000),
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/token") {
      return new Response(TOKEN);
    }
    if (url.pathname === "/token-watched") {
      return new Response(watched);
    }
    if (url.pathname === "/api-health") {
      const response = await fetch(`${api}/health`);
      return new Response(await response.text(), { status: response.status });
    }
    return new Response(`<!doctype html><title>bench</title><p>${TOKEN}</p>`, {
      headers: { "content-type": "text/html" },
    });
  },
});
