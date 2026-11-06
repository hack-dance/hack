import { isRecord } from "../lib/guards.ts";
import {
  invokeNativeRuntime,
  type NativeRuntimeSelection,
} from "./native-runtime-client.ts";

const SERVICE = /^[A-Za-z0-9_.-]{1,128}$/;
const STOPPED = new Set(["exited", "dead", "absent"]);

/** A service container that stopped while the foreground graph was ready. */
export type NativeServiceExit =
  | {
      readonly service: string;
      readonly state: "exited";
      readonly code: number;
    }
  | { readonly service: string; readonly state: "dead" | "absent" };

type ServiceStates = ReadonlyMap<string, { state: string; code?: number }>;

/**
 * Parse a lock-free `graph observe` reply for exactly this run. Anything else
 * yields no observation; the monitor is advisory and never grants authority.
 */
function observed(value: unknown, run: string): ServiceStates | undefined {
  if (
    !(isRecord(value) && value.run === run && isRecord(value.services)) ||
    value.phase !== "ready-observed"
  ) {
    return;
  }
  const states = new Map<string, { state: string; code?: number }>();
  for (const [service, observation] of Object.entries(value.services)) {
    if (
      !(
        SERVICE.test(service) &&
        isRecord(observation) &&
        typeof observation.state === "string"
      )
    ) {
      return;
    }
    states.set(service, {
      state: observation.state,
      ...(Number.isSafeInteger(observation.code)
        ? { code: observation.code as number }
        : {}),
    });
  }
  return states;
}

function exitOf(
  service: string,
  current: { state: string; code?: number }
): NativeServiceExit | undefined {
  if (current.state === "exited" && current.code !== undefined) {
    return { service, state: "exited", code: current.code };
  }
  if (current.state === "dead" || current.state === "absent") {
    return { service, state: current.state };
  }
  return;
}

/**
 * Report service containers that stop while a foreground graph is ready, as
 * attached Compose `up` does ("SERVICE exited with code N"). Each stop is
 * reported once per running-to-stopped transition. When every service
 * container has stopped, `onAllStopped` runs once: Compose `up` then ends.
 *
 * Polls `graph observe`, which takes no provider lease, so `exec`, `logs`
 * and `ps` from another terminal never contend with it. Observation failures
 * are skipped; this monitor never stops, restarts or repairs anything itself.
 * Stop it by aborting `signal`; the returned promise settles after the last poll.
 */
export async function monitorNativeServiceExits(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly projectRoot: string;
  readonly run: string;
  readonly signal: AbortSignal;
  readonly intervalMs: number;
  readonly invoke?: typeof invokeNativeRuntime;
  readonly onExit: (exit: NativeServiceExit) => void;
  readonly onAllStopped: () => void;
}): Promise<void> {
  const invoke = opts.invoke ?? invokeNativeRuntime;
  const previous = new Map<string, string>();
  while (!opts.signal.aborted) {
    await waitOrAbort(opts.intervalMs, opts.signal);
    if (opts.signal.aborted) {
      return;
    }
    let states: ServiceStates | undefined;
    try {
      states = observed(
        await invoke({
          runtime: opts.runtime,
          cwd: opts.projectRoot,
          args: ["graph", "observe", "--run-id", opts.run, "--json"],
          timeoutMs: 15_000,
          signal: opts.signal,
        }),
        opts.run
      );
    } catch {
      states = undefined;
    }
    if (!states || opts.signal.aborted) {
      continue;
    }
    reportTransitions(states, previous, opts.onExit);
    if (
      states.size > 0 &&
      [...states.values()].every((current) => STOPPED.has(current.state))
    ) {
      opts.onAllStopped();
      return;
    }
  }
}

/** Report each running-to-stopped transition once; remember the new states. */
function reportTransitions(
  states: ServiceStates,
  previous: Map<string, string>,
  onExit: (exit: NativeServiceExit) => void
): void {
  for (const [service, current] of states) {
    const before = previous.get(service);
    previous.set(service, current.state);
    if (before === current.state || (before && STOPPED.has(before))) {
      continue;
    }
    const exit = exitOf(service, current);
    if (exit) {
      onExit(exit);
    }
  }
}

function waitOrAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}
