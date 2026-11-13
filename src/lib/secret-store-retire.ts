import { stat } from "node:fs/promises";
import { resolve } from "node:path";

import { PROJECT_CONFIG_FILENAME } from "../constants.ts";
import { readControlPlaneConfig } from "../control-plane/sdk/config.ts";
import { resolveGlobalConfigPath } from "./config-paths.ts";
import { readOptionalTextFile } from "./fs.ts";
import { readHackEnvContract, readHackEnvRuntimeConfig } from "./hack-env.ts";
import { readProjectsRegistry } from "./projects-registry.ts";
import {
  type FileSecretStoreListing,
  listFileSecretStoreEntries,
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
  /** False when the registry could not be read. */
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
  let projects: readonly {
    readonly name: string;
    readonly projectDir: string;
  }[];
  try {
    projects = (await readProjectsRegistry()).projects;
  } catch {
    return { names: [], registryRead: false, unchecked: 0 };
  }
  const target = await stat(opts.storePath).catch(() => null);
  const names = new Set<string>();
  let unchecked = 0;
  for (const project of projects) {
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
    if (
      location.active &&
      (await sameStoreFile({ path: location.storePath, opts, target })) &&
      (await projectUsesSecretStore({ projectDir: project.projectDir }))
    ) {
      names.add(project.name);
    }
  }
  return { names: [...names].sort(), registryRead: true, unchecked };
}

/** The same configured path, or the same existing file (device and inode). */
async function sameStoreFile(input: {
  readonly path: string;
  readonly opts: { readonly storePath: string };
  readonly target: { readonly dev: number; readonly ino: number } | null;
}): Promise<boolean> {
  if (resolve(input.path) === resolve(input.opts.storePath)) {
    return true;
  }
  if (input.target === null) {
    return false;
  }
  const candidate = await stat(input.path).catch(() => null);
  return (
    candidate !== null &&
    candidate.dev === input.target.dev &&
    candidate.ino === input.target.ino
  );
}

/**
 * Where a project's store is, and whether its backend is active. The
 * listing reads the store only to classify it, and never provisions a key.
 */
async function storeLocation(opts: {
  readonly projectName: string;
  readonly projectDir?: string;
}): Promise<FileSecretStoreListing> {
  return await listFileSecretStoreEntries(opts);
}

/** The outcome of `hack secrets retire-store` (paths only, never values). */
export type SecretStoreRetireOutcome =
  | {
      readonly kind: "retired";
      readonly from: string;
      readonly to: string;
      readonly keyPath: string;
    }
  | { readonly kind: "refused"; readonly message: string };

/**
 * Checks that the store selected for this context (a project, or the global
 * configuration when `projectDir` is omitted) is one retiring is for, then
 * moves it aside ({@link retireEncryptedStoreFile}). Refused, with the
 * reason and nothing moved, when no file store is configured, the store is
 * absent or empty, it opens with the key in use, or it cannot be read for
 * another reason (its key file refused, the store unreadable or a link).
 */
export async function retireSecretStore(opts: {
  readonly projectName: string;
  readonly projectDir?: string;
  readonly now?: Date;
}): Promise<SecretStoreRetireOutcome> {
  const selection = await secretStoreSelectionProblem(opts);
  if (selection !== null) {
    return {
      kind: "refused",
      message: `${selection} Nothing was moved. Fix that config, then run hack doctor and retry.`,
    };
  }
  const listing = await storeLocation(opts);
  const refusal = retireRefusal(listing);
  if (refusal !== null) {
    return { kind: "refused", message: refusal };
  }
  try {
    const moved = await retireEncryptedStoreFile({
      storePath: listing.storePath,
      keyPath: listing.keyPath,
      now: opts.now,
      // Classified before the lock: classify again under it, so a store
      // whose key came back, or that was replaced, is not retired.
      recheck: async () => {
        const unsure = await secretStoreSelectionProblem(opts);
        if (unsure !== null) {
          return `${unsure} Nothing was moved. (It changed while retiring.)`;
        }
        const current = await storeLocation(opts);
        if (current.storePath !== listing.storePath) {
          return "The secret store configuration changed while retiring; nothing was moved. Run hack doctor, then retry.";
        }
        const changed = retireRefusal(current);
        return changed === null
          ? null
          : `${changed} (It changed while retiring.)`;
      },
    });
    return { kind: "retired", ...moved, keyPath: listing.keyPath };
  } catch (error: unknown) {
    if (error instanceof SecretStoreRetireError) {
      return { kind: "refused", message: error.message };
    }
    throw error;
  }
}

/**
 * Why a store is not one to retire, or null when it is (entries exist and
 * the key that opens them is missing or wrong).
 */
function retireRefusal(listing: FileSecretStoreListing): string | null {
  if (listing.kind === "inactive") {
    return "No encrypted file secret store is configured here (the backend is the OS keychain); nothing was moved.";
  }
  if (listing.kind === "listed") {
    return listing.ownEntries.size + listing.foreignEntryCount === 0
      ? `There is no encrypted secret store with entries at ${listing.storePath}; nothing was moved.`
      : `The encrypted secret store at ${listing.storePath} opens with the key in use, so there is nothing to retire; nothing was moved.`;
  }
  if (!RETIRABLE_REASONS.has(listing.reason)) {
    return `The encrypted secret store at ${listing.storePath} is not retired: it is not a missing or wrong key (${listing.reason.replaceAll("_", " ")}). Run hack doctor for what to fix; nothing was moved.`;
  }
  return null;
}
