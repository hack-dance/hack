import { afterEach, beforeEach, expect, test } from "bun:test";
import type { NativeProjectPsResult } from "../src/backends/native-project-observe.ts";
import { observeNativeProject } from "../src/lib/project-native-observation.ts";
import type { ProjectView } from "../src/lib/project-views.ts";

let original: Record<string, string | undefined>;
beforeEach(() => {
  original = {
    HACK_RUNTIME_BACKEND: process.env.HACK_RUNTIME_BACKEND,
    HACK_NATIVE_BINARY: process.env.HACK_NATIVE_BINARY,
    HACK_NATIVE_HOME: process.env.HACK_NATIVE_HOME,
  };
  process.env.HACK_RUNTIME_BACKEND = "native";
  process.env.HACK_NATIVE_BINARY = "/example/native";
  process.env.HACK_NATIVE_HOME = "/example/native-home";
});
afterEach(() => {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});
const view: ProjectView = {
  name: "sample",
  repoRoot: "/example/project",
  projectDir: "/example/project/.hack",
  devHost: null,
  ownership: null,
  definedServices: ["api", "task"],
  extensionsEnabled: null,
  features: null,
  serviceHosts: null,
  runtimeConfigured: true,
  runtimeStatus: "unknown",
  runtime: null,
  branchRuntime: [],
  sessions: [],
  lifecycle: null,
  worktrees: null,
  kind: "registered",
  status: "unknown",
};

test("native projection requires fresh current state and the retained readiness role", async () => {
  let calls = 0;
  const report = await observeNativeProject({
    view,
    ps: async (opts) => {
      calls++;
      expect(opts.includeReadiness).toBe(true);
      expect(opts.scope.projectRoot).toBe("/example/project");
      return {
        backend: "native",
        status: "observed",
        run: "run",
        phase: "ready-observed",
        items: [
          {
            service: "api",
            container: "member",
            phase: "ready",
            state: "running",
            health: "healthy",
            exitCode: null,
            readiness: "healthy",
          },
          {
            service: "task",
            container: "task",
            phase: "ready",
            state: "exited",
            health: null,
            exitCode: 0,
            readiness: "completed",
          },
        ],
      };
    },
  });
  expect(calls).toBe(1);
  expect(report.backend).toBe("native");
  expect(report.state).toBe("running");
  expect(report.services[1]?.completed).toBe(true);
  expect(report.started_at).toBeNull();
});

test.each([
  "runtime_not_running",
  "runtime_busy",
  "owner_unconfirmed",
] as const)("native %s is unknown, never stopped or a stale ready claim", async (status) => {
  const report = await observeNativeProject({
    view,
    ps: async () => ({
      backend: "native",
      status,
      run: "run",
      phase: "ready-observed",
      items: [],
    }),
  });
  expect(report.state).toBe("unknown");
  expect(report.state_reason).toBe("observation-unavailable");
});

test.each([
  "pending",
  "not_started",
] as const)("native %s comes from the owned run observer", async (status) => {
  const result: NativeProjectPsResult = {
    backend: "native",
    status,
    run: null,
    phase: null,
    items: [],
  };
  const report = await observeNativeProject({ view, ps: async () => result });
  expect(report.state).toBe(status === "pending" ? "starting" : "stopped");
});

test("native refusal omits raw provider diagnostics", async () => {
  const report = await observeNativeProject({
    view,
    ps: async () => {
      throw new Error("private diagnostic placeholder");
    },
  });
  expect(report.state).toBe("unknown");
  expect(JSON.stringify(report)).not.toContain("diagnostic placeholder");
});

test("verified native runtime degradation is distinct from unavailable observation", async () => {
  const report = await observeNativeProject({
    view,
    ps: async () => ({
      backend: "native",
      status: "runtime_degraded",
      run: "run",
      phase: "ready-observed",
      items: [],
    }),
  });
  expect(report.state).toBe("degraded");
  expect(report.state_reason).toBe("native-runtime-degraded");
});
