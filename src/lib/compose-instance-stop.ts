import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { isRecord } from "./guards.ts";
import { exec } from "./shell.ts";

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
 * then stops what Compose still left behind in this checkout, and finally
 * reports what it observed rather than what it asked for. Anything it cannot
 * observe counts as still running.
 */

/**
 * Profiles a stop must enable: the ones the instance recorded at its full
 * up/restart runs, any `--profile` given now, and the ones the current
 * managed env selects. A union, so an env changed since `up` cannot hide a
 * started service; enabling a profile whose services never started is a
 * no-op for `down`.
 */
export function resolveInstanceStopProfiles(opts: {
  readonly recorded: readonly string[] | undefined;
  readonly cliProfiles: readonly string[];
  readonly currentProfiles: readonly string[];
}): string[] {
  return unionProfiles([
    ...(opts.recorded ?? []),
    ...opts.cliProfiles,
    ...opts.currentProfiles,
  ]);
}

/** Trimmed, non-empty profiles in first-seen order, without duplicates. */
export function unionProfiles(profiles: readonly string[]): string[] {
  const out: string[] = [];
  for (const profile of profiles) {
    const trimmed = profile.trim();
    if (trimmed.length > 0 && !out.includes(trimmed)) {
      out.push(trimmed);
    }
  }
  return out;
}

/** One container labelled with the instance's Compose project. */
export type InstanceContainer = {
  readonly id: string;
  readonly service: string;
  /** Docker state, lowercase (`running`, `exited`, …). */
  readonly state: string;
  /** `com.docker.compose.project.working_dir`, or null when unknown. */
  readonly workingDir: string | null;
};

/** The instance's containers, or why they could not be listed. */
export type InstanceContainerListing =
  | { readonly ok: true; readonly containers: readonly InstanceContainer[] }
  | { readonly ok: false; readonly reason: string };

const DOCKER_PS_FORMAT =
  '{"id":{{json .ID}},"state":{{json .State}},"service":{{json (.Label "com.docker.compose.service")}},"workingDir":{{json (.Label "com.docker.compose.project.working_dir")}}}';

type ExecRunner = (
  cmd: readonly string[],
  opts: { readonly stdin: "ignore"; readonly timeoutMs: number }
) => Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}>;

/**
 * Every container labelled `com.docker.compose.project=<composeProject>`, in
 * any state, with its service and working dir, from one bounded `docker ps`.
 * A failed, timed-out or unreadable listing is unknown, never empty.
 */
export async function listInstanceContainersByProject(opts: {
  readonly composeProject: string;
  readonly timeoutMs: number;
  /** Test seam; defaults to the shell runner. */
  readonly run?: ExecRunner;
}): Promise<InstanceContainerListing> {
  const run = opts.run ?? exec;
  let result: Awaited<ReturnType<ExecRunner>>;
  try {
    result = await run(
      [
        "docker",
        "ps",
        "--all",
        "--no-trunc",
        "--filter",
        `label=com.docker.compose.project=${opts.composeProject}`,
        "--format",
        DOCKER_PS_FORMAT,
      ],
      { stdin: "ignore", timeoutMs: opts.timeoutMs }
    );
  } catch (error: unknown) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "docker ps failed",
    };
  }
  if (result.exitCode !== 0) {
    return {
      ok: false,
      reason:
        result.exitCode === 124
          ? `docker ps timed out after ${opts.timeoutMs}ms`
          : `docker ps failed (exit ${result.exitCode})`,
    };
  }
  return parseInstanceContainers(result.stdout);
}

/** Parses the `docker ps` lines; any malformed line makes the listing unknown. */
export function parseInstanceContainers(
  stdout: string
): InstanceContainerListing {
  const containers: InstanceContainer[] = [];
  for (const line of stdout.split("\n")) {
    const text = line.trim();
    if (text.length === 0) {
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return { ok: false, reason: "docker ps printed an unreadable line" };
    }
    if (
      !isRecord(value) ||
      typeof value.id !== "string" ||
      typeof value.state !== "string"
    ) {
      return { ok: false, reason: "docker ps printed an unexpected entry" };
    }
    containers.push({
      id: value.id,
      state: value.state.toLowerCase(),
      service: typeof value.service === "string" ? value.service : "",
      workingDir:
        typeof value.workingDir === "string" && value.workingDir.length > 0
          ? value.workingDir
          : null,
    });
  }
  return { ok: true, containers };
}

