import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, opendir, realpath } from "node:fs/promises";
import { join, posix, resolve } from "node:path";
import { isRecord } from "./guards.ts";
import { legacyComposeBuildIgnore } from "./native-compose-adoption-build-ignore.ts";
import { legacyComposeAdoptionLayoutSupported } from "./native-compose-adoption-contract.ts";
import {
  type NativeConfigImportInputs,
  privateNativeConfigImportSourceProof,
  readNativeConfigImportSourceFile,
} from "./native-config-import-inputs.ts";
import {
  freezeImportValue,
  mapLegacyNativeRetainedBasicBuild,
} from "./native-config-import-plan.ts";

const MAX_ENTRIES = 256;
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_NAMES = 4096;
const MAX_DEPTH = 32;
const MAX_PROOF_BYTES = 48 * 1024;
const PRIVATE_PATHS = [
  { path: ".git", tree: true },
  { path: ".hack/.internal", tree: true },
  { path: ".hack/.branch", tree: true },
  { path: ".hack/hack.config.json", tree: false },
  { path: ".hack/docker-compose.yml", tree: false },
  { path: ".hack/hack.project.json", tree: false },
] as const;
type Source = Extract<NativeConfigImportInputs, { readonly ok: true }>;
type Identity = {
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly uid: number;
};
type File = Identity & {
  readonly path: string;
  readonly hash: string;
  readonly size: number;
};
type Node =
  | (Identity & { readonly path: string; readonly kind: "directory" })
  | (File & { readonly kind: "file" });
type Build = {
  readonly service: string;
  readonly context: string;
  readonly dockerfile: string;
  readonly target: string | null;
};
type Context = Build & {
  readonly ancestors: readonly (Identity & { readonly path: string })[];
  readonly definition: File;
  readonly ignores: readonly {
    readonly path: string;
    readonly file: File | null;
  }[];
  readonly effectiveIgnore: string | null;
  readonly nodes: readonly Node[];
};
type Budget = { entries: number; bytes: number; names: number };

