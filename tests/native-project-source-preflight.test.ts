import { expect, test } from "bun:test";
import {
  NATIVE_IDLE_POOL_RESTART_NOTICE,
  NATIVE_PROJECT_SHARE_EXTENSION_REQUIRED,
  NATIVE_PROJECT_SHARE_POOL_IN_USE,
  preflightNativeProjectSource,
} from "../src/backends/native-project-source-preflight.ts";
import { NativeRuntimeRequestError } from "../src/backends/native-runtime-client.ts";
import { ClosedCliError } from "../src/lib/cli-result.ts";

const runtime = { binary: "/candidate/hack-native", home: "/candidate/home" };
const checkArgs = (root: string) => [
  "runtime",
  "check-project-share",
  "--project-share",
  root,
  "--unfiltered-source",
  "--json",
];
const extensionRequired = () =>
  new NativeRuntimeRequestError({
    message:
      "Native runtime request failed (project_share_extension_required).",
    nativeCode: NATIVE_PROJECT_SHARE_EXTENSION_REQUIRED,
  });
const added = (project: string) => ({
  kind: "project_share_added",
  project,
  changed: true,
  restarted: false,
  disks_preserved: true,
  effective: "next-boot",
});

test("source admission asks the selected runtime to validate the exact root", async () => {
  await preflightNativeProjectSource({
    runtime,
    projectRoot: "/worktrees/branch/project",
    invoke: async (request) => {
      expect(request.runtime).toEqual(runtime);
      expect(request.args).toEqual(checkArgs("/worktrees/branch/project"));
      expect(request.timeoutMs).toBe(5000);
      return { source_admitted: true, pool_initialized: false };
    },
  });
});

test("invalid and refused source admission never counts as startup permission", async () => {
  for (const result of [
    null,
    true,
    {},
    { source_admitted: false, pool_initialized: true },
    { source_admitted: true },
  ]) {
    const refusal = await preflightNativeProjectSource({
      runtime,
      projectRoot: "/project",
      invoke: async () => result,
    }).catch((error: unknown) => error);
    // A closed refusal: the CLI prints this one line without a stack.
    expect(refusal).toBeInstanceOf(ClosedCliError);
    expect(String(refusal)).toContain("invalid receipt");
  }
  await expect(
    preflightNativeProjectSource({
      runtime,
      projectRoot: "/project",
      invoke: async () => {
        throw new Error("source pool mismatch");
      },
    })
  ).rejects.toThrow("source pool mismatch");
});

test("a stopped shared pool adds another project root before hooks, then re-admits it", async () => {
  const calls: string[][] = [];
  let shared = false;
  await preflightNativeProjectSource({
    runtime,
    projectRoot: "/work/second-app",
    invoke: async (request) => {
      calls.push([...request.args]);
      expect(request.runtime).toEqual(runtime);
      expect(request.cwd).toBe(runtime.home);
      if (request.args[1] === "check-project-share") {
        if (!shared) {
          throw extensionRequired();
        }
        return { source_admitted: true, pool_initialized: true };
      }
      if (request.args[1] === "status") {
        return { phase: "stopped", process_alive: false };
      }
      shared = true;
      return added("/work/second-app");
    },
  });
  expect(calls).toEqual([
    checkArgs("/work/second-app"),
    ["runtime", "status", "--json"],
    [
      "runtime",
      "project-share",
      "add",
      "--project-share",
      "/work/second-app",
      "--unfiltered-source",
      "--json",
    ],
    checkArgs("/work/second-app"),
  ]);
});

const addArgs = (root: string, extra: readonly string[] = []) => [
  "runtime",
  "project-share",
  "add",
  "--project-share",
  root,
  "--unfiltered-source",
  ...extra,
  "--json",
];

test("an idle running pool is stopped by the share update, which prints one line before the start boots it", async () => {
  const calls: string[][] = [];
  const lines: string[] = [];
  let shared = false;
  await preflightNativeProjectSource({
    runtime,
    projectRoot: "/work/second-app",
    notice: (line) => lines.push(line),
    invoke: async (request) => {
      calls.push([...request.args]);
      if (request.args[1] === "check-project-share") {
        if (!shared) {
          throw extensionRequired();
        }
        return { source_admitted: true, pool_initialized: true };
      }
      if (request.args[1] === "status") {
        return { phase: "running", process_alive: true };
      }
      expect(request.timeoutMs).toBe(120_000);
      shared = true;
      return { ...added("/work/second-app"), stopped_idle_pool: true };
    },
  });
  expect(calls).toEqual([
    checkArgs("/work/second-app"),
    ["runtime", "status", "--json"],
    addArgs("/work/second-app", ["--stop-idle-pool"]),
    checkArgs("/work/second-app"),
  ]);
  expect(lines).toEqual([NATIVE_IDLE_POOL_RESTART_NOTICE]);
});

