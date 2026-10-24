import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";

import {
  DEFAULT_LOKI_SNAPSHOT_LOOKBACK_MS,
  LOKI_FOLLOW_EMPTY_NOTICE_DELAY_MS,
  type LogsCommandSelectors,
  type LogsCommandTarget,
  type LokiSnapshotOutcome,
  renderComposeLogsSuggestion,
  renderEmptyLokiFollowNotice,
  resolveLokiQueryWindow,
  runLokiSnapshotWithFallback,
} from "../src/lib/logs.ts";
import {
  GLOBAL_ALLOY_DATA_VOLUME,
  GLOBAL_ALLOY_DOCKER_REFRESH_INTERVAL,
  GLOBAL_ALLOY_LOG_LEVEL,
  GLOBAL_ALLOY_STORAGE_PATH,
  renderGlobalAlloyConfig,
  renderGlobalLoggingCompose,
} from "../src/templates.ts";
import {
  buildLokiQueryRangeUrl,
  lokiLogs,
  lokiSnapshot,
  type NoticeScheduler,
} from "../src/ui/loki-logs.ts";
import { withOwnedProcessListeners } from "./helpers/owned-process-listeners.ts";

// HACK-1277: a one-shot Compose service that exits quickly must not make
// Loki-backed `hack logs` look empty while `docker compose logs` has output.

const NOW = new Date("2026-10-21T12:00:00.000Z");

function ns(date: Date): string {
  return (BigInt(date.getTime()) * 1_000_000n).toString();
}

test("Loki snapshot window defaults to a 24h lookback ending now", () => {
  expect(DEFAULT_LOKI_SNAPSHOT_LOOKBACK_MS).toBe(24 * 60 * 60 * 1000);
  const window = resolveLokiQueryWindow({ now: NOW });
  expect(window.end).toEqual(NOW);
  expect(window.start).toEqual(new Date("2026-10-20T12:00:00.000Z"));
});

test("Loki snapshot window keeps explicit --since and --until", () => {
  const since = new Date("2026-10-21T11:00:00.000Z");
  const until = new Date("2026-10-21T11:30:00.000Z");
  expect(resolveLokiQueryWindow({ start: since, now: NOW })).toEqual({
    start: since,
    end: NOW,
  });
  // --until alone looks back from the given end, not from now.
  expect(resolveLokiQueryWindow({ end: until, now: NOW })).toEqual({
    start: new Date("2026-10-20T11:30:00.000Z"),
    end: until,
  });
});

test("buildLokiQueryRangeUrl covers a service that exited before the old 15m window", () => {
  const url = buildLokiQueryRangeUrl({
    baseUrl: "http://127.0.0.1:3100/",
    query: '{project="demo",service="migrate"}',
    tail: 200,
    now: NOW,
  });
  expect(`${url.origin}${url.pathname}`).toBe(
    "http://127.0.0.1:3100/loki/api/v1/query_range"
  );
  expect(url.searchParams.get("query")).toBe(
    '{project="demo",service="migrate"}'
  );
  expect(url.searchParams.get("direction")).toBe("BACKWARD");
  expect(url.searchParams.get("limit")).toBe("200");
  expect(url.searchParams.get("end")).toBe(ns(NOW));
  // A one-shot that exited 20 minutes ago is inside the queried range.
  const exitedAt = new Date(NOW.getTime() - 20 * 60 * 1000);
  const start = BigInt(url.searchParams.get("start") ?? "0");
  expect(start < BigInt(ns(exitedAt))).toBe(true);
  expect(url.searchParams.get("start")).toBe(
    ns(new Date("2026-10-20T12:00:00.000Z"))
  );
});

// --- lokiSnapshot against an in-process fake Loki -------------------------

let lokiStreams: unknown[] = [];
const lokiRequests: URL[] = [];
let fakeLoki: ReturnType<typeof Bun.serve> | null = null;
let restoreStdout: () => void = () => undefined;
let stdout = "";

