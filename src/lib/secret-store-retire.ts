import { lstat, realpath, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";

import { PROJECT_CONFIG_FILENAME } from "../constants.ts";
import { readControlPlaneConfig } from "../control-plane/sdk/config.ts";
import { resolveGlobalConfigPath } from "./config-paths.ts";
import { readOptionalTextFile } from "./fs.ts";
import { readHackEnvContract, readHackEnvRuntimeConfig } from "./hack-env.ts";
import {
  type RegisteredProject,
  readProjectsRegistryStrict,
} from "./projects-registry.ts";
import {
  classifyEncryptedStoreAt,
  isEncryptedStoreFile,
  resolveFileSecretStorePaths,
  retireEncryptedStoreFile,
  SecretStoreRetireError,
} from "./secret-store.ts";

/**
 * Retiring an encrypted secret store whose key is gone (HACK-2177): a
 * deliberate, reversible way forward after `hack doctor` reports a store it
 * cannot open. Retiring only renames the store file beside itself; it never
 * deletes, decrypts or prints an entry.
 */

/** Store states retiring is for: entries exist and the key that opens them does not. */
const RETIRABLE_REASONS = new Set(["key_missing", "wrong_key_or_corrupt"]);

/**
 * Whether a project's runtime reads its secret store: its legacy env
 * contract declares a store-backed (`source: "keychain"`) value, or its
 * configuration keeps plaintext in the backend. The same condition the
 * runtime uses before it opens the store. A contract that cannot be read
 * counts as using it, since what it declares is unknown.
 */
export async function projectUsesSecretStore(opts: {
  readonly projectDir: string;
}): Promise<boolean> {
  try {
    const runtime = await readHackEnvRuntimeConfig(opts);
    if (runtime.storePlaintextInBackend) {
      return true;
    }
    const contract = await readHackEnvContract(opts);
    if (contract.parseError !== undefined) {
      return true;
    }
    return contract.contract.vars.some(
      (contractVar) => contractVar.source === "keychain"
    );
  } catch {
    return true;
  }
}

/**
 * Why the configuration that selects the store (the global config and, for
 * a project, its `hack.config.json`) cannot be trusted, or null when it can.
 * A file that exists but cannot be read is not absent, and one that does
 * not parse contributes nothing, so either could silently select another
 * store (for example the global one). Value-free: paths only.
 */
export async function secretStoreSelectionProblem(opts: {
  readonly projectDir?: string;
}): Promise<string | null> {
  const paths = [
    resolveGlobalConfigPath(),
    ...(opts.projectDir === undefined
      ? []
      : [resolve(opts.projectDir, PROJECT_CONFIG_FILENAME)]),
  ];
  for (const path of paths) {
    if ((await readOptionalTextFile(path)).kind === "unreadable") {
      return `The Hack config ${path} exists but cannot be read, so which secret store is selected is unknown.`;
    }
  }
  const config = await readControlPlaneConfig({ projectDir: opts.projectDir });
  return config.parseError === undefined
    ? null
    : "The Hack config that selects the secret store does not parse, so which secret store is selected is unknown.";
}

/** Registered projects that read a store, and whether every one was checked. */
export type SecretStoreUsers = {
  /** Names only, sorted. */
  readonly names: readonly string[];
  /** False when the registry could not be read or is not a valid registry. */
  readonly registryRead: boolean;
  /** Registered projects whose store selection could not be checked. */
  readonly unchecked: number;
};

/**
 * Registered projects whose configuration selects the store at `storePath`
 * and whose runtime reads it, from configuration only: no store is opened.
 * A project selects the same store when its configured path is the same,
 * or names the same file (device and inode, so aliases through symlinked
 * directories match). What could not be checked is counted, never taken as
 * "does not read it".
 */
export async function listProjectsUsingSecretStore(opts: {
  readonly storePath: string;
}): Promise<SecretStoreUsers> {
  let projects: readonly RegisteredProject[];
  // Registry entries that are not valid projects: unknown, so unchecked.
  let rejected = 0;
  try {
    const read = await readProjectsRegistryStrict();
    if (read.kind === "invalid") {
      return { names: [], registryRead: false, unchecked: 0 };
    }
    projects = read.kind === "valid" ? read.registry.projects : [];
    rejected = read.kind === "valid" ? read.rejected : 0;
  } catch {
    return { names: [], registryRead: false, unchecked: 0 };
  }
  const target = await identity(opts.storePath);
  const names = new Set<string>();
  let unchecked = rejected;
  // A project's linked worktrees are registered under it, not as projects
  // of their own, and each can have its own env contract and store config:
  // every checkout is a context of its own.
  for (const project of projects.flatMap(registeredCheckouts)) {
    // A checkout that is not there (an unmounted volume, a moved repo) has
    // no config or contract to read, which is not "does not read it".
    if (!(await stat(project.projectDir).catch(() => null))?.isDirectory()) {
      unchecked += 1;
      continue;
    }
    let location: Awaited<ReturnType<typeof resolveFileSecretStorePaths>>;
    try {
      if (
        (await secretStoreSelectionProblem({
          projectDir: project.projectDir,
        })) !== null
      ) {
        unchecked += 1;
        continue;
      }
      location = await resolveFileSecretStorePaths({
        projectDir: project.projectDir,
      });
    } catch {
      unchecked += 1;
      continue;
    }
    if (!location.active) {
      continue;
    }
    const same = await sameStoreFile({
      path: location.storePath,
      opts,
      target,
    });
    if (same === "unknown") {
      unchecked += 1;
    } else if (
      same === "same" &&
      (await projectUsesSecretStore({ projectDir: project.projectDir }))
    ) {
      names.add(project.name);
    }
  }
  return { names: [...names].sort(), registryRead: true, unchecked };
}

/** A registered project's primary checkout and each of its linked worktrees. */
function registeredCheckouts(
  project: RegisteredProject
): { readonly name: string; readonly projectDir: string }[] {
  return [
    { name: project.name, projectDir: project.projectDir },
    ...(project.worktrees ?? []).map((worktree) => ({
      name: `${project.name} (worktree ${basename(worktree.path)})`,
      projectDir: resolve(worktree.path, project.projectDirName),
    })),
  ];
}

/**
 * A file's device and inode: `absent` when nothing is there, `unknown` when
 * that cannot be established (for example EACCES or EIO).
 */
async function identity(
  path: string
): Promise<
  { readonly dev: number; readonly ino: number } | "absent" | "unknown"
> {
  try {
    const info = await stat(path);
    return { dev: info.dev, ino: info.ino };
  } catch (error: unknown) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? (error as { readonly code?: unknown }).code
        : undefined;
    return code === "ENOENT" || code === "ENOTDIR" ? "absent" : "unknown";
  }
}

