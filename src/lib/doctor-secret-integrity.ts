import { isAbsolute, relative, sep } from "node:path";

import { PROJECT_ENV_KEY_FILENAME } from "../constants.ts";
import { resolveUserHomeDir } from "./home-dir.ts";
import { quoteShellWord } from "./logs.ts";
import {
  inspectProjectEnvLayerKeys,
  PROJECT_ENV_SECRET_KEY_ENV,
  type ProjectEnvLayerInspectionFailure,
  type ProjectEnvLayerKeyReport,
} from "./project-env-config.ts";
import {
  listFileSecretStoreEntries,
  listRetiredEncryptedStores,
} from "./secret-store.ts";
import {
  listProjectsUsingSecretStore,
  projectUsesSecretStore,
} from "./secret-store-retire.ts";

/**
 * `hack doctor`'s secret integrity findings (HACK-2169): stores and env
 * layers whose secrets cannot all be read, with recovery steps. Closed and
 * value-free: paths, counts and fixed text only, never a value or key.
 */
export type SecretIntegrityFinding = {
  /** `info` is not a problem: it is shown with an `ok` result. */
  readonly status: "info" | "warn" | "error";
  readonly message: string;
};

/** The command that moves a store whose key is gone aside (HACK-2177). */
export const RETIRE_STORE_COMMAND = "hack secrets retire-store";

/**
 * The retire command for the store this project selects: with `--path`,
 * since it otherwise acts on the current directory's project.
 */
function retireStoreCommand(projectRoot: string): string {
  return `${RETIRE_STORE_COMMAND} --path ${quoteShellWord(projectRoot)}`;
}

/** A path for display: project-relative inside it, `~/...` under home. */
function displayPath(opts: {
  readonly projectRoot: string;
  readonly path: string;
}): string {
  const inside = relative(opts.projectRoot, opts.path);
  if (
    inside &&
    !inside.startsWith(`..${sep}`) &&
    inside !== ".." &&
    !isAbsolute(inside)
  ) {
    return inside;
  }
  const home = resolveUserHomeDir();
  const underHome = relative(home, opts.path);
  if (underHome && !underHome.startsWith("..") && !isAbsolute(underHome)) {
    return `~/${underHome}`;
  }
  return opts.path;
}

/** Findings for the legacy encrypted-file (or cloud shim) store, if any. */
async function inspectSecretStore(opts: {
  readonly projectRoot: string;
  readonly projectDir: string;
  readonly projectName: string;
}): Promise<SecretIntegrityFinding[]> {
  const listing = await listFileSecretStoreEntries({
    projectName: opts.projectName,
    projectDir: opts.projectDir,
  });
  const retired =
    listing.kind === "inactive"
      ? []
      : await retiredStoreFindings({ ...opts, storePath: listing.storePath });
  if (listing.kind !== "unreadable") {
    return retired;
  }
  const store = displayPath({ ...opts, path: listing.storePath });
  const key = displayPath({ ...opts, path: listing.keyPath });
  if (
    listing.reason === "key_missing" ||
    listing.reason === "wrong_key_or_corrupt"
  ) {
    return [
      await keylessStoreFinding({
        ...opts,
        storePath: listing.storePath,
        store,
        key,
        missing: listing.reason === "key_missing",
      }),
      ...retired,
    ];
  }
  return [...storeFindings({ reason: listing.reason, store, key }), ...retired];
}

/**
 * A store with entries that no available key opens (HACK-2177). An error
 * only for a project whose runtime reads the store; for any other project
 * the same machine-wide store is a warning. It says what is known without
 * the key (entries cannot be counted), which registered projects read it,
 * and the two ways forward: restore the key, or retire the store.
 */