beforeAll(() => {
  fakeLoki = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      lokiRequests.push(url);
      return Response.json({
        status: "success",
        data: { resultType: "streams", result: lokiStreams },
      });
    },
  });
});

afterAll(() => {
  fakeLoki?.stop(true);
});

afterEach(() => {
  restoreStdout();
  restoreStdout = () => undefined;
  lokiStreams = [];
  lokiRequests.length = 0;
  stdout = "";
});

function captureStdout(): void {
  const original = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout +=
      typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as typeof process.stdout.write;
  restoreStdout = () => {
    process.stdout.write = original;
  };
}

function fakeLokiUrl(): string {
  return `http://127.0.0.1:${fakeLoki?.port ?? 0}`;
}

const streamContext = { backend: "loki" as const, follow: false };

test("lokiSnapshot defers an empty result without writing any output", async () => {
  captureStdout();
  const outcome = await lokiSnapshot({
    baseUrl: fakeLokiUrl(),
    query: '{project="demo",service="migrate"}',
    follow: false,
    tail: 50,
    pretty: false,
    json: true,
    showProjectPrefix: true,
    streamContext,
    deferEmpty: true,
  });
  restoreStdout();

  expect(outcome).toEqual({ exitCode: 0, entryCount: 0, deferred: true });
  // No NDJSON start/end pair: the fallback backend owns the only stream.
  expect(stdout).toBe("");
  expect(lokiRequests).toHaveLength(1);
});

test("lokiSnapshot still writes an empty stream when not deferring", async () => {
  captureStdout();
  const outcome = await lokiSnapshot({
    baseUrl: fakeLokiUrl(),
    query: '{project="demo"}',
    follow: false,
    tail: 50,
    pretty: false,
    json: true,
    showProjectPrefix: true,
    streamContext,
  });
  restoreStdout();

  expect(outcome).toEqual({ exitCode: 0, entryCount: 0, deferred: false });
  const types = stdout
    .trim()
    .split("\n")
    .map((line) => (JSON.parse(line) as { type: string }).type);
  expect(types).toEqual(["start", "end"]);
});

test("lokiSnapshot prints entries and never defers a non-empty result", async () => {
  lokiStreams = [
    {
      stream: { project: "demo", service: "migrate" },
      values: [
        [ns(new Date("2026-10-21T11:40:00.002Z")), "migrations done"],
        [ns(new Date("2026-10-21T11:40:00.001Z")), "running migrations"],
      ],
    },
  ];
  captureStdout();
  const outcome = await lokiSnapshot({
    baseUrl: fakeLokiUrl(),
    query: '{project="demo",service="migrate"}',
    follow: false,
    tail: 50,
    pretty: false,
    showProjectPrefix: true,
    deferEmpty: true,
  });
  restoreStdout();

  expect(outcome).toEqual({ exitCode: 0, entryCount: 2, deferred: false });
  expect(stdout).toBe(
    [
      "demo/migrate | 2026-10-21T11:40:00.001Z running migrations",
      "demo/migrate | 2026-10-21T11:40:00.002Z migrations done",
      "",
    ].join("\n")
  );
});

// --- empty-snapshot fallback policy ---------------------------------------

function fallbackHarness(
  outcome: LokiSnapshotOutcome,
  target: LogsCommandTarget = {}
) {
  const calls = {
    lokiDeferEmpty: [] as boolean[],
    compose: 0,
    notices: [] as string[],
  };
  const run = async (
    wantsLokiExplicit: boolean,
    selectors: LogsCommandSelectors = {}
  ) =>
    await runLokiSnapshotWithFallback({
      wantsLokiExplicit,
      query: '{project="demo",service="migrate"}',
      target,
      selectors,
      runLoki: async ({ deferEmpty }) => {
        calls.lokiDeferEmpty.push(deferEmpty);
        return outcome;
      },
      runCompose: async () => {
        calls.compose += 1;
        return 7;
      },
      writeNotice: (line) => {
        calls.notices.push(line);
      },
    });
  return { calls, run };
}

