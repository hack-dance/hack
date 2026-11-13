import { constants } from "node:fs";
import { type FileHandle, open, readdir, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";

import { inspectDoctorAgentIntegrations } from "../commands/doctor.ts";
import {
  PROJECT_COMPOSE_FILENAME,
  PROJECT_CONFIG_FILENAME,
  PROJECT_CONFIG_LEGACY_FILENAME,
  PROJECT_ENV_CONTRACT_FILENAME,
  PROJECT_ENV_FILENAME,
  PROJECT_ENV_STATE_FILENAME,
} from "../constants.ts";
import {
  gitIsLocalKeyIgnored,
  gitListTrackedKeyPaths,
  inspectProjectEnvKey,
  resolveEnvKeyCandidates,
} from "./doctor-env-key.ts";
import {
  inspectHackDirGitignoreForDoctor,
  inspectTrackedGeneratedFiles,
} from "./doctor-generated-files.ts";
import { withProcessDeadline } from "./process-deadline.ts";
import {
  ProjectEnvLayerPathConflictError,
  projectEnvConfigExistsForMutation,
} from "./project-env-config.ts";
import type { RegisteredProject } from "./projects-registry.ts";
import type { NativePreflightProbe } from "./upgrade-check-probes.ts";

/**
 * Per-checkout checks for `hack upgrade check` (HACK-2189): the checkout's
 * state in the registry, then, for a live checkout, its env format, env
 * key, tracked machine-local files, ignore rules, agent integrations and
 * (Apple Silicon) native preflight. Read-only; reports names, paths, counts
 * and codes, never a value.
 */

/**
 * - `blocker`: continuing would fail or lose data.
 * - `incomplete`: a check the upgrade's safety depends on could not be
 *   performed (it failed or ran out of time); readiness is not established.
 * - `warn`: a step to take; `info` and `ok` need nothing.
 */
export type UpgradeFindingStatus =
  | "ok"
  | "info"
  | "warn"
  | "incomplete"
  | "blocker";

export type UpgradeFinding = {
  /** Stable id, for example `env-format` or `secret-store`. */
  readonly id: string;
  readonly status: UpgradeFindingStatus;
  readonly summary: string;
  /**
   * The Hack CLI arguments of the command that fixes it (or diagnoses it),
   * run through the CLI that produced the report. Null when only a manual
   * action applies.
   */
  readonly args: readonly string[] | null;
  /** A manual action, when no command fixes it or as its alternative. Never run. */
  readonly action: string | null;
};

/** Checks the upgrade's safety depends on; a failure there is `incomplete`. */
const REQUIRED_CHECKS = new Set([
  "env-format",
  "env-key",
  "tracked-files",
  "ignore-rules",
]);

export type RegistryEntryState =
  | { readonly state: "live" }
  /** The checkout or its Hack config is gone: a dead entry to prune. */
  | { readonly state: "missing"; readonly reason: string }
  /** It exists but cannot be read: a live project to repair, not prune. */
  | { readonly state: "unreadable"; readonly reason: string };

/**
 * One registered checkout: a project's primary checkout or one of its
 * registered linked worktrees, each checked on its own.
 */
export type RegisteredCheckout = {
  /** The project name, with ` (worktree <dir>)` for a linked worktree. */
  readonly name: string;
  readonly repoRoot: string;
  readonly projectDir: string;
  readonly projectDirName: string;
};

/** A registered project's primary checkout and its registered worktrees. */
export function registeredCheckouts(
  project: RegisteredProject
): RegisteredCheckout[] {
  return [
    {
      name: project.name,
      repoRoot: project.repoRoot,
      projectDir: project.projectDir,
      projectDirName: project.projectDirName,
    },
    ...(project.worktrees ?? []).map((worktree) => ({
      name: `${project.name} (worktree ${basename(worktree.path)})`,
      repoRoot: worktree.path,
      projectDir: resolve(worktree.path, project.projectDirName),
      projectDirName: project.projectDirName,
    })),
  ];
}

/** Largest config file the classifier reads. */
const MAX_CONFIG_BYTES = 1024 * 1024;

/**
 * Classifies a registered checkout from its files only. Config files are
 * read only when they are regular files, through a non-blocking no-follow
 * open with a size bound, so a FIFO or link at a config path cannot stall
 * or redirect the check.
 */
export async function classifyRegistryEntry(
  project: RegisteredCheckout
): Promise<RegistryEntryState> {
  const root = await statState(project.repoRoot);
  if (root === "absent") {
    return { state: "missing", reason: "repo root is gone" };
  }
  if (root !== "directory") {
    return { state: "unreadable", reason: "repo root cannot be read" };
  }
  const dir = await statState(project.projectDir);
  if (dir === "absent") {
    return { state: "missing", reason: `${project.projectDirName}/ is gone` };
  }
  if (dir !== "directory") {
    return {
      state: "unreadable",
      reason: `${project.projectDirName}/ cannot be read`,
    };
  }
  const config = await readConfigText(
    resolve(project.projectDir, PROJECT_CONFIG_FILENAME)
  );
  if (config.kind === "unreadable") {
    return {
      state: "unreadable",
      reason: `${PROJECT_CONFIG_FILENAME} cannot be read (or is not a regular file)`,
    };
  }
  if (config.kind === "text") {
    try {
      JSON.parse(config.text);
    } catch {
      return {
        state: "unreadable",
        reason: `${PROJECT_CONFIG_FILENAME} is not valid JSON`,
      };
    }
    return { state: "live" };
  }
  // No JSON config: the legacy TOML config or a Compose file still makes it
  // a project (the same inputs project discovery and prune accept).
  for (const name of [
    PROJECT_CONFIG_LEGACY_FILENAME,
    PROJECT_COMPOSE_FILENAME,
  ]) {
    const other = await readConfigText(resolve(project.projectDir, name));
    if (other.kind === "unreadable") {
      return {
        state: "unreadable",
        reason: `${name} cannot be read (or is not a regular file)`,
      };
    }
    if (other.kind === "text") {
      return { state: "live" };
    }
  }
  return {
    state: "missing",
    reason: `its config (${PROJECT_CONFIG_FILENAME}, ${PROJECT_CONFIG_LEGACY_FILENAME} or ${PROJECT_COMPOSE_FILENAME}) is gone`,
  };
}

async function readConfigText(
  path: string
): Promise<
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "absent" | "unreadable" }
> {
  let handle: FileHandle | null = null;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_CONFIG_BYTES) {
      return { kind: "unreadable" };
    }
    return { kind: "text", text: await handle.readFile("utf8") };
  } catch (error: unknown) {
    const code = errorCode(error);
    return code === "ENOENT" || code === "ENOTDIR"
      ? { kind: "absent" }
      : { kind: "unreadable" };
  } finally {
    await handle?.close();
  }
}

