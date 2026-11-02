/**
 * Portable shared-host-helper fixture process for
 * tests/shared-host-lifecycle.test.ts.
 *
 * argv: <mode> <port> <helper> <upstream>
 * - `identity`: HTTP on 127.0.0.1:<port>; `/__hack/identity` reports
 *   {helper, upstream, pid}; `/` answers `served:<upstream>`;
 *   `/__fixture/env` lists this process's environment variable names.
 * - `stubborn`: like `identity`, but ignores SIGTERM (only SIGKILL stops it).
 * - `slow-term`: like `identity`, but on SIGTERM keeps running for
 *   {@link SLOW_TERM_MS}, then writes `<HOME>/term-exited` and exits 0 (a
 *   helper that ignores TERM briefly; the marker proves it was not killed).
 * - `oversized`: like `identity`, but pads the identity answer past 4 KiB.
 * - `exit`: exits immediately (a helper that dies during startup).
 * - `tcp`: a plain TCP listener that never answers (a foreign port owner).
 * - `reset`: a TCP listener that drops every connection at once.
 * - `placeholder`: stays alive and never listens (a sleeping placeholder).
 * - `parent`: spawns a `placeholder` grandchild, prints its PID, then serves
 *   like `identity` (a helper with its own child process).
 *
 * Every mode exits once its private HOME (the test's scratch root) is gone,
 * so no fixture outlives its test even when a failing run skips cleanup.
 */
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** How long `slow-term` keeps running after SIGTERM (the test mirrors it). */
const SLOW_TERM_MS = 600;

const [mode, portText, helper, upstream] = process.argv.slice(2);
const port = Number(portText);
const home = process.env.HOME;
setInterval(() => {
  if (!(home && existsSync(home))) {
    process.exit(0);
  }
}, 250);

function serveIdentity(opts: { readonly padding?: number } = {}): void {
  Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/__hack/identity") {
        return Response.json({
          helper,
          upstream,
          pid: process.pid,
          ...(opts.padding ? { padding: "x".repeat(opts.padding) } : {}),
        });
      }
      if (url.pathname === "/__fixture/env") {
        return Response.json(Object.keys(process.env).sort());
      }
      return new Response(`served:${upstream}`);
    },
  });
}

switch (mode) {
  case "identity":
    serveIdentity();
    break;
  case "stubborn":
    process.on("SIGTERM", () => {
      // Ignored on purpose: the stop path must escalate to SIGKILL.
    });
    serveIdentity();
    break;
  case "slow-term":
    process.on("SIGTERM", () => {
      setTimeout(() => {
        if (home) {
          writeFileSync(join(home, "term-exited"), `${process.pid}\n`);
        }
        process.exit(0);
      }, SLOW_TERM_MS);
    });
    serveIdentity();
    break;
  case "oversized":
    serveIdentity({ padding: 8192 });
    break;
  case "exit":
    process.exit(3);
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
  case "reset":
    Bun.listen({
      hostname: "127.0.0.1",
      port,
      socket: {
        open(socket) {
          // Accepts and drops every connection without answering.
          socket.terminate();
        },
        data() {
          // Never reached.
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
