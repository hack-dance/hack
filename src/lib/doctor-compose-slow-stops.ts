import { YAML } from "bun";
import {
  buildSlowStopHints,
  COMPOSE_DOWN_SIGKILL_EXIT_CODE,
  readProjectSlowStops,
  type SlowStopHint,
} from "./compose-down-slow-stop.ts";
import { resolveComposeProjectName } from "./compose-project-name.ts";
import { readTextFile } from "./fs.ts";
import { isRecord } from "./guards.ts";
import { findProjectContext, readProjectConfig } from "./project.ts";
import {
  type RuntimeProjectsResult,
  readRuntimeProjects,
} from "./runtime-projects.ts";

/** Doctor check id for Compose services killed with exit 137 during stop. */
export const COMPOSE_SLOW_STOPS_CHECK = "compose slow stops";

const EXITED_137_STATUS = /^Exited \(137\)(?:\s|$)/i;

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

type ComposeInitInventory = {
  readonly defined: ReadonlySet<string>;
  readonly withInit: ReadonlySet<string>;
};

async function readComposeInitInventory(
  composeFile: string
): Promise<ComposeInitInventory | null> {
  const text = await readTextFile(composeFile);
  if (!text) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = YAML.parse(text);
  } catch {
    return null;
  }
  if (!(isRecord(parsed) && isRecord(parsed.services))) {
    return null;
  }
  const defined = new Set<string>();
  const withInit = new Set<string>();
  for (const [serviceName, rawService] of Object.entries(parsed.services)) {
    defined.add(serviceName);
    if (isRecord(rawService) && rawService.init === true) {
      withInit.add(serviceName);
    }
  }
  return { defined, withInit };
}

function collectRuntimeExited137Services(opts: {
  readonly runtime: RuntimeProjectsResult;
  readonly baseComposeProject: string;
  readonly projectDir: string;
}): readonly string[] {
  if (!opts.runtime.ok) {
    return [];
  }
  const found = new Set<string>();
  for (const project of opts.runtime.runtime) {
    const matchesProject =
      project.project === opts.baseComposeProject ||
      project.project.startsWith(`${opts.baseComposeProject}--`) ||
      project.workingDir === opts.projectDir;
    if (!matchesProject) {
      continue;
    }
    for (const [serviceName, runtimeService] of project.services) {
      for (const container of runtimeService.containers) {
        const exited137 =
          container.observation?.exitCode === COMPOSE_DOWN_SIGKILL_EXIT_CODE ||
          EXITED_137_STATUS.test(container.status);
        if (exited137) {
          found.add(serviceName);
        }
      }
    }
  }
  return [...found];
}

/**
 * Doctor check surfacing Compose services that recently exited 137 (killed after the stop
 * grace period) during `hack down` or remain stopped with exit 137 in Docker. Services that
 * have since added `init: true` in Compose or been removed from the Compose file are cleared.
 */
export async function checkComposeSlowStops(opts: {
  readonly startDir: string;
  readonly dockerOk: boolean;
  readonly readRuntime?: () => Promise<RuntimeProjectsResult>;
}): Promise<ComposeSlowStopsCheckResult> {
  const ctx = await findProjectContext(opts.startDir);
  if (!ctx) {
    return {
      name: COMPOSE_SLOW_STOPS_CHECK,
      status: "ok",
      message: "Skipped (no project context found)",
    };
  }

  const candidateServices = new Set<string>();
  const recorded = await readProjectSlowStops({ projectDir: ctx.projectDir });
  for (const entry of recorded) {
    for (const service of entry.services) {
      candidateServices.add(service);
    }
  }

  if (opts.dockerOk) {
    try {
      const cfg = await readProjectConfig(ctx);
      const baseComposeProject = await resolveComposeProjectName({
        project: ctx,
        cfg,
      });
      const runtime = opts.readRuntime
        ? await opts.readRuntime()
        : await readRuntimeProjects({ includeGlobal: false });
      for (const service of collectRuntimeExited137Services({
        runtime,
        baseComposeProject,
        projectDir: ctx.projectDir,
      })) {
        candidateServices.add(service);
      }
    } catch {
      // Best-effort live inspection; persisted slow-stop findings still apply.
    }
  }

  if (candidateServices.size === 0) {
    return {
      name: COMPOSE_SLOW_STOPS_CHECK,
      status: "ok",
      message: "No services observed exiting 137 during recent Compose stops",
    };
  }

  const inventory = await readComposeInitInventory(ctx.composeFile);
  const activeServices = [...candidateServices]
    .filter((service) => {
      if (!inventory) {
        return true;
      }
      if (!inventory.defined.has(service)) {
        return false;
      }
      return !inventory.withInit.has(service);
    })
    .sort((a, b) => a.localeCompare(b));

  if (activeServices.length === 0) {
    return {
      name: COMPOSE_SLOW_STOPS_CHECK,
      status: "ok",
      message: "No services observed exiting 137 during recent Compose stops",
    };
  }

  const hints = buildSlowStopHints(activeServices);
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