test("implicit Loki snapshot with no entries falls back to compose logs", async () => {
  const { calls, run } = fallbackHarness({
    exitCode: 0,
    entryCount: 0,
    deferred: true,
  });
  expect(await run(false, { services: ["migrate"] })).toBe(7);
  expect(calls.lokiDeferEmpty).toEqual([true]);
  expect(calls.compose).toBe(1);
  expect(calls.notices).toHaveLength(1);
  expect(calls.notices[0]).toContain("showing docker compose logs instead");
  expect(calls.notices[0]).not.toContain("\n");
});

test("implicit Loki snapshot with entries does not run compose", async () => {
  const { calls, run } = fallbackHarness({
    exitCode: 0,
    entryCount: 3,
    deferred: false,
  });
  expect(await run(false)).toBe(0);
  expect(calls.compose).toBe(0);
  expect(calls.notices).toEqual([]);
});

test("explicit Loki snapshot with no entries hints at --compose instead of falling back", async () => {
  const { calls, run } = fallbackHarness({
    exitCode: 0,
    entryCount: 0,
    deferred: false,
  });
  expect(await run(true, { services: ["migrate"] })).toBe(0);
  expect(calls.lokiDeferEmpty).toEqual([false]);
  expect(calls.compose).toBe(0);
  expect(calls.notices).toHaveLength(1);
  // A snapshot hint suggests a snapshot: plain `--compose` would follow.
  expect(calls.notices[0]).toContain(
    "try `hack logs --compose --no-follow migrate`."
  );
  expect(calls.notices[0]).not.toContain("\n");
});

test("explicit Loki snapshot hint keeps --path, --project and --branch", async () => {
  const { calls, run } = fallbackHarness(
    { exitCode: 0, entryCount: 0, deferred: false },
    { path: "./my app", project: "demo", branch: "feat-x" }
  );
  expect(await run(true, { services: ["migrate"] })).toBe(0);
  expect(calls.notices[0]).toContain(
    "try `hack logs --compose --no-follow --path './my app' --project demo --branch feat-x migrate`."
  );
});

// HACK-1379: the hint carries every selector, not only the project target.
test("explicit Loki snapshot hint carries --tail, --profile, --pretty and --json", async () => {
  const { calls, run } = fallbackHarness(
    { exitCode: 0, entryCount: 0, deferred: false },
    { project: "demo" }
  );
  expect(
    await run(true, {
      services: ["migrate"],
      tail: 50,
      profiles: ["jobs", "debug"],
      pretty: true,
      json: false,
    })
  ).toBe(0);
  expect(calls.notices[0]).toEndWith(
    "try `hack logs --compose --no-follow --project demo --tail 50 --profile jobs,debug --pretty migrate`."
  );
  expect(calls.notices[0]).not.toContain("--json");
  expect(calls.notices[0]).not.toContain("\n");
});

test("explicit Loki snapshot hint names --services, --since, --until and --query it cannot carry", async () => {
  const { calls, run } = fallbackHarness({
    exitCode: 0,
    entryCount: 0,
    deferred: false,
  });
  expect(
    await run(true, {
      services: ["api", "www"],
      json: true,
      query: '{project="demo"} |= "boom"',
      since: "15m",
      until: "5m",
    })
  ).toBe(0);
  // Two services cannot become one positional; the command shows all services
  // and the notice says which selectors were not applied.
  expect(calls.notices[0]).toEndWith(
    'try `hack logs --compose --no-follow --json`. The compose backend has no equivalent for --services api,www, --query \'{project="demo"} |= "boom"\', --since 15m and --until 5m.'
  );
  expect(calls.notices[0]).not.toContain("\n");
});