function canonicalPath(path: string): string {
  const resolved = resolve(path);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

/**
 * Where a container belongs relative to this checkout: `owned` when its
 * Compose working dir is this checkout's project dir, `foreign` for another
 * directory (another checkout sharing the Compose project name), `unknown`
 * without a working dir label.
 */
export function containerOwnership(opts: {
  readonly container: InstanceContainer;
  readonly projectDir: string;
}): "owned" | "foreign" | "unknown" {
  if (opts.container.workingDir === null) {
    return "unknown";
  }
  return canonicalPath(opts.container.workingDir) ===
    canonicalPath(opts.projectDir)
    ? "owned"
    : "foreign";
}

/**
 * Containers this checkout may stop: only owned ones. A foreign or unlabelled
 * container is never stopped by this checkout's `down`.
 */
export function selectOwnedInstanceContainers(opts: {
  readonly containers: readonly InstanceContainer[];
  readonly projectDir: string;
}): InstanceContainer[] {
  return opts.containers.filter(
    (container) =>
      containerOwnership({ container, projectDir: opts.projectDir }) === "owned"
  );
}

/**
 * States in which nothing runs and nothing restarts on its own; the same set
 * `compose-down-confirmation` uses. Any other state, unknown ones included,
 * may still run.
 */
const NOT_RUNNING_STATES = new Set(["created", "exited", "dead"]);

/** The observed result of a down. */
export type DownObservation =
  | { readonly complete: true }
  | {
      readonly complete: false;
      /** Services of this checkout (or of unknown ownership) that may run. */
      readonly running: readonly string[];
      /** Containers of another checkout under the same project that may run. */
      readonly foreign: readonly {
        readonly service: string;
        readonly workingDir: string;
      }[];
      /** Set when the containers could not be listed at all. */
      readonly unknownReason?: string;
    };

/**
 * Complete only when nothing labelled with the instance's project may still
 * run. A container of another checkout is never stopped here, but it is not
 * hidden either: it makes the down incomplete and is named. An unknown
 * listing is incomplete, never "none left".
 */
export function classifyDownObservation(opts: {
  readonly listing: InstanceContainerListing;
  readonly projectDir: string;
}): DownObservation {
  if (!opts.listing.ok) {
    return {
      complete: false,
      running: [],
      foreign: [],
      unknownReason: opts.listing.reason,
    };
  }
  const mayRun = opts.listing.containers.filter(
    (container) => !NOT_RUNNING_STATES.has(container.state)
  );
  if (mayRun.length === 0) {
    return { complete: true };
  }
  const running = new Set<string>();
  const foreign: { service: string; workingDir: string }[] = [];
  for (const container of mayRun) {
    if (
      containerOwnership({ container, projectDir: opts.projectDir }) ===
        "foreign" &&
      container.workingDir !== null
    ) {
      foreign.push({
        service: container.service || container.id,
        workingDir: container.workingDir,
      });
    } else {
      running.add(container.service || container.id);
    }
  }
  return {
    complete: false,
    running: [...running].sort((a, b) => a.localeCompare(b)),
    foreign,
  };
}

/** Value-free message for an incomplete down. */
export function downIncompleteMessage(opts: {
  readonly observation: Extract<DownObservation, { complete: false }>;
}): string {
  const { observation } = opts;
  if (observation.unknownReason !== undefined) {
    return `Could not confirm that this instance stopped: ${observation.unknownReason}. Run \`hack ps --json\` to inspect, then \`hack down\` again.`;
  }
  const parts: string[] = [];
  if (observation.running.length > 0) {
    parts.push(
      `${observation.running.length === 1 ? "a container" : "containers"} of this instance still running (${observation.running.join(", ")}); run \`hack ps --json\` to inspect, then \`hack down\` again`
    );
  }
  if (observation.foreign.length > 0) {
    const dirs = [
      ...new Set(observation.foreign.map((entry) => entry.workingDir)),
    ];
    parts.push(
      `running containers of the same Compose project started from another checkout (${observation.foreign.map((entry) => entry.service).join(", ")}); run \`hack down\` from ${dirs.join(" or ")}`
    );
  }
  return `docker compose down left ${parts.join("; and ")}.`;
}