/** Env formats a project's `.hack/` holds. */
export type EnvFormat = "layers" | "legacy-json" | "dotenv";

/**
 * Which env formats the project dir holds: YAML layers
 * (`hack.env.*.yaml`), the legacy JSON contract (`hack.env.json`) and
 * legacy dotenv files (`.env`, `.env.<overlay>`). Conflict when a layer
 * path is a link or not a file (the same rule `hack env set` uses).
 */
export async function detectEnvFormats(opts: {
  readonly projectDir: string;
}): Promise<
  | { readonly kind: "formats"; readonly formats: readonly EnvFormat[] }
  | { readonly kind: "conflict" }
> {
  const formats: EnvFormat[] = [];
  try {
    if (await projectEnvConfigExistsForMutation(opts)) {
      formats.push("layers");
    }
  } catch (error: unknown) {
    if (error instanceof ProjectEnvLayerPathConflictError) {
      return { kind: "conflict" };
    }
    throw error;
  }
  const names = await readdir(opts.projectDir);
  if (names.includes(PROJECT_ENV_CONTRACT_FILENAME)) {
    formats.push("legacy-json");
  }
  if (
    names.some(
      (name) =>
        name !== PROJECT_ENV_STATE_FILENAME &&
        (name === PROJECT_ENV_FILENAME ||
          (name.startsWith(`${PROJECT_ENV_FILENAME}.`) &&
            !name.endsWith(".json") &&
            !name.endsWith(".tmp")))
    )
  ) {
    formats.push("dotenv");
  }
  return { kind: "formats", formats };
}

function envFormatFinding(opts: {
  readonly detected: Awaited<ReturnType<typeof detectEnvFormats>>;
  readonly root: string;
}): UpgradeFinding {
  if (opts.detected.kind === "conflict") {
    return {
      id: "env-format",
      status: "blocker",
      summary:
        "An env layer path (.hack/hack.env.*.yaml) is a link or not a regular file, so the env format cannot be decided.",
      args: ["doctor", "--path", opts.root],
      action: null,
    };
  }
  const { formats } = opts.detected;
  const legacy = formats.filter((format) => format !== "layers");
  if (legacy.length === 0) {
    return {
      id: "env-format",
      status: "ok",
      summary:
        formats.length === 0
          ? "No env configuration."
          : "Env uses YAML layers (current format).",
      args: null,
      action: null,
    };
  }
  return {
    id: "env-format",
    status: "warn",
    summary: `Env uses the legacy format (${legacy.join(", ")}${formats.includes("layers") ? ", beside YAML layers" : ""}); migrate it to YAML layers.`,
    args: ["doctor", "--migrate-env-config", "--path", opts.root],
    action: null,
  };
}