test("renderComposeLogsSuggestion matches follow mode, quotes unsafe words and reports omitted selectors", () => {
  expect(
    renderComposeLogsSuggestion({ follow: true, target: {}, selectors: {} })
  ).toEqual({ command: "hack logs --compose", omitted: [] });
  expect(
    renderComposeLogsSuggestion({
      follow: false,
      target: { path: "  ", branch: "it's" },
      selectors: { services: [" web "], profiles: [" ", "a b"] },
    })
  ).toEqual({
    command:
      "hack logs --compose --no-follow --branch 'it'\\''s' --profile 'a b' web",
    omitted: [],
  });
  // A single service from --services is the same selection as the positional.
  expect(
    renderComposeLogsSuggestion({
      follow: false,
      target: {},
      selectors: { services: ["api"], tail: 5, since: "2026-10-21T10:00:00Z" },
    })
  ).toEqual({
    command: "hack logs --compose --no-follow --tail 5 api",
    omitted: ["--since 2026-10-21T10:00:00Z"],
  });
  expect(
    renderComposeLogsSuggestion({
      follow: true,
      target: {},
      selectors: { services: ["api", "www", "api"], until: "now" },
    })
  ).toEqual({
    command: "hack logs --compose",
    omitted: ["--services api,www,api", "--until now"],
  });
});

test("follow notice suggests a following compose command for the same target", () => {
  const notice = renderEmptyLokiFollowNotice({
    query: '{project="demo--feat-x",service="api"}',
    target: { branch: "feat-x" },
    selectors: { services: ["api"] },
  });
  expect(notice).toContain(
    'Loki has sent no log entries for {project="demo--feat-x",service="api"} yet'
  );
  expect(notice).toContain("still following");
  expect(notice).toEndWith("Try `hack logs --compose --branch feat-x api`.");
  expect(notice).not.toContain("--no-follow");
  expect(notice).not.toContain("\n");
  expect(LOKI_FOLLOW_EMPTY_NOTICE_DELAY_MS).toBe(8000);
});

test("follow notice carries every selector and names the ones compose cannot apply", () => {
  const notice = renderEmptyLokiFollowNotice({
    query: '{project="demo",service=~"^(api|www)$"}',
    target: { project: "demo" },
    selectors: {
      services: ["api", "www"],
      tail: 20,
      profiles: ["jobs"],
      json: true,
      since: "1h",
    },
  });
  expect(notice).toEndWith(
    "Try `hack logs --compose --project demo --tail 20 --profile jobs --json`. The compose backend has no equivalent for --services api,www and --since 1h."
  );
  expect(notice).not.toContain("\n");
});

test("a failed Loki query keeps its exit code and adds no empty-result notice", async () => {
  for (const explicit of [true, false]) {
    const { calls, run } = fallbackHarness({
      exitCode: 1,
      entryCount: 0,
      deferred: false,
    });
    expect(await run(explicit)).toBe(1);
    expect(calls.compose).toBe(0);
    expect(calls.notices).toEqual([]);
  }
});

// --- Alloy discovery config ------------------------------------------------

test("Alloy discovers exited Compose containers so one-shot services reach Loki", () => {
  const config = renderGlobalAlloyConfig();
  const discovery = config.slice(
    config.indexOf('discovery.docker "local" {'),
    config.indexOf('discovery.relabel "docker_compose" {')
  );
  expect(discovery).toContain(
    `refresh_interval = "${GLOBAL_ALLOY_DOCKER_REFRESH_INTERVAL}"`
  );
  expect(GLOBAL_ALLOY_DOCKER_REFRESH_INTERVAL).toBe("5s");
  // Docker lists all containers once a status filter is present.
  expect(discovery).toMatch(
    /filter \{\s+name\s+= "status"\s+values = \["running", "restarting", "paused", "exited"\]\s+\}/
  );
});

test("Alloy keeps a stopped container's target labels stable and still requires a Compose project", () => {
  const config = renderGlobalAlloyConfig();
  const relabel = config.slice(
    config.indexOf('discovery.relabel "docker_compose" {'),
    config.indexOf('loki.source.docker "default" {')
  );
  expect(relabel).toContain(
    'source_labels = ["__meta_docker_container_label_com_docker_compose_project"]'
  );
  expect(relabel).toContain('action        = "keep"');
  expect(relabel).toMatch(
    /action = "labeldrop"\s+regex {2}= "__meta_docker_\(network\|port\)_\.\+"/
  );
  expect(relabel).toMatch(
    /source_labels = \["__meta_docker_container_id"\]\s+target_label {2}= "__address__"/
  );
  // Stream labels used by `hack logs` selectors are unchanged.
  for (const label of ["container", "service", "project"]) {
    expect(relabel).toContain(`target_label  = "${label}"`);
  }
});

