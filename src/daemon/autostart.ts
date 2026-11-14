import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { YAML } from "bun";
import { resolveNativeRuntimeSelection } from "../backends/native-runtime-client.ts";
import {
  GLOBAL_CADDY_COMPOSE_FILENAME,
  GLOBAL_CADDY_DIR_NAME,
} from "../constants.ts";
import { childEnvironment } from "../lib/child-environment.ts";
import { resolveComposeProjectName } from "../lib/compose-project-name.ts";
import { resolveGlobalHackDir } from "../lib/config-paths.ts";
import { readTextFile } from "../lib/fs.ts";
import { isRecord } from "../lib/guards.ts";
import { findProjectContextAtRoot, readProjectConfig } from "../lib/project.ts";
import {
  beginAutostartLoginRun,
  claimProjectAutostart,
  finishAutostartLoginRun,
  type RegisteredProject,
  readAutostartGlobal,
  readProjectsRegistry,
  recordAutostartLoginOutcome,
  recordProjectAutostartResult,
} from "../lib/projects-registry.ts";

export type AutostartResult = {
  readonly status: "started" | "skipped" | "failed" | "already_running";
  readonly reason: string | null;
  readonly at: string;
};

type StartResult = Omit<AutostartResult, "at">;

/** Side effects are explicit so ordering, bounds and restart recovery can be tested without an engine. */
export type AutostartDependencies = {
  readonly bootId: () => Promise<string | null>;
  readonly startupRefusal?: () => "native_unsupported" | null;
  readonly now: () => number;
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly engineReady: () => Promise<boolean>;
  readonly routingInstalled: () => Promise<boolean>;
  readonly startRouting: (signal?: AbortSignal) => Promise<boolean>;
  readonly inspect: (
    project: RegisteredProject,
    signal?: AbortSignal
  ) => Promise<"running" | "stopped" | "unknown">;
  readonly start: (
    project: RegisteredProject,
    signal?: AbortSignal
  ) => Promise<StartResult>;
};

const MAC_BOOT_TIME_PATTERN = /sec = (\d+), usec = (\d+)/;

const ENGINE_WAIT_MS = 60_000;
const ENGINE_POLL_MS = 2000;
const START_STAGGER_MS = 500;
const MAX_CONCURRENT_STARTS = 2;

/**
 * One replay per OS boot, with a durable claim before each launch. An interrupted
 * claim is deliberately not retried in this first slice: unknown launch outcome
 * is not proof of absence. Explicit `hack up` remains the recovery path.
 */
export async function runAutostartAtLogin(
  opts: {
    readonly signal?: AbortSignal;
    readonly registryPath?: string;
    readonly dependencies?: AutostartDependencies;
  } = {}
): Promise<void> {
  const deps = opts.dependencies ?? productionDependencies();
  const prior = await readAutostartGlobal({ registryPath: opts.registryPath });
  if (prior.loginRun.inProgress && prior.loginRun.runId) {
    await finishAutostartLoginRun({
      runId: prior.loginRun.runId,
      registryPath: opts.registryPath,
    });
  }
  const registry = await readProjectsRegistry({
    registryPath: opts.registryPath,
    requireAutostartTrust: true,
  });
  if (registry.autostartGlobal?.paused) {
    return;
  }
  const machineBootId = await deps.bootId().catch(() => null);
  const bootId = machineBootId ?? "unavailable";
  const pending = registry.projects
    .filter(
      (project) =>
        project.autostart &&
        !project.autostart.paused &&
        !project.autostart.invalid &&
        project.autostart.lastAttemptBootId !== bootId
    )
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name, "en") || a.id.localeCompare(b.id, "en")
    );
  if (pending.length === 0 || opts.signal?.aborted) {
    return;
  }
  const loginRun = await beginAutostartLoginRun({
    bootId,
    startedAt: new Date(deps.now()).toISOString(),
    pendingIds: pending.map((project) => project.id),
    registryPath: opts.registryPath,
  });
  if (!loginRun?.runId) {
    return;
  }
  try {
    const refusal = await prepareAutostartRuntime({
      deps,
      machineBootId,
      signal: opts.signal,
      registryPath: opts.registryPath,
    });
    await dispatchAutostartProjects({
      ...opts,
      pending,
      deps,
      bootId,
      runId: loginRun.runId,
      refusal,
    });
  } finally {
    await finishAutostartLoginRun({
      runId: loginRun.runId,
      registryPath: opts.registryPath,
    });
  }
}

