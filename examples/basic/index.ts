import { parseArgs } from "node:util";

const parsed = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    port: { type: "string" },
    host: { type: "string" },
  },
  strict: false,
  allowPositionals: true,
});

const portRaw = parsed.values.port;
const hostRaw = parsed.values.host;

const port =
  typeof portRaw === "string" && portRaw.length > 0 ? Number(portRaw) : 3000;
const hostname =
  typeof hostRaw === "string" && hostRaw.length > 0 ? hostRaw : "0.0.0.0";

const server = Bun.serve({
  port,
  hostname,
  fetch(req) {
    console.log(
      JSON.stringify(
        { req, date: new Date().toISOString(), pid: process.pid },
        null,
        2
      )
    );
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      return new Response("ok\n", {
        headers: { "content-type": "text/plain" },
      });
    }
    return new Response(`hello from examples/basic\npath=${url.pathname}\n`, {
      headers: { "content-type": "text/plain" },
    });
  },
});

// eslint-disable-next-line no-console
console.log(`listening on http://${server.hostname}:${server.port}`);
