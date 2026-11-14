import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { userInfo } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { YAML } from "bun";
import { resolveNativeRuntimeSelection } from "../backends/native-runtime-client.ts";
import {
  GLOBAL_CADDY_COMPOSE_FILENAME,
  GLOBAL_CADDY_DIR_NAME,
  GLOBAL_CONFIG_FILENAME,
  GLOBAL_PROJECTS_REGISTRY_FILENAME,
  PROJECT_ENV_CONFIG_FILENAME_PREFIX,
  PROJECT_ENV_CONFIG_FILENAME_SUFFIX,
  PROJECT_ENV_CONTRACT_FILENAME,
  PROJECT_ENV_FILENAME,
} from "../constants.ts";
import { assertAutostartCheckoutTrusted } from "../lib/autostart-checkout-trust.ts";
import { assertAutostartDockerConfigTrusted } from "../lib/autostart-docker-trust.ts";
import { assertAutostartExecutablePathTrusted } from "../lib/autostart-executable-trust.ts";
import { isAutostartManualStartReason } from "../lib/autostart-refusal.ts";
import { autostartStartPolicyRefusal } from "../lib/autostart-start-policy.ts";
import { resolveComposeProjectName } from "../lib/compose-project-name.ts";
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
  setAutostartLoginWaitingForEngine,
} from "../lib/projects-registry.ts";
import { checkServiceExecutableTrusted } from "./systemd.ts";

export type AutostartResult = {
  readonly status: "started" | "skipped" | "failed" | "already_running";
  readonly reason: string | null;
  readonly at: string;
};

type StartResult = Omit<AutostartResult, "at">;
type AutostartStartupRefusal =
  | "native_unsupported"
  | "executable_path_untrusted"
  | "docker_config_untrusted"
  | null;

/** Side effects are explicit so ordering, bounds and restart recovery can be tested without an engine. */
export type AutostartDependencies = {
  readonly bootId: () => Promise<string | null>;
  readonly startupRefusal?: () =>
    | AutostartStartupRefusal
    | Promise<AutostartStartupRefusal>;
  readonly projectRefusal?: (
    project: RegisteredProject
  ) => Promise<string | null>;
  readonly now: () => number;
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly engineReady: (opts?: {
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
  }) => Promise<boolean>;
  readonly routingInstalled: () => Promise<boolean>;
  readonly startRouting: (signal?: AbortSignal) => Promise<boolean>;
  readonly inspect: (
    project: RegisteredProject,
    signal?: AbortSignal
  ) => Promise<"running" | "stopped" | "unknown" | "untrusted">;
  readonly start: (
    project: RegisteredProject,
    signal?: AbortSignal
  ) => Promise<StartResult>;
};

const MAC_BOOT_TIME_PATTERN = /sec = (\d+), usec = (\d+)/;

const ENGINE_WAIT_MS = 600_000;
const ENGINE_POLL_MAX_MS = 30_000;
const ENGINE_POLL_MS = 2000;
const START_STAGGER_MS = 500;
const MAX_CONCURRENT_STARTS = 2;

/** Values come from the owned service's validated paths, never the invoking shell. */
export type AutostartRuntimeOptions = {
  readonly home: string;
  readonly hackHome: string;
  readonly engineWaitMs?: number;
  readonly serviceOrigin?: boolean;
  readonly platform?: NodeJS.Platform;
};

export type AutostartLoginOutcome = { readonly waitingForEngine: boolean };

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
    readonly runtime?: AutostartRuntimeOptions;
    readonly engineWaitMs?: number;
  } = {}
): Promise<AutostartLoginOutcome> {
  const runtime = opts.runtime;
  const deps =
    opts.dependencies ??
    createAutostartProductionDependencies(requireAutostartRuntime(runtime));
  const registryPath =
    opts.registryPath ??
    (runtime
      ? resolve(runtime.hackHome, GLOBAL_PROJECTS_REGISTRY_FILENAME)
      : undefined);
  const options = { ...opts, registryPath };
  return await runAutostartLoginPass({ ...options, dependencies: deps });
}

