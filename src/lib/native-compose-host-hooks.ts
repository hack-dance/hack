import { posix } from "node:path";
import type { EnvironmentBinding } from "../../packages/config-compiler/generated/native-config.ts";
import { isRecord } from "./guards.ts";
import {
  type NativeComposeHook,
  NativeComposeHostHookError,
} from "./native-compose-host-contract.ts";
import { resolveNativeComposeEnvironment } from "./native-compose-renderer.ts";
import type { NativeEnvironmentPlan } from "./native-env-plan-protocol.ts";
import { run } from "./shell.ts";

function assert(value: unknown): asserts value {
  if (!value) {
    throw new NativeComposeHostHookError();
  }
}

function externalEndpoint(
  binding: Extract<EnvironmentBinding, { kind: "endpoint" }>
): string {
  assert(
    binding.reference.kind === "host_binding" &&
      binding.target.kind === "external" &&
      binding.target.protocol !== "tcp"
  );
  return `${binding.target.protocol}://${binding.target.hostname}:${binding.target.port}`;
}

/** Preflight shares final binding checks before private values are requested. */
export function assertNativeComposeBeforeHookBindings(opts: {
  readonly hooks: readonly NativeComposeHook[];
  readonly environmentPlan: NativeEnvironmentPlan;
  readonly managedValues?: ReadonlyMap<
    string,
    Readonly<Record<string, string>>
  >;
}): void {
  for (const hook of opts.hooks) {
    const values = opts.managedValues?.get(hook.name);
    assert(opts.managedValues === undefined || values !== undefined);
    hookEnvironment({ ...opts, hook, values });
  }
}

function hookEnvironment(opts: {
  readonly hook: NativeComposeHook;
  readonly environmentPlan: NativeEnvironmentPlan;
  readonly values?: Readonly<Record<string, string>>;
}) {
  const { hook } = opts;
  const reports = opts.environmentPlan.host;
  assert(reports && Object.hasOwn(reports, hook.name));
  const report = reports[hook.name];
  const target = hook.env_target;
  assert(
    report &&
      target &&
      report.env_target.kind === target.kind &&
      (target.kind === "host" ||
        (report.env_target.kind === "workload" &&
          target.name === report.env_target.name))
  );
  return resolveNativeComposeEnvironment({
    bindings: report.bindings,
    directives: hook.environment ?? {},
    values: opts.values,
    scopeNames: [
      "global",
      "host",
      ...(target.kind === "workload" ? [target.name] : []),
    ],
    endpointValue: externalEndpoint,
  });
}

/** Missing/unknown groups are uncertain. Never kill a recorded numeric PID after its owner exits. */
async function groupAbsent(group: number): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      process.kill(-group, 0);
    } catch (error: unknown) {
      if (isRecord(error) && error.code === "ESRCH") {
        return true;
      }
    }
    await Bun.sleep(50);
  }
  return false;
}

/** Ordered, bounded, inherited-stdin execution; a surviving descendant retains durable uncertainty. */
export async function runNativeComposeBeforeHooks(opts: {
  readonly hooks: readonly NativeComposeHook[];
  readonly projectRoot: string;
  readonly environmentPlan: NativeEnvironmentPlan;
  readonly resolveHostValues: (
    name: string
  ) => Promise<Readonly<Record<string, string>>>;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly json: boolean;
}): Promise<{
  readonly outcome: "complete" | "uncertain";
  readonly value: number;
}> {
  const prepared: {
    readonly hook: NativeComposeHook;
    readonly env: Record<string, string>;
  }[] = [];
  for (const hook of opts.hooks) {
    const values = await opts.resolveHostValues(hook.name);
    prepared.push({ hook, env: hookEnvironment({ ...opts, hook, values }) });
  }
  const deadline = Date.now() + opts.timeoutMs;
  for (const { hook, env } of prepared) {
    if (opts.signal.aborted || Date.now() >= deadline) {
      return { outcome: "complete", value: opts.signal.aborted ? 130 : 124 };
    }
    const result = await runPreparedHook({ ...opts, hook, env, deadline });
    if (result.outcome !== "complete" || result.value !== 0) {
      return result;
    }
  }
  return { outcome: "complete", value: 0 };
}
async function runPreparedHook(opts: {
  readonly hook: NativeComposeHook;
  readonly env: Record<string, string>;
  readonly projectRoot: string;
  readonly deadline: number;
  readonly signal: AbortSignal;
  readonly json: boolean;
}): Promise<{
  readonly outcome: "complete" | "uncertain";
  readonly value: number;
}> {
  const { hook, env } = opts;
  let group: number | undefined;
  const code = await run(
    "exec" in hook.command
      ? hook.command.exec
      : ["/bin/sh", "-c", hook.command.shell],
    {
      cwd: posix.join(opts.projectRoot, hook.cwd ?? "."),
      env,
      unsetEnvKeys: Object.entries(hook.environment ?? {})
        .filter(([, value]) => isRecord(value) && value.unset === true)
        .map(([key]) => key),
      stdin: "inherit",
      stdout: opts.json ? "stderr" : "inherit",
      forwardSignals: true,
      timeoutMs: Math.max(1, opts.deadline - Date.now()),
      onSpawn: (event) => {
        assert(event.ownsProcessGroup);
        group = event.processGroupId ?? event.pid;
        return Promise.resolve();
      },
    }
  );
  if (group === undefined || !(await groupAbsent(group))) {
    return { outcome: "uncertain", value: code || 1 };
  }
  return {
    outcome: "complete",
    value: code || (opts.signal.aborted ? 130 : 0),
  };
}
