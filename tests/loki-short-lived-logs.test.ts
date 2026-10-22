import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";

import {
  DEFAULT_LOKI_SNAPSHOT_LOOKBACK_MS,
  type LokiSnapshotOutcome,
  resolveLokiQueryWindow,
  runLokiSnapshotWithFallback,
} from "../src/lib/logs.ts";
import {
  GLOBAL_ALLOY_DOCKER_REFRESH_INTERVAL,
  renderGlobalAlloyConfig,
} from "../src/templates.ts";
import { buildLokiQueryRangeUrl, lokiSnapshot } from "../src/ui/loki-logs.ts";

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

function fallbackHarness(outcome: LokiSnapshotOutcome) {
  const calls = {
    lokiDeferEmpty: [] as boolean[],
    compose: 0,
    notices: [] as string[],
  };
  const run = async (wantsLokiExplicit: boolean, service?: string) =>
    await runLokiSnapshotWithFallback({
      wantsLokiExplicit,
      query: '{project="demo",service="migrate"}',
      service,
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
  expect(await run(false, "migrate")).toBe(7);
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
  expect(await run(true, "migrate")).toBe(0);
  expect(calls.lokiDeferEmpty).toEqual([false]);
  expect(calls.compose).toBe(0);
  expect(calls.notices).toHaveLength(1);
  expect(calls.notices[0]).toContain("`hack logs --compose migrate`");
  expect(calls.notices[0]).not.toContain("\n");
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