async function runAutostartLoginPass(opts: {
  readonly signal?: AbortSignal;
  readonly registryPath?: string;
  readonly dependencies: AutostartDependencies;
  readonly runtime?: AutostartRuntimeOptions;
  readonly engineWaitMs?: number;
}): Promise<AutostartLoginOutcome> {
  const deps = opts.dependencies;
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
    return { waitingForEngine: false };
  }
  const startupRefusal = (await deps.startupRefusal?.()) ?? null;
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
    return { waitingForEngine: false };
  }
  const loginRun = await beginAutostartLoginRun({
    bootId,
    startedAt: new Date(deps.now()).toISOString(),
    pendingIds: pending.map((project) => project.id),
    registryPath: opts.registryPath,
    waitingForEngine: true,
  });
  if (!loginRun?.runId) {
    return { waitingForEngine: false };
  }
  let waitingForEngine = false;
  try {
    if (machineBootId === null || startupRefusal) {
      await recordUnclaimedAutostartRefusal({
        pending,
        runId: loginRun.runId,
        registryPath: opts.registryPath,
        deps,
        reason: startupRefusal ?? "boot_identity_unavailable",
        signal: opts.signal,
      });
      return { waitingForEngine: false };
    }
    const eligible: RegisteredProject[] = [];
    for (const project of pending) {
      const reason = await deps.projectRefusal?.(project);
      if (reason) {
        await recordUnclaimedAutostartRefusal({
          pending: [project],
          runId: loginRun.runId,
          registryPath: opts.registryPath,
          deps,
          reason,
          signal: opts.signal,
        });
      } else {
        eligible.push(project);
      }
    }
    if (eligible.length === 0) {
      return { waitingForEngine: false };
    }
    const refusal = await prepareAutostartRuntime({
      deps,
      machineBootId,
      signal: opts.signal,
      registryPath: opts.registryPath,
      engineWaitMs: opts.engineWaitMs ?? opts.runtime?.engineWaitMs,
      runId: loginRun.runId,
      startupRefusal,
    });
    if (refusal === "engine_timeout" && !opts.signal?.aborted) {
      waitingForEngine = true;
      return { waitingForEngine: true };
    }
    await setAutostartLoginWaitingForEngine({
      runId: loginRun.runId,
      waitingForEngine: false,
      registryPath: opts.registryPath,
    });
    await dispatchAutostartProjects({
      ...opts,
      pending: eligible,
      deps,
      bootId,
      runId: loginRun.runId,
      refusal,
    });
  } finally {
    await finishAutostartLoginRun({
      runId: loginRun.runId,
      registryPath: opts.registryPath,
      waitingForEngine,
    });
  }
  return { waitingForEngine: false };
}

