import { expect, test } from "bun:test";
import {
  NATIVE_PROJECT_SHARE_EXTENSION_REQUIRED,
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

test("a running shared pool never changes mounts and explains the stop-then-up path", async () => {
  for (const status of [
    { phase: "running", process_alive: true },
    { phase: "process-exited", process_alive: true },
  ]) {
    const calls: string[][] = [];
    const refusal = await preflightNativeProjectSource({
      runtime,
      projectRoot: "/work/second-app",
      invoke: async (request) => {
        calls.push([...request.args]);
        if (request.args[1] === "check-project-share") {
          throw extensionRequired();
        }
        return status;
      },
    }).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ClosedCliError);
    expect(String(refusal)).toContain("mounts never change");
    expect(String(refusal)).toContain("Startup hooks were not run");
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
