import { readFile } from "node:fs/promises";
import { greet } from "greeting";

const buildInfo = JSON.parse(
  await readFile("/generated/build-info.json", "utf8")
) as { readonly generatedAt: string };

Bun.serve({
  port: 3000,
  fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === "/healthz") {
      return new Response("ok");
    }
    return Response.json({
      message: greet("pattern-p01"),
      generatedAt: buildInfo.generatedAt,
    });
  },
});
