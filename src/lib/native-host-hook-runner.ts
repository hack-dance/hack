import { posix } from "node:path";
import { isRecord } from "./guards.ts";
import {
  type NativeComposeHook,
  NativeComposeHostHookError,
  selectNativeComposeAfterHooks,
  selectNativeComposeBeforeHooks,
  selectNativeComposeDownHooks,
} from "./native-compose-host-contract.ts";
import { resolveNativeComposeEnvironment } from "./native-compose-renderer.ts";
import type { NativeEnvironmentPlan } from "./native-env-plan-protocol.ts";
import { type RunExitEvent, run } from "./shell.ts";

export const NATIVE_HOOK_PHASES = [
  "up.before",
  "up.after",
  "down.before",
  "down.after",
] as const;
export type NativeHookPhase = (typeof NATIVE_HOOK_PHASES)[number];
export type NativeFiniteHooks = Readonly<
  Record<NativeHookPhase, readonly NativeComposeHook[]>
>;
export type NativeHookResult = {
  readonly outcome: "complete" | "uncertain";
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly canceled: boolean;
};

/** Share the owning normalized grammar. Persistent processes are never discarded. */
export function selectNativeFiniteHooks(
  plan: Readonly<Record<string, unknown>>
): NativeFiniteHooks {
  const down = selectNativeComposeDownHooks(plan);
  return Object.freeze({
    "up.before": selectNativeComposeBeforeHooks(plan),
    "up.after": selectNativeComposeAfterHooks(plan),
    "down.before": down.before,
    "down.after": down.after,
  });
}

function refuse(): never {
  throw new NativeComposeHostHookError();
}
function environment(opts: {
  readonly hook: NativeComposeHook;
  readonly report: NativeEnvironmentPlan;
  readonly values?: Readonly<Record<string, string>>;
}): Record<string, string> {
  const { hook, report, values } = opts;
  const binding = report.host?.[hook.name];
  if (
    !report.complete ||
    report.diagnostics.length !== 0 ||
    !binding ||
    JSON.stringify(binding.env_target) !== JSON.stringify(hook.env_target)
  ) {
    return refuse();
  }
  return resolveNativeComposeEnvironment({
    bindings: binding.bindings,
    directives: hook.environment ?? {},
    values,
    scopeNames: [
      "global",
      "host",
      ...(hook.env_target?.kind === "workload" ? [hook.env_target.name] : []),
    ],
    // Native graph workload endpoints have no qualified host-facing delivery yet.
    endpointValue: refuse,
  });
}

/** Complete capability admission precedes credential acquisition and every hook. */
export function assertNativeFiniteHookBindings(opts: {
  readonly hooks: NativeFiniteHooks;
  readonly report: NativeEnvironmentPlan;
}): void {
  for (const phase of NATIVE_HOOK_PHASES) {
    for (const hook of opts.hooks[phase]) {
      environment({ hook, report: opts.report });
    }
  }
}

async function absent(group: number): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      process.kill(-group, 0);
    } catch (error) {
      if (isRecord(error) && error.code === "ESRCH") {
        return true;
      }
    }
    await Bun.sleep(50);
  }
  return false;
}

type PhaseOptions = Parameters<typeof prepareNativeFiniteHookPhase>[0];
async function executeHook(
  opts: PhaseOptions,
  hook: NativeComposeHook,
  env: Record<string, string>,
  timeoutMs: number | undefined
): Promise<NativeHookResult | undefined> {
  let group: number | undefined;
  let settled: RunExitEvent | undefined;
  let observationFailed = false;
  try {
    const exitCode = await run(
      "exec" in hook.command
        ? hook.command.exec
        : ["/bin/sh", "-c", hook.command.shell],
      {
        cwd: posix.join(opts.projectRoot, hook.cwd ?? "."),
        env,
        unsetEnvKeys: Object.entries(hook.environment ?? {})
          .filter(([, value]) => isRecord(value) && value.unset === true)
          .map(([name]) => name),
        stdin: "inherit",
        stdout: "stderr",
        forwardSignals: true,
        signal: opts.signal,
        timeoutMs,
        beforeSpawn: () => {
          opts.remaining();
          opts.beforeSpawn();
        },
        onSpawn: async (event) => {
          if (!event.ownsProcessGroup) {
            observationFailed = true;
            return;
          }
          group = event.processGroupId ?? event.pid;
          try {
            await opts.onSpawn(group);
          } catch {
            // Keep awaiting the existing child owner even when journal capture fails.
            observationFailed = true;
          }
        },
        onExit: (event) => {
          settled = event;
          return Promise.resolve();
        },
      }
    );
    if (
      observationFailed ||
      group === undefined ||
      !settled ||
      !(await absent(group))
    ) {
      return {
        outcome: "uncertain",
        exitCode: exitCode || 1,
        timedOut: settled?.timedOut ?? false,
        canceled: settled?.cancelled ?? opts.signal.aborted,
      };
    }
    if (exitCode !== 0 || settled.timedOut || settled.cancelled) {
      return {
        outcome: "complete",
        exitCode,
        timedOut: settled.timedOut,
        canceled: settled.cancelled,
      };
    }
  } catch {
    // A callback/observation failure cannot certify a child or clear intent.
    return {
      outcome: "uncertain",
      exitCode: 1,
      timedOut: false,
      canceled: opts.signal.aborted,
    };
  }
}

/** Values are captured before intent publication. The returned runner is single-use;
 * shell.run remains the only child/group owner, for pipes and controlling terminals.
 * No arbitrary hook duration ceiling is introduced: the enclosing lifecycle budget
 * supplies a monotonic deadline, including private preparation and last-spawn guards.
 */
export async function prepareNativeFiniteHookPhase(input: {
  readonly hooks: readonly NativeComposeHook[];
  readonly report: NativeEnvironmentPlan;
  readonly projectRoot: string;
  readonly signal: AbortSignal;
  readonly remaining: () => number | undefined;
  readonly assertFresh: () => Promise<void>;
  readonly resolveHostValues: (
    name: string
  ) => Promise<Readonly<Record<string, string>>>;
  readonly beforeSpawn: () => void;
  readonly onSpawn: (group: number) => Promise<void>;
  /** Only an admitted frontend owner supplies a qualified host endpoint policy. */
  readonly resolveEnvironment?: (opts: {
    readonly invocation: NativeComposeHook;
    readonly report: NativeEnvironmentPlan;
    readonly values: Readonly<Record<string, string>>;
  }) => Record<string, string>;
}): Promise<() => Promise<NativeHookResult>> {
  const opts = { ...input, hooks: structuredClone(input.hooks) };
  const prepared: {
    readonly hook: NativeComposeHook;
    readonly env: Record<string, string>;
  }[] = [];
  for (const hook of opts.hooks) {
    opts.remaining();
    const values = await opts.resolveHostValues(hook.name);
    await opts.assertFresh();
    opts.remaining();
    prepared.push({
      hook,
      env: opts.resolveEnvironment
        ? opts.resolveEnvironment({
            invocation: hook,
            report: opts.report,
            values,
          })
        : environment({ hook, report: opts.report, values }),
    });
  }
  let used = false;
  return async () => {
    if (used) {
      return refuse();
    }
    used = true;
    for (const { hook, env } of prepared) {
      await opts.assertFresh();
      const timeoutMs = opts.remaining();
      const result = await executeHook(opts, hook, env, timeoutMs);
      if (result) {
        return result;
      }
    }
    return {
      outcome: "complete",
      exitCode: 0,
      timedOut: false,
      canceled: false,
    };
  };
}
