import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { isRecord } from "./guards.ts";

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

const WORKING_DIR_LABEL = "com.docker.compose.project.working_dir";
const LABEL_START = /^[A-Za-z0-9_.\-/]+=/;

/**
 * Compose's `ps --format json` prints `Labels` as one comma-joined
 * `key=value` string. A value may itself contain a comma, so a piece that
 * does not start a new `key=` continues the previous value.
 */
export function parseComposeLabels(labels: string): Record<string, string> {
  const entries: string[] = [];
  for (const piece of labels.split(",")) {
    if (entries.length > 0 && !LABEL_START.test(piece)) {
      entries[entries.length - 1] += `,${piece}`;
    } else {
      entries.push(piece);
    }
  }
  const out: Record<string, string> = {};
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    if (separator > 0) {
      out[entry.slice(0, separator)] = entry.slice(separator + 1);
    }
  }
  return out;
}

/**
 * The containers in `docker compose ps --all --format json` output: one JSON
 * object per line, or one JSON array (older Compose). Compose lists every
 * container carrying the project label, profiled and orphaned ones included,
 * whatever the model enables. Any line that is not a container object makes
 * the listing unknown.
 */
/** The JSON values of `compose ps --format json`: lines, or one array. */
function decodeComposePsValues(
  stdout: string
):
  | { readonly ok: true; readonly values: readonly unknown[] }
  | { readonly ok: false; readonly reason: string } {
  const text = stdout.trim();
  if (text.length === 0) {
    return { ok: true, values: [] };
  }
  if (text.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(text);
      return Array.isArray(parsed)
        ? { ok: true, values: parsed }
        : {
            ok: false,
            reason: "docker compose ps printed an unexpected value",
          };
    } catch {
      return {
        ok: false,
        reason: "docker compose ps printed unreadable output",
      };
    }
  }
  const values: unknown[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    try {
      values.push(JSON.parse(line));
    } catch {
      return {
        ok: false,
        reason: "docker compose ps printed an unreadable line",
      };
    }
  }
  return { ok: true, values };
}

export function parseComposePsInstanceContainers(
  stdout: string
): InstanceContainerListing {
  const decoded = decodeComposePsValues(stdout);
  if (!decoded.ok) {
    return decoded;
  }
  const values = decoded.values;
  const containers: InstanceContainer[] = [];
  for (const value of values) {
    if (
      !isRecord(value) ||
      typeof value.ID !== "string" ||
      typeof value.State !== "string"
    ) {
      return {
        ok: false,
        reason: "docker compose ps printed an unexpected entry",
      };
    }
    const labels =
      typeof value.Labels === "string" ? parseComposeLabels(value.Labels) : {};
    const workingDir = labels[WORKING_DIR_LABEL];
    containers.push({
      id: value.ID,
      state: value.State.toLowerCase(),
      service: typeof value.Service === "string" ? value.Service : "",
      workingDir:
        typeof workingDir === "string" && workingDir.length > 0
          ? workingDir
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