async function dispatchAutostartProjects(opts: {
  readonly pending: readonly RegisteredProject[];
  readonly deps: AutostartDependencies;
  readonly bootId: string;
  readonly runId: string;
  readonly refusal: string | null;
  readonly registryPath?: string;
  readonly signal?: AbortSignal;
}): Promise<void> {
  const { deps, bootId, pending } = opts;
  const active = new Set<Promise<void>>();
  const tasks: Promise<void>[] = [];
  let lastStartAt: number | null = null;
  try {
    for (const candidate of pending) {
      if (opts.signal?.aborted) {
        break;
      }
      while (active.size >= MAX_CONCURRENT_STARTS) {
        await Promise.race(active);
      }
      if (lastStartAt !== null) {
        const delay = START_STAGGER_MS - (deps.now() - lastStartAt);
        if (delay > 0) {
          await deps.sleep(delay, opts.signal);
        }
      }
      if (
        opts.signal?.aborted ||
        (await readAutostartGlobal({ registryPath: opts.registryPath })).paused
      ) {
        break;
      }
      const project = await claimProjectAutostart({
        id: candidate.id,
        bootId,
        registryPath: opts.registryPath,
      });
      if (!project) {
        continue;
      }
      let dispatched = () => {
        /* Replaced synchronously by the Promise executor. */
      };
      const dispatch = new Promise<void>((done) => {
        dispatched = done;
      });
      const task = startClaimedProject({
        ...opts,
        project,
        onDispatched: dispatched,
      });
      const tracked = task.then(
        () => {
          active.delete(tracked);
        },
        () => {
          active.delete(tracked);
        }
      );
      active.add(tracked);
      tasks.push(task);
      await dispatch;
      lastStartAt = deps.now();
    }
  } finally {
    await Promise.all(tasks);
  }
}

async function prepareAutostartRuntime(opts: {
  readonly deps: AutostartDependencies;
  readonly machineBootId: string | null;
  readonly registryPath?: string;
  readonly signal?: AbortSignal;
}): Promise<string | null> {
  const refusal = opts.deps.startupRefusal?.();
  if (refusal) {
    return refusal;
  }
  if (!opts.machineBootId) {
    return "boot_identity_unavailable";
  }
  const { deps, signal } = opts;
  const deadline = deps.now() + ENGINE_WAIT_MS;
  let ready = false;
  while (!signal?.aborted) {
    if (
      (await readAutostartGlobal({ registryPath: opts.registryPath })).paused
    ) {
      return "global_paused";
    }
    ready = await deps.engineReady().catch(() => false);
    if (ready || deps.now() >= deadline) {
      break;
    }
    await deps.sleep(Math.min(ENGINE_POLL_MS, deadline - deps.now()), signal);
  }
  if (!ready) {
    return "engine_timeout";
  }
  if (
    signal?.aborted ||
    (await readAutostartGlobal({ registryPath: opts.registryPath })).paused
  ) {
    return "global_paused";
  }
  if (await deps.routingInstalled()) {
    if (
      signal?.aborted ||
      (await readAutostartGlobal({ registryPath: opts.registryPath })).paused
    ) {
      return "global_paused";
    }
    if (!(await deps.startRouting(signal).catch(() => false))) {
      return "routing_failed";
    }
  }
  return null;
}

