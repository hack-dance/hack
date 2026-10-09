import { posix } from "node:path";
import type { HostHook } from "../../packages/config-compiler/generated/native-config.ts";
import { isRecord } from "./guards.ts";
import { parseNativeHostTarget } from "./native-host-plan-protocol.ts";

const NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/;
export type NativeComposeHook = Omit<HostHook, "environment"> & {
  readonly environment?: Readonly<Record<string, unknown>>;
};

export class NativeComposeHostHookError extends Error {
  readonly code = "E_NATIVE_PROJECT_UNSUPPORTED";
  constructor() {
    super(
      "Native Compose host hooks require finite lifecycle commands and complete selected host bindings; values omitted."
    );
    this.name = "NativeComposeHostHookError";
  }
}

function assert(value: unknown): asserts value {
  if (!value) {
    throw new NativeComposeHostHookError();
  }
}
function only(value: Record<string, unknown>, fields: readonly string[]) {
  return Object.keys(value).every((key) => fields.includes(key));
}
function command(value: unknown): value is HostHook["command"] {
  if (!isRecord(value)) {
    return false;
  }
  if (Object.hasOwn(value, "exec")) {
    return (
      only(value, ["exec"]) &&
      Array.isArray(value.exec) &&
      value.exec.length > 0 &&
      value.exec[0] !== "" &&
      value.exec.every(
        (part) => typeof part === "string" && !part.includes("\0")
      )
    );
  }
  return (
    only(value, ["shell"]) &&
    typeof value.shell === "string" &&
    value.shell.length > 0 &&
    !value.shell.includes("\0")
  );
}
function relative(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("\0") &&
    !value.includes("\\") &&
    !value.includes(":") &&
    !value.startsWith("/") &&
    !value.endsWith("/") &&
    !value.split("/").includes("..") &&
    posix.normalize(value) === value
  );
}

/** Validate all finite normalized lifecycle phases. Persistent owners refuse. */
export function selectNativeComposeBeforeHooks(
  plan: Readonly<Record<string, unknown>>
): readonly NativeComposeHook[] {
  return selectNativeComposeLifecycleHooks(plan).up.before;
}

export function selectNativeComposeAfterHooks(
  plan: Readonly<Record<string, unknown>>
): readonly NativeComposeHook[] {
  return selectNativeComposeLifecycleHooks(plan).up.after;
}

export function selectNativeComposeDownHooks(
  plan: Readonly<Record<string, unknown>>
): HookSequence {
  return selectNativeComposeLifecycleHooks(plan).down;
}

type HookSequence = {
  readonly before: readonly NativeComposeHook[];
  readonly after: readonly NativeComposeHook[];
};
function selectNativeComposeLifecycleHooks(
  plan: Readonly<Record<string, unknown>>
): { readonly up: HookSequence; readonly down: HookSequence } {
  if (plan.host === undefined) {
    return { up: { before: [], after: [] }, down: { before: [], after: [] } };
  }
  const host = plan.host;
  assert(isRecord(host) && only(host, ["up", "down", "processes"]));
  assert(
    host.processes === undefined ||
      (isRecord(host.processes) && Object.keys(host.processes).length === 0)
  );
  const result: Record<
    "up" | "down",
    { before: NativeComposeHook[]; after: NativeComposeHook[] }
  > = {
    up: { before: [], after: [] },
    down: { before: [], after: [] },
  };
  const names = new Set<string>();
  for (const phase of ["up", "down"] as const) {
    const hooks = host[phase];
    if (hooks === undefined) {
      continue;
    }
    assert(isRecord(hooks) && only(hooks, ["before", "after"]));
    for (const order of ["before", "after"] as const) {
      const entries = hooks[order];
      if (entries === undefined) {
        continue;
      }
      assert(Array.isArray(entries));
      for (const entry of entries) {
        const hook = readNativeHostInvocation(entry);
        assert(!names.has(hook.name));
        names.add(hook.name);
        result[phase][order].push(hook);
      }
    }
  }
  return result;
}

export function readNativeHostInvocation(entry: unknown): NativeComposeHook {
  assert(
    isRecord(entry) &&
      only(entry, ["name", "command", "cwd", "environment", "env_target"])
  );
  assert(typeof entry.name === "string" && NAME.test(entry.name));
  assert(
    command(entry.command) && (entry.cwd === undefined || relative(entry.cwd))
  );
  const target = parseNativeHostTarget(entry.env_target);
  assert(target);
  assert(entry.environment === undefined || isRecord(entry.environment));
  return {
    name: entry.name,
    command: entry.command,
    env_target: target,
    ...(entry.cwd === undefined ? {} : { cwd: entry.cwd }),
    ...(entry.environment === undefined
      ? {}
      : { environment: entry.environment }),
  };
}
