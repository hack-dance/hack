import { isRecord } from "./guards.ts";
import {
  type NativeComposeHook,
  NativeComposeHostHookError,
  readNativeHostInvocation,
} from "./native-compose-host-contract.ts";
import { resolveNativeComposeEnvironment } from "./native-compose-renderer.ts";
import type { NativeEndpointBinding } from "./native-endpoint-plan-protocol.ts";
import type { NativeEnvironmentPlan } from "./native-env-plan-protocol.ts";
import {
  NATIVE_HOOK_PHASES,
  type NativeFiniteHooks,
} from "./native-host-hook-runner.ts";

export type NativeHostProcess = NativeComposeHook & {
  readonly singleton?: {
    readonly ports: readonly number[];
    readonly onConflict: "fail" | "adopt";
  };
};
export type NativeHostLifecycle = {
  readonly hooks: NativeFiniteHooks;
  readonly processes: readonly NativeHostProcess[];
};
function assert(value: unknown): asserts value {
  if (!value) {
    throw new NativeComposeHostHookError();
  }
}
function only(
  value: Record<string, unknown>,
  names: readonly string[]
): boolean {
  return Object.keys(value).every((key) => names.includes(key));
}

function hooksFor(
  host: Record<string, unknown>,
  names: Set<string>
): NativeFiniteHooks {
  const hooks: Record<
    (typeof NATIVE_HOOK_PHASES)[number],
    NativeComposeHook[]
  > = {
    "up.before": [],
    "up.after": [],
    "down.before": [],
    "down.after": [],
  };
  for (const phase of ["up", "down"] as const) {
    const sequence = host[phase];
    if (sequence === undefined) {
      continue;
    }
    assert(isRecord(sequence) && only(sequence, ["before", "after"]));
    for (const order of ["before", "after"] as const) {
      const entries = sequence[order];
      if (entries === undefined) {
        continue;
      }
      assert(Array.isArray(entries));
      for (const entry of entries) {
        const hook = readNativeHostInvocation(entry);
        assert(!names.has(hook.name));
        names.add(hook.name);
        hooks[`${phase}.${order}`].push(hook);
      }
    }
  }
  return hooks;
}
function singletonFor(
  value: unknown
): NonNullable<NativeHostProcess["singleton"]> {
  assert(
    isRecord(value) &&
      only(value, ["ports", "on_conflict"]) &&
      Array.isArray(value.ports) &&
      value.ports.length > 0 &&
      value.ports.every(
        (port) => Number.isInteger(port) && port > 0 && port <= 65_535
      ) &&
      new Set(value.ports).size === value.ports.length
  );
  assert(
    value.on_conflict === undefined ||
      value.on_conflict === "fail" ||
      value.on_conflict === "adopt"
  );
  return { ports: [...value.ports], onConflict: value.on_conflict ?? "fail" };
}
function processFor(name: string, entry: unknown): NativeHostProcess {
  assert(
    isRecord(entry) &&
      only(entry, [
        "command",
        "cwd",
        "environment",
        "env_target",
        "startup",
        "exit",
        "singleton",
      ])
  );
  assert(
    (entry.startup === undefined || entry.startup === "up") &&
      (entry.exit === undefined || entry.exit === "stop_on_down")
  );
  const invocation = readNativeHostInvocation({
    name,
    command: entry.command,
    ...(entry.cwd === undefined ? {} : { cwd: entry.cwd }),
    ...(entry.environment === undefined
      ? {}
      : { environment: entry.environment }),
    env_target: entry.env_target,
  });
  return {
    ...invocation,
    ...(Object.hasOwn(entry, "singleton")
      ? { singleton: singletonFor(entry.singleton) }
      : {}),
  };
}
/** Validate every normalized host entry before values or effects. The compiler
 * still owns normalization; this reader neither edits nor lowers away host intent.
 */
export function selectNativeHostLifecycle(
  plan: Readonly<Record<string, unknown>>
): NativeHostLifecycle {
  const host = plan.host;
  assert(isRecord(host) && only(host, ["up", "down", "processes"]));
  const names = new Set<string>();
  const hooks = hooksFor(host, names);
  const processes: NativeHostProcess[] = [];
  if (host.processes !== undefined) {
    assert(isRecord(host.processes));
    for (const name of Object.keys(host.processes).sort()) {
      assert(!names.has(name));
      names.add(name);
      processes.push(processFor(name, host.processes[name]));
    }
  }
  return structuredClone({ hooks, processes });
}

/** Host loopback is chosen only for compiler-verified host-context references.
 * Guest, routed and typed TCP endpoints need their real delivery owners and refuse.
 */
export function nativeHostEndpointValue(
  binding: NativeEndpointBinding
): string {
  const { reference, target } = binding;
  assert(
    reference.kind === "host_binding" &&
      (target.kind === "host" || target.kind === "external") &&
      target.protocol !== "tcp"
  );
  if (target.kind === "host") {
    assert(target.context === "host");
    return `${target.protocol}://127.0.0.1:${target.port}`;
  }
  return `${target.protocol}://${target.hostname}:${target.port}`;
}

export function resolveNativeHostInvocationEnvironment(opts: {
  readonly invocation: NativeComposeHook;
  readonly report: NativeEnvironmentPlan;
  readonly values?: Readonly<Record<string, string>>;
}): Record<string, string> {
  const { invocation, report } = opts;
  const binding = report.host?.[invocation.name];
  assert(
    report.complete &&
      report.diagnostics.length === 0 &&
      binding &&
      JSON.stringify(binding.env_target) ===
        JSON.stringify(invocation.env_target)
  );
  return resolveNativeComposeEnvironment({
    bindings: binding.bindings,
    directives: invocation.environment ?? {},
    values: opts.values,
    scopeNames: [
      "global",
      "host",
      ...(invocation.env_target?.kind === "workload"
        ? [invocation.env_target.name]
        : []),
    ],
    endpointValue: nativeHostEndpointValue,
  });
}
export function assertNativeHostLifecycleBindings(
  lifecycle: NativeHostLifecycle,
  report: NativeEnvironmentPlan
): void {
  for (const invocation of [
    ...NATIVE_HOOK_PHASES.flatMap((phase) => lifecycle.hooks[phase]),
    ...lifecycle.processes,
  ]) {
    resolveNativeHostInvocationEnvironment({ invocation, report });
  }
}