test("Alloy keeps its own component logs at warn so per-poll info lines stay out of Loki", () => {
  // HACK-1364: loki.source.docker logs "finished transferring logs" at info on
  // every log reopen, every 5s for each kept exited container that never
  // logged a line, and Alloy's own container is a Compose service it ships to
  // Loki.
  expect(GLOBAL_ALLOY_LOG_LEVEL).toBe("warn");
  const config = renderGlobalAlloyConfig();
  expect(config).toMatch(
    /^logging \{\n {2}level {2}= "warn"\n {2}format = "logfmt"\n\}\n/
  );
  // One top-level logging block; Alloy refuses a duplicate.
  expect(config.match(/^logging \{/gm)).toHaveLength(1);
});

test("Alloy keeps its read positions in a named volume so a recreated container does not re-read every log", () => {
  // HACK-1379: positions lived in the container's writable layer, so every
  // `hack global down`/`up` re-read all retained container logs into Loki.
  expect(GLOBAL_ALLOY_DATA_VOLUME).toBe("alloy-data");
  expect(GLOBAL_ALLOY_STORAGE_PATH).toBe("/var/lib/alloy/data");
  const compose = Bun.YAML.parse(renderGlobalLoggingCompose()) as {
    services: Record<
      string,
      { command?: string; volumes?: string[]; image?: string }
    >;
    volumes: Record<string, unknown>;
  };
  const alloy = compose.services.alloy;
  expect(alloy?.image).toBe("grafana/alloy:v1.12.0");
  expect(alloy?.volumes).toContain("alloy-data:/var/lib/alloy/data");
  // The image's default command carries --storage.path; ours replaces the
  // command, so the flag must be repeated or positions land outside the volume.
  expect(alloy?.command).toBe(
    "run --storage.path=/var/lib/alloy/data /etc/alloy/config.alloy"
  );
  expect(Object.keys(compose.volumes)).toEqual([
    "loki-data",
    "grafana-data",
    "alloy-data",
  ]);
  // Each named volume is declared once and left unconfigured (Compose default
  // driver), so `docker compose down` keeps it and `down -v` removes it.
  expect(compose.volumes["alloy-data"]).toBeNull();
});

// --- Loki follow: notice when nothing arrives -------------------------------

type TailSocket = { close: () => void; send: (data: string) => void };

async function withFakeLokiTail(
  onOpen: (socket: TailSocket) => void,
  body: (opts: {
    readonly baseUrl: string;
    readonly sockets: TailSocket[];
  }) => Promise<void>
): Promise<void> {
  const sockets: TailSocket[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, srv) {
      if (
        new URL(request.url).pathname === "/loki/api/v1/tail" &&
        srv.upgrade(request, { data: undefined })
      ) {
        return;
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        sockets.push(ws);
        onOpen(ws);
      },
      message() {
        // The tail endpoint ignores client messages.
      },
    },
  });
  try {
    await body({ baseUrl: `http://127.0.0.1:${server.port}`, sockets });
  } finally {
    server.stop(true);
  }
}

async function waitFor(
  condition: () => boolean,
  label: string,
  timeoutMs = 5000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await Bun.sleep(10);
  }
}

/**
 * A hand-driven notice timer (HACK-1379): the test decides when the delay
 * elapses, so no assertion depends on a real timer racing the socket.
 */
