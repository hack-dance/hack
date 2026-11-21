import { dirname, resolve } from "node:path";
import { YAML } from "bun";
import { DEFAULT_DOCKER_STOP_TIMEOUT_SECONDS } from "./compose-down-budget.ts";
import { dockerHelperRunEnvironment } from "./docker-helper-environment.ts";
import {
  ensureDir,
  pathExists,
  readTextFile,
  writeTextFileAtomicIfChanged,
} from "./fs.ts";
import { getString, isRecord } from "./guards.ts";
import { parseJsonLines } from "./json-lines.ts";
import { type ExecOptions, type ExecResult, exec } from "./shell.ts";

/** Exit code Docker reports when a container is killed with SIGKILL after its stop grace period. */
export const COMPOSE_DOWN_SIGKILL_EXIT_CODE = 137 as const;

/** Bound (ms) on the single slow-path `docker events` inspection call. */
export const SLOW_STOP_EVENTS_TIMEOUT_MS = 5000;

/** Extra lookback slack (ms) added to `--since` for the daemon-relative `docker events` window. */
export const SLOW_STOP_WINDOW_SKEW_MS = 1000;

/** Maximum age (ms) for persisted `.hack/.internal/slow-stops.json` entries (7 days). */
export const SLOW_STOP_RECORD_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const SLOW_STOP_EVENTS_MAX_STDOUT_BYTES = 256 * 1024;
const SLOW_STOP_EVENTS_MAX_STDERR_BYTES = 16 * 1024;
const PROJECT_SLOW_STOPS_FILENAME = "slow-stops.json" as const;
const COMPOSE_DURATION_FULL = /^(?:(?:\d+(?:\.\d+)?)(?:ns|us|µs|ms|s|m|h))+$/;
const COMPOSE_DURATION_PART = /(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/g;

const DURATION_UNIT_MS: Readonly<Record<string, number>> = {
  ns: 1e-6,
  us: 1e-3,
  µs: 1e-3,
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
};

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

export type ComposeServiceStopMeta = {
  readonly defined: ReadonlySet<string>;
  readonly withInit: ReadonlySet<string>;
  /** Smallest positive effective stop grace period (ms) across defined services, or `null` if all are 0. */
  readonly minPositiveGraceMs: number | null;
};

export type SlowStopObservationStatus = "fast" | "skipped" | "ok" | "failed";

export type SlowStopObservation = {
  readonly status: SlowStopObservationStatus;
  readonly probed: boolean;
  readonly exited137: readonly string[];
  readonly exitedClean: readonly string[];
};

export type SlowStopExec = (
  cmd: readonly string[],
  opts?: ExecOptions
) => Promise<ExecResult>;

/** Parse a Compose `stop_grace_period` duration (`3s`, `1m30s`, `500ms`, or numeric seconds) to ms. */
export function parseComposeDurationMs(raw: unknown): number | undefined {
  if (typeof raw === "number") {
    return Number.isFinite(raw) && raw >= 0
      ? Math.round(raw * 1000)
      : undefined;
  }
  if (typeof raw !== "string") {
    return undefined;
  }
  const text = raw.trim();
  if (!COMPOSE_DURATION_FULL.test(text)) {
    return undefined;
  }
  let totalMs = 0;
  for (const match of text.matchAll(COMPOSE_DURATION_PART)) {
    const amount = Number(match[1]);
    const unitMs = DURATION_UNIT_MS[match[2] ?? ""];
    if (!(Number.isFinite(amount) && unitMs !== undefined)) {
      return undefined;
    }
    totalMs += amount * unitMs;
  }
  return Math.round(totalMs);
}

/** Read Compose service names, `init: true` flags, and smallest positive `stop_grace_period`. */
export async function readComposeServiceStopMeta(
  composeFile: string
): Promise<ComposeServiceStopMeta | null> {
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
  const defaultGraceMs = DEFAULT_DOCKER_STOP_TIMEOUT_SECONDS * 1000;
  let minPositiveGraceMs: number | null = null;

  for (const [serviceName, rawService] of Object.entries(parsed.services)) {
    defined.add(serviceName);
    const serviceObj = isRecord(rawService) ? rawService : null;
    if (serviceObj?.init === true) {
      withInit.add(serviceName);
    }
    const configuredGraceMs = serviceObj
      ? parseComposeDurationMs(serviceObj.stop_grace_period)
      : undefined;
    const effectiveGraceMs = configuredGraceMs ?? defaultGraceMs;
    if (
      effectiveGraceMs > 0 &&
      (minPositiveGraceMs === null || effectiveGraceMs < minPositiveGraceMs)
    ) {
      minPositiveGraceMs = effectiveGraceMs;
    }
  }
  return { defined, withInit, minPositiveGraceMs };
}

/**
 * Single-line explanation shared by `hack down` and `hack doctor` when a service exited 137.
 * Tailors advice when the service already sets `init: true` so both commands stay consistent.
 */
export function formatSlowStopHint(
  service: string,
  opts?: { readonly hasInit?: boolean }
): string {
  const action = opts?.hasInit
    ? "It already sets init: true, so handle SIGTERM/SIGINT in the process or set stop_signal/stop_grace_period."
    : "Add init: true to the service in Compose or handle SIGTERM/SIGINT so it exits cleanly.";
  return `Slow stop: service ${service} exited ${COMPOSE_DOWN_SIGKILL_EXIT_CODE} (killed after the stop grace period). ${action}`;
}

export function buildSlowStopHints(
  services: readonly string[],
  opts?: { readonly withInit?: ReadonlySet<string> }
): readonly SlowStopHint[] {
  return [...new Set(services)]
    .sort((a, b) => a.localeCompare(b))
    .map((service) => ({
      service,
      exitCode: COMPOSE_DOWN_SIGKILL_EXIT_CODE,
      hint: formatSlowStopHint(service, {
        hasInit: opts?.withInit?.has(service) === true,
      }),
    }));
}

/**
 * Elapsed threshold (ms) before probing `docker events` for exit-137 containers.
 *
 * Uses the effective stop grace period: `--timeout` / `compose.downTimeoutSeconds` when set,
 * otherwise the smallest positive `stop_grace_period` in Compose (defaulting to Docker's 10 s).
 * Returns `null` when `--timeout 0` (immediate SIGKILL) or every service sets `stop_grace_period: 0s`.
 */
export function slowStopProbeThresholdMs(opts?: {
  readonly timeoutSeconds?: number;
  readonly minServiceGraceMs?: number | null;
}): number | null {
  if (opts?.timeoutSeconds === 0) {
    return null;
  }
  if (opts?.timeoutSeconds !== undefined && opts.timeoutSeconds > 0) {
    return opts.timeoutSeconds * 1000;
  }
  if (opts?.minServiceGraceMs === null) {
    return null;
  }
  if (opts?.minServiceGraceMs !== undefined && opts.minServiceGraceMs > 0) {
    return opts.minServiceGraceMs;
  }
  return DEFAULT_DOCKER_STOP_TIMEOUT_SECONDS * 1000;
}

/**
 * Parse `docker events --filter type=container --filter event=die --format '{{json .}}'`
 * into services that died with exit code 137 vs services that exited with any other code.
 */
export function parseComposeDownDieEvents(opts: {
  readonly stdout: string;
  readonly composeProject: string;
}): {
  readonly exited137: readonly string[];
  readonly exitedClean: readonly string[];
} {
  const exited137 = new Set<string>();
  const exitedClean = new Set<string>();
  for (const row of parseJsonLines(opts.stdout)) {
    if (getString(row, "Type") !== "container") {
      continue;
    }
    if (getString(row, "Action") !== "die") {
      continue;
    }
    const actor = isRecord(row.Actor) ? row.Actor : null;
    const attributes =
      actor && isRecord(actor.Attributes) ? actor.Attributes : null;
    if (
      !attributes ||
      getString(attributes, "com.docker.compose.project") !==
        opts.composeProject
    ) {
      continue;
    }
    const service = getString(attributes, "com.docker.compose.service")?.trim();
    const exitCode = getString(attributes, "exitCode")?.trim();
    if (!(service && exitCode)) {
      continue;
    }
    if (exitCode === String(COMPOSE_DOWN_SIGKILL_EXIT_CODE)) {
      exited137.add(service);
      exitedClean.delete(service);
    } else if (!exited137.has(service)) {
      exitedClean.add(service);
    }
  }
  return {
    exited137: [...exited137].sort((a, b) => a.localeCompare(b)),
    exitedClean: [...exitedClean].sort((a, b) => a.localeCompare(b)),
  };
}

const SLOW_STOP_DAEMON_TIME_TIMEOUT_MS = 2000;

async function resolveDockerEventsWindow(opts: {
  readonly lookbackMs: number;
  readonly cwd: string;
  readonly helperEnv: ReturnType<typeof dockerHelperRunEnvironment>;
  readonly runExec: SlowStopExec;
}): Promise<{
  readonly since: string;
  readonly until: string;
}> {
  try {
    const info = await opts.runExec(
      ["docker", "info", "--format", "{{.SystemTime}}"],
      {
        cwd: opts.cwd,
        ...opts.helperEnv,
        stdin: "ignore",
        timeoutMs: SLOW_STOP_DAEMON_TIME_TIMEOUT_MS,
        maxStdoutBytes: 4096,
        maxStderrBytes: 4096,
      }
    );
    const daemonNowIso = info.exitCode === 0 ? info.stdout.trim() : "";
    const daemonNowMs = daemonNowIso ? Date.parse(daemonNowIso) : Number.NaN;
    if (Number.isFinite(daemonNowMs)) {
      const sinceMs = Math.max(
        0,
        daemonNowMs - opts.lookbackMs - SLOW_STOP_WINDOW_SKEW_MS
      );
      return {
        since: new Date(sinceMs).toISOString(),
        until: daemonNowIso,
      };
    }
  } catch {
    // Fall back to daemon-relative durations below.
  }
  const sinceSeconds = Math.max(
    1,
    Math.ceil((opts.lookbackMs + SLOW_STOP_WINDOW_SKEW_MS) / 1000)
  );
  // Docker truncates relative `--until` durations to whole seconds, so `0s` drops
  // events in the current second; `-1s` advances to the next whole-second boundary.
  return {
    since: `${sinceSeconds}s`,
    until: "-1s",
  };
}

/**
 * Observe container `die` events for a `docker compose down` window using a bounded
 * daemon-clock query (`docker info --format '{{.SystemTime}}'` + `docker events`).
 *
 * Sampling the daemon's own nanosecond `SystemTime` avoids host-vs-engine clock skew,
 * returns without blocking, and avoids Docker's whole-second truncation on `--until 0s`
 * (which otherwise drops `die` events in the final second). Falls back to `--since <N>s --until -1s`
 * if `docker info` is unavailable.
 * Note: Docker Engine keeps a bounded in-memory event ring (e.g. 256 events), so very long
 * or noisy teardowns can evict earlier `die` events before this post-down check runs.
 */
export async function observeComposeDownSlowStops(opts: {
  readonly composeProject: string;
  readonly downElapsedMs: number;
  readonly windowLookbackMs?: number;
  readonly timeoutSeconds?: number;
  readonly minServiceGraceMs?: number | null;
  readonly forceProbe?: boolean;
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly execImpl?: SlowStopExec;
}): Promise<SlowStopObservation> {
  if (!opts.forceProbe) {
    const thresholdMs = slowStopProbeThresholdMs({
      timeoutSeconds: opts.timeoutSeconds,
      minServiceGraceMs: opts.minServiceGraceMs,
    });
    if (thresholdMs === null) {
      return {
        status: "skipped",
        probed: false,
        exited137: [],
        exitedClean: [],
      };
    }
    if (opts.downElapsedMs < thresholdMs) {
      return { status: "fast", probed: false, exited137: [], exitedClean: [] };
    }
  }

  const runExec = opts.execImpl ?? exec;
  const helperEnv = dockerHelperRunEnvironment(opts.env);
  const probeStartedMs = performance.now();
  const lookbackMs = Math.max(
    opts.downElapsedMs,
    opts.windowLookbackMs ?? opts.downElapsedMs
  );
  const window = await resolveDockerEventsWindow({
    lookbackMs,
    cwd: opts.cwd,
    helperEnv,
    runExec,
  });
  const cmd = [
    "docker",
    "events",
    "--since",
    window.since,
    "--until",
    window.until,
    "--filter",
    "type=container",
    "--filter",
    "event=die",
    "--filter",
    `label=com.docker.compose.project=${opts.composeProject}`,
    "--format",
    "{{json .}}",
  ] as const;

  const elapsedProbeMs = Math.max(
    0,
    Math.round(performance.now() - probeStartedMs)
  );
  const eventsTimeoutMs = Math.max(
    1000,
    SLOW_STOP_EVENTS_TIMEOUT_MS - elapsedProbeMs
  );

  try {
    const res = await runExec(cmd, {
      cwd: opts.cwd,
      ...helperEnv,
      stdin: "ignore",
      timeoutMs: eventsTimeoutMs,
      maxStdoutBytes: SLOW_STOP_EVENTS_MAX_STDOUT_BYTES,
      maxStderrBytes: SLOW_STOP_EVENTS_MAX_STDERR_BYTES,
    });
    if (res.exitCode !== 0) {
      return {
        status: "failed",
        probed: true,
        exited137: [],
        exitedClean: [],
      };
    }
    const parsed = parseComposeDownDieEvents({
      stdout: res.stdout,
      composeProject: opts.composeProject,
    });
    return {
      status: "ok",
      probed: true,
      exited137: parsed.exited137,
      exitedClean: parsed.exitedClean,
    };
  } catch {
    return { status: "failed", probed: true, exited137: [], exitedClean: [] };
  }
}

export function resolveProjectSlowStopsPath(opts: {
  readonly projectDir: string;
}): string {
  return resolve(opts.projectDir, ".internal", PROJECT_SLOW_STOPS_FILENAME);
}

/**
 * Read unexpired slow-stop records persisted under `.hack/.internal/slow-stops.json`.
 * Entries older than {@link SLOW_STOP_RECORD_TTL_MS} or with malformed timestamps are dropped.
 */
export async function readProjectSlowStops(opts: {
  readonly projectDir: string;
  readonly nowMs?: number;
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
  const nowMs = opts.nowMs ?? Date.now();
  const entries: ProjectSlowStopEntry[] = [];
  for (const raw of parsed.entries) {
    if (!isRecord(raw)) {
      continue;
    }
    const composeProject = getString(raw, "composeProject");
    const observedAt = getString(raw, "observedAt");
    const observedAtMs = observedAt ? Date.parse(observedAt) : Number.NaN;
    const servicesRaw = raw.services;
    if (
      !(
        composeProject &&
        observedAt &&
        Number.isFinite(observedAtMs) &&
        nowMs - observedAtMs <= SLOW_STOP_RECORD_TTL_MS &&
        Array.isArray(servicesRaw)
      )
    ) {
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
    if (services.length > 0) {
      entries.push({ composeProject, services, observedAt });
    }
  }
  return entries;
}

export async function recordProjectSlowStops(opts: {
  readonly projectDir: string;
  readonly composeProject: string;
  readonly services: readonly string[];
  readonly observedAt?: string;
  readonly nowMs?: number;
}): Promise<void> {
  const uniqueServices = [
    ...new Set(
      opts.services
        .map((service) => service.trim())
        .filter((service) => service.length > 0)
    ),
  ].sort((a, b) => a.localeCompare(b));
  const current = await readProjectSlowStops({
    projectDir: opts.projectDir,
    nowMs: opts.nowMs,
  });
  const otherEntries = current.filter(
    (entry) => entry.composeProject !== opts.composeProject
  );
  if (uniqueServices.length === 0) {
    if (otherEntries.length === current.length) {
      return;
    }
    await writeProjectSlowStopsFile({
      projectDir: opts.projectDir,
      entries: otherEntries,
    });
    return;
  }
  const observedAt =
    opts.observedAt ?? new Date(opts.nowMs ?? Date.now()).toISOString();
  const nextEntries = [
    ...otherEntries,
    {
      composeProject: opts.composeProject,
      services: uniqueServices,
      observedAt,
    },
  ].sort((a, b) => a.composeProject.localeCompare(b.composeProject));
  await writeProjectSlowStopsFile({
    projectDir: opts.projectDir,
    entries: nextEntries,
  });
}

async function writeProjectSlowStopsFile(opts: {
  readonly projectDir: string;
  readonly entries: readonly ProjectSlowStopEntry[];
}): Promise<void> {
  const path = resolveProjectSlowStopsPath({ projectDir: opts.projectDir });
  await ensureDir(dirname(path));
  await writeTextFileAtomicIfChanged(
    path,
    `${JSON.stringify({ entries: opts.entries }, null, 2)}\n`,
    {
      createMode: 0o600,
      tightenExisting: true,
      noFollowTarget: true,
    }
  );
}

/**
 * Advisory post-down slow-stop observation and state persistence.
 *
 * Never throws and never changes `hack down`'s exit code or lifecycle hooks.
 * Only clears previously recorded services when a `docker events` probe succeeds and
 * confirms those services exited cleanly; failed probes, `--timeout 0`, or no-op downs
 * on already-stopped projects leave existing records intact.
 */
export async function finalizeComposeDownSlowStops(opts: {
  readonly projectDir: string;
  readonly composeFile: string;
  readonly composeProject: string;
  readonly downElapsedMs: number;
  readonly windowLookbackMs?: number;
  readonly timeoutSeconds?: number;
  readonly forceProbe?: boolean;
  readonly allowClear?: boolean;
  /** Known pre-down running services when available (e.g. `--json`); empty skips clearing probe. */
  readonly runningBeforeDown?: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly nowMs?: number;
  readonly execImpl?: SlowStopExec;
}): Promise<readonly SlowStopHint[]> {
  try {
    const [meta, existingEntries] = await Promise.all([
      readComposeServiceStopMeta(opts.composeFile).catch(() => null),
      readProjectSlowStops({
        projectDir: opts.projectDir,
        nowMs: opts.nowMs,
      }).catch(() => [] as readonly ProjectSlowStopEntry[]),
    ]);
    const existingForProject = existingEntries.find(
      (entry) => entry.composeProject === opts.composeProject
    );
    const allowClear = opts.allowClear !== false;
    const knownStoppedBeforeDown =
      opts.runningBeforeDown !== undefined &&
      opts.runningBeforeDown.length === 0;
    const shouldVerifyExistingRecord =
      Boolean(existingForProject) &&
      allowClear &&
      opts.timeoutSeconds !== 0 &&
      !knownStoppedBeforeDown;

    const observation = await observeComposeDownSlowStops({
      composeProject: opts.composeProject,
      downElapsedMs: opts.downElapsedMs,
      windowLookbackMs: opts.windowLookbackMs,
      timeoutSeconds: opts.timeoutSeconds,
      minServiceGraceMs: meta?.minPositiveGraceMs,
      forceProbe: opts.forceProbe || shouldVerifyExistingRecord,
      cwd: opts.cwd,
      env: opts.env,
      execImpl: opts.execImpl,
    });

    if (observation.status === "ok") {
      const nextServices = new Set(existingForProject?.services ?? []);
      if (allowClear) {
        for (const cleanService of observation.exitedClean) {
          nextServices.delete(cleanService);
        }
      }
      for (const slowService of observation.exited137) {
        nextServices.add(slowService);
      }
      const changed =
        observation.exited137.length > 0 ||
        (allowClear &&
          existingForProject !== undefined &&
          observation.exitedClean.length > 0);
      if (changed) {
        await recordProjectSlowStops({
          projectDir: opts.projectDir,
          composeProject: opts.composeProject,
          services: [...nextServices],
          nowMs: opts.nowMs,
        }).catch(() => undefined);
      }
    }

    return buildSlowStopHints(observation.exited137, {
      withInit: meta?.withInit,
    });
  } catch {
    return [];
  }
}
