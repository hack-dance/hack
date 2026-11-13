import { readdir, readFile, stat } from "node:fs/promises";
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
import { quoteShellWord } from "./logs.ts";
import {
  ProjectEnvLayerPathConflictError,
  projectEnvConfigExistsForMutation,
} from "./project-env-config.ts";
import type { RegisteredProject } from "./projects-registry.ts";
import type { NativePreflightProbe } from "./upgrade-check-probes.ts";

/**
 * Per-project checks for `hack upgrade check` (HACK-2189): the project's
 * state in the registry, then, for a live project, its env format, env key,
 * tracked machine-local files, ignore rules, agent integrations and (Apple
 * Silicon) native preflight. Read-only; reports names, paths, counts and
 * codes, never a value.
 */

export type UpgradeFindingStatus = "ok" | "info" | "warn" | "blocker";

export type UpgradeFinding = {
  /** Stable id, for example `env-format` or `secret-store`. */
  readonly id: string;
  readonly status: UpgradeFindingStatus;
  readonly summary: string;
  /** The command (or action) that fixes it, run from anywhere. */
  readonly fix: string | null;
};

export type RegistryEntryState =
  | { readonly state: "live" }
  /** The checkout or its Hack config is gone: a dead entry to prune. */
  | { readonly state: "missing"; readonly reason: string }
  /** It exists but cannot be read: a live project to repair, not prune. */
  | { readonly state: "unreadable"; readonly reason: string };

/** Classifies a registered project from its files only. */
export async function classifyRegistryEntry(
  project: RegisteredProject
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
      reason: `${PROJECT_CONFIG_FILENAME} cannot be read`,
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
      return { state: "unreadable", reason: `${name} cannot be read` };
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
  try {
    return { kind: "text", text: await readFile(path, "utf8") };
  } catch (error: unknown) {
    const code = errorCode(error);
    return code === "ENOENT" || code === "ENOTDIR"
      ? { kind: "absent" }
      : { kind: "unreadable" };
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
  const names = await readdir(opts.projectDir).catch(() => [] as string[]);
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
  const path = quoteShellWord(opts.root);
  if (opts.detected.kind === "conflict") {
    return {
      id: "env-format",
      status: "blocker",
      summary:
        "An env layer path (.hack/hack.env.*.yaml) is a link or not a regular file, so the env format cannot be decided.",
      fix: `hack doctor --path ${path}`,
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
      fix: null,
    };
  }
  return {
    id: "env-format",
    status: "warn",
    summary: `Env uses the legacy format (${legacy.join(", ")}${formats.includes("layers") ? ", beside YAML layers" : ""}); migrate it to YAML layers.`,
    fix: `hack doctor --migrate-env-config --path ${path}`,
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
      fix: null,
    };
  }
  return {
    id: "env-key",
    status: inspection.status === "error" ? "blocker" : "warn",
    summary: `Env key: ${codes.join(", ")}.${worst.remedy ? ` In the project root: ${worst.remedy}` : ""}`,
    fix: `hack doctor --path ${quoteShellWord(opts.root)}`,
  };
}

async function trackedFilesFinding(opts: {
  readonly root: string;
  readonly projectDirName: string;
}): Promise<UpgradeFinding> {
  const tracked = await inspectTrackedGeneratedFiles({
    projectRoot: opts.root,
    projectDirName: opts.projectDirName,
  });
  const fix = `hack doctor --fix --path ${quoteShellWord(opts.root)}`;
  if (tracked === null) {
    return {
      id: "tracked-files",
      status: "info",
      summary: "Not a Git checkout, or Git could not list tracked files.",
      fix: null,
    };
  }
  if (tracked.secretKeyTracked) {
    return {
      id: "tracked-files",
      status: "blocker",
      summary:
        "The project's env secret key is tracked in Git (a committed secret).",
      fix,
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
      fix: null,
    };
  }
  return {
    id: "tracked-files",
    status: "warn",
    summary: `${count} machine-local or sensitive file(s) are tracked or not ignored.`,
    fix,
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
      fix: null,
    };
  }
  return {
    id: "ignore-rules",
    status: "warn",
    summary: `The committed .hack/.gitignore is ${state}.`,
    fix: `hack doctor --fix --path ${quoteShellWord(opts.root)}`,
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
        fix: null,
      }
    : {
        id: "agent-integrations",
        status: "warn",
        summary:
          "Standalone Hack agent files are stale; the hack plugin replaces them.",
        fix: `hack setup migrate --path ${quoteShellWord(opts.root)}`,
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
        fix: null,
      }
    : {
        // Native is optional: a Compose project upgrades without it.
        id: "native-preflight",
        status: "info",
        summary: `Not ready for the native backend (${probe.blockers} blocker(s)); Compose is unaffected.`,
        fix: null,
      };
}

/**
 * A check that threw or ran out of time is reported, never a pass. It gets
 * at most `timeoutMs`, and never runs past `deadline` (epoch ms): once the
 * whole check's budget is spent, it reports "not checked" without running.
 */
async function guarded(
  id: string,
  limits: { readonly timeoutMs: number; readonly deadline: number },
  run: () => Promise<UpgradeFinding | null>
): Promise<UpgradeFinding | null> {
  const timeoutMs = Math.min(limits.timeoutMs, limits.deadline - Date.now());
  if (timeoutMs <= 0) {
    return {
      id,
      status: "warn",
      summary:
        "Not checked: the upgrade check ran out of time before this project.",
      fix: null,
    };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((done) => {
    timer = setTimeout(() => done("timeout"), timeoutMs);
  });
  try {
    const result = await Promise.race([run(), timeout]);
    return result === "timeout"
      ? {
          id,
          status: "warn",
          summary: `Not checked: it took longer than ${Math.round(timeoutMs / 1000)} s.`,
          fix: null,
        }
      : result;
  } catch {
    return {
      id,
      status: "warn",
      summary: "Not checked: the check failed.",
      fix: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

const PROJECT_CHECK_TIMEOUT_MS = 8000;

/** The findings for one live project, in a fixed order. */
export async function inspectUpgradeProject(opts: {
  readonly project: RegisteredProject;
  readonly homeDir: string;
  readonly nativePreflight: (opts: {
    readonly projectRoot: string;
  }) => Promise<NativePreflightProbe | null>;
  /** Epoch ms after which no further project check starts. */
  readonly deadline: number;
}): Promise<readonly UpgradeFinding[]> {
  const root = opts.project.repoRoot;
  const projectDir = opts.project.projectDir;
  const limits = {
    timeoutMs: PROJECT_CHECK_TIMEOUT_MS,
    deadline: opts.deadline,
  };
  const results = await Promise.all([
    guarded("env-format", limits, async () =>
      envFormatFinding({
        detected: await detectEnvFormats({ projectDir }),
        root,
      })
    ),
    guarded("env-key", limits, () => envKeyFinding({ root })),
    guarded("tracked-files", limits, () =>
      trackedFilesFinding({
        root,
        projectDirName: basename(projectDir),
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
