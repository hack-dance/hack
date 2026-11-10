import { afterEach, expect, test } from "bun:test";

import { lokiLogs } from "../src/ui/loki-logs.ts";

// Regression cases carried from the v4 line (HACK-1344), run against the
// `noEntriesNotice` contract: the empty-follow notice fires once when no line
// arrives, and not after a line arrives or once the stream has closed.

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

const QUERY = '{project="p",service="api"}';

/** Runs a follow against the fake tail and counts empty-result notices. */
async function followWithNotice(opts: {
  readonly fake: FakeTail;
  readonly afterMs: number;
}): Promise<{ readonly code: number; readonly notices: number }> {
  const originalStdout = process.stdout.write.bind(process.stdout);
  let notices = 0;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    const code = await lokiLogs({
      baseUrl: opts.fake.baseUrl,
      query: QUERY,
      follow: true,
      tail: 10,
      pretty: false,
      showProjectPrefix: true,
      noEntriesNotice: {
        afterMs: opts.afterMs,
        notify: () => {
          notices += 1;
        },
      },
    });
    return { code, notices };
  } finally {
    process.stdout.write = originalStdout;
  }
}

test("Loki follow reports an empty result when no line arrives", async () => {
  const fake = startFakeTail({ closeAfterMs: 300 });
  const result = await followWithNotice({ fake, afterMs: 50 });

  expect(result.code).toBe(0);
  expect(result.notices).toBe(1);
});

test("Loki follow skips the notice once a line arrives", async () => {
  const fake = startFakeTail({ line: "hello", closeAfterMs: 300 });
  const result = await followWithNotice({ fake, afterMs: 50 });

  expect(result.code).toBe(0);
  expect(result.notices).toBe(0);
});

test("Loki follow skips the notice when the stream closes first", async () => {
  const fake = startFakeTail({ closeAfterMs: 20 });
  const result = await followWithNotice({ fake, afterMs: 200 });

  expect(result.code).toBe(0);
  expect(result.notices).toBe(0);
});
