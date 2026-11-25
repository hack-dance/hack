/**
 * Doctor wiring for the HACK-2323 dev performance checks and their opt-in
 * polling repair. The checks themselves live in
 * `src/lib/doctor-dev-performance.ts`; this module selects the project,
 * observes Docker when it is available, and renders the text detail.
 */

import { relative } from "node:path";
import { note } from "@clack/prompts";
import { HACK_PROJECT_DIR_PRIMARY } from "../constants.ts";
import {
  processArchitecture,
  readEngineArchitecture,
} from "../lib/container-architecture.ts";
import {
  DEV_PERFORMANCE_CHECKS,
  type DevPerformanceCheck,
  type DevPerformanceReport,
  hasDevPerformanceDetail,
  observeDevRuntime,
  runDevPerformanceChecks,
  SHARED_VOLUME_ARCH_CHECK,
} from "../lib/doctor-dev-performance.ts";
import {
  POLLING_FIX_ID,
  type PollingFixPlan,
  runPollingFixForFile,
} from "../lib/doctor-polling-fix.ts";
import { selectDoctorFixProject } from "../lib/doctor-safe-fix.ts";
import { withProcessDeadline } from "../lib/process-deadline.ts";
import { findProjectContext, readProjectConfig } from "../lib/project.ts";

export type { DevPerformanceReport } from "../lib/doctor-dev-performance.ts";

type CheckRunner<T> = (
  name: DevPerformanceCheck["name"],
  fn: () => Promise<DevPerformanceCheck>
) => Promise<T>;

/**
 * The dev performance rows for a legacy Compose project. One observation,
 * bounded once, feeds all rows; the shared-volume row needs Docker and is
 * omitted without it, like the other runtime-only project checks.
 */
export async function runDevPerformanceDoctorChecks<T>(opts: {
  readonly startDir: string;
  readonly dockerOk: boolean;
  readonly run: CheckRunner<T>;
}): Promise<T[]> {
  let checks: DevPerformanceCheck[] | null = null;
  let collected = false;
  // The first row carries the observation's duration. If the observation
  // throws, runCheck reports that row as an error and no other row is added.
  const first = await opts.run(DEV_PERFORMANCE_CHECKS[0], async () => {
    checks = await collect(opts);
    collected = true;
    return checks?.[0] ?? skipped(DEV_PERFORMANCE_CHECKS[0]);
  });
  const rows: T[] = [first];
  if (!collected) {
    return rows;
  }
  const observed: DevPerformanceCheck[] | null = checks;
  if (observed === null) {
    for (const name of DEV_PERFORMANCE_CHECKS.slice(1)) {
      if (name !== SHARED_VOLUME_ARCH_CHECK) {
        rows.push(await opts.run(name, async () => skipped(name)));
      }
    }
    return rows;
  }
  // The shared-volume row is present only when Docker was actually read.
  for (const check of (observed as DevPerformanceCheck[]).slice(1)) {
    rows.push(await opts.run(check.name, async () => check));
  }
  return rows;
}

function skipped(name: DevPerformanceCheck["name"]): DevPerformanceCheck {
  return {
    name,
    status: "warn",
    message: `Skipped (no ${HACK_PROJECT_DIR_PRIMARY}/ found)`,
  };
}

/**
 * One deadline for the whole Docker observation. Past it the rows still
 * report the Compose file's findings, as when Docker is unavailable.
 */
const RUNTIME_OBSERVATION_DEADLINE_MS = 15_000;

async function withDeadline<T>(
  work: () => Promise<T>,
  fallback: T
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      withProcessDeadline(Date.now() + RUNTIME_OBSERVATION_DEADLINE_MS, work),
      new Promise<T>((resolve) => {
        timer = setTimeout(
          () => resolve(fallback),
          RUNTIME_OBSERVATION_DEADLINE_MS
        );
      }),
    ]);
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

