import { dirname, resolve } from "node:path";
import { dockerHelperEnvironment } from "./docker-helper-environment.ts";
import { ensureDir, pathExists, readTextFile, writeTextFile } from "./fs.ts";
import { getString, isRecord } from "./guards.ts";
import { parseJsonLines } from "./json-lines.ts";
import { type ExecOptions, type ExecResult, exec } from "./shell.ts";

/** Exit code Docker reports when a container is killed with SIGKILL after its stop grace period. */
export const COMPOSE_DOWN_SIGKILL_EXIT_CODE = 137 as const;

/**
 * Unset-timeout elapsed threshold (ms) before probing Docker events for exit-137 containers.
 * Clean stops finish well below 5 s and make zero extra Docker calls; stops waiting out Docker's
 * default 10 s grace period (or a 5 s+ service `stop_grace_period`) cross this threshold and run
 * one bounded `docker events` query.
 */
export const DEFAULT_SLOW_STOP_PROBE_THRESHOLD_MS = 5000;

/** Bound on the single slow-path `docker events` inspection call. */
export const SLOW_STOP_EVENTS_TIMEOUT_MS = 5000;

const SLOW_STOP_EVENTS_MAX_STDOUT_BYTES = 256 * 1024;
const SLOW_STOP_EVENTS_MAX_STDERR_BYTES = 16 * 1024;
const SLOW_STOP_WINDOW_SKEW_MS = 1000;
const SLOW_STOP_EVENT_FLOOR_SKEW_MS = 500;
const PROJECT_SLOW_STOPS_FILENAME = "slow-stops.json" as const;

export type SlowStopHint = {
  readonly service: string;
  readonly exitCode: typeof COMPOSE_DOWN_SIGKILL_EXIT_CODE;
  readonly hint: string;
};

export type ProjectSlowStopEntry = {
  readonly composeProject: string;
  readonly services: readonly string[];
  readonly observedAt: string;
};

type ProjectSlowStopsFile = {
  readonly entries: readonly ProjectSlowStopEntry[];
};

export type SlowStopObservation = {
  /** True when the slow-path `docker events` call ran (1 extra Docker call); false on the fast path (0 extra calls). */
  readonly probed: boolean;
  readonly services: readonly string[];
};

export type SlowStopExec = (
  cmd: readonly string[],
  opts?: ExecOptions
) => Promise<ExecResult>;

/**
 * Single-line explanation printed by `hack down` (and reused by `hack doctor`) when a Compose
 * service container exited 137 (killed after its stop grace period).
 */
export function formatSlowStopHint(service: string): string {
  return `Slow stop: service ${service} exited ${COMPOSE_DOWN_SIGKILL_EXIT_CODE} (killed after the stop grace period). Add init: true to the service in Compose or handle SIGTERM/SIGINT so it exits cleanly.`;
}

export function buildSlowStopHints(
  services: readonly string[]
): readonly SlowStopHint[] {
  return [...new Set(services)]
    .sort((a, b) => a.localeCompare(b))
    .map((service) => ({
      service,
      exitCode: COMPOSE_DOWN_SIGKILL_EXIT_CODE,
      hint: formatSlowStopHint(service),
    }));
}

/**
 * Elapsed duration (ms) that separates a fast `hack down` (0 extra Docker calls) from a slow stop
 * that warrants 1 bounded `docker events` check for exit-137 containers.
 *
 * Returns `null` when `timeoutSeconds === 0` because an explicit zero grace period requests
 * immediate SIGKILL rather than a grace-period timeout.
 */
export function slowStopProbeThresholdMs(
  timeoutSeconds?: number
): number | null {
  if (timeoutSeconds === 0) {
    return null;
  }
  if (timeoutSeconds !== undefined && timeoutSeconds > 0) {
    return Math.max(500, timeoutSeconds * 1000 - 250);
  }
  return DEFAULT_SLOW_STOP_PROBE_THRESHOLD_MS;
}

