/**
 * Application service shared by every overlay. It reads its capabilities from
 * env and never starts an interactive sign-in itself: a runner overlay must
 * provide a non-interactive auth mode.
 */
const authMode = process.env.AUTH_MODE;
const browserSignIn = process.env.BROWSER_SIGN_IN === "allowed";
const upstreamUrl = process.env.UPSTREAM_URL;
const timeoutMs = Number(process.env.UPSTREAM_TIMEOUT_MS ?? "3000");

if (!(authMode && upstreamUrl)) {
  console.error("Select an env overlay that sets AUTH_MODE and UPSTREAM_URL.");
  process.exit(2);
}
if (authMode === "browser-session" && !browserSignIn) {
  console.error("browser-session auth needs an overlay that allows sign-in.");
  process.exit(2);
}

async function upstreamReachable(): Promise<boolean> {
  try {
    const response = await fetch(`${upstreamUrl}/healthz`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}

Bun.serve({
  port: 3000,
  async fetch(request) {
    const { pathname } = new URL(request.url);
    const reachable = await upstreamReachable();
    if (pathname === "/healthz") {
      return new Response(reachable ? "ok" : "upstream unreachable", {
        status: reachable ? 200 : 503,
      });
    }
    return Response.json({
      authMode,
      browserSignIn,
      helperMode: process.env.HELPER_MODE ?? null,
      upstreamReachable: reachable,
    });
  },
});