async function keylessStoreFinding(opts: {
  readonly projectRoot: string;
  readonly projectDir: string;
  readonly storePath: string;
  readonly store: string;
  readonly key: string;
  readonly missing: boolean;
}): Promise<SecretIntegrityFinding> {
  const usedHere = await projectUsesSecretStore({
    projectDir: opts.projectDir,
  });
  const users = await listProjectsUsingSecretStore({
    storePath: opts.storePath,
  });
  const state = opts.missing
    ? `The encrypted secret store ${opts.store} has entries, but its key ${opts.key} is missing.`
    : `The available key does not open the encrypted secret store ${opts.store}, or the store is damaged.`;
  const usage = [
    usedHere
      ? "This project's env contract reads it."
      : "This project does not read it.",
    users.length > 0
      ? `Registered projects that read it: ${users.join(", ")}.`
      : "No registered project reads it.",
  ].join(" ");
  return {
    status: usedHere ? "error" : "warn",
    message: `${state} Its entries cannot be counted or read without that key. ${usage} Choose one: restore the key (put the key file back at ${opts.key} with mode 600 from a backup or another machine, or set HACK_SECRETS_FILE_KEY to the same key); or, if the key is gone for good, run \`${retireStoreCommand(opts.projectRoot)}\`, which moves the store aside to a timestamped name beside it, deletes nothing, and prints how to put it back. Do not provision a new key: it cannot open these entries.`,
  };
}

/** Retired copies kept beside the store: information, not a problem. */
async function retiredStoreFindings(opts: {
  readonly projectRoot: string;
  readonly storePath: string;
}): Promise<SecretIntegrityFinding[]> {
  const store = displayPath({ ...opts, path: opts.storePath });
  return (await listRetiredEncryptedStores(opts.storePath)).map((path) => {
    const shown = displayPath({ ...opts, path });
    // Absolute paths (a quoted `~` is not expanded), shell-quoted: a
    // configured store path is project input and may hold a quote.
    return {
      status: "info",
      message: `Retired secret store kept at ${shown}; Hack no longer reads it. To put it back while no store is at ${store}: mv ${quoteShellWord(path)} ${quoteShellWord(opts.storePath)}`,
    };
  });
}

/** Findings for the remaining store states (unchanged from HACK-2169). */
function storeFindings(opts: {
  readonly reason: Exclude<
    Extract<
      Awaited<ReturnType<typeof listFileSecretStoreEntries>>,
      { kind: "unreadable" }
    >["reason"],
    "key_missing" | "wrong_key_or_corrupt"
  >;
  readonly store: string;
  readonly key: string;
}): SecretIntegrityFinding[] {
  const { store, key } = opts;
  switch (opts.reason) {
    case "store_unreadable":
      return [
        {
          status: "error",
          message: `The encrypted secret store ${store} exists but cannot be read; Hack will not read or change it. Make it a regular file this user owns and can read and write (chmod 600 ${store}), then re-run hack doctor.`,
        },
      ];
    case "store_refused":
      return [
        {
          status: "error",
          message: `The encrypted secret store ${store} is a symlink, not a regular file, or too large, so Hack refuses to read or change it. Replace it with a regular file this user owns (for a symlink: copy the target's contents to ${store} with mode 600), then re-run hack doctor.`,
        },
      ];
    case "key_unreadable":
      return [
        {
          status: "error",
          message: `The key ${key} for ${store} exists but cannot be read by this user. Fix its owner and permissions (chmod 600 ${key}, owned by this user), then re-run hack doctor. Do not retire the store or provision a new key: the existing key may still open it.`,
        },
      ];
    case "key_refused":
      return [
        {
          status: "error",
          message: `The key ${key} for ${store} is refused: it is a symlink, other users can read or write it, or git tracks it. Replace it with a regular, untracked file this user owns (chmod 600 ${key}; git rm --cached if tracked, then rotate it).`,
        },
      ];
    case "incomplete_config":
      return [
        {
          status: "warn",
          message: `The cloud secrets backend has no provider configured, so ${store} cannot be checked. Set controlPlane.secrets.cloud.provider.`,
        },
      ];
    default:
      return [];
  }
}

/** Most secret names a finding lists before "and N more". */
const LISTED_SECRET_NAMES = 10;

/**
 * The `hack env` options that select one secret in one layer, without the
 * name: `--service`, `--env` and `--local` as needed.
 */
function layerOptions(opts: {
  readonly layer: ProjectEnvLayerKeyReport;
  readonly scope: string;
}): string {
  return [
    opts.scope === "global" ? null : `--service ${opts.scope}`,
    opts.layer.envName === null ? null : `--env ${opts.layer.envName}`,
    opts.layer.local ? "--local" : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" ");
}