test("a running pool in use names the projects that use it, or says why it cannot", async () => {
  const inUse = new NativeRuntimeRequestError({
    message: "Native runtime request failed (project_share_pool_in_use).",
    nativeCode: NATIVE_PROJECT_SHARE_POOL_IN_USE,
  });
  // The runtime refuses an in-use pool, or a pool another start booted meanwhile.
  for (const [refusal, liveRuns, says] of [
    [inUse, ["a".repeat(32)], "in use by first-app"],
    [extensionRequired(), ["a".repeat(32)], "in use by first-app"],
    [inUse, [], "an open interactive session"],
    [inUse, undefined, "its live runs could not be read"],
    [
      new NativeRuntimeRequestError({
        message: "Native runtime request failed (provider_busy).",
        nativeCode: "provider_busy",
      }),
      undefined,
      "a native image build is running",
    ],
  ] as const) {
    const lines: string[] = [];
    const described: (readonly string[])[] = [];
    let statuses = 0;
    const error = await preflightNativeProjectSource({
      runtime,
      projectRoot: "/work/second-app",
      notice: (line) => lines.push(line),
      describe: async (runs) => {
        described.push(runs);
        return "first-app";
      },
      invoke: async (request) => {
        if (request.args[1] === "check-project-share") {
          throw extensionRequired();
        }
        if (request.args[1] === "status") {
          statuses += 1;
          return {
            phase: "running",
            process_alive: true,
            ...(statuses > 1 && liveRuns ? { live_runs: liveRuns } : {}),
          };
        }
        throw refusal;
      },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ClosedCliError);
    expect(String(error)).toContain(says);
    expect(String(error)).toContain("mounts never change");
    expect(String(error)).toContain("`down` in each");
    expect(String(error)).toContain("Startup hooks were not run");
    expect(described).toEqual(liveRuns?.length ? [liveRuns] : []);
    expect(lines).toEqual([]);
  }
});

test("a pool starting or stopping, or a running record whose provider is gone, is never updated", async () => {
  for (const status of [
    { phase: "process-exited", process_alive: true },
    { phase: "running", process_alive: false },
    { phase: "running" },
  ]) {
    const calls: string[][] = [];
    const error = await preflightNativeProjectSource({
      runtime,
      projectRoot: "/work/second-app",
      invoke: async (request) => {
        calls.push([...request.args]);
        if (request.args[1] === "check-project-share") {
          throw extensionRequired();
        }
        return status;
      },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ClosedCliError);
    expect(String(error)).toContain("starting or stopping, or its provider");
    expect(String(error)).toContain("mounts never change");
    expect(calls.some((args) => args[1] === "project-share")).toBe(false);
  }
});

test("share update and status receipts must be exact before admission continues", async () => {
  for (const [status, receipt] of [
    [null, added("/work/second-app")],
    [{ phase: "stopped", process_alive: false }, null],
    [{ phase: "stopped", process_alive: false }, added("/work/other")],
    [
      { phase: "stopped", process_alive: false },
      { ...added("/work/second-app"), restarted: true },
    ],
    [
      { phase: "stopped", process_alive: false },
      { ...added("/work/second-app"), kind: "project_share_removed" },
    ],
    // A running pool's update must say whether it stopped the pool.
    [{ phase: "running", process_alive: true }, added("/work/second-app")],
  ] as const) {
    let checks = 0;
    const refusal = await preflightNativeProjectSource({
      runtime,
      projectRoot: "/work/second-app",
      invoke: async (request) => {
        if (request.args[1] === "check-project-share") {
          checks += 1;
          throw extensionRequired();
        }
        return request.args[1] === "status" ? status : receipt;
      },
    }).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ClosedCliError);
    expect(String(refusal)).toContain("invalid receipt");
    expect(checks).toBe(1);
  }
});

test("other native refusals and a refused share update propagate unchanged", async () => {
  const foreign = new NativeRuntimeRequestError({
    message: "Native runtime request failed (project_share).",
    nativeCode: "project_share",
  });
  await expect(
    preflightNativeProjectSource({
      runtime,
      projectRoot: "/project",
      invoke: async () => {
        throw foreign;
      },
    })
  ).rejects.toBe(foreign);
  const update = new NativeRuntimeRequestError({
    message: "Native runtime request failed (project_share_update).",
    nativeCode: "project_share_update",
  });
  await expect(
    preflightNativeProjectSource({
      runtime,
      projectRoot: "/project",
      invoke: async (request) => {
        if (request.args[1] === "check-project-share") {
          throw extensionRequired();
        }
        if (request.args[1] === "status") {
          return { phase: "stopped", process_alive: false };
        }
        throw update;
      },
    })
  ).rejects.toBe(update);
});