function manualNoticeTimer() {
  const state = {
    scheduled: 0,
    afterMs: undefined as number | undefined,
    cancelled: false,
    pending: undefined as (() => void) | undefined,
  };
  const schedule: NoticeScheduler = (fn, afterMs) => {
    state.scheduled += 1;
    state.afterMs = afterMs;
    state.cancelled = false;
    state.pending = fn;
    return () => {
      state.cancelled = true;
      state.pending = undefined;
    };
  };
  // Elapse the delay; a cancelled timer, like a cleared setTimeout, never fires.
  const fire = () => {
    const fn = state.pending;
    state.pending = undefined;
    if (fn && !state.cancelled) {
      fn();
    }
  };
  return { schedule, fire, state };
}

function tailMessage(service: string, line: string): string {
  return JSON.stringify({
    streams: [
      {
        stream: { project: "demo", service },
        values: [[ns(new Date("2026-10-21T11:59:00.000Z")), line]],
      },
    ],
  });
}

function trackSettled(promise: Promise<number>): { readonly settled: boolean } {
  const state = { settled: false };
  promise.then(
    () => {
      state.settled = true;
    },
    () => {
      state.settled = true;
    }
  );
  return state;
}

test("Loki follow reports once when the tail stays empty and keeps following afterwards", async () => {
  const timer = manualNoticeTimer();
  await withFakeLokiTail(
    () => undefined,
    async ({ baseUrl, sockets }) => {
      let notices = 0;
      captureStdout();
      const exit = lokiLogs({
        baseUrl,
        query: '{project="demo",service="migrate"}',
        follow: true,
        tail: 10,
        pretty: false,
        showProjectPrefix: true,
        noEntriesNotice: {
          afterMs: LOKI_FOLLOW_EMPTY_NOTICE_DELAY_MS,
          notify: () => {
            notices += 1;
          },
          schedule: timer.schedule,
        },
      });
      const exitState = trackSettled(exit);
      await waitFor(() => timer.state.scheduled > 0, "the notice timer");
      expect(timer.state.afterMs).toBe(LOKI_FOLLOW_EMPTY_NOTICE_DELAY_MS);
      expect(notices).toBe(0);
      timer.fire();
      expect(notices).toBe(1);
      // The tail is still open after the notice: an entry that arrives later
      // is printed, and the follow has not ended on its own.
      expect(sockets).toHaveLength(1);
      sockets[0]?.send(tailMessage("migrate", "after the notice"));
      await waitFor(
        () => stdout.includes("after the notice"),
        "the entry sent after the notice"
      );
      expect(exitState.settled).toBe(false);
      // The timer is armed once; a later entry does not re-arm it.
      timer.fire();
      expect(notices).toBe(1);
      expect(timer.state.scheduled).toBe(1);
      for (const socket of sockets) {
        socket.close();
      }
      expect(await exit).toBe(0);
      restoreStdout();
      expect(stdout).toBe(
        "demo/migrate | 2026-10-21T11:59:00.000Z after the notice\n"
      );
    }
  );
});

test("Loki follow stays quiet when an entry arrives before the notice delay", async () => {
  const timer = manualNoticeTimer();
  await withFakeLokiTail(
    (socket) => socket.send(tailMessage("api", "hello")),
    async ({ baseUrl, sockets }) => {
      let notices = 0;
      captureStdout();
      const exit = lokiLogs({
        baseUrl,
        query: '{project="demo",service="api"}',
        follow: true,
        tail: 10,
        pretty: false,
        showProjectPrefix: true,
        noEntriesNotice: {
          afterMs: LOKI_FOLLOW_EMPTY_NOTICE_DELAY_MS,
          notify: () => {
            notices += 1;
          },
          schedule: timer.schedule,
        },
      });
      await waitFor(() => stdout.includes("hello"), "the streamed entry");
      // The first entry cancelled the timer, so elapsing the delay now is a
      // no-op, exactly as a cleared setTimeout would be.
      expect(timer.state.scheduled).toBe(1);
      expect(timer.state.cancelled).toBe(true);
      timer.fire();
      expect(notices).toBe(0);
      for (const socket of sockets) {
        socket.close();
      }
      expect(await exit).toBe(0);
      restoreStdout();
      expect(notices).toBe(0);
      expect(stdout).toBe("demo/api | 2026-10-21T11:59:00.000Z hello\n");
    }
  );
});