/** Recovery steps for a layer with secrets under more than one key. */
function mixedLayerRecovery(layer: ProjectEnvLayerKeyReport): string {
  const listed = layer.unopened.slice(0, LISTED_SECRET_NAMES).map((secret) => {
    const options = layerOptions({ layer, scope: secret.scope });
    return options ? `${secret.name} (${options})` : secret.name;
  });
  const more = layer.unopened.length - listed.length;
  const names =
    more > 0 ? `${listed.join(", ")} and ${more} more` : listed.join(", ");
  return `Secrets that do not open: ${names}. To recover, read each of their values with the key that encrypted them, remove each with hack env unset <name> (with the options shown; unset needs no key), then store it again with hack env set <name> --secret.`;
}

/**
 * What could not be inspected, so its secrets are unknown, not fine
 * (HACK-2169). Fixed text and paths only.
 */
function inspectionFailureMessage(opts: {
  readonly failure: ProjectEnvLayerInspectionFailure;
  readonly path: string;
}): string {
  const where = opts.failure.inherited
    ? " (in the primary checkout, which this worktree inherits)"
    : "";
  switch (opts.failure.what) {
    case "layer":
      return `The env layer ${opts.path}${where} exists but could not be read or parsed, so its secrets were not checked. Make it a readable, valid env file inside the project (no link leading outside it), then re-run hack doctor.`;
    case "directory":
      return `The env layers in ${opts.path}${where} could not be listed, so their secrets were not checked. Make the directory readable by this user, then re-run hack doctor.`;
    default:
      return `The local env layers this linked worktree inherits from its primary checkout could not be determined (its project config or git linkage could not be read), so their secrets were not checked. Fix the project config in ${opts.path}, or turn inheritance off with worktree.inherit_local: false, then re-run hack doctor.`;
  }
}

/** Findings for env layers whose secrets do not all open under one key. */
async function inspectEnvLayers(opts: {
  readonly projectRoot: string;
  readonly projectDir: string;
}): Promise<SecretIntegrityFinding[]> {
  const inspected = await inspectProjectEnvLayerKeys(opts);
  const findings: SecretIntegrityFinding[] = inspected.failures.map(
    (failure) => ({
      status: "error",
      message: inspectionFailureMessage({
        failure,
        path: displayPath({ ...opts, path: failure.path }),
      }),
    })
  );
  for (const layer of inspected.reports) {
    const shown = displayPath({ ...opts, path: layer.path });
    // An inherited layer lives in the primary checkout: say so, since
    // `hack env` here does not change it.
    const path = layer.inherited
      ? `${shown} (in the primary checkout, which this worktree inherits; run the hack env steps below there. If this worktree's project env key differs from the primary's, the "worktree keys" check reports it: keep one key first, since values re-entered in the primary would still not open here)`
      : shown;
    const n = layer.secretCount;
    if (layer.openCount === null) {
      findings.push({
        status: "error",
        message: `${path} holds ${n} secret(s), but no project env key is available here. Copy ${PROJECT_ENV_KEY_FILENAME} (mode 600, untracked) from a checkout that has it, or set ${PROJECT_ENV_SECRET_KEY_ENV} to the same key. A new key cannot open these values.`,
      });
    } else if (layer.openCount === 0) {
      findings.push({
        status: "error",
        message: `None of the ${n} secret(s) in ${path} open under this checkout's project env key (a different key encrypted them). Restore the matching ${PROJECT_ENV_KEY_FILENAME}.`,
      });
    } else if (layer.openCount < n) {
      findings.push({
        status: "error",
        message: `${path} holds secrets under more than one key: ${layer.openCount} of ${n} open under the current project env key. This happens when a secret was added with a new key while another key was in use, and hack env set refuses to add to such a layer until it uses one key. ${mixedLayerRecovery(layer)} Values are never shown here.`,
      });
    }
  }
  return findings;
}

/**
 * Every secret integrity finding for a project, most severe first. Empty
 * when every store and env layer secret can be read with the key in use.
 */
export async function inspectSecretIntegrity(opts: {
  readonly projectRoot: string;
  readonly projectDir: string;
  readonly projectName: string;
}): Promise<readonly SecretIntegrityFinding[]> {
  const findings = [
    ...(await inspectSecretStore(opts)),
    ...(await inspectEnvLayers(opts)),
  ];
  const rank = (finding: SecretIntegrityFinding) =>
    ({ error: 0, warn: 1, info: 2 })[finding.status];
  return findings.sort((a, b) => rank(a) - rank(b));
}
