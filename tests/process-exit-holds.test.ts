import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * The CLI exits explicitly once `runCli` returns (src/lib/process-exit.ts),
 * so work that must outlive the command has to be registered with
 * `holdProcessUntil` (or `holdSignalCleanup`). This guard lists every source
 * file that starts a server, a listener, a stdio transport, a renderer or an
 * interval, and says why the explicit exit cannot cut it short. A new file
 * that starts such work fails here until it is classified.
 */
const ROOT = resolve(import.meta.dir, "..");

const STARTS_LONG_RUNNING =
  /Bun\.serve\(|Bun\.listen\(|\.listen\(|createServer\(|StdioServerTransport|createCliRenderer|setInterval\(/;

type Reason =
  /** Registers the work with a hold; the file must call one. */
  | { readonly kind: "held"; readonly what: string }
  /** Opened and closed inside one awaited call, before the command returns. */
  | { readonly kind: "scoped"; readonly what: string }
  /** Runs inside a process whose lifetime is already held, or not via runCli. */
  | { readonly kind: "owned-elsewhere"; readonly what: string };

const CLASSIFIED: Readonly<Record<string, Reason>> = {
  "src/lib/command-timings.ts": {
    kind: "held",
    what: "child timing drains; callers await trace finalization",
  },
  "src/mcp/server.ts": {
    kind: "held",
    what: "stdio MCP session and each tool call",
  },
  "src/daemon/server.ts": { kind: "held", what: "foreground daemon" },
  "src/tui/hack-tui.ts": {
    kind: "held",
    what: "TUI renderer close and action children",
  },
  "src/commands/remote.ts": { kind: "held", what: "remote monitor renderer" },
  "src/daemon/request-target-proxy.ts": {
    kind: "owned-elsewhere",
    what: "proxy servers started by the daemon, whose lifetime src/daemon/server.ts holds",
  },
  "src/mcp/socket-backend.ts": {
    kind: "owned-elsewhere",
    what: "started only by scripts/run-mcp-socket-backend.ts, which does not exit through runCli",
  },
  "src/backends/native-authored-hook-stop.ts": {
    kind: "scoped",
    what: "loopback stop listener closed before the hook stop resolves",
  },
  "src/backends/native-graph-start-budget.ts": {
    kind: "scoped",
    what: "budget interval cleared when the graph start settles",
  },
  "src/backends/native-https-owner-server.ts": {
    kind: "scoped",
    what: "owner HTTPS servers awaited to close by the owner lifetime that started them",
  },
  "src/backends/native-start-pool-watch.ts": {
    kind: "scoped",
    what: "pool watch interval, unref'd, cleared when the start settles; it never keeps a finished start alive",
  },
  "src/backends/native-https-port.ts": {
    kind: "scoped",
    what: "port probe server closed in its listen callback",
  },
  "src/backends/native-log-consumer.ts": {
    kind: "scoped",
    what: "poll interval cleared when the consumer ends",
  },
  "src/backends/native-project-https.ts": {
    kind: "scoped",
    what: "port probe server closed in its listen callback",
  },
  "src/lib/lifecycle-process-delivery.ts": {
    kind: "scoped",
    what: "one-shot delivery socket closed once claimed or aborted",
  },
  "src/lib/native-detached-up.ts": {
    kind: "scoped",
    what: "launcher heartbeat interval cleared when the start settles",
  },
  "src/lib/project-lifecycle-singleton.ts": {
    kind: "scoped",
    what: "bind probe stopped at once",
  },
  "src/lib/unix-socket-publish.ts": {
    kind: "scoped",
    what: "staging socket closed after publication",
  },
  "src/ui/planet.ts": {
    kind: "scoped",
    what: "animation intervals cleared by their dispose/stop",
  },
};

const HOLD_CALL = /holdProcessUntil\(|holdSignalCleanup\(/;

test("every source file that starts long-running work is classified for the explicit exit", async () => {
  const files: string[] = [];
  for await (const file of new Bun.Glob("src/**/*.ts").scan({ cwd: ROOT })) {
    if (STARTS_LONG_RUNNING.test(await readFile(resolve(ROOT, file), "utf8"))) {
      files.push(file);
    }
  }
  const unclassified = files.filter((file) => !(file in CLASSIFIED)).sort();
  expect(unclassified).toEqual([]);
  // A classification for a file that no longer starts such work is stale.
  expect(
    Object.keys(CLASSIFIED).filter((file) => !files.includes(file))
  ).toEqual([]);
});

test("files classified as held call a hold", async () => {
  for (const [file, reason] of Object.entries(CLASSIFIED)) {
    if (reason.kind !== "held") {
      continue;
    }
    const source = await readFile(resolve(ROOT, file), "utf8");
    expect([file, HOLD_CALL.test(source)]).toEqual([file, true]);
  }
});
