import { homedir } from "node:os";
import { isAbsolute, relative, sep } from "node:path";

import { PROJECT_ENV_KEY_FILENAME } from "../constants.ts";
import {
  inspectProjectEnvLayerKeys,
  PROJECT_ENV_SECRET_KEY_ENV,
  type ProjectEnvLayerKeyReport,
} from "./project-env-config.ts";
import { listFileSecretStoreEntries } from "./secret-store.ts";

/**
 * `hack doctor`'s secret integrity findings (HACK-2169): stores and env
 * layers whose secrets cannot all be read, with recovery steps. Closed and
 * value-free: paths, counts and fixed text only, never a value or key.
 */
export type SecretIntegrityFinding = {
  readonly status: "warn" | "error";
  readonly message: string;
};

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
  const home = homedir();
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
  if (listing.kind !== "unreadable") {
    return [];
  }
  const store = displayPath({ ...opts, path: listing.storePath });
  const key = displayPath({ ...opts, path: listing.keyPath });
  switch (listing.reason) {
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
    case "key_missing":
      return [
        {
          status: "error",
          message: `The encrypted secret store ${store} has entries, but its key ${key} is missing. Restore that key file from a backup or another machine (mode 600), or set HACK_SECRETS_FILE_KEY to the same key. Do not provision a new key: it cannot open these entries.`,
        },
      ];
    case "key_refused":
      return [
        {
          status: "error",
          message: `The key ${key} for ${store} is refused: it is a symlink, other users can read or write it, or git tracks it. Replace it with a regular, untracked file this user owns (chmod 600 ${key}; git rm --cached if tracked, then rotate it).`,
        },
      ];
    case "wrong_key_or_corrupt":
      return [
        {
          status: "error",
          message: `The available key does not open the encrypted secret store ${store}, or the store is damaged. Restore the key that encrypted it (or the store from a backup); do not provision a replacement key over it.`,
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

/** Findings for env layers whose secrets do not all open under one key. */
async function inspectEnvLayers(opts: {
  readonly projectRoot: string;
  readonly projectDir: string;
}): Promise<SecretIntegrityFinding[]> {
  const findings: SecretIntegrityFinding[] = [];
  for (const layer of await inspectProjectEnvLayerKeys(opts)) {
    const shown = displayPath({ ...opts, path: layer.path });
    // An inherited layer lives in the primary checkout: say so, since
    // `hack env` here does not change it.
    const path = layer.inherited
      ? `${shown} (in the primary checkout, which this worktree inherits; run the hack env steps below there)`
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
    finding.status === "error" ? 0 : 1;
  return findings.sort((a, b) => rank(a) - rank(b));
}