/** Private current raw-byte provenance, never a report, label, log or builder input. */
export type LegacyComposeBuildSourceProof = {
  readonly build_source_version: 1;
  readonly contexts: readonly Context[];
};
function refuse(): never {
  throw new Error(
    "Legacy retained build source is unsupported, unsafe or changed; values omitted."
  );
}
function check(signal?: AbortSignal) {
  if (signal?.aborted) {
    refuse();
  }
}
function refusePrivateMaterial(root: string, path: string) {
  const relative = posix.relative(root, path);
  if (
    [".env", ".hack/.env", ".hack/hack.local.json"].includes(relative) ||
    /^\.hack\/hack\.env(?:\.|$)/.test(relative)
  ) {
    refuse();
  }
}
async function requireLayout(opts: {
  readonly root: string;
  readonly candidate: unknown;
  readonly signal?: AbortSignal;
}) {
  if (
    !(await legacyComposeAdoptionLayoutSupported({
      projectRoot: opts.root,
      candidate: opts.candidate,
      signal: opts.signal,
    }))
  ) {
    refuse();
  }
}
function identity(info: Stats): Identity {
  if (
    info.uid !== process.getuid?.() ||
    (info.mode & 0o022) !== 0 ||
    !(info.mode & 0o444)
  ) {
    refuse();
  }
  return { dev: info.dev, ino: info.ino, mode: info.mode, uid: info.uid };
}
function pathSupported(path: string) {
  return (
    path.length > 0 &&
    path.length <= 1024 &&
    path.split("/").length <= MAX_DEPTH &&
    posix.normalize(path) === path &&
    !path.startsWith("/") &&
    path !== ".." &&
    !path.startsWith("../") &&
    !path.includes("$") &&
    !/[\\\0\r\n]/.test(path)
  );
}
function selectedBuilds(candidate: unknown): readonly Build[] {
  if (!(isRecord(candidate) && isRecord(candidate.services))) {
    refuse();
  }
  const result: Build[] = [];
  for (const [service, value] of Object.entries(candidate.services)) {
    if (!isRecord(value)) {
      refuse();
    }
    // These other version owners cannot be implicitly combined with a new proof.
    if (
      Object.hasOwn(value, "profiles") ||
      Object.hasOwn(value, "depends_on") ||
      Object.hasOwn(value, "readiness")
    ) {
      refuse();
    }
    if (!Object.hasOwn(value, "build")) {
      continue;
    }
    // The retained start owner never invokes a builder. Explicit build policy
    // requires a new image even when one exists, so it cannot be honored here.
    if (Object.hasOwn(value, "pull_policy")) {
      refuse();
    }
    const build = value.build;
    if (
      !(
        isRecord(build) &&
        typeof build.context === "string" &&
        pathSupported(build.context)
      )
    ) {
      refuse();
    }
    if (
      PRIVATE_PATHS.some(
        (owned) =>
          build.context === owned.path ||
          build.context.startsWith(`${owned.path}/`)
      )
    ) {
      refuse();
    }
    const dockerfile = build.dockerfile ?? "Dockerfile";
    const target = build.target ?? null;
    if (
      typeof dockerfile !== "string" ||
      !pathSupported(dockerfile) ||
      dockerfile === "." ||
      (target !== null && typeof target !== "string")
    ) {
      refuse();
    }
    const definitionPath = posix.join(build.context, dockerfile);
    if (
      PRIVATE_PATHS.some(
        (owned) =>
          definitionPath === owned.path ||
          (owned.tree && definitionPath.startsWith(`${owned.path}/`))
      )
    ) {
      refuse();
    }
    result.push({ service, context: build.context, dockerfile, target });
  }
  if (!result.length || result.length > 16) {
    refuse();
  }
  return result.sort((left, right) =>
    left.service.localeCompare(right.service)
  );
}
async function directory(path: string, signal?: AbortSignal) {
  check(signal);
  const info = await lstat(path);
  if (!info.isDirectory() || (await realpath(path)) !== path) {
    refuse();
  }
  return identity(info);
}
async function names(path: string, budget: Budget, signal?: AbortSignal) {
  const selected: string[] = [];
  const reader = await opendir(path);
  for await (const entry of reader) {
    check(signal);
    if (
      ++budget.names > MAX_NAMES ||
      entry.name.includes("\n") ||
      entry.name.includes("\r")
    ) {
      refuse();
    }
    selected.push(entry.name);
  }
  return selected.sort();
}
async function optionalFile(path: string, signal?: AbortSignal) {
  try {
    await lstat(path);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  return readNativeConfigImportSourceFile({ path, signal });
}
function requireExcluded(
  context: string,
  ignore: ReturnType<typeof legacyComposeBuildIgnore>
) {
  for (const owned of PRIVATE_PATHS) {
    if (context === owned.path || context.startsWith(`${owned.path}/`)) {
      refuse();
    }
    const relative = posix.relative(context, owned.path);
    if (relative === ".." || relative.startsWith("../")) {
      continue;
    }
    if (
      !(owned.tree
        ? ignore.subtreeExcluded(relative)
        : ignore.excluded(relative))
    ) {
      refuse();
    }
  }
}
async function captureContext(opts: {
  readonly root: string;
  readonly build: Build;
  readonly signal?: AbortSignal;
  readonly budget: Budget;
}): Promise<Context> {
  const { root, build, signal, budget } = opts;
  const base = resolve(root, build.context);
  const ancestors = new Map<string, Identity>();
  const checks: (() => Promise<void>)[] = [];
  async function pinDirectory(path: string) {
    refusePrivateMaterial(root, path);
    const before = await directory(path, signal);
    const relative = posix.relative(root, path) || ".";
    const held = ancestors.get(relative);
    if (held && JSON.stringify(held) !== JSON.stringify(before)) {
      refuse();
    }
    ancestors.set(relative, before);
    checks.push(async () => {
      if (
        JSON.stringify(await directory(path, signal)) !== JSON.stringify(before)
      ) {
        refuse();
      }
    });
    return before;
  }
  let ancestor = root;
  await pinDirectory(ancestor);
  for (const part of build.context === "." ? [] : build.context.split("/")) {
    ancestor = join(ancestor, part);
    await pinDirectory(ancestor);
  }
  async function pinFile(relative: string, optional = false) {
    let parent = base;
    for (const part of relative.split("/").slice(0, -1)) {
      parent = join(parent, part);
      await pinDirectory(parent);
    }
    const path = join(base, relative);
    // A known private input added after the names-only precheck must never be
    // opened as context material. The final layout check still refuses drift.
    refusePrivateMaterial(root, path);
    const read = optional
      ? await optionalFile(path, signal)
      : await readNativeConfigImportSourceFile({ path, signal });
    checks.push(async () => {
      if (!read) {
        if (await optionalFile(path, signal)) {
          refuse();
        }
        return;
      }
      const info = await lstat(path);
      if (
        !info.isFile() ||
        JSON.stringify(identity(info)) !==
          JSON.stringify(identity(read.info)) ||
        info.nlink !== 1 ||
        info.size !== read.info.size ||
        info.mtimeMs !== read.info.mtimeMs ||
        info.ctimeMs !== read.info.ctimeMs
      ) {
        refuse();
      }
    });
    if (!read) {
      return null;
    }
    budget.bytes += read.bytes.byteLength;
    budget.entries += 1;
    if (budget.bytes > MAX_BYTES || budget.entries > MAX_ENTRIES) {
      refuse();
    }
    return {
      file: {
        path: relative,
        ...identity(read.info),
        hash: createHash("sha256").update(read.bytes).digest("hex"),
        size: read.bytes.byteLength,
      },
      bytes: read.bytes,
    };
  }
  const definition = await pinFile(build.dockerfile);
  if (!definition) {
    refuse();
  }
  const rootIgnore = await pinFile(".dockerignore", true);
  const specificPath = `${build.dockerfile}.dockerignore`;
  const specificIgnore = await pinFile(specificPath, true);
  const effective = specificIgnore ?? rootIgnore;
  // Shadowing does not hide an unqualified ignore grammar from this first slice.
  for (const selected of [rootIgnore, specificIgnore]) {
    if (selected) {
      legacyComposeBuildIgnore(
        new TextDecoder("utf-8", { fatal: true }).decode(selected.bytes)
      );
    }
  }
  const ignore = legacyComposeBuildIgnore(
    effective
      ? new TextDecoder("utf-8", { fatal: true }).decode(effective.bytes)
      : ""
  );
  requireExcluded(build.context, ignore);
  const nodes: Node[] = [];
  async function walk(path: string, relative: string, depth: number) {
    check(signal);
    if (depth > MAX_DEPTH || ++budget.entries > MAX_ENTRIES) {
      refuse();
    }
    const before = await pinDirectory(path);
    nodes.push({ path: relative, kind: "directory", ...before });
    const selectedNames = async () =>
      (await names(path, budget, signal)).filter(
        (name) =>
          !ignore.subtreeExcluded(relative ? `${relative}/${name}` : name)
      );
    const entries = await selectedNames();
    for (const name of entries) {
      const selected = join(path, name);
      const nodePath = relative ? `${relative}/${name}` : name;
      const info = await lstat(selected);
      if (info.isDirectory()) {
        await walk(selected, nodePath, depth + 1);
      } else if (info.isFile() && !ignore.excluded(nodePath)) {
        const read = await pinFile(nodePath);
        if (!read) {
          refuse();
        }
        nodes.push({ ...read.file, kind: "file" });
      } else if (!info.isFile()) {
        refuse();
      }
    }
    // Excluded output creation does not change the projected names. Included
    // additions/removals and ancestor replacement still refuse this acquisition.
    if (
      JSON.stringify(before) !==
        JSON.stringify(await directory(path, signal)) ||
      JSON.stringify(entries) !== JSON.stringify(await selectedNames())
    ) {
      refuse();
    }
  }
  await walk(base, "", 0);
  for (const recheck of checks) {
    check(signal);
    await recheck();
  }
  return {
    ...build,
    ancestors: [...ancestors.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, held]) => ({ path, ...held })),
    definition: definition.file,
    ignores: [
      { path: ".dockerignore", file: rootIgnore?.file ?? null },
      { path: specificPath, file: specificIgnore?.file ?? null },
    ],
    effectiveIgnore: specificIgnore
      ? specificPath
      : rootIgnore
        ? ".dockerignore"
        : null,
    nodes,
  };
}
async function capture(opts: {
  readonly root: string;
  readonly candidate: unknown;
  readonly signal?: AbortSignal;
}): Promise<LegacyComposeBuildSourceProof> {
  const contexts: Context[] = [];
  const budget: Budget = { entries: 0, bytes: 0, names: 0 };
  for (const build of selectedBuilds(opts.candidate)) {
    contexts.push(
      await captureContext({
        root: opts.root,
        build,
        signal: opts.signal,
        budget,
      })
    );
  }
  const proof: LegacyComposeBuildSourceProof = {
    build_source_version: 1,
    contexts,
  };
  if (Buffer.byteLength(JSON.stringify(proof)) > MAX_PROOF_BYTES) {
    refuse();
  }
  freezeImportValue(proof);
  return proof;
}

