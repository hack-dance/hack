import type { NativeProjectPsResult } from "../backends/native-project-observe.ts";
import { psServiceState } from "../ui/ps-output.ts";
import { HackCliError } from "./cli-result.ts";

/**
 * Waits for a native run that `hack up` returned at started (every container
 * started, the owner still waiting for every goal). Commands that need the
 * whole project ready (`exec`, one-off `run`) wait for the run; `hack open`
 * waits for its own service. Each prints one line once, ends at the start
 * budget, and gives up with the run's state named. Ctrl-C ends the wait.
 */

type PsItem = NativeProjectPsResult["items"][number];

/**
 * Started but its own goal not met yet: running with a health goal (healthcheck or
 * route probe) that has not passed, or a completion job still running.
 */
export function warmingItem(item: PsItem): boolean {
  if (item.state !== "running") {
    return false;
  }
  if (item.readiness === "completed") {
    return true;
  }
  return (
    item.readiness === "healthy" &&
    item.health !== "healthy" &&
    item.health !== "unhealthy"
  );
}

type WaitOptions = {
  readonly ps: () => Promise<NativeProjectPsResult>;
  readonly budgetMs: number;
  /** The one line, printed once (stderr for exec and run). */
  readonly onWaiting: (line: string) => void;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
};

async function poll<T>(
  opts: WaitOptions,
  step: (result: NativeProjectPsResult) => T | "wait",
  waiting: string,
  timedOut: (result: NativeProjectPsResult) => HackCliError
): Promise<T> {
  const now = opts.now ?? (() => performance.now());
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  const deadline = now() + opts.budgetMs;
  let said = false;
  for (;;) {
    const result = await opts.ps();
    const outcome = step(result);
    if (outcome !== "wait") {
      return outcome;
    }
    if (now() >= deadline) {
      throw timedOut(result);
    }
    if (!said) {
      opts.onWaiting(waiting);
      said = true;
    }
    await sleep(1000);
  }
}

/**
 * `exec` and one-off `run` on a warming run: wait until it is ready, so scripts
 * written for `up -d && hack exec ...` keep working. A run that was not warming
 * returns at once (the command then checks it as before). A start that fails
 * while this waits ends here with that outcome; nothing is run.
 */
export async function waitForNativeProjectReady(
  opts: WaitOptions
): Promise<void> {
  let warmed = false;
  await poll(
    {
      ...opts,
      // An unavailable observation decides nothing here: the command goes on
      // and its own checks (unchanged) refuse it as before.
      ps: async () => {
        try {
          return await opts.ps();
        } catch (error) {
          if (warmed) {
            throw error;
          }
          return { readiness: undefined } as unknown as NativeProjectPsResult;
        }
      },
    },
    (result) => {
      if (result.readiness === "warming") {
        warmed = true;
        return "wait";
      }
      if (warmed && result.readiness !== "ready") {
        throw new HackCliError({
          code: "E_STARTUP_INCOMPLETE",
          message: `Native project did not become ready (phase ${result.phase ?? "none"}); nothing was run. See hack ps and hack logs SERVICE.`,
        });
      }
      return undefined;
    },
    "waiting for the project to become ready…",
    (result) => {
      const warming = result.items.filter(warmingItem);
      const which = warming.length
        ? ` (${warming.map((item) => `${item.service}: ${psServiceState(item)}`).join(", ")})`
        : "";
      return new HackCliError({
        code: "E_STARTUP_INCOMPLETE",
        message: `Native project is not ready after ${Math.round(opts.budgetMs / 1000)} s${which}; nothing was run. See hack ps and hack logs SERVICE.`,
      });
    }
  );
}

/** Refuses for a run that `open` cannot wait on any more. */
function openRefused(message: string): HackCliError {
  return new HackCliError({
    code: "E_STARTUP_INCOMPLETE",
    message: `Native open refused: ${message} Nothing was opened.`,
  });
}

type OpenSeen = {
  what: string;
  selected: string | null | undefined;
  /** The run was warming when first observed: only then does `open` wait. */
  warming: boolean;
};

/** One observation for `open`: refuse, wait, or go on (`undefined`). */
function openStep(
  result: NativeProjectPsResult,
  target: string,
  seen: OpenSeen
): undefined | "wait" {
  if (seen.selected === undefined) {
    seen.selected = result.run;
    seen.warming = result.readiness === "warming";
    if (!seen.warming) {
      // Not warming (ready, stopped or not native-started): open as before.
      return undefined;
    }
  } else if (result.run !== seen.selected) {
    throw openRefused(`the run ${seen.what} belonged to was replaced.`);
  }
  if (result.readiness === undefined) {
    throw openRefused(
      `the project is not running (phase ${result.phase ?? "none"}).`
    );
  }
  const item = result.items.find((entry) => entry.service === target);
  if (!item) {
    seen.what = "the project";
    return result.readiness === "ready" ? undefined : "wait";
  }
  seen.what = item.service;
  if (
    item.state === "exited" ||
    item.state === "dead" ||
    item.health === "unhealthy"
  ) {
    throw openRefused(
      `${item.service} is ${psServiceState(item)}. See why with hack logs ${item.service}.`
    );
  }
  if (warmingItem(item)) {
    return "wait";
  }
  const published =
    result.readiness === "ready" ||
    (result.ports ?? []).some(
      (port) => port.service === item.service && port.state === "observed"
    );
  return published ? undefined : "wait";
}

/**
 * `hack open` on a run that may still be warming. It waits for the selected run
 * (the one it first observed) until the target service's own goal is met and its
 * port publication is verified, or, for a target that names no service, until the
 * run is ready; then until `probe` (one request to the route) answers. It refuses
 * at once when the target exited, died or became unhealthy, when the run was
 * replaced, or when the run ended. Bounded by the start budget; nothing is opened
 * on a refusal or timeout.
 */
export async function waitForNativeOpenTarget(
  opts: WaitOptions & {
    readonly target: string;
    /** One route request; true when it answered. */
    readonly probe?: () => Promise<boolean>;
  }
): Promise<void> {
  const seen: OpenSeen = {
    what: opts.target,
    selected: undefined,
    warming: false,
  };
  await poll(
    opts,
    (result) => openStep(result, opts.target, seen),
    `waiting for ${opts.target} to answer…`,
    (result) => {
      const item = result.items.find((entry) => entry.service === opts.target);
      const state = item ? ` (${psServiceState(item)})` : "";
      return new HackCliError({
        code: "E_STARTUP_INCOMPLETE",
        message: `Native open stopped waiting: ${seen.what} is not ready after ${Math.round(opts.budgetMs / 1000)} s${state}. Nothing was opened. See why with hack logs ${item ? item.service : "SERVICE"}.`,
      });
    }
  );
  if (!(opts.probe && seen.warming)) {
    return;
  }
  // The route itself must answer before anything is opened.
  const now = opts.now ?? (() => performance.now());
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  const deadline = now() + opts.budgetMs;
  while (!(await opts.probe().catch(() => false))) {
    if (now() >= deadline) {
      throw new HackCliError({
        code: "E_STARTUP_INCOMPLETE",
        message: `Native open stopped waiting: the route for ${seen.what} did not answer within ${Math.round(opts.budgetMs / 1000)} s. Nothing was opened.`,
      });
    }
    await sleep(1000);
  }
}