function extractExit137ServiceFromEvent(opts: {
  readonly row: Record<string, unknown>;
  readonly composeProject: string;
  readonly windowStartMs?: number;
}): string | null {
  const type = getString(opts.row, "Type");
  if (type !== undefined && type !== "container") {
    return null;
  }
  const action = getString(opts.row, "Action") ?? getString(opts.row, "status");
  if (action !== "die") {
    return null;
  }
  if (opts.windowStartMs !== undefined) {
    const eventMs = readDockerEventTimestampMs(opts.row);
    if (
      eventMs !== undefined &&
      eventMs < opts.windowStartMs - SLOW_STOP_EVENT_FLOOR_SKEW_MS
    ) {
      return null;
    }
  }
  const actor = isRecord(opts.row.Actor) ? opts.row.Actor : null;
  const attributes =
    actor && isRecord(actor.Attributes) ? actor.Attributes : null;
  if (!attributes) {
    return null;
  }
  if (
    getString(attributes, "com.docker.compose.project") !== opts.composeProject
  ) {
    return null;
  }
  const exitCode = attributes.exitCode;
  if (
    exitCode !== String(COMPOSE_DOWN_SIGKILL_EXIT_CODE) &&
    exitCode !== COMPOSE_DOWN_SIGKILL_EXIT_CODE
  ) {
    return null;
  }
  const service = getString(attributes, "com.docker.compose.service")?.trim();
  return service && service.length > 0 ? service : null;
}

/**
 * Extract sorted unique Compose service names whose containers died with exit code 137 from
 * `docker events --format '{{json .}}'` output.
 */
export function parseComposeDownExit137Services(opts: {
  readonly stdout: string;
  readonly composeProject: string;
  readonly windowStartMs?: number;
}): readonly string[] {
  const services = new Set<string>();
  for (const row of parseJsonLines(opts.stdout)) {
    const service = extractExit137ServiceFromEvent({
      row,
      composeProject: opts.composeProject,
      windowStartMs: opts.windowStartMs,
    });
    if (service) {
      services.add(service);
    }
  }
  return [...services].sort((a, b) => a.localeCompare(b));
}

function readDockerEventTimestampMs(
  row: Record<string, unknown>
): number | undefined {
  const timeNano = row.timeNano;
  if (typeof timeNano === "number" && Number.isFinite(timeNano)) {
    return timeNano / 1_000_000;
  }
  const timeSec = row.time;
  if (typeof timeSec === "number" && Number.isFinite(timeSec)) {
    return timeSec * 1000;
  }
  return undefined;
}

/**
 * Observe which Compose services exited 137 during a completed `docker compose down`.
 *
 * - Fast path (down elapsed below {@link slowStopProbeThresholdMs} or `--timeout 0`):
 *   0 extra Docker calls.
 * - Slow path: exactly 1 bounded `docker events` call (`--since`/`--until` capped to the down
 *   window so the command exits immediately without streaming).
 *
 * Best-effort: a Docker events failure or timeout never fails `hack down`.
 */
export async function observeComposeDownSlowStops(opts: {
  readonly composeProject: string;
  readonly downElapsedMs: number;
  readonly downStartedAtMs: number;
  readonly downEndedAtMs: number;
  readonly timeoutSeconds?: number;
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly execImpl?: SlowStopExec;
}): Promise<SlowStopObservation> {
  const thresholdMs = slowStopProbeThresholdMs(opts.timeoutSeconds);
  if (thresholdMs === null || opts.downElapsedMs < thresholdMs) {
    return { probed: false, services: [] };
  }

  const sinceMs = Math.max(0, opts.downStartedAtMs - SLOW_STOP_WINDOW_SKEW_MS);
  const untilMs = Math.max(opts.downEndedAtMs, opts.downStartedAtMs);
  const cmd = [
    "docker",
    "events",
    "--since",
    new Date(sinceMs).toISOString(),
    "--until",
    new Date(untilMs).toISOString(),
    "--filter",
    "type=container",
    "--filter",
    "event=die",
    "--filter",
    `label=com.docker.compose.project=${opts.composeProject}`,
    "--format",
    "{{json .}}",
  ] as const;

  const helperEnv = dockerHelperEnvironment(opts.env);
  const unsetEnvKeys = Object.keys(process.env).filter(
    (key) => !Object.hasOwn(helperEnv, key)
  );
  const runExec = opts.execImpl ?? exec;
  try {
    const res = await runExec(cmd, {
      cwd: opts.cwd,
      env: helperEnv,
      unsetEnvKeys,
      stdin: "ignore",
      timeoutMs: SLOW_STOP_EVENTS_TIMEOUT_MS,
      maxStdoutBytes: SLOW_STOP_EVENTS_MAX_STDOUT_BYTES,
      maxStderrBytes: SLOW_STOP_EVENTS_MAX_STDERR_BYTES,
    });
    if (res.exitCode !== 0) {
      return { probed: true, services: [] };
    }
    return {
      probed: true,
      services: parseComposeDownExit137Services({
        stdout: res.stdout,
        composeProject: opts.composeProject,
        windowStartMs: opts.downStartedAtMs,
      }),
    };
  } catch {
    return { probed: true, services: [] };
  }
}