async function collect(opts: {
  readonly startDir: string;
  readonly dockerOk: boolean;
}): Promise<DevPerformanceCheck[] | null> {
  const ctx = await findProjectContext(opts.startDir);
  if (!ctx) {
    return null;
  }
  const [hostArch, containers] = opts.dockerOk
    ? await withDeadline(
        () =>
          Promise.all([
            readEngineArchitecture(),
            observeDevRuntime({
              projectRoot: ctx.projectRoot,
              projectDir: ctx.projectDir,
            }),
          ]),
        [null, null]
      )
    : [null, null];
  return await runDevPerformanceChecks({
    projectRoot: ctx.projectRoot,
    composeFile: ctx.composeFile,
    hostArch: hostArch ?? processArchitecture(),
    containers,
    ...localDirectoriesInputs(await readProjectConfig(ctx)),
  });
}

function localDirectoriesInputs(config: {
  readonly localDirectories?: readonly string[];
  readonly localDirectoriesError?: string;
}): {
  readonly localDirectories?: readonly string[];
  readonly localDirectoriesError?: string;
} {
  return {
    localDirectories: config.localDirectories,
    localDirectoriesError: config.localDirectoriesError,
  };
}

/** Text mode: each finding in full, after the summary (which shortens it). */
export function renderDevPerformanceNotes(
  results: readonly {
    readonly name: string;
    readonly status: string;
    readonly message: string;
    readonly devPerformance?: DevPerformanceReport;
  }[]
): void {
  const lines = results
    .filter(
      (result) =>
        (DEV_PERFORMANCE_CHECKS as readonly string[]).includes(result.name) &&
        hasDevPerformanceDetail({
          status: result.status === "ok" ? "ok" : "warn",
          message: result.message,
          devPerformance: result.devPerformance,
        })
    )
    .map((result) => `${result.name}: ${result.message}`);
  if (lines.length > 0) {
    note(lines.join("\n\n"), "dev performance");
  }
}

export type PollingFixOutcome = {
  readonly plan: PollingFixPlan;
  readonly applied: boolean;
  readonly changed: boolean;
  readonly confirmed: boolean;
  readonly check: {
    readonly name: typeof POLLING_FIX_ID;
    readonly status: "ok" | "error";
    readonly message: string;
  };
};

/**
 * `hack doctor --fix --only 'polling watchers' [--yes]`: the diff always,
 * the write only with `--yes`. Adopted projects are refused like the other
 * selected repair.
 */
export async function runPollingWatcherFix(opts: {
  readonly startDir: string;
  readonly apply: boolean;
}): Promise<PollingFixOutcome> {
  const project = await selectDoctorFixProject(opts.startDir);
  const displayPath =
    relative(project.projectRoot, project.composeFile) || project.composeFile;
  const { plan, changed, confirmed } = await runPollingFixForFile({
    composeFile: project.composeFile,
    displayPath,
    apply: opts.apply,
  });
  const count = plan.removed.length;
  const lines = `${count} generated polling line${count === 1 ? "" : "s"}`;
  let check: PollingFixOutcome["check"];
  if (count === 0) {
    check = {
      name: POLLING_FIX_ID,
      status: "ok",
      message: `No generated polling lines in ${displayPath}; other polling settings are project configuration and are reported only.`,
    };
  } else if (!opts.apply) {
    check = {
      name: POLLING_FIX_ID,
      status: "ok",
      message: `Preview: would remove ${lines} from ${displayPath}. Nothing written; add --yes to apply.`,
    };
  } else if (confirmed) {
    check = {
      name: POLLING_FIX_ID,
      status: "ok",
      message: `Removed ${lines} from ${displayPath}; recreate the services (hack restart) to stop polling.`,
    };
  } else {
    check = {
      name: POLLING_FIX_ID,
      status: "error",
      message: `Could not verify the removal in ${displayPath}.`,
    };
  }
  return { plan, applied: opts.apply, changed, confirmed, check };
}
