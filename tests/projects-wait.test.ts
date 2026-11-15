import { expect, test } from "bun:test";
import {
  PROJECTS_WAIT_DEFAULT_MS,
  PROJECTS_WAIT_MAX_WAITERS,
  parseProjectsWait,
  projectsStateToken,
  projectsWaiterCount,
  resolveProjectsPayload,
} from "../src/daemon/projects-wait.ts";

const TOKEN = "0123456789abcdef0123456789abcdef";
const params = (query: string) => new URLSearchParams(query);

test("wait parameters are closed: a 32-hex token and a bounded timeout", () => {
  expect(parseProjectsWait(params(""))).toEqual({ kind: "none" });
  expect(parseProjectsWait(params(`wait=${TOKEN}`))).toEqual({
    kind: "wait",
    token: TOKEN,
    timeoutMs: PROJECTS_WAIT_DEFAULT_MS,
  });
  expect(
    parseProjectsWait(params(`wait=${TOKEN}&wait_timeout_ms=1000`))
  ).toEqual({ kind: "wait", token: TOKEN, timeoutMs: 1000 });
  for (const [query, error] of [
    ["wait_timeout_ms=5000", "wait_timeout_requires_wait"],
    ["wait=2026-11-15T00:00:00.000Z", "invalid_wait"],
    [`wait=${TOKEN.toUpperCase()}`, "invalid_wait"],
    [`wait=${TOKEN}&wait_timeout_ms=999`, "invalid_wait_timeout_ms"],
    [`wait=${TOKEN}&wait_timeout_ms=55001`, "invalid_wait_timeout_ms"],
    [`wait=${TOKEN}&wait_timeout_ms=1e4`, "invalid_wait_timeout_ms"],
    [`wait=${TOKEN}&wait_timeout_ms=-5`, "invalid_wait_timeout_ms"],
  ] as const) {
    expect(parseProjectsWait(params(query))).toEqual({
      kind: "invalid",
      error,
    });
  }
});

test("the token ignores per-response fields and changes with content", () => {
  const a = { generated_at: "t1", profiling: { x: 1 }, projects: [1] };
  const b = { generated_at: "t2", projects: [1] };
  const c = { generated_at: "t1", projects: [2] };
  expect(projectsStateToken(a)).toBe(projectsStateToken(b));
  expect(projectsStateToken(a)).not.toBe(projectsStateToken(c));
  expect(projectsStateToken(a)).toMatch(/^[0-9a-f]{32}$/);
  // Refresh stamps and Docker's humanized status text do not count; state does.
  const container = (status: string, state = "running") => ({
    runtime_checked_at: status,
    runtime_last_ok_at: status,
    projects: [
      {
        runtime: { services: [{ containers: [{ id: "c1", state, status }] }] },
      },
    ],
  });
  expect(projectsStateToken(container("Up 1 second"))).toBe(
    projectsStateToken(container("Up 31 seconds"))
  );
  expect(projectsStateToken(container("Up 1 second"))).not.toBe(
    projectsStateToken(container("Exited (0)", "exited"))
  );
  // A `status` field elsewhere (not a container entry) still counts.
  expect(projectsStateToken({ projects: [{ status: "running" }] })).not.toBe(
    projectsStateToken({ projects: [{ status: "stopped" }] })
  );
});

/** A payload source whose content advances only when told to. */
function source() {
  let version = 0;
  let builds = 0;
  return {
    build: async () => {
      builds++;
      return { generated_at: String(builds), projects: [version] };
    },
    advance: () => {
      version++;
    },
    builds: () => builds,
  };
}

/** Manually driven refreshes with the cache's generation and wake rules. */
function refreshes() {
  const pending = new Set<() => void>();
  let generation = 0;
  return {
    refreshGeneration: () => generation,
    nextRefresh: (opts: {
      readonly after: number;
      readonly signal: AbortSignal;
      readonly deadlineMs: number;
    }) =>
      new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(timer);
          pending.delete(wake);
          resolve();
        };
        const timer = setTimeout(
          wake,
          Math.max(0, opts.deadlineMs - Date.now())
        );
        if (opts.signal.aborted || generation > opts.after) {
          wake();
          return;
        }
        opts.signal.addEventListener("abort", wake, { once: true });
        pending.add(wake);
      }),
    fire: () => {
      generation++;
      for (const wake of [...pending]) {
        wake();
      }
    },
  };
}

const neverAborted = () => new AbortController().signal;

test("without wait, or with a stale token, the answer is immediate", async () => {
  const data = source();
  const events = refreshes();
  const plain = await resolveProjectsPayload({
    build: data.build,
    wait: { kind: "none" },
    refreshGeneration: events.refreshGeneration,
    nextRefresh: events.nextRefresh,
    signal: neverAborted(),
  });
  expect(plain.state_token).toBe(projectsStateToken(plain));
  const stale = await resolveProjectsPayload({
    build: data.build,
    wait: { kind: "wait", token: TOKEN, timeoutMs: 55_000 },
    refreshGeneration: events.refreshGeneration,
    nextRefresh: events.nextRefresh,
    signal: neverAborted(),
  });
  expect(stale.state_token).toBe(plain.state_token);
  expect(data.builds()).toBe(2);
});