/**
 * Whether a configured store path is the store: the same resolved path, or
 * the same existing file (device and inode). `unknown` when a file's
 * identity cannot be established, never taken as "different".
 */
async function sameStoreFile(input: {
  readonly path: string;
  readonly opts: { readonly storePath: string };
  readonly target: Awaited<ReturnType<typeof identity>>;
}): Promise<"same" | "different" | "unknown"> {
  if (resolve(input.path) === resolve(input.opts.storePath)) {
    return "same";
  }
  const candidate = await identity(input.path);
  if (candidate === "absent" || input.target === "absent") {
    return "different";
  }
  if (candidate === "unknown" || input.target === "unknown") {
    return "unknown";
  }
  return candidate.dev === input.target.dev &&
    candidate.ino === input.target.ino
    ? "same"
    : "different";
}

/** The outcome of `hack secrets retire-store` (paths only, never values). */
export type SecretStoreRetireOutcome =
  | {
      readonly kind: "retired";
      readonly from: string;
      readonly to: string;
      /** A replacement found at the store path while moving, kept too. */
      readonly replacement: string | null;
      /** The configured store path; `from` is its real path. */
      readonly configured: string;
      readonly keyPath: string;
    }
  | { readonly kind: "refused"; readonly message: string };

/**
 * What retiring would act on, resolved once (HACK-2177): the configured
 * store path (project input, possibly through a symlinked directory), its
 * real path, and the key path. Shown before confirmation, and carried into
 * {@link retireSecretStore}, which refuses if a fresh plan differs.
 */
