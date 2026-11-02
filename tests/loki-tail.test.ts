import { afterEach, expect, test } from "bun:test";

import { lokiLogs, renderLokiTailEmptyHint } from "../src/ui/loki-logs.ts";

type FakeTail = {
  readonly baseUrl: string;
  readonly stop: () => void;
};

const servers: FakeTail[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop();
  }
});

/** Fake Loki /tail endpoint: optionally sends one line, then closes after closeAfterMs. */
function startFakeTail(opts: {
  readonly line?: string;
  readonly closeAfterMs: number;
}): FakeTail {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      if (srv.upgrade(req)) {
        return;
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        if (opts.line) {
          ws.send(
            JSON.stringify({
              streams: [
                {
                  stream: { project: "p", service: "api" },
                  values: [[`${Date.now()}000000`, opts.line]],
                },
              ],
            })
          );
        }
        setTimeout(() => ws.close(), opts.closeAfterMs);
      },
      message() {
        // Loki tail is server-push only.
      },
    },
  });
  const fake = {
    baseUrl: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
  };
  servers.push(fake);
  return fake;
}

async function captureOutput(run: () => Promise<number>): Promise<{
  readonly code: number;
  readonly stderr: string;
}> {
  const originalStderr = process.stderr.write.bind(process.stderr);
  const originalStdout = process.stdout.write.bind(process.stdout);
  let stderr = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stderr.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    const code = await run();
    return { code, stderr };
  } finally {
    process.stderr.write = originalStderr;
    process.stdout.write = originalStdout;
  }
}

const QUERY = '{project="p",service="api"}';

test("Loki follow prints an empty-result hint when no line arrives", async () => {
  const fake = startFakeTail({ closeAfterMs: 300 });
  const result = await captureOutput(() =>
    lokiLogs({
      baseUrl: fake.baseUrl,
      query: QUERY,
      follow: true,
      tail: 10,
      pretty: false,
      showProjectPrefix: true,
      emptyHintMs: 50,
    })
  );

  expect(result.code).toBe(0);
  expect(result.stderr).toBe(
    renderLokiTailEmptyHint({ query: QUERY, waitedMs: 50 })
  );
  expect(result.stderr).toContain("hack logs --loki --no-follow --since 24h");
  expect(result.stderr).toContain("hack logs --compose");
});

test("Loki follow skips the hint once a line arrives", async () => {
  const fake = startFakeTail({ line: "hello", closeAfterMs: 300 });
  const result = await captureOutput(() =>
    lokiLogs({
      baseUrl: fake.baseUrl,
      query: QUERY,
      follow: true,
      tail: 10,
      pretty: false,
      showProjectPrefix: true,
      emptyHintMs: 50,
    })
  );

  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
});

test("Loki follow skips the hint when the stream closes first", async () => {
  const fake = startFakeTail({ closeAfterMs: 20 });
  const result = await captureOutput(() =>
    lokiLogs({
      baseUrl: fake.baseUrl,
      query: QUERY,
      follow: true,
      tail: 10,
      pretty: false,
      showProjectPrefix: true,
      emptyHintMs: 200,
    })
  );

  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
});