async function startClaimedProject(opts: {
  readonly project: RegisteredProject;
  readonly bootId: string;
  readonly runId: string;
  readonly refusal: string | null;
  readonly onDispatched: () => void;
  readonly deps: AutostartDependencies;
  readonly signal?: AbortSignal;
  readonly registryPath?: string;
}): Promise<void> {
  let result: StartResult = { status: "skipped", reason: opts.refusal };
  try {
    const registry = await readProjectsRegistry({
      registryPath: opts.registryPath,
      requireAutostartTrust: true,
    });
    const current = registry.projects.find(
      (project) => project.id === opts.project.id
    );
    if (
      !current?.autostart ||
      current.autostart.paused ||
      registry.autostartGlobal?.paused ||
      opts.signal?.aborted
    ) {
      result = {
        status: "skipped",
        reason: opts.signal?.aborted ? "daemon_stopped" : "paused",
      };
    } else if (!opts.refusal) {
      const state = await opts.deps.inspect(current, opts.signal);
      if (state === "running") {
        result = { status: "already_running", reason: null };
      } else if (state === "unknown") {
        result = { status: "skipped", reason: "runtime_unknown" };
      } else {
        result = await dispatchIfStillWanted({ ...opts, project: current });
      }
    }
  } catch {
    result = { status: "failed", reason: "start_failed" };
  } finally {
    opts.onDispatched();
  }
  await recordProjectAutostartResult({
    id: opts.project.id,
    bootId: opts.bootId,
    result: { ...result, at: new Date(opts.deps.now()).toISOString() },
    registryPath: opts.registryPath,
  });
  await recordAutostartLoginOutcome({
    runId: opts.runId,
    id: opts.project.id,
    succeeded:
      result.status === "started" || result.status === "already_running",
    cancelled:
      result.reason !== null &&
      ["paused", "global_paused", "daemon_stopped", "target_changed"].includes(
        result.reason
      ),
    registryPath: opts.registryPath,
  });
}

async function dispatchIfStillWanted(opts: {
  readonly project: RegisteredProject;
  readonly onDispatched: () => void;
  readonly deps: AutostartDependencies;
  readonly signal?: AbortSignal;
  readonly registryPath?: string;
}): Promise<StartResult> {
  const registry = await readProjectsRegistry({
    registryPath: opts.registryPath,
    requireAutostartTrust: true,
  });
  const latest = registry.projects.find(
    (project) => project.id === opts.project.id
  );
  if (registry.autostartGlobal?.paused) {
    return { status: "skipped", reason: "global_paused" };
  }
  if (!latest?.autostart || latest.autostart.paused || opts.signal?.aborted) {
    return {
      status: "skipped",
      reason: opts.signal?.aborted ? "daemon_stopped" : "paused",
    };
  }
  if (latest.autostart.branch !== opts.project.autostart?.branch) {
    return { status: "skipped", reason: "target_changed" };
  }
  const start = opts.deps.start(latest, opts.signal);
  opts.onDispatched();
  return await start;
}

/** Only closed reason codes cross into the registry; subprocess output is never retained. */
export function classifyAutostartExit(opts: {
  readonly exitCode: number;
  readonly stdout: string;
  readonly reason?: "output_limit" | "daemon_stopped" | "start_timeout";
}): StartResult {
  if (opts.reason) {
    return {
      status: opts.reason === "daemon_stopped" ? "skipped" : "failed",
      reason: opts.reason,
    };
  }
  if (opts.exitCode === 0) {
    return { status: "started", reason: null };
  }
  let code: unknown;
  let detail: unknown;
  try {
    const value: unknown = JSON.parse(opts.stdout);
    if (isRecord(value) && isRecord(value.error)) {
      code = value.error.code;
      detail = value.error.detail;
    }
  } catch {
    /* A malformed response is a failure, never a reason to retain output. */
  }
  if (
    code === "E_CONFIG_INVALID" &&
    isRecord(detail) &&
    (detail.reason === "pending_env_migration" ||
      detail.reason === "native_unsupported" ||
      detail.reason === "keychain_unavailable")
  ) {
    return { status: "skipped", reason: detail.reason };
  }
  if (code === "E_PROJECT_NOT_FOUND") {
    return { status: "skipped", reason: "project_unavailable" };
  }
  const skipReasons: Readonly<Record<string, string>> = {
    E_INTERACTIVE_REQUIRED: "interactive_required",
    E_ENV_KEY_MISSING: "env_key_missing",
  };
  const reason = typeof code === "string" ? skipReasons[code] : undefined;
  return reason
    ? { status: "skipped", reason }
    : {
        status: "failed",
        reason: opts.exitCode === 124 ? "start_timeout" : "start_failed",
      };
}