test("Loki follow uses a real timer for the notice when none is injected", async () => {
  await withFakeLokiTail(
    () => undefined,
    async ({ baseUrl, sockets }) => {
      let notices = 0;
      captureStdout();
      const exit = lokiLogs({
        baseUrl,
        query: '{project="demo",service="migrate"}',
        follow: true,
        tail: 10,
        pretty: false,
        showProjectPrefix: true,
        noEntriesNotice: {
          afterMs: 20,
          notify: () => {
            notices += 1;
          },
        },
      });
      // Only a lower bound on timing: the notice must arrive, however loaded
      // the machine is.
      await waitFor(() => notices > 0, "the empty-follow notice");
      expect(sockets).toHaveLength(1);
      for (const socket of sockets) {
        socket.close();
      }
      expect(await exit).toBe(0);
      restoreStdout();
      expect(notices).toBe(1);
      expect(stdout).toBe("");
    }
  );
});

// --- Loki follow: SIGINT listener ownership (HACK-1392) ----------------------
// All test files share one Bun process. A follow that leaves its `once`
// SIGINT listener behind makes the next SIGINT in the process run a stale
// stop, and the global-state guard then blames whichever test emits it.

function sameListeners<T>(left: readonly T[], right: readonly T[]): boolean {
  return (
    left.length === right.length &&
    left.every((listener, index) => listener === right[index])
  );
}

const FOLLOW_PARAMS = {
  query: '{project="demo",service="api"}',
  follow: true,
  tail: 10,
  pretty: false,
  showProjectPrefix: true,
} as const;

test("Loki follow removes its SIGINT listener once the tail closes", async () => {
  const before = process.listeners("SIGINT");
  await withFakeLokiTail(
    () => undefined,
    async ({ baseUrl, sockets }) => {
      captureStdout();
      const exit = lokiLogs({ baseUrl, ...FOLLOW_PARAMS });
      await waitFor(() => sockets.length === 1, "the tail connection");
      expect(process.listenerCount("SIGINT")).toBe(before.length + 1);
      for (const socket of sockets) {
        socket.close();
      }
      expect(await exit).toBe(0);
      expect(sameListeners(process.listeners("SIGINT"), before)).toBe(true);
    }
  );
});

test("Loki follow stops on SIGINT and leaves no listener behind", async () => {
  const before = process.listeners("SIGINT");
  await withFakeLokiTail(
    () => undefined,
    async ({ baseUrl, sockets }) => {
      captureStdout();
      const exit = lokiLogs({ baseUrl, ...FOLLOW_PARAMS });
      await waitFor(() => sockets.length === 1, "the tail connection");
      const added = process
        .listeners("SIGINT")
        .filter((listener) => !before.includes(listener));
      expect(added).toHaveLength(1);
      // Run the follow's own handler instead of emitting SIGINT, which would
      // reach every listener in the shared test process.
      added[0]?.("SIGINT");
      expect(await exit).toBe(0);
      expect(sameListeners(process.listeners("SIGINT"), before)).toBe(true);
    }
  );
});

test("Loki follow drops its SIGINT listener through a real SIGINT emit", async () => {
  // The fixture owns every SIGINT listener, so the emit reaches only the
  // follow's handler and not another file's or test's.
  await withOwnedProcessListeners("SIGINT", () =>
    withFakeLokiTail(
      () => undefined,
      async ({ baseUrl, sockets }) => {
        captureStdout();
        const exit = lokiLogs({ baseUrl, ...FOLLOW_PARAMS });
        await waitFor(() => sockets.length === 1, "the tail connection");
        expect(process.listenerCount("SIGINT")).toBe(1);
        process.emit("SIGINT");
        // The signal path itself removes the `once` listener, before the
        // tail closes and the follow's `finally` runs.
        expect(process.listenerCount("SIGINT")).toBe(0);
        expect(await exit).toBe(0);
        expect(process.listenerCount("SIGINT")).toBe(0);
      }
    )
  );
});