/**
 * Same-issued authored acquisition plus bounded included context provenance.
 * Neither this proof nor config-hash attests the image's historical build input.
 * Hidden proof/candidate/callbacks authorize no builder or engine effect.
 */
export async function acquireLegacyComposeBuildSource(opts: {
  readonly source: Source;
  readonly signal?: AbortSignal;
}) {
  try {
    const { source, signal } = opts;
    if (signal !== undefined && !(signal instanceof AbortSignal)) {
      refuse();
    }
    privateNativeConfigImportSourceProof(source);
    const candidate = mapLegacyNativeRetainedBasicBuild(source).candidate;
    if (!candidate) {
      refuse();
    }
    selectedBuilds(candidate);
    await requireLayout({ root: source.projectRoot, candidate, signal });
    await source.assertFresh({ signal });
    const proof = await capture({
      root: source.projectRoot,
      candidate,
      signal,
    });
    const assertFresh = async (current?: { readonly signal?: AbortSignal }) => {
      try {
        const selected =
          signal && current?.signal
            ? AbortSignal.any([signal, current.signal])
            : (current?.signal ?? signal);
        await requireLayout({
          root: source.projectRoot,
          candidate,
          signal: selected,
        });
        await source.assertFresh({ signal: selected });
        if (
          JSON.stringify(
            await capture({
              root: source.projectRoot,
              candidate,
              signal: selected,
            })
          ) !== JSON.stringify(proof)
        ) {
          refuse();
        }
        await source.assertFresh({ signal: selected });
        await requireLayout({
          root: source.projectRoot,
          candidate,
          signal: selected,
        });
      } catch {
        refuse();
      }
    };
    await assertFresh();
    const result = { candidate, proof, assertFresh };
    for (const key of Object.keys(result)) {
      Object.defineProperty(result, key, { enumerable: false });
    }
    return Object.freeze(result);
  } catch {
    refuse();
  }
}

/** Key-free saved read pins included bytes/identity and optional ignore presence. */
export async function assertSavedLegacyComposeBuildSource(opts: {
  readonly projectRoot: string;
  readonly configText: string;
  readonly composeText: string;
  readonly proof: unknown;
  readonly signal?: AbortSignal;
  readonly checkOwner: () => Promise<void>;
}) {
  try {
    const { projectRoot, configText, composeText, signal, checkOwner } = opts;
    const saved = JSON.stringify(opts.proof);
    if (
      typeof saved !== "string" ||
      Buffer.byteLength(saved) > MAX_PROOF_BYTES
    ) {
      refuse();
    }
    const candidate = mapLegacyNativeRetainedBasicBuild({
      configText,
      composeText,
    }).candidate;
    if (!candidate) {
      refuse();
    }
    await checkOwner();
    await requireLayout({ root: projectRoot, candidate, signal });
    if (
      JSON.stringify(
        await capture({ root: projectRoot, candidate, signal })
      ) !== saved
    ) {
      refuse();
    }
    await checkOwner();
    await requireLayout({ root: projectRoot, candidate, signal });
  } catch {
    refuse();
  }
}
