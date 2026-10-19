/**
 * Portable shared-host-helper fixture process for
 * tests/shared-host-lifecycle.test.ts.
 *
 * argv: <mode> <port> <helper> <upstream>
 * - `identity`: HTTP on 127.0.0.1:<port>; `/__hack/identity` reports
 *   {helper, upstream, pid}; `/` answers `served:<upstream>`.
 * - `tcp`: a plain TCP listener that never answers (a foreign port owner).
 * - `placeholder`: stays alive and never listens (a sleeping placeholder).
 * - `parent`: spawns a `placeholder` grandchild, prints its PID, then serves
 *   like `identity` (a helper with its own child process).
 *
 * Every mode exits once its private HOME (the test's scratch root) is gone,
 * so no fixture outlives its test even when a failing run skips cleanup.
 */
import { existsSync } from "node:fs";

const [mode, portText, helper, upstream] = process.argv.slice(2);
const port = Number(portText);
const home = process.env.HOME;
setInterval(() => {
  if (!(home && existsSync(home))) {
    process.exit(0);
  }
}, 250);

function serveIdentity(): void {
  Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/__hack/identity") {
        return Response.json({ helper, upstream, pid: process.pid });
      }
      return new Response(`served:${upstream}`);
    },
  });
}

switch (mode) {
  case "identity":
    serveIdentity();
    break;
  case "tcp":
    Bun.listen({
      hostname: "127.0.0.1",
      port,
      socket: {
        data() {
          // Accepts connections and never answers.
        },
      },
    });
    break;
  case "placeholder":
    setInterval(() => undefined, 60_000);
    break;
  case "parent": {
    const child = Bun.spawn(
      [process.execPath, import.meta.path, "placeholder", "0", "-", "-"],
      { stdin: "ignore", stdout: "ignore", stderr: "ignore" }
    );
    console.log(`grandchild ${child.pid}`);
    serveIdentity();
    break;
  }
  default:
    process.exit(2);
}
console.log("listening");