/** Native startup waits for separate runtime/login qualification; never probe Docker for it. */
export function autostartRuntimeRefusal(
  env: Readonly<Record<string, string | undefined>> = process.env
): "native_unsupported" | null {
  try {
    return resolveNativeRuntimeSelection(env) ? "native_unsupported" : null;
  } catch {
    return "native_unsupported";
  }
}

function productionDependencies(): AutostartDependencies {
  const invocation = [
    process.execPath,
    ...(Bun.main.startsWith("/$bunfs/")
      ? []
      : [fileURLToPath(new URL("../../index.ts", import.meta.url))]),
  ];
  return {
    startupRefusal: autostartRuntimeRefusal,
    now: Date.now,
    sleep: async (ms, signal) => {
      if (signal?.aborted) {
        return;
      }
      await new Promise<void>((done) => {
        const finish = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", finish);
          done();
        };
        const timer = setTimeout(finish, ms);
        signal?.addEventListener("abort", finish, { once: true });
      });
    },
    bootId: readMachineBootId,
    engineReady: async () =>
      (
        await runAutostartSubprocess(
          ["docker", "info", "--format", "{{.ID}}"],
          {
            timeoutMs: 2000,
          }
        )
      ).exitCode === 0,
    routingInstalled: async () =>
      Bun.file(
        resolve(
          resolveGlobalHackDir(),
          GLOBAL_CADDY_DIR_NAME,
          GLOBAL_CADDY_COMPOSE_FILENAME
        )
      ).exists(),
    startRouting: async (signal) =>
      (
        await runAutostartSubprocess(
          [...invocation, "global", "up", "--no-interactive"],
          {
            timeoutMs: 60_000,
            signal,
          }
        )
      ).exitCode === 0,
    inspect: inspectComposeProject,
    start: async (project, signal) => {
      const args = [
        ...invocation,
        "up",
        "-d",
        "--no-interactive",
        "--json",
        "--path",
        project.repoRoot,
      ];
      if (project.autostart?.branch) {
        args.push(`--branch=${project.autostart.branch}`);
      }
      return classifyAutostartExit(
        await runAutostartSubprocess(args, { timeoutMs: 120_000, signal })
      );
    },
  };
}