export type SecretStoreRetirePlan = {
  readonly configured: string;
  readonly canonical: string;
  readonly keyPath: string;
  /** For the confirmation: the real path, and the configured one if it differs. */
  readonly display: string;
};

/**
 * Plans retiring the store this context selects (a project, or the global
 * configuration when `projectDir` is omitted). Refused, with the reason,
 * when the selecting config is unsure, no file store is configured, its
 * real path cannot be resolved, or the store at that real path is not one
 * to retire (absent or empty, opens with the key in use, unreadable for a
 * reason other than a missing or wrong key, or not a store envelope).
 * Every store read uses the real path, never the configured alias.
 */
export async function planSecretStoreRetire(opts: {
  readonly projectDir?: string;
}): Promise<
  | { readonly kind: "plan"; readonly plan: SecretStoreRetirePlan }
  | { readonly kind: "refused"; readonly message: string }
> {
  const selection = await secretStoreSelectionProblem(opts);
  if (selection !== null) {
    return {
      kind: "refused",
      message: `${selection} Nothing was moved. Fix that config, then run hack doctor and retry.`,
    };
  }
  const location = await resolveFileSecretStorePaths(opts).catch(() => null);
  if (location === null || !location.active) {
    return {
      kind: "refused",
      message:
        "No encrypted file secret store is configured here (the backend is the OS keychain); nothing was moved.",
    };
  }
  const leafRefusal = await symlinkedStoreRefusal(location.storePath);
  if (leafRefusal !== null) {
    return { kind: "refused", message: leafRefusal };
  }
  const canonical = await realpath(location.storePath).catch(() => null);
  if (canonical === null) {
    return {
      kind: "refused",
      message: `There is no encrypted secret store with entries at ${location.storePath}; nothing was moved.`,
    };
  }
  const refusal = await eligibilityRefusal({
    storePath: canonical,
    keyPath: location.keyPath,
  });
  if (refusal !== null) {
    return { kind: "refused", message: refusal };
  }
  return {
    kind: "plan",
    plan: {
      configured: location.storePath,
      canonical,
      keyPath: location.keyPath,
      display:
        canonical === resolve(location.storePath)
          ? canonical
          : `${canonical} (configured as ${location.storePath})`,
    },
  };
}

/**
 * Retires the store this context selects ({@link retireEncryptedStoreFile}
 * on its real path). With `approved` (the plan shown before confirmation),
 * refuses unless a fresh plan names the same configured path, real path
 * and key, so a target retargeted while the confirmation waited is not
 * moved. Under the store's lock it checks again: the same config and
 * paths, the configured path still leading to the same real path, and the
 * store at that real path still one to retire.
 */
export async function retireSecretStore(opts: {
  /** Unused: the store is the file, whichever project scope it holds. */
  readonly projectName?: string;
  readonly projectDir?: string;
  readonly now?: Date;
  readonly approved?: SecretStoreRetirePlan;
  /** Test seam: runs under the lock after the path checks, before eligibility. */
  readonly beforeEligibility?: () => Promise<void>;
}): Promise<SecretStoreRetireOutcome> {
  const planned = await planSecretStoreRetire(opts);
  if (planned.kind === "refused") {
    return planned;
  }
  const { plan } = planned;
  if (opts.approved !== undefined && !samePlan(opts.approved, plan)) {
    return {
      kind: "refused",
      message: `The store to retire changed after it was confirmed (confirmed: ${opts.approved.display}; now: ${plan.display}); nothing was moved. Run the command again to confirm the current target.`,
    };
  }
  try {
    const moved = await retireEncryptedStoreFile({
      storePath: plan.canonical,
      keyPath: plan.keyPath,
      now: opts.now,
      recheck: async () => {
        const changed = await lockedRecheck({ opts, plan });
        return changed === null
          ? null
          : `${changed} (It changed while retiring.)`;
      },
    });
    return {
      kind: "retired",
      ...moved,
      configured: plan.configured,
      keyPath: plan.keyPath,
    };
  } catch (error: unknown) {
    if (error instanceof SecretStoreRetireError) {
      return { kind: "refused", message: error.message };
    }
    throw error;
  }
}

