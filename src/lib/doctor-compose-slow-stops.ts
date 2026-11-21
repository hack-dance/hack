import {
  buildSlowStopHints,
  COMPOSE_DOWN_SIGKILL_EXIT_CODE,
  readComposeServiceStopMeta,
  readProjectSlowStops,
  type SlowStopHint,
} from "./compose-down-slow-stop.ts";
import { findProjectContext } from "./project.ts";

/** Doctor check id for Compose services killed with exit 137 during `hack down`. */
export const COMPOSE_SLOW_STOPS_CHECK = "compose slow stops";

export type ComposeSlowStopsReport = {
  readonly services: readonly string[];
  readonly exitCode: typeof COMPOSE_DOWN_SIGKILL_EXIT_CODE;
  readonly hints: readonly SlowStopHint[];
};

export type ComposeSlowStopsCheckResult = {
  readonly name: typeof COMPOSE_SLOW_STOPS_CHECK;
  readonly status: "ok" | "warn";
  readonly message: string;
  readonly composeSlowStops?: ComposeSlowStopsReport;
};

/**
 * Doctor check surfacing Compose services observed exiting 137 during recent `hack down`
 * windows (persisted under `.hack/.internal/slow-stops.json` with TTL expiry).
 *
 * Only reports services observed during `hack down` so `docker kill` or OOM kills are never
 * misattributed to the stop grace period, and keeps services with `init: true` visible when
 * they still exited 137 (using the same tailored hint as `hack down`).
 */
export async function checkComposeSlowStops(opts: {
  readonly startDir: string;
  readonly nowMs?: number;
}): Promise<ComposeSlowStopsCheckResult> {
  const ctx = await findProjectContext(opts.startDir);
  if (!ctx) {
    return {
      name: COMPOSE_SLOW_STOPS_CHECK,
      status: "ok",
      message: "Skipped (no project context found)",
    };
  }

  const recorded = await readProjectSlowStops({
    projectDir: ctx.projectDir,
    nowMs: opts.nowMs,
  });
  const candidateServices = new Set<string>();
  for (const entry of recorded) {
    for (const service of entry.services) {
      candidateServices.add(service);
    }
  }

  if (candidateServices.size === 0) {
    return {
      name: COMPOSE_SLOW_STOPS_CHECK,
      status: "ok",
      message: "No services observed exiting 137 during recent Compose stops",
    };
  }

  const meta = await readComposeServiceStopMeta(ctx.composeFile);
  const activeServices = [...candidateServices]
    .filter((service) => !meta || meta.defined.has(service))
    .sort((a, b) => a.localeCompare(b));

  if (activeServices.length === 0) {
    return {
      name: COMPOSE_SLOW_STOPS_CHECK,
      status: "ok",
      message: "No services observed exiting 137 during recent Compose stops",
    };
  }

  const hints = buildSlowStopHints(activeServices, {
    withInit: meta?.withInit,
  });
  return {
    name: COMPOSE_SLOW_STOPS_CHECK,
    status: "warn",
    message: hints.map((entry) => entry.hint).join(" "),
    composeSlowStops: {
      services: activeServices,
      exitCode: COMPOSE_DOWN_SIGKILL_EXIT_CODE,
      hints,
    },
  };
}
