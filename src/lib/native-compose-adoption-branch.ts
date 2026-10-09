import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isRecord } from "./guards.ts";
import { readNativeConfigImportSourceFile } from "./native-config-import-inputs.ts";
import { parseImportDocument } from "./native-config-import-parser.ts";
import { sanitizeBranchSlug } from "./project.ts";
import { buildRuntimeHostMetadataOverride } from "./runtime-host-metadata.ts";
import { resolveVerifiedLegacyAdoptionBranch } from "./worktree-local-config.ts";

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SELECTED_PROJECT = /^[a-z0-9]+(?:-+[a-z0-9]+)*$/;
const HOST = /^[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?$/;
const HASH = /^[a-f0-9]{64}$/;

function refuse(): never {
  throw new Error(
    "Selected legacy branch identity is unsupported or changed; values omitted."
  );
}

export type LegacyComposeBranchProof = {
  readonly branch_version: 1;
  readonly branch: string;
  readonly selection: "explicit" | "worktree";
  readonly gitBranch: string | null;
  readonly composeProject: string;
  readonly directory: { readonly dev: number; readonly ino: number };
  readonly fragment: {
    readonly dev: number;
    readonly ino: number;
    readonly mode: number;
    readonly nlink: number;
    readonly size: number;
    readonly mtimeMs: number;
    readonly ctimeMs: number;
    readonly uid: number;
    readonly hash: string;
  };
};

export function legacyComposeBranchProof(
  value: unknown
): value is LegacyComposeBranchProof {
  if (
    !(
      isRecord(value) &&
      Object.keys(value).sort().join(",") ===
        "branch,branch_version,composeProject,directory,fragment,gitBranch,selection"
    )
  ) {
    return false;
  }
  if (
    !(
      value.branch_version === 1 &&
      typeof value.branch === "string" &&
      NAME.test(value.branch) &&
      (value.selection === "explicit" || value.selection === "worktree") &&
      (value.gitBranch === null || typeof value.gitBranch === "string") &&
      typeof value.composeProject === "string" &&
      SELECTED_PROJECT.test(value.composeProject) &&
      isRecord(value.directory) &&
      Object.keys(value.directory).sort().join(",") === "dev,ino" &&
      Number.isSafeInteger(value.directory.dev) &&
      Number(value.directory.dev) >= 0 &&
      Number.isSafeInteger(value.directory.ino) &&
      Number(value.directory.ino) > 0 &&
      isRecord(value.fragment) &&
      Object.keys(value.fragment).sort().join(",") ===
        "ctimeMs,dev,hash,ino,mode,mtimeMs,nlink,size,uid" &&
      typeof value.fragment.hash === "string" &&
      HASH.test(value.fragment.hash)
    )
  ) {
    return false;
  }
  const fragment = value.fragment;
  if (!isRecord(fragment)) {
    return false;
  }
  return (
    ["dev", "ino", "mode", "nlink", "size", "uid"].every(
      (key) => Number.isSafeInteger(fragment[key]) && Number(fragment[key]) >= 0
    ) &&
    Number(fragment.nlink) === 1 &&
    ["mtimeMs", "ctimeMs"].every(
      (key) =>
        typeof fragment[key] === "number" && Number.isFinite(fragment[key])
    ) &&
    ((value.selection === "worktree" &&
      typeof value.gitBranch === "string" &&
      value.gitBranch.length > 0) ||
      (value.selection === "explicit" && value.gitBranch === null))
  );
}

function autoBranch(config: Record<string, unknown>): boolean {
  if (!Object.hasOwn(config, "worktree")) {
    return true;
  }
  const worktree = config.worktree;
  if (!isRecord(worktree)) {
    refuse();
  }
  const selected = ["auto_branch", "autoBranch"].filter((key) =>
    Object.hasOwn(worktree, key)
  );
  if (
    selected.some((key) => typeof worktree[key] !== "boolean") ||
    new Set(selected.map((key) => worktree[key])).size > 1
  ) {
    refuse();
  }
  return selected.length ? worktree[selected[0] ?? ""] === true : true;
}

async function selection(opts: {
  readonly root: string;
  readonly config: Record<string, unknown>;
  readonly requestedBranch?: string;
  readonly signal?: AbortSignal;
}) {
  const requested = opts.requestedBranch;
  if (
    requested !== undefined &&
    (typeof requested !== "string" || !requested.trim())
  ) {
    refuse();
  }
  const explicit =
    requested === undefined ? null : sanitizeBranchSlug(requested.trim());
  if (requested !== undefined && !explicit) {
    refuse();
  }
  if (explicit) {
    return { branch: explicit, source: "explicit" as const, gitBranch: null };
  }
  if (!autoBranch(opts.config)) {
    return { branch: null, source: "none" as const, gitBranch: null };
  }
  const marker = await lstat(join(opts.root, ".git")).catch(
    (error: unknown) => {
      if (isRecord(error) && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  );
  if (!marker || marker.isDirectory()) {
    return { branch: null, source: "none" as const, gitBranch: null };
  }
  if (!marker.isFile()) {
    refuse();
  }
  const selected = await resolveVerifiedLegacyAdoptionBranch({
    projectRoot: opts.root,
    signal: opts.signal,
  });
  if (!selected) {
    refuse();
  }
  return { ...selected, source: "worktree" as const };
}

async function ownedBranchDirectory(path: string) {
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o022) !== 0 ||
    (await realpath(path)) !== path
  ) {
    refuse();
  }
  return info;
}

/** Read-only selected branch proof; never creates a branch, registry entry, fragment or resource. */
export async function acquireLegacyComposeBranch(opts: {
  readonly root: string;
  readonly configText: string;
  readonly composeText: string;
  readonly requestedBranch?: string;
  readonly saved?: LegacyComposeBranchProof;
  readonly signal?: AbortSignal;
}): Promise<{
  readonly proof: LegacyComposeBranchProof;
  readonly composeFiles: readonly string[];
} | null> {
  if (opts.signal?.aborted) {
    refuse();
  }
  const root = resolve(opts.root);
  if (root !== opts.root) {
    refuse();
  }
  const config = parseImportDocument({
    text: opts.configText,
    document: "config",
  }).value;
  if (!(config && typeof config.name === "string" && NAME.test(config.name))) {
    refuse();
  }
  const selected = await selection({
    root,
    config,
    requestedBranch: opts.requestedBranch,
    signal: opts.signal,
  });
  const branch = selected.branch;
  if (!branch) {
    if (opts.saved || opts.requestedBranch !== undefined) {
      refuse();
    }
    return null;
  }
  if (!(typeof config.dev_host === "string" && HOST.test(config.dev_host))) {
    refuse();
  }
  const composeProject = `${config.name}--${branch}`;
  if (!SELECTED_PROJECT.test(composeProject)) {
    refuse();
  }
  if (
    opts.saved &&
    (!legacyComposeBranchProof(opts.saved) ||
      opts.saved.branch !== branch ||
      opts.saved.composeProject !== composeProject ||
      (opts.requestedBranch === undefined &&
        (opts.saved.selection !== "worktree" ||
          opts.saved.gitBranch !== selected.gitBranch)))
  ) {
    refuse();
  }
  const directoryPath = join(root, ".hack/.branch");
  const directory = await ownedBranchDirectory(directoryPath);
  const fileName = `compose.${branch}.runtime.override.yml`;
  const entries = await readdir(directoryPath);
  if (entries.length !== 1 || entries[0] !== fileName) {
    refuse();
  }
  const path = join(directoryPath, fileName);
  const fragment = await readNativeConfigImportSourceFile({
    path,
    signal: opts.signal,
  });
  if (fragment.info.uid !== process.getuid?.()) {
    refuse();
  }
  const expected = buildRuntimeHostMetadataOverride({
    composeYamls: [opts.composeText],
    branch,
    devHost: config.dev_host,
    aliasHost: null,
    composeProject,
  });
  if (!(expected && fragment.bytes.equals(Buffer.from(expected)))) {
    refuse();
  }
  const proof: LegacyComposeBranchProof = {
    branch_version: 1,
    branch,
    selection:
      opts.saved?.selection ??
      (selected.source === "explicit" || selected.source === "worktree"
        ? selected.source
        : refuse()),
    gitBranch: opts.saved?.gitBranch ?? selected.gitBranch,
    composeProject,
    directory: { dev: directory.dev, ino: directory.ino },
    fragment: {
      dev: fragment.info.dev,
      ino: fragment.info.ino,
      mode: fragment.info.mode,
      nlink: fragment.info.nlink,
      size: fragment.info.size,
      mtimeMs: fragment.info.mtimeMs,
      ctimeMs: fragment.info.ctimeMs,
      uid: fragment.info.uid,
      hash: createHash("sha256").update(fragment.bytes).digest("hex"),
    },
  };
  if (opts.saved && JSON.stringify(proof) !== JSON.stringify(opts.saved)) {
    refuse();
  }
  if (opts.signal?.aborted) {
    refuse();
  }
  const currentDirectory = await ownedBranchDirectory(directoryPath);
  if (
    currentDirectory.dev !== directory.dev ||
    currentDirectory.ino !== directory.ino ||
    (await readdir(directoryPath)).join("\0") !== fileName
  ) {
    refuse();
  }
  const currentFragment = await readNativeConfigImportSourceFile({
    path,
    signal: opts.signal,
  });
  if (
    JSON.stringify({
      dev: currentFragment.info.dev,
      ino: currentFragment.info.ino,
      mode: currentFragment.info.mode,
      nlink: currentFragment.info.nlink,
      size: currentFragment.info.size,
      mtimeMs: currentFragment.info.mtimeMs,
      ctimeMs: currentFragment.info.ctimeMs,
      uid: currentFragment.info.uid,
      hash: createHash("sha256").update(currentFragment.bytes).digest("hex"),
    }) !== JSON.stringify(proof.fragment)
  ) {
    refuse();
  }
  return {
    proof,
    composeFiles: [join(root, ".hack/docker-compose.yml"), path],
  };
}
