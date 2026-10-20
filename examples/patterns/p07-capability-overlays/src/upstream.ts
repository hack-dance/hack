/** Shared dependency that both laptop and runner overlays must reach. */
Bun.serve({
  port: 4000,
  fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === "/healthz") {
      return new Response("ok");
    }
    return Response.json({ service: "upstream" });
  },
});
