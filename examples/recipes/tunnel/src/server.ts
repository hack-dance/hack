// A stand-in app with a webhook endpoint. It logs each delivery it receives.
Bun.serve({
  port: 3000,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/webhooks") {
      console.log(`webhook received: ${await request.text()}`);
      return new Response(null, { status: 204 });
    }
    return Response.json({ ok: true, host: request.headers.get("host") });
  },
});
