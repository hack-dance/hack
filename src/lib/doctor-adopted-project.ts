import { join } from "node:path";
import { HACK_PROJECT_DIR_PRIMARY } from "../constants.ts";
import { COMPOSE_BACKEND_CHECK } from "./doctor-compose-backend.ts";
import { selectLegacyComposeAdoptedRoot } from "./native-compose-adoption-command.ts";
import { inspectLegacyComposeAdoptionSelection } from "./native-compose-adoption-marker.ts";
import { assertLegacyProjectDiscovery } from "./project-input-selection.ts";

/**
 * An adopted (`hack config adopt`) Compose project as `hack doctor` sees it.
 *
 * Ownership: an active or pending adoption owns the project's authored Compose
 * inputs (they live in its saved generation), so ordinary project discovery
 * refuses the project. Doctor selects it explicitly, runs only the checks that
 * do not read those inputs (env key, tracked generated files, env values at
 * rest), and reports every other project check as not applicable. Doctor and
 * `--fix` never read, move or rewrite the adoption's inputs or state.
 */
export type DoctorAdoptedProject = {
  readonly projectRoot: string;
  readonly projectDir: string;
  readonly projectDirName: typeof HACK_PROJECT_DIR_PRIMARY;
  /** `pending`: an adoption operation is in progress or was interrupted. */
  readonly state: "active" | "pending";
};

/**
 * The adopted project that owns `startDir`, or null when discovery from there
 * reaches no active or pending adoption (or a nearer legacy project). The
 * adoption selector walks every ancestor that ordinary discovery walks, so a
 * deep start directory with no adoption above it is null here, not a throw
 * (HACK-1380). Unsafe adoption state throws the selector's closed, value-free
 * refusal (`E_CONFIG_INVALID`).
 */
export async function findDoctorAdoptedProject(opts: {
  readonly startDir: string;
}): Promise<DoctorAdoptedProject | null> {
  const projectRoot = await selectLegacyComposeAdoptedRoot({
    cwd: opts.startDir,
  });
  if (!projectRoot) {
    return null;
  }
  const state = await inspectLegacyComposeAdoptionSelection({ projectRoot });
  if (state !== "active" && state !== "pending") {
    // Rolled back since the selection: ordinary discovery owns it again.
    return null;
  }
  return {
    projectRoot,
    projectDir: join(projectRoot, HACK_PROJECT_DIR_PRIMARY),
    projectDirName: HACK_PROJECT_DIR_PRIMARY,
    state,
  };
}

/**
 * The adopted project doctor reports, or null after ordinary discovery's
 * native-input refusal passed. An adopted project's inputs belong to its
 * adoption, so that discovery would refuse it as native input; doctor selects
 * it first (HACK-1311). A start directory with no adoption above it, however
 * deep, gets ordinary discovery instead of a throw.
 */
export async function preflightDoctorProject(opts: {
  readonly startDir: string;
}): Promise<DoctorAdoptedProject | null> {
  const adopted = await findDoctorAdoptedProject(opts);
  if (!adopted) {
    await assertLegacyProjectDiscovery(opts);
  }
  return adopted;
}

/** Doctor's `project` check for an adopted project. Closed and value-free. */
export function adoptedProjectCheckResult(project: DoctorAdoptedProject): {
  readonly name: "project";
  readonly status: "ok" | "warn";
  readonly message: string;
} {
  if (project.state === "pending") {
    return {
      name: "project",
      status: "warn",
      message: `Adopted Compose project at ${project.projectDir} has a pending or interrupted adoption operation. Use explicit adoption recovery before other project commands; values omitted.`,
    };
  }
  return {
    name: "project",
    status: "ok",
    message: `Adopted Compose project at ${project.projectDir} ('hack config adopt'). Its Compose inputs belong to the adoption; adopted commands support retained-container start, restart, stop, ps, logs and exec.`,
  };
}

/**
 * Project checks that read authored Compose inputs, project config or env
 * config, or the project's own Compose instance. For an adopted project those
 * inputs belong to the adoption, so each is reported as skipped instead of
 * failing on ordinary discovery's refusal.
 */
export const ADOPTED_PROJECT_NOT_APPLICABLE_CHECKS = [
  "runtime hygiene",
  "lifecycle hygiene",
  "compose networks",
  COMPOSE_BACKEND_CHECK,
  "DEV_HOST",
  "env mode",
  "env materialization",
  "env overlay warnings",
  "worktree keys",
  "worktree instances",
  "hack gitignore",
  "caddy hosts",
] as const;

/**
 * Doctor's skip wording (`Skipped (<reason>)`), as for the other checks that
 * do not apply.
 */
export const ADOPTED_PROJECT_NOT_APPLICABLE_MESSAGE =
  "Skipped (adopted Compose project: its inputs belong to 'hack config adopt')";

/**
 * Skip results for {@link ADOPTED_PROJECT_NOT_APPLICABLE_CHECKS}.
 *
 * Status `ok`, deliberately. Doctor uses `warn` for a skip that points at
 * something to fix (no `.hack/` found, Docker unavailable) and `ok` for a
 * skip that is expected in a healthy setup (`Skipped (not a git checkout)`).
 * These checks do not apply to any adopted project by design, so `warn`
 * would put the same 12 warnings on every healthy adoption and bury real
 * ones. A problem the adoption owns surfaces in the `project` check
 * (`warn` for a pending adoption) or in the adopted commands.
 */
export function adoptedProjectNotApplicableResults(): readonly {
  readonly name: string;
  readonly status: "ok";
  readonly message: string;
}[] {
  return ADOPTED_PROJECT_NOT_APPLICABLE_CHECKS.map((name) => ({
    name,
    status: "ok",
    message: ADOPTED_PROJECT_NOT_APPLICABLE_MESSAGE,
  }));
}