function samePlan(a: SecretStoreRetirePlan, b: SecretStoreRetirePlan): boolean {
  return (
    a.configured === b.configured &&
    a.canonical === b.canonical &&
    a.keyPath === b.keyPath
  );
}

/**
 * Under the store's lock: the selecting config is still sure, still names
 * the same store and key paths, the configured path still leads to the
 * pinned real path, and the store at that real path (never the alias) is
 * still one to retire. A refusal message, or null to go on.
 */
async function lockedRecheck(input: {
  readonly opts: {
    readonly projectDir?: string;
    readonly beforeEligibility?: () => Promise<void>;
  };
  readonly plan: SecretStoreRetirePlan;
}): Promise<string | null> {
  const { opts, plan } = input;
  const unsure = await secretStoreSelectionProblem(opts);
  if (unsure !== null) {
    return `${unsure} Nothing was moved.`;
  }
  const location = await resolveFileSecretStorePaths(opts).catch(() => null);
  if (
    location === null ||
    !location.active ||
    location.storePath !== plan.configured ||
    location.keyPath !== plan.keyPath
  ) {
    return "The secret store configuration changed; nothing was moved. Run hack doctor, then retry.";
  }
  const leafRefusal = await symlinkedStoreRefusal(plan.configured);
  if (leafRefusal !== null) {
    return leafRefusal;
  }
  if ((await realpath(plan.configured).catch(() => null)) !== plan.canonical) {
    return `${plan.configured} no longer leads to ${plan.canonical}; nothing was moved.`;
  }
  await opts.beforeEligibility?.();
  return await eligibilityRefusal({
    storePath: plan.canonical,
    keyPath: plan.keyPath,
  });
}

/**
 * Refuses a configured store path whose last component is a symlink (a
 * symlinked directory on the way is fine). Runtime, doctor and the store's
 * own reads refuse such a store; retiring its target would leave a
 * dangling link at the configured path.
 */
async function symlinkedStoreRefusal(
  configured: string
): Promise<string | null> {
  const leaf = await lstat(configured).catch(() => null);
  return leaf?.isSymbolicLink() === true
    ? `The configured store path ${configured} is itself a symlink, which Hack refuses as a store; nothing was moved. Replace it with the regular store file it points to, or point controlPlane.secrets.encryptedFile.path at that file.`
    : null;
}

/**
 * Why the store at this (real) path is not one to retire, or null when it
 * is: entries exist, the key that opens them is missing or wrong, and the
 * file holds a store envelope.
 */
async function eligibilityRefusal(input: {
  readonly storePath: string;
  readonly keyPath: string;
}): Promise<string | null> {
  const state = await classifyEncryptedStoreAt(input);
  if (state.kind === "empty") {
    return `There is no encrypted secret store with entries at ${input.storePath}; nothing was moved.`;
  }
  if (state.kind === "opens") {
    return `The encrypted secret store at ${input.storePath} opens with the key in use, so there is nothing to retire; nothing was moved.`;
  }
  if (!RETIRABLE_REASONS.has(state.reason)) {
    return `The encrypted secret store at ${input.storePath} is not retired: it is not a missing or wrong key (${state.reason.replaceAll("_", " ")}). Run hack doctor for what to fix; nothing was moved.`;
  }
  return await notAStoreRefusal(input.storePath);
}

/**
 * What `hack secrets retire-store` would move, for its confirmation; null
 * when there is nothing to retire here. {@link planSecretStoreRetire}
 * carries the same target into the retirement.
 */
export async function describeRetireTarget(opts: {
  readonly projectDir?: string;
}): Promise<string | null> {
  const planned = await planSecretStoreRetire(opts);
  return planned.kind === "plan" ? planned.plan.display : null;
}

/**
 * Refuses a configured store path that does not hold a Hack encrypted
 * store envelope: the path is project input and may name any file.
 */
async function notAStoreRefusal(storePath: string): Promise<string | null> {
  return (await isEncryptedStoreFile(storePath))
    ? null
    : `${storePath} is not a Hack encrypted secret store (it does not hold the store's encrypted envelope), so it is not retired; nothing was moved. Check controlPlane.secrets.encryptedFile.path in the Hack config.`;
}