export function resolveProjectSlowStopsPath(opts: {
  readonly projectDir: string;
}): string {
  return resolve(opts.projectDir, ".internal", PROJECT_SLOW_STOPS_FILENAME);
}

/**
 * Read value-free slow-stop records persisted under `.hack/.internal/slow-stops.json`
 * so `hack doctor` can surface exit-137 findings after `hack down` removed the containers.
 */
export async function readProjectSlowStops(opts: {
  readonly projectDir: string;
}): Promise<readonly ProjectSlowStopEntry[]> {
  const path = resolveProjectSlowStopsPath({ projectDir: opts.projectDir });
  if (!(await pathExists(path))) {
    return [];
  }
  const text = await readTextFile(path);
  if (!text) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!(isRecord(parsed) && Array.isArray(parsed.entries))) {
    return [];
  }
  const entries: ProjectSlowStopEntry[] = [];
  for (const raw of parsed.entries) {
    if (!isRecord(raw)) {
      continue;
    }
    const composeProject = getString(raw, "composeProject");
    const observedAt = getString(raw, "observedAt");
    const servicesRaw = raw.services;
    if (!(composeProject && observedAt && Array.isArray(servicesRaw))) {
      continue;
    }
    const services = [
      ...new Set(
        servicesRaw
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim())
          .filter((item) => item.length > 0)
      ),
    ].sort((a, b) => a.localeCompare(b));
    if (services.length === 0) {
      continue;
    }
    entries.push({ composeProject, services, observedAt });
  }
  return entries;
}

export async function recordProjectSlowStops(opts: {
  readonly projectDir: string;
  readonly composeProject: string;
  readonly services: readonly string[];
  readonly observedAt?: string;
}): Promise<void> {
  const uniqueServices = [
    ...new Set(
      opts.services
        .map((service) => service.trim())
        .filter((service) => service.length > 0)
    ),
  ].sort((a, b) => a.localeCompare(b));
  if (uniqueServices.length === 0) {
    await clearProjectSlowStops({
      projectDir: opts.projectDir,
      composeProject: opts.composeProject,
    });
    return;
  }
  const current = await readProjectSlowStops({ projectDir: opts.projectDir });
  const next: ProjectSlowStopsFile = {
    entries: [
      ...current.filter(
        (entry) => entry.composeProject !== opts.composeProject
      ),
      {
        composeProject: opts.composeProject,
        services: uniqueServices,
        observedAt: opts.observedAt ?? new Date().toISOString(),
      },
    ].sort((a, b) => a.composeProject.localeCompare(b.composeProject)),
  };
  await writeProjectSlowStopsFile({
    projectDir: opts.projectDir,
    state: next,
  });
}

export async function clearProjectSlowStops(opts: {
  readonly projectDir: string;
  readonly composeProject: string;
}): Promise<void> {
  const current = await readProjectSlowStops({ projectDir: opts.projectDir });
  const nextEntries = current.filter(
    (entry) => entry.composeProject !== opts.composeProject
  );
  if (nextEntries.length === current.length) {
    return;
  }
  await writeProjectSlowStopsFile({
    projectDir: opts.projectDir,
    state: { entries: nextEntries },
  });
}

async function writeProjectSlowStopsFile(opts: {
  readonly projectDir: string;
  readonly state: ProjectSlowStopsFile;
}): Promise<void> {
  const path = resolveProjectSlowStopsPath({ projectDir: opts.projectDir });
  await ensureDir(dirname(path));
  await writeTextFile(path, `${JSON.stringify(opts.state, null, 2)}\n`);
}
