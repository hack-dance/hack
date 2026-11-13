import { resolve } from "node:path";

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
 * Names (only) of registered projects whose configuration selects the store
 * at `storePath` and whose runtime reads it, from configuration only: no
 * store is opened. Projects whose configuration cannot be read are skipped;
 * a registry that cannot be read yields none.
 */
export async function listProjectsUsingSecretStore(opts: {
  readonly storePath: string;
}): Promise<readonly string[]> {
  let projects: readonly {
    readonly name: string;
    readonly projectDir: string;
  }[];
  try {
    projects = (await readProjectsRegistry()).projects;
  } catch {
    return [];
  }
  const names = new Set<string>();
  for (const project of projects) {
    let location: Awaited<ReturnType<typeof resolveFileSecretStorePaths>>;
    try {
      location = await resolveFileSecretStorePaths({
        projectDir: project.projectDir,
      });
    } catch {
      continue;
    }
    if (
      location.active &&
      resolve(location.storePath) === resolve(opts.storePath) &&
      (await projectUsesSecretStore({ projectDir: project.projectDir }))
    ) {
      names.add(project.name);
    }
  }
  return [...names].sort();
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
  const listing = await storeLocation(opts);
  if (listing.kind === "inactive") {
    return {
      kind: "refused",
      message:
        "No encrypted file secret store is configured here (the backend is the OS keychain); nothing was moved.",
    };
  }
  if (listing.kind === "listed") {
    return {
      kind: "refused",
      message:
        listing.ownEntries.size + listing.foreignEntryCount === 0
          ? `There is no encrypted secret store with entries at ${listing.storePath}; nothing was moved.`
          : `The encrypted secret store at ${listing.storePath} opens with the key in use, so there is nothing to retire; nothing was moved.`,
    };
  }
  if (!RETIRABLE_REASONS.has(listing.reason)) {
    return {
      kind: "refused",
      message: `The encrypted secret store at ${listing.storePath} is not retired: it is not a missing or wrong key (${listing.reason.replaceAll("_", " ")}). Run hack doctor for what to fix; nothing was moved.`,
    };
  }
  try {
    const moved = await retireEncryptedStoreFile({
      storePath: listing.storePath,
      now: opts.now,
    });
    return { kind: "retired", ...moved, keyPath: listing.keyPath };
  } catch (error: unknown) {
    if (error instanceof SecretStoreRetireError) {
      return { kind: "refused", message: error.message };
    }
    throw error;
  }
}