async function inspectComposeProject(
  project: RegisteredProject,
  signal?: AbortSignal
): Promise<"running" | "stopped" | "unknown"> {
  const context = await findProjectContextAtRoot({
    projectRoot: project.repoRoot,
    projectDirName: project.projectDirName,
  });
  if (!context) {
    return "unknown";
  }
  const cfg = await readProjectConfig(context);
  if (cfg.parseError) {
    return "unknown";
  }
  // An uncertain selected graph must run ordinary up rather than adopt a subset.
  if (
    project.autostart?.branch ||
    process.env.COMPOSE_FILE ||
    process.env.COMPOSE_PROFILES
  ) {
    return "stopped";
  }
  const model = await readAutostartComposeModel(context.composeFile);
  if (!model) {
    return "stopped";
  }
  const name = await resolveComposeProjectName({ project: context, cfg });
  const composeName = project.autostart?.branch
    ? `${name}--${project.autostart.branch}`
    : name;
  const result = await runAutostartSubprocess(
    [
      "docker",
      "ps",
      "-a",
      "--filter",
      `label=com.docker.compose.project=${composeName}`,
      "--filter",
      "label=com.docker.compose.oneoff=False",
      "--format",
      "{{.ID}}",
    ],
    { timeoutMs: 5000, signal }
  );
  if (result.exitCode !== 0) {
    return "unknown";
  }
  const ids = result.stdout.trim().split("\n").filter(Boolean);
  if (ids.length === 0) {
    return "stopped";
  }
  const inspected = await runAutostartSubprocess(
    [
      "docker",
      "inspect",
      "--format",
      '{{index .Config.Labels "com.docker.compose.service"}}|{{.State.Status}}|{{.State.ExitCode}}',
      ...ids,
    ],
    { timeoutMs: 5000, signal }
  );
  if (inspected.exitCode !== 0) {
    return "unknown";
  }
  return classifyAutostartContainers(
    inspected.stdout,
    model.completedServices,
    model.requiredServices
  );
}

/** Only declared successful-completion dependency targets may be adopted after exit. */
export function classifyAutostartContainers(
  text: string,
  completedServices: ReadonlySet<string> = new Set(),
  requiredServices: ReadonlySet<string> = new Set()
): "running" | "stopped" | "unknown" {
  const states = text.trim().split("\n").filter(Boolean);
  if (states.length === 0) {
    return "unknown";
  }
  let running = false;
  const observed = new Set<string>();
  for (const state of states) {
    const [service, status, exitCode, extra] = state.split("|");
    if (extra !== undefined || !service || !status || !exitCode) {
      return "unknown";
    }
    if (
      status !== "running" &&
      !(
        status === "exited" &&
        exitCode === "0" &&
        completedServices.has(service)
      )
    ) {
      return "stopped";
    }
    observed.add(service);
    running ||= status === "running";
  }
  if ([...requiredServices].some((service) => !observed.has(service))) {
    return "stopped";
  }
  return running ? "running" : "stopped";
}

type AutostartComposeModel = {
  readonly requiredServices: ReadonlySet<string>;
  readonly completedServices: ReadonlySet<string>;
};

async function readAutostartComposeModel(
  composeFile: string
): Promise<AutostartComposeModel | null> {
  const text = await readTextFile(composeFile);
  if (text === null) {
    return null;
  }
  try {
    return autostartComposeModel(YAML.parse(text));
  } catch {
    return null;
  }
}

/** Conservative default-profile model; unsupported composition is never adoption evidence. */
export function autostartComposeModel(
  compose: unknown
): AutostartComposeModel | null {
  if (
    !(isRecord(compose) && isRecord(compose.services)) ||
    compose.include !== undefined
  ) {
    return null;
  }
  const services = compose.services;
  const requiredServices = new Set<string>();
  for (const [name, service] of Object.entries(services)) {
    const defaultService = isDefaultAutostartService(service);
    if (defaultService === null) {
      return null;
    }
    if (defaultService) {
      requiredServices.add(name);
    }
  }
  for (const name of requiredServices) {
    const service = services[name];
    if (!isRecord(service)) {
      return null;
    }
    const dependencies = requiredComposeDependencies(service.depends_on);
    if (dependencies === null) {
      return null;
    }
    for (const target of dependencies) {
      if (!isRecord(services[target])) {
        return null;
      }
      requiredServices.add(target);
    }
  }
  return {
    requiredServices,
    completedServices: completedDependencyServices(compose),
  };
}

function isDefaultAutostartService(service: unknown): boolean | null {
  if (!isRecord(service) || service.extends !== undefined) {
    return null;
  }
  if (service.profiles === undefined) {
    return true;
  }
  if (
    !(
      Array.isArray(service.profiles) &&
      service.profiles.every(
        (profile) => typeof profile === "string" && !profile.includes("$")
      )
    )
  ) {
    return null;
  }
  return service.profiles.length === 0;
}