async function envKeyFinding(opts: {
  readonly root: string;
}): Promise<UpgradeFinding> {
  const inspection = await inspectProjectEnvKey({
    projectRoot: opts.root,
    candidates: await resolveEnvKeyCandidates({ projectRoot: opts.root }),
    env: process.env,
    uid: typeof process.getuid === "function" ? process.getuid() : null,
    listTrackedKeyPaths: gitListTrackedKeyPaths,
    isLocalKeyIgnored: gitIsLocalKeyIgnored,
  });
  const worst = inspection.findings[0];
  const codes = inspection.findings
    .filter((finding) => finding.status !== "ok")
    .map((finding) => finding.code);
  if (inspection.status === "ok" || worst === undefined) {
    const present = !inspection.findings.some(
      (finding) => finding.code === "env-key-absent"
    );
    return {
      id: "env-key",
      status: "ok",
      summary: present
        ? "Env key present, private and untracked."
        : "No env key (none needed yet).",
      args: null,
      action: null,
    };
  }
  return {
    id: "env-key",
    status: inspection.status === "error" ? "blocker" : "warn",
    summary: `Env key: ${codes.join(", ")}.`,
    args: ["doctor", "--path", opts.root],
    action: worst.remedy ? `In the project root: ${worst.remedy}` : null,
  };
}

async function trackedFilesFinding(opts: {
  readonly root: string;
  readonly projectDirName: string;
  readonly timeoutMs: number;
}): Promise<UpgradeFinding> {
  const tracked = await inspectTrackedGeneratedFiles({
    projectRoot: opts.root,
    projectDirName: opts.projectDirName,
    timeoutMs: opts.timeoutMs,
  });
  const args = ["doctor", "--fix", "--path", opts.root];
  if (tracked === null) {
    // A checkout Git failed on is not a directory without Git: whether
    // sensitive files are tracked there is unknown.
    return (await insideGitWorkTree(opts.root))
      ? {
          id: "tracked-files",
          status: "incomplete",
          summary:
            "Git could not list this checkout's tracked files (an unreadable index, or a repository Git refuses), so whether sensitive files are tracked is unknown.",
          args: ["doctor", "--path", opts.root],
          action: null,
        }
      : {
          id: "tracked-files",
          status: "info",
          summary: "Not a Git checkout; no tracked files to check.",
          args: null,
          action: null,
        };
  }
  if (tracked.secretKeyTracked) {
    return {
      id: "tracked-files",
      status: "blocker",
      summary:
        "The project's env secret key is tracked in Git (a committed secret).",
      args,
      action: null,
    };
  }
  const count =
    tracked.trackedPaths.length +
    tracked.trackedOverlayPaths.length +
    tracked.unignoredOverlayPaths.length;
  if (count === 0) {
    return {
      id: "tracked-files",
      status: "ok",
      summary: "No machine-local or sensitive files are tracked.",
      args: null,
      action: null,
    };
  }
  return {
    id: "tracked-files",
    status: "warn",
    summary: `${count} machine-local or sensitive file(s) are tracked or not ignored.`,
    args,
    action: null,
  };
}

async function ignoreRulesFinding(opts: {
  readonly root: string;
  readonly projectDir: string;
}): Promise<UpgradeFinding> {
  const state = await inspectHackDirGitignoreForDoctor({
    projectDir: opts.projectDir,
  });
  if (state === null || state === "current") {
    return {
      id: "ignore-rules",
      status: "ok",
      summary:
        state === null
          ? "Not a Git checkout; no ignore rules needed."
          : "The committed .hack/.gitignore is current.",
      args: null,
      action: null,
    };
  }
  return {
    id: "ignore-rules",
    status: "warn",
    summary: `The committed .hack/.gitignore is ${state}.`,
    args: ["doctor", "--fix", "--path", opts.root],
    action: null,
  };
}

async function agentFinding(opts: {
  readonly root: string;
  readonly homeDir: string;
}): Promise<UpgradeFinding> {
  const state = await inspectDoctorAgentIntegrations({
    projectRoot: opts.root,
    homeDir: opts.homeDir,
  });
  return state.status === "current"
    ? {
        id: "agent-integrations",
        status: "ok",
        summary: "Agent integrations are current (or not installed).",
        args: null,
        action: null,
      }
    : {
        id: "agent-integrations",
        status: "warn",
        summary:
          "Standalone Hack agent files are stale; the hack plugin replaces them.",
        args: ["setup", "migrate", "--path", opts.root],
        action: null,
      };
}

