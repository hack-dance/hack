import type { NativeProjectPsResult } from "../backends/native-project-observe.ts";
import { psServiceState } from "../ui/ps-output.ts";
import { HackCliError } from "./cli-result.ts";

/**
 * Waits for a native run that `hack up` returned at started (every container
 * started, the owner still waiting for every goal). Commands that need the
 * whole project ready (`exec`, one-off `run`) wait for the run. The wait prints
 * one line once, ends at the start budget, and gives up with the run's state
 * named. Ctrl-C ends the wait.
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
      // One deadline: an outcome observed after it is a timeout, not success.
      if (said && now() > deadline) {
        throw timedOut(result);
      }
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
  // The run first seen warming; another run in the window is never its success.
  let pinned: string | null | undefined;
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
      if (warmed && result.run !== pinned) {
        throw new HackCliError({
          code: "E_STARTUP_INCOMPLETE",
          message:
            "Native project run changed while waiting for it to become ready; nothing was run. See hack ps.",
        });
      }
      if (result.readiness === "warming") {
        pinned ??= result.run;
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