test("a current token waits for a refresh that changes the content", async () => {
  const data = source();
  const events = refreshes();
  const first = await resolveProjectsPayload({
    build: data.build,
    wait: { kind: "none" },
    refreshGeneration: events.refreshGeneration,
    nextRefresh: events.nextRefresh,
    signal: neverAborted(),
  });
  let settled = false;
  const waiting = resolveProjectsPayload({
    build: data.build,
    wait: { kind: "wait", token: first.state_token, timeoutMs: 55_000 },
    refreshGeneration: events.refreshGeneration,
    nextRefresh: events.nextRefresh,
    signal: neverAborted(),
  }).then((result) => {
    settled = true;
    return result;
  });
  await Bun.sleep(5);
  expect(projectsWaiterCount()).toBe(1);
  // A refresh with identical content keeps waiting.
  events.fire();
  await Bun.sleep(5);
  expect(settled).toBe(false);
  data.advance();
  events.fire();
  const changed = await waiting;
  expect(changed.projects).toEqual([1]);
  expect(changed.state_token).not.toBe(first.state_token);
  expect(projectsWaiterCount()).toBe(0);
});

test("a timeout answers with a fresh build; an abort stops waiting", async () => {
  const data = source();
  const events = refreshes();
  const first = await resolveProjectsPayload({
    build: data.build,
    wait: { kind: "none" },
    refreshGeneration: events.refreshGeneration,
    nextRefresh: events.nextRefresh,
    signal: neverAborted(),
  });
  // Content changes without any refresh (as a registry edit does).
  data.advance();
  const timedOut = await resolveProjectsPayload({
    build: data.build,
    wait: { kind: "wait", token: first.state_token, timeoutMs: 1000 },
    refreshGeneration: events.refreshGeneration,
    nextRefresh: events.nextRefresh,
    signal: neverAborted(),
  });
  // The first build already differed, so it answered at once.
  expect(timedOut.projects).toEqual([1]);

  const same = await resolveProjectsPayload({
    build: data.build,
    wait: { kind: "none" },
    refreshGeneration: events.refreshGeneration,
    nextRefresh: events.nextRefresh,
    signal: neverAborted(),
  });
  const started = Date.now();
  const unchanged = await resolveProjectsPayload({
    build: data.build,
    wait: { kind: "wait", token: same.state_token, timeoutMs: 1000 },
    refreshGeneration: events.refreshGeneration,
    nextRefresh: events.nextRefresh,
    signal: neverAborted(),
  });
  expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  expect(unchanged.state_token).toBe(same.state_token);

  const controller = new AbortController();
  const aborted = resolveProjectsPayload({
    build: data.build,
    wait: { kind: "wait", token: same.state_token, timeoutMs: 55_000 },
    refreshGeneration: events.refreshGeneration,
    nextRefresh: events.nextRefresh,
    signal: controller.signal,
  });
  await Bun.sleep(5);
  const buildsBefore = data.builds();
  controller.abort();
  await aborted;
  expect(data.builds()).toBe(buildsBefore);
  expect(projectsWaiterCount()).toBe(0);
});

test("past the waiter cap a matching request is answered at once", async () => {
  const data = source();
  const events = refreshes();
  const first = await resolveProjectsPayload({
    build: data.build,
    wait: { kind: "none" },
    refreshGeneration: events.refreshGeneration,
    nextRefresh: events.nextRefresh,
    signal: neverAborted(),
  });
  const controller = new AbortController();
  const held = Array.from({ length: PROJECTS_WAIT_MAX_WAITERS }, () =>
    resolveProjectsPayload({
      build: data.build,
      wait: { kind: "wait", token: first.state_token, timeoutMs: 55_000 },
      refreshGeneration: events.refreshGeneration,
      nextRefresh: events.nextRefresh,
      signal: controller.signal,
    })
  );
  await Bun.sleep(5);
  expect(projectsWaiterCount()).toBe(PROJECTS_WAIT_MAX_WAITERS);
  const extra = await resolveProjectsPayload({
    build: data.build,
    wait: { kind: "wait", token: first.state_token, timeoutMs: 55_000 },
    refreshGeneration: events.refreshGeneration,
    nextRefresh: events.nextRefresh,
    signal: neverAborted(),
  });
  expect(extra.state_token).toBe(first.state_token);
  controller.abort();
  await Promise.all(held);
  expect(projectsWaiterCount()).toBe(0);
});

test("a refresh that completes during the build is not missed", async () => {
  const data = source();
  const events = refreshes();
  const first = await resolveProjectsPayload({
    build: data.build,
    wait: { kind: "none" },
    refreshGeneration: events.refreshGeneration,
    nextRefresh: events.nextRefresh,
    signal: neverAborted(),
  });
  let builds = 0;
  const started = Date.now();
  const result = await resolveProjectsPayload({
    // The first build reads the old state; a refresh then lands before the
    // waiter subscribes (as when Docker events arrive during project views).
    build: async () => {
      const payload = await data.build();
      if (builds++ === 0) {
        data.advance();
        events.fire();
      }
      return payload;
    },
    wait: { kind: "wait", token: first.state_token, timeoutMs: 55_000 },
    refreshGeneration: events.refreshGeneration,
    nextRefresh: events.nextRefresh,
    signal: neverAborted(),
  });
  expect(result.projects).toEqual([1]);
  expect(Date.now() - started).toBeLessThan(5000);
});