function requiredComposeDependencies(value: unknown): readonly string[] | null {
  if (value === undefined) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.every((item) => typeof item === "string") ? value : null;
  }
  if (!isRecord(value)) {
    return null;
  }
  return Object.entries(value)
    .filter(
      ([, dependency]) => !isRecord(dependency) || dependency.required !== false
    )
    .map(([name]) => name);
}

/** A zero exit or restart policy alone does not establish a one-shot service. */
export function completedDependencyServices(
  compose: unknown
): ReadonlySet<string> {
  const completed = new Set<string>();
  if (!(isRecord(compose) && isRecord(compose.services))) {
    return completed;
  }
  for (const service of Object.values(compose.services)) {
    if (!(isRecord(service) && isRecord(service.depends_on))) {
      continue;
    }
    for (const [target, dependency] of Object.entries(service.depends_on)) {
      if (
        isRecord(dependency) &&
        dependency.condition === "service_completed_successfully" &&
        isRecord(compose.services[target])
      ) {
        completed.add(target);
      }
    }
  }
  return completed;
}

async function readMachineBootId(): Promise<string | null> {
  if (process.platform === "linux") {
    try {
      return (
        (await Bun.file("/proc/sys/kernel/random/boot_id").text()).trim() ||
        null
      );
    } catch {
      return null;
    }
  }
  if (process.platform === "darwin") {
    const result = await runAutostartSubprocess(
      ["sysctl", "-n", "kern.boottime"],
      {
        timeoutMs: 2000,
      }
    );
    const match = result.stdout.match(MAC_BOOT_TIME_PATTERN);
    return result.exitCode === 0 && match ? `${match[1]}:${match[2]}` : null;
  }
  return null;
}

/** Own process group, no TTY, no keychain, no recursive daemon startup, bounded output and lifetime. */
export async function runAutostartSubprocess(
  argv: readonly string[],
  opts: {
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
    readonly env?: Readonly<Record<string, string | undefined>>;
  }
): Promise<{
  exitCode: number;
  stdout: string;
  reason?: "output_limit" | "daemon_stopped" | "start_timeout";
}> {
  if (opts.signal?.aborted) {
    return { exitCode: 124, stdout: "", reason: "daemon_stopped" };
  }
  const proc = Bun.spawn([...argv], {
    env: {
      ...childEnvironment(opts.env ?? process.env, {
        HACK_NO_INTERACTIVE: "1",
        HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK: "1",
        HACK_DAEMON_AUTOSTART_DISABLE: "1",
      }),
      HACK_AUTOSTART_LOGIN: "1",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    detached: true,
  });
  let reason: "output_limit" | "daemon_stopped" | "start_timeout" | undefined;
  const stop = (
    failure: "output_limit" | "daemon_stopped" | "start_timeout"
  ) => {
    reason ??= failure;
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      /* Own child may already have exited. */
    }
  };
  const timer = setTimeout(() => stop("start_timeout"), opts.timeoutMs);
  const abort = () => stop("daemon_stopped");
  opts.signal?.addEventListener("abort", abort, { once: true });
  let stdout = "";
  const decoder = new TextDecoder();
  const reader = proc.stdout.getReader();
  let outputBytes = 0;
  try {
    while (true) {
      const { value: chunk, done } = await reader.read();
      if (done) {
        break;
      }
      outputBytes += chunk.byteLength;
      if (outputBytes > 64 * 1024) {
        stop("output_limit");
        break;
      }
      stdout += decoder.decode(chunk, { stream: true });
    }
    const exitCode = await proc.exited;
    return {
      exitCode: reason ? 124 : exitCode,
      stdout: reason ? "" : stdout,
      ...(reason ? { reason } : {}),
    };
  } finally {
    reader.releaseLock();
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", abort);
  }
}