/** Unknown boot identity cannot replace a real claim and authorize a later replay. */
async function recordUnclaimedAutostartRefusal(opts: {
  readonly pending: readonly RegisteredProject[];
  readonly runId: string;
  readonly registryPath?: string;
  readonly deps: AutostartDependencies;
  readonly reason: string;
  readonly signal?: AbortSignal;
}): Promise<void> {
  await setAutostartLoginWaitingForEngine({
    runId: opts.runId,
    waitingForEngine: false,
    registryPath: opts.registryPath,
  });
  for (const project of opts.pending) {
    const recorded =
      !opts.signal?.aborted &&
      (await recordProjectAutostartResult({
        id: project.id,
        bootId: project.autostart?.lastAttemptBootId ?? null,
        expectedBranch: project.autostart?.branch,
        onlyIfWanted: true,
        result: {
          status: "skipped",
          reason: opts.reason,
          at: new Date(opts.deps.now()).toISOString(),
        },
        registryPath: opts.registryPath,
      }));
    await recordAutostartLoginOutcome({
      runId: opts.runId,
      id: project.id,
      succeeded: false,
      cancelled: !recorded || isAutostartManualStartReason(opts.reason),
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
  readonly startupRefusal: AutostartStartupRefusal;
  readonly runId: string;
  readonly engineWaitMs?: number;
  readonly registryPath?: string;
  readonly signal?: AbortSignal;
}): Promise<string | null> {
  const refusal = opts.startupRefusal;
  if (refusal) {
    return refusal;
  }
  if (!opts.machineBootId) {
    return "boot_identity_unavailable";
  }
  const { deps, signal } = opts;
  const deadline = deps.now() + resolveAutostartEngineWaitMs(opts.engineWaitMs);
  let ready = false;
  let delay = ENGINE_POLL_MS;
  while (!signal?.aborted) {
    if (
      (await readAutostartGlobal({ registryPath: opts.registryPath })).paused
    ) {
      return "global_paused";
    }
    const remaining = deadline - deps.now();
    if (remaining <= 0) {
      break;
    }
    ready = await deps
      .engineReady({ timeoutMs: Math.min(2000, remaining), signal })
      .catch(() => false);
    if (ready || deps.now() >= deadline) {
      break;
    }
    await deps.sleep(Math.min(delay, deadline - deps.now()), signal);
    delay = Math.min(delay * 2, ENGINE_POLL_MAX_MS);
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
  await setAutostartLoginWaitingForEngine({
    runId: opts.runId,
    waitingForEngine: false,
    registryPath: opts.registryPath,
  });
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

type ClaimedAutostartOptions = {
  readonly project: RegisteredProject;
  readonly bootId: string;
  readonly runId: string;
  readonly refusal: string | null;
  readonly onDispatched: () => void;
  readonly deps: AutostartDependencies;
  readonly signal?: AbortSignal;
  readonly registryPath?: string;
};

async function startClaimedProject(
  opts: ClaimedAutostartOptions
): Promise<void> {
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
      result = await inspectAndDispatchAutostart({ ...opts, project: current });
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
    releaseUnstartedClaim:
      result.status === "skipped" &&
      isAutostartManualStartReason(result.reason),
    expectedBranch: opts.project.autostart?.branch,
    registryPath: opts.registryPath,
  });
  await recordAutostartLoginOutcome({
    runId: opts.runId,
    id: opts.project.id,
    succeeded:
      result.status === "started" || result.status === "already_running",
    cancelled:
      result.reason !== null &&
      (isAutostartManualStartReason(result.reason) ||
        [
          "paused",
          "global_paused",
          "daemon_stopped",
          "target_changed",
        ].includes(result.reason)),
    registryPath: opts.registryPath,
  });
}

async function inspectAndDispatchAutostart(
  opts: ClaimedAutostartOptions
): Promise<StartResult> {
  const refusal = await opts.deps.projectRefusal?.(opts.project);
  if (refusal) {
    return { status: "skipped", reason: refusal };
  }
  const state = await opts.deps.inspect(opts.project, opts.signal);
  if (state === "running") {
    return { status: "already_running", reason: null };
  }
  if (state === "untrusted") {
    return { status: "skipped", reason: "checkout_untrusted" };
  }
  if (state === "unknown") {
    return { status: "skipped", reason: "runtime_unknown" };
  }
  return await dispatchIfStillWanted(opts);
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
    code === "E_CANCELLED" &&
    isRecord(detail) &&
    typeof detail.reason === "string" &&
    ["paused", "global_paused", "target_changed"].includes(detail.reason)
  ) {
    return { status: "skipped", reason: detail.reason };
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
  if (
    code === "E_PERMISSION" &&
    isRecord(detail) &&
    (isAutostartManualStartReason(detail.reason) ||
      detail.reason === "checkout_untrusted" ||
      detail.reason === "executable_path_untrusted" ||
      detail.reason === "docker_config_untrusted")
  ) {
    return { status: "skipped", reason: detail.reason };
  }
  if (code === "E_PROJECT_NOT_FOUND") {
    return { status: "skipped", reason: "project_unavailable" };
  }
  const skipReasons = new Map([
    ["E_INTERACTIVE_REQUIRED", "interactive_required"],
    ["E_ENV_KEY_MISSING", "env_key_missing"],
  ]);
  const reason = typeof code === "string" ? skipReasons.get(code) : undefined;
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

/** The same installed Caddy Compose location used by global up/install. */
export async function autostartRoutingInstalled(
  hackHome: string
): Promise<boolean> {
  return await Bun.file(
    resolve(hackHome, GLOBAL_CADDY_DIR_NAME, GLOBAL_CADDY_COMPOSE_FILENAME)
  ).exists();
}

export function createAutostartProductionDependencies(
  runtime: AutostartRuntimeOptions,
  checks?: {
    readonly executablePath?: typeof assertAutostartExecutablePathTrusted;
  }
): AutostartDependencies {
  const env = autostartServiceEnvironment(runtime);
  const invocation = [
    process.execPath,
    ...(Bun.main.startsWith("/$bunfs/")
      ? []
      : [
          "--no-env-file",
          fileURLToPath(new URL("../../index.ts", import.meta.url)),
        ]),
  ];
  return {
    projectRefusal: (project) =>
      autostartStartPolicyRefusal({
        ...project,
        globalConfigPath: resolve(runtime.hackHome, GLOBAL_CONFIG_FILENAME),
      }),
    startupRefusal: async () => {
      try {
        await (checks?.executablePath ?? assertAutostartExecutablePathTrusted)({
          path: env.PATH ?? "",
        });
      } catch {
        return "executable_path_untrusted";
      }
      try {
        assertAutostartDockerConfigTrusted({ home: runtime.home });
      } catch {
        return "docker_config_untrusted";
      }
      return autostartRuntimeRefusal(env);
    },
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
    bootId: () => readMachineBootId(env),
    engineReady: async (probe) =>
      (
        await runAutostartSubprocess(
          ["docker", "info", "--format", "{{.ID}}"],
          {
            timeoutMs: probe?.timeoutMs ?? 2000,
            terminationGraceMs: 0,
            signal: probe?.signal,
            env,
          }
        )
      ).exitCode === 0,
    routingInstalled: () => autostartRoutingInstalled(runtime.hackHome),
    startRouting: async (signal) =>
      (
        await runAutostartSubprocess(
          [...invocation, "global", "up", "--no-interactive"],
          {
            timeoutMs: 60_000,
            signal,
            env,
            routing: true,
          }
        )
      ).exitCode === 0,
    inspect: (project, signal) => inspectComposeProject(project, signal, env),
    start: async (project, signal) => {
      const args = buildAutostartProjectInvocation({
        invocation,
        project,
        serviceOrigin: runtime.serviceOrigin,
        platform: runtime.platform,
      });
      return classifyAutostartExit(
        await runAutostartSubprocess(args, {
          timeoutMs: 120_000,
          signal,
          env,
          projectId: project.id,
        })
      );
    },
  };
}

/** Linux login-service children own a separate scope so hackd replacement leaves helpers alive. */
export function buildAutostartProjectInvocation(opts: {
  readonly invocation: readonly string[];
  readonly project: RegisteredProject;
  readonly serviceOrigin?: boolean;
  readonly platform?: NodeJS.Platform;
}): readonly string[] {
  const args = [
    ...opts.invocation,
    "up",
    "-d",
    "--no-interactive",
    "--json",
    "--path",
    opts.project.repoRoot,
  ];
  if (opts.project.autostart?.branch) {
    args.push(`--branch=${opts.project.autostart.branch}`);
  }
  if (opts.serviceOrigin && !opts.platform) {
    throw new Error(
      "A service-origin autostart requires its explicit platform."
    );
  }
  return opts.serviceOrigin && opts.platform === "linux"
    ? [
        "systemd-run",
        "--user",
        "--scope",
        "--quiet",
        `--unit=hack-autostart-${randomUUID()}`,
        ...args,
      ]
    : args;
}

async function inspectComposeProject(
  project: RegisteredProject,
  signal?: AbortSignal,
  env: Readonly<Record<string, string | undefined>> = {}
): Promise<"running" | "stopped" | "unknown" | "untrusted"> {
  try {
    assertAutostartCheckoutTrusted({
      repoRoot: project.repoRoot,
      projectDir: project.projectDir,
    });
  } catch {
    return "untrusted";
  }
  // An uncertain selected graph must run ordinary up rather than adopt a subset.
  if (
    project.autostart?.branch ||
    env.COMPOSE_FILE ||
    env.COMPOSE_PROFILES ||
    !(await canAdoptAutostartEnvironment({
      projectRoot: project.repoRoot,
      projectDir: project.projectDir,
    }))
  ) {
    return "stopped";
  }
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
    { timeoutMs: 5000, signal, env }
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
    { timeoutMs: 5000, signal, env }
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

/**
 * Managed global/project values can select a different Compose graph, including
 * values reachable only through secret references. Presence is enough to decline
 * adoption: observation never decrypts layers or asks a keychain for graph values.
 * Ordinary up remains the authority for resolving those sources and overlays.
 */
export async function canAdoptAutostartEnvironment(opts: {
  readonly projectRoot: string;
  readonly projectDir: string;
}): Promise<boolean> {
  try {
    for (const directory of new Set([opts.projectRoot, opts.projectDir])) {
      const entries = await readdir(directory);
      if (
        entries.some(
          (name) =>
            name === PROJECT_ENV_CONTRACT_FILENAME ||
            name === PROJECT_ENV_FILENAME ||
            name.startsWith(`${PROJECT_ENV_FILENAME}.`) ||
            (name.startsWith(PROJECT_ENV_CONFIG_FILENAME_PREFIX) &&
              name.endsWith(PROJECT_ENV_CONFIG_FILENAME_SUFFIX))
        )
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
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
  if (
    !isRecord(service) ||
    service.extends !== undefined ||
    service.scale !== undefined ||
    (isRecord(service.deploy) && service.deploy.replicas !== undefined)
  ) {
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

async function readMachineBootId(
  env: Readonly<Record<string, string | undefined>>
): Promise<string | null> {
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
    const sysctl = "/usr/sbin/sysctl";
    if (
      (await checkServiceExecutableTrusted({ path: sysctl, uid: 0 })) !== null
    ) {
      return null;
    }
    const result = await runAutostartSubprocess(
      [sysctl, "-n", "kern.boottime"],
      {
        timeoutMs: 2000,
        env,
      }
    );
    const match = result.stdout.match(MAC_BOOT_TIME_PATTERN);
    return result.exitCode === 0 && match ? `${match[1]}:${match[2]}` : null;
  }
  return null;
}

function requireAutostartRuntime(
  runtime: AutostartRuntimeOptions | undefined
): AutostartRuntimeOptions {
  if (!(runtime && isAbsolute(runtime.home) && isAbsolute(runtime.hackHome))) {
    throw new Error("Autostart requires explicit absolute service home paths.");
  }
  return runtime;
}

export function resolveAutostartEngineWaitMs(value?: number): number {
  const duration = value ?? ENGINE_WAIT_MS;
  if (!Number.isSafeInteger(duration) || duration < 1 || duration > 3_600_000) {
    throw new Error(
      "Autostart engine wait must be from 1 to 3600000 milliseconds."
    );
  }
  return duration;
}

/** No Docker, Compose, credential or application settings are inherited from a shell. */
export function autostartServiceEnvironment(
  runtime: AutostartRuntimeOptions
): Record<string, string> {
  requireAutostartRuntime(runtime);
  const user = userInfo();
  return {
    HOME: runtime.home,
    HACK_HOME: runtime.hackHome,
    USER: user.username,
    LOGNAME: user.username,
    TMPDIR: "/tmp",
    PATH: autostartServicePath({
      home: runtime.home,
      platform: runtime.platform ?? process.platform,
    }),
    ...(process.platform === "linux"
      ? { XDG_RUNTIME_DIR: `/run/user/${user.uid}` }
      : {}),
  };
}

/** Service lookup includes known per-user installs without accepting the caller's PATH. */
export function autostartServicePath(opts: {
  readonly home: string;
  readonly platform: NodeJS.Platform;
}): string {
  const system =
    opts.platform === "darwin"
      ? [
          "/usr/local/bin",
          "/opt/homebrew/bin",
          "/usr/bin",
          "/bin",
          "/usr/sbin",
          "/sbin",
        ]
      : ["/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  return [
    ...system,
    ...(opts.platform === "linux" ? [resolve(opts.home, ".local/bin")] : []),
    resolve(opts.home, ".bun/bin"),
    resolve(opts.home, ".hack/bin"),
    resolve(opts.home, ".docker/bin"),
  ].join(":");
}

/** Own process group, no TTY, no keychain, no recursive daemon startup, bounded output and lifetime. */
export async function runAutostartSubprocess(
  argv: readonly string[],
  opts: {
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly projectId?: string;
    /** Routing helpers must not load a working-directory Compose .env. */
    readonly routing?: boolean;
    readonly terminationGraceMs?: number;
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
      ...filterAutostartServiceEnvironment(opts.env ?? {}),
      HACK_NO_INTERACTIVE: "1",
      HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK: "1",
      HACK_DAEMON_AUTOSTART_DISABLE: "1",
      HACK_AUTOSTART_LOGIN: "1",
      ...(opts.projectId ? { HACK_AUTOSTART_PROJECT_ID: opts.projectId } : {}),
      ...(opts.routing ? { COMPOSE_ENV_FILES: "/dev/null" } : {}),
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    detached: true,
  });
  let reason: "output_limit" | "daemon_stopped" | "start_timeout" | undefined;
  let stopping: Promise<void> | undefined;
  const stop = (
    failure: "output_limit" | "daemon_stopped" | "start_timeout"
  ) => {
    reason ??= failure;
    stopping ??= terminateAutostartGroup({
      pid: proc.pid,
      // Inner runtime phases get two seconds to kill their separately owned
      // groups and unwind while the login CLI still holds the startup lock.
      graceMs: opts.terminationGraceMs ?? 5000,
    });
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
    await stopping;
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

const AUTOSTART_SERVICE_ENV_KEYS = new Set([
  "HOME",
  "HACK_HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "XDG_RUNTIME_DIR",
  "PATH",
]);

function filterAutostartServiceEnvironment(
  env: Readonly<Record<string, string | undefined>>
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of AUTOSTART_SERVICE_ENV_KEYS) {
    const value = env[key];
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

async function terminateAutostartGroup(opts: {
  readonly pid: number;
  readonly graceMs: number;
}): Promise<void> {
  const signal = (value: "SIGTERM" | "SIGKILL") => {
    try {
      process.kill(-opts.pid, value);
    } catch {
      /* The owned group is already absent. */
    }
  };
  signal("SIGTERM");
  const deadline =
    performance.now() + Math.max(0, Math.min(opts.graceMs, 5000));
  while (performance.now() < deadline) {
    try {
      process.kill(-opts.pid, 0);
    } catch {
      return;
    }
    await Bun.sleep(Math.min(50, Math.max(1, deadline - performance.now())));
  }
  signal("SIGKILL");
}