function nativeFinding(
  probe: NativePreflightProbe | null
): UpgradeFinding | null {
  if (probe === null) {
    return null;
  }
  return probe.ready
    ? {
        id: "native-preflight",
        status: "ok",
        summary: `Ready for the native backend (${probe.warnings} warning(s)).`,
        args: null,
        action: null,
      }
    : {
        // Native is optional: a Compose project upgrades without it.
        id: "native-preflight",
        status: "info",
        summary: `Not ready for the native backend (${probe.blockers} blocker(s)); Compose is unaffected.`,
        args: null,
        action: null,
      };
}

/**
 * Runs one check. A check that threw or ran out of time is reported, never
 * a pass: `incomplete` for a required check (readiness is then not
 * established), `warn` for an optional one. It gets at most `timeoutMs`,
 * and never runs past `deadline` (epoch ms).
 */
async function guarded(
  id: string,
  limits: {
    readonly timeoutMs: number;
    readonly deadline: number;
    readonly root: string;
  },
  run: (timeoutMs: number) => Promise<UpgradeFinding | null>
): Promise<UpgradeFinding | null> {
  const notChecked = (summary: string): UpgradeFinding => ({
    id,
    status: REQUIRED_CHECKS.has(id) ? "incomplete" : "warn",
    summary,
    args: ["doctor", "--path", limits.root],
    action: null,
  });
  const timeoutMs = Math.min(limits.timeoutMs, limits.deadline - Date.now());
  if (timeoutMs <= 0) {
    return notChecked(
      "Not checked: the upgrade check ran out of time before this check."
    );
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((done) => {
    timer = setTimeout(() => done("timeout"), timeoutMs);
  });
  try {
    // Every child process the check starts ends by the check's own limit.
    const result = await Promise.race([
      withProcessDeadline(Date.now() + timeoutMs, () => run(timeoutMs)),
      timeout,
    ]);
    return result === "timeout"
      ? notChecked(
          `Not checked: it took longer than ${Math.max(1, Math.round(timeoutMs / 1000))} s.`
        )
      : result;
  } catch {
    return notChecked("Not checked: the check failed.");
  } finally {
    clearTimeout(timer);
  }
}

const PROJECT_CHECK_TIMEOUT_MS = 8000;

/** The findings for one live checkout, in a fixed order. */
export async function inspectUpgradeProject(opts: {
  readonly project: RegisteredCheckout;
  readonly homeDir: string;
  readonly nativePreflight: (opts: {
    readonly projectRoot: string;
  }) => Promise<NativePreflightProbe | null>;
  /** Epoch ms after which no further check starts. */
  readonly deadline: number;
  /** Per-check limit; defaults to 8 s. */
  readonly checkTimeoutMs?: number;
}): Promise<readonly UpgradeFinding[]> {
  const root = opts.project.repoRoot;
  const projectDir = opts.project.projectDir;
  const limits = {
    timeoutMs: opts.checkTimeoutMs ?? PROJECT_CHECK_TIMEOUT_MS,
    deadline: opts.deadline,
    root,
  };
  const results = await Promise.all([
    guarded("env-format", limits, async () =>
      envFormatFinding({
        detected: await detectEnvFormats({ projectDir }),
        root,
      })
    ),
    guarded("env-key", limits, () => envKeyFinding({ root })),
    guarded("tracked-files", limits, (timeoutMs) =>
      trackedFilesFinding({
        root,
        projectDirName: basename(projectDir),
        timeoutMs,
      })
    ),
    guarded("ignore-rules", limits, () =>
      ignoreRulesFinding({ root, projectDir })
    ),
    guarded("agent-integrations", limits, () =>
      agentFinding({ root, homeDir: opts.homeDir })
    ),
    guarded("native-preflight", limits, async () =>
      nativeFinding(await opts.nativePreflight({ projectRoot: root }))
    ),
  ]);
  return results.filter((finding) => finding !== null);
}

/** Whether `path` or a directory above it holds a `.git` entry. */
async function insideGitWorkTree(path: string): Promise<boolean> {
  let current = resolve(path);
  for (;;) {
    if ((await statState(resolve(current, ".git"))) !== "absent") {
      return true;
    }
    const parent = resolve(current, "..");
    if (parent === current) {
      return false;
    }
    current = parent;
  }
}

async function statState(
  path: string
): Promise<"directory" | "other" | "absent" | "error"> {
  try {
    return (await stat(path)).isDirectory() ? "directory" : "other";
  } catch (error: unknown) {
    return errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR"
      ? "absent"
      : "error";
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return;
  }
  const { code } = error;
  return typeof code === "string" ? code : undefined;
}
