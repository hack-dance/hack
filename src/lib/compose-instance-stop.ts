import { realpathSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Rules for stopping a whole Compose instance (HACK-2340).
 *
 * `docker compose down` acts on the services of the active model only. A
 * service behind a profile that the down invocation does not enable is
 * neither in the model nor an orphan, so Compose leaves its container
 * running (and the network in use) while still exiting 0. `up` enables the
 * profiles from `--profile` or `COMPOSE_PROFILES` in the managed env; `down`
 * used to run without that env, so it silently missed them.
 *
 * `down` therefore enables every profile the instance may have started,
 * then stops what Compose still left behind, and finally reports what it
 * observed rather than what it asked for.
 */

/**
 * Profiles a stop must enable: the ones the instance recorded at its last
 * full up/restart, any `--profile` given now, and the ones the current
 * managed env selects. A union, so an env changed since `up` cannot hide a
 * started service; enabling a profile whose services never started is a
 * no-op for `down`.
 */
export function resolveInstanceStopProfiles(opts: {
  readonly recorded: readonly string[] | undefined;
  readonly cliProfiles: readonly string[];
  readonly currentProfiles: readonly string[];
}): string[] {
  const out: string[] = [];
  for (const profile of [
    ...(opts.recorded ?? []),
    ...opts.cliProfiles,
    ...opts.currentProfiles,
  ]) {
    const trimmed = profile.trim();
    if (trimmed.length > 0 && !out.includes(trimmed)) {
      out.push(trimmed);
    }
  }
  return out;
}

/** One container Compose still lists for the instance after a down. */
export type InstanceContainer = {
  readonly id: string;
  readonly service: string;
  /** Docker state, lowercase (`running`, `exited`, …). */
  readonly state: string;
  /** `com.docker.compose.project.working_dir`, or null when unknown. */
  readonly workingDir: string | null;
};

function canonicalPath(path: string): string {
  const resolved = resolve(path);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

/**
 * Containers this checkout owns: those whose Compose working directory is
 * its project dir. A container of another checkout that happens to share the
 * Compose project name is never stopped by this checkout's `down`.
 */
export function selectOwnedInstanceContainers(opts: {
  readonly containers: readonly InstanceContainer[];
  readonly projectDir: string;
}): InstanceContainer[] {
  const projectDir = canonicalPath(opts.projectDir);
  return opts.containers.filter(
    (container) =>
      container.workingDir !== null &&
      canonicalPath(container.workingDir) === projectDir
  );
}

const STILL_RUNNING_STATES = new Set(["running", "restarting", "paused"]);

/**
 * The observed result of a down: complete when no container of the instance
 * is still running (or restarting or paused). Otherwise the down failed,
 * whatever Compose's exit code said, and `running` names the services.
 */
export function classifyDownObservation(opts: {
  readonly remaining: readonly InstanceContainer[];
}):
  | { readonly complete: true }
  | {
      readonly complete: false;
      readonly running: readonly string[];
      readonly containerIds: readonly string[];
    } {
  const running = opts.remaining.filter((container) =>
    STILL_RUNNING_STATES.has(container.state)
  );
  if (running.length === 0) {
    return { complete: true };
  }
  return {
    complete: false,
    running: [...new Set(running.map((container) => container.service))].sort(
      (a, b) => a.localeCompare(b)
    ),
    containerIds: running.map((container) => container.id),
  };
}

/** Value-free message for an incomplete down. */
export function downIncompleteMessage(opts: {
  readonly running: readonly string[];
}): string {
  return `docker compose down left ${opts.running.length === 1 ? "a container" : "containers"} of this instance running (${opts.running.join(", ")}). Run \`hack ps --json\` to inspect, then \`hack down\` again.`;
}
