import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, readdir, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { HACK_PROJECT_DIR_PRIMARY } from "../constants.ts";
import {
  type ComposeEnvOverrideContent,
  classifyComposeEnvOverrideText,
} from "./compose-managed-env.ts";
import { isRecord } from "./guards.ts";
import { inspectLegacyComposeAdoptionSelection } from "./native-compose-adoption-marker.ts";
import {
  type ReplaceablePrivateFileOptions,
  readReplaceablePrivateFile,
  replacePrivateFileAtomic,
} from "./private-file.ts";

/**
 * At-rest ownership of `.hack/.internal/compose.env.override.yml`.
 *
 * Invariant: Hack writes this file with environment values that are only
 * `${NAME}` Compose references (see `renderComposeEnvReferenceOverride`). The
 * resolved values reach Compose through its process environment, so no
 * decrypted value is written to disk by any Compose command, including a
 * failed, interrupted or killed one. The path stays stable because Compose
 * records it in each container's `config_files` label.
 *
 * Files written by earlier Hack versions can still hold literal values. A
 * Compose command that renders the override replaces such a file, one that
 * renders none removes it, `hack down` removes it, and `hack doctor` reports
 * it with an authorized `--fix` removal. A value-free file is never removed
 * here, even when a concurrent Compose command replaces the inspected file
 * between inspection and removal: it is put back. It is absent only between
 * the move aside and the put-back, so a Compose process that opens it in that
 * moment fails and must be retried. Nothing here returns or logs a value from
 * the file.
 *
 * Exception: a saved `hack config adopt` generation pins the override's bytes
 * and inode in its integrity proof, and adopted commands never write it. While
 * such a generation exists (prepared, active or pending), nothing here removes
 * the file, because removal would make the adoption unloadable; the supported
 * way to drop its values is rollback, `hack up`, then adopting again. New
 * adoptions refuse a literal override (`hack config adopt`).
 */
export const COMPOSE_ENV_OVERRIDE_FILENAME = "compose.env.override.yml";

const REFUSAL =
  "Refused the generated Compose env override: it or .hack/.internal is a symlink or not a regular file. Remove it and retry; values omitted.";

/** Absolute path of the generated env override for a project directory. */
export function composeEnvOverridePath(opts: {
  readonly projectDir: string;
}): string {
  return resolve(opts.projectDir, ".internal", COMPOSE_ENV_OVERRIDE_FILENAME);
}

function fileOptions(path: string): ReplaceablePrivateFileOptions {
  return {
    path,
    directories: [dirname(path)],
    refusal: () => new Error(REFUSAL),
  };
}

/**
 * Writes value-free override text atomically with mode 0600 when the content
 * or the permissions differ. `text` must come from
 * `renderComposeEnvReferenceOverride`; a literal value is refused before any
 * write so a caller bug cannot put a value at rest.
 */
export async function writeComposeEnvOverride(opts: {
  readonly projectDir: string;
  readonly text: string;
  /** Clock for the stale-aside age check; tests only, no authority. */
  readonly now?: () => number;
}): Promise<string> {
  if (classifyComposeEnvOverrideText(opts.text).kind !== "references") {
    throw new Error(
      "Refused to write a Compose env override that holds literal values; values omitted."
    );
  }
  const path = composeEnvOverridePath(opts);
  await mkdir(dirname(path), { recursive: true });
  const options = fileOptions(path);
  const existing = await readReplaceablePrivateFile(options);
  if (existing?.text !== opts.text || (existing.mode & 0o077) !== 0) {
    await replacePrivateFileAtomic({ ...options, text: opts.text });
  }
  // An aside left by a crashed removal can hold values, so a rendering command
  // sweeps stale ones too, once the directory passed the symlink checks above.
  // Best effort: `hack doctor` reports what remains.
  await removeStaleAsides({ path, now: opts.now ?? Date.now }).catch(() => 0);
  return path;
}

/** At-rest state of the generated override; counts only, never values. */
export type ComposeEnvOverrideAtRest =
  | { readonly kind: "absent"; readonly path: string }
  | { readonly kind: "unreadable"; readonly path: string }
  | (ComposeEnvOverrideContent & { readonly path: string });

/**
 * Reports what the generated override holds without following a symlink. A
 * symlink or other non-regular entry is `unverifiable`.
 */
export async function inspectComposeEnvOverrideAtRest(opts: {
  readonly projectDir: string;
}): Promise<ComposeEnvOverrideAtRest> {
  const path = composeEnvOverridePath(opts);
  return { ...(await inspectEntry(path)), path };
}

async function inspectEntry(
  path: string
): Promise<
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable" }
  | ComposeEnvOverrideContent
> {
  let current: Awaited<ReturnType<typeof readReplaceablePrivateFile>>;
  try {
    current = await readReplaceablePrivateFile(fileOptions(path));
  } catch (error: unknown) {
    if (error instanceof Error && error.message === REFUSAL) {
      const info = await lstat(path).catch(() => null);
      return info ? { kind: "unverifiable" } : { kind: "absent" };
    }
    return { kind: "unreadable" };
  }
  if (current === null) {
    return { kind: "absent" };
  }
  return classifyComposeEnvOverrideText(current.text);
}

/** Private sibling that holds an entry only between its move and its unlink. */
const ASIDE_PATTERN = /^\.compose\.env\.override\.yml\.[0-9a-f-]{36}\.remove$/;
/** An aside is stale (its owner crashed) once its rename is this old. */
const STALE_ASIDE_MS = 60_000;

/**
 * Removes the override only while it still holds (or may hold) literal
 * values: `plaintext` always, `unverifiable` when `includeUnverifiable` is set.
 * Returns the state that was acted on.
 *
 * Race safety: the entry is first moved aside with one atomic rename, and the
 * moved entry itself is classified again. If a concurrent Compose command had
 * already replaced the inspected file with a value-free one, that file is put
 * back with a no-clobber link (a still newer file at the path wins), so a
 * value-free override is never removed. An aside left by a crash between the
 * move and the unlink is removed by a later call once it is stale.
 */
export async function removePlaintextComposeEnvOverride(opts: {
  readonly projectDir: string;
  readonly includeUnverifiable?: boolean;
  /** Race-test observation point between inspection and the move; no authority. */
  readonly afterInspect?: () => Promise<void>;
  /** Clock for the stale-aside age check; tests only, no authority. */
  readonly now?: () => number;
}): Promise<{
  readonly removed: boolean;
  readonly state: ComposeEnvOverrideAtRest;
  /** True when a saved adoption may pin the file, so it was kept. */
  readonly adoptionBound: boolean;
  /** Stale asides of crashed removals that this call deleted. */
  readonly asidesRemoved: number;
}> {
  const path = composeEnvOverridePath(opts);
  const asidesRemoved = await removeStaleAsides({
    path,
    now: opts.now ?? Date.now,
  });
  const eligible = (state: { readonly kind: string }) =>
    state.kind === "plaintext" ||
    (state.kind === "unverifiable" && opts.includeUnverifiable === true);
  const state = await inspectComposeEnvOverrideAtRest(opts);
  const kept = { removed: false, adoptionBound: false, asidesRemoved };
  if (!eligible(state)) {
    return { ...kept, state };
  }
  if (await composeEnvOverrideAdoptionBound(opts)) {
    return { ...kept, state, adoptionBound: true };
  }
  await opts.afterInspect?.();
  const info = await lstat(path).catch(() => null);
  if (!info || info.isDirectory()) {
    return { ...kept, state };
  }
  const aside = join(
    dirname(path),
    `.${COMPOSE_ENV_OVERRIDE_FILENAME}.${randomUUID()}.remove`
  );
  try {
    await rename(path, aside);
  } catch (error: unknown) {
    if (isRecord(error) && error.code === "ENOENT") {
      return { ...kept, state: { kind: "absent", path } };
    }
    throw error;
  }
  const movedInfo = await lstat(aside);
  const moved = await inspectEntry(aside);
  if (movedInfo.isDirectory() || !eligible(moved)) {
    await restoreAside({ aside, path, regular: movedInfo.isFile() });
    return { ...kept, state: { ...moved, path } };
  }
  await unlinkIfPresent(aside);
  return { ...kept, removed: true, state };
}

/**
 * True when a saved `hack config adopt` generation may pin the override: its
 * private state exists and is not rolled back. Prepared, active and pending
 * generations bind the file's bytes and inode in their integrity proof, so
 * removing or replacing it makes the adoption refuse to load. An adoption
 * state that cannot be read safely counts as bound. Reads the adoption
 * receipt status only; never a key or value.
 */
export async function composeEnvOverrideAdoptionBound(opts: {
  readonly projectDir: string;
}): Promise<boolean> {
  const projectDir = resolve(opts.projectDir);
  if (basename(projectDir) !== HACK_PROJECT_DIR_PRIMARY) {
    return false;
  }
  try {
    const status = await inspectLegacyComposeAdoptionSelection({
      projectRoot: dirname(projectDir),
    });
    return status !== null && status !== "rolled-back";
  } catch {
    return true;
  }
}

/** Puts a moved entry back unless a newer one already holds the path. */
async function restoreAside(opts: {
  readonly aside: string;
  readonly path: string;
  readonly regular: boolean;
}): Promise<void> {
  if (opts.regular) {
    try {
      await link(opts.aside, opts.path);
    } catch (error: unknown) {
      if (
        !(isRecord(error) && ["EEXIST", "ENOENT"].includes(String(error.code)))
      ) {
        throw error;
      }
    }
    await unlinkIfPresent(opts.aside);
    return;
  }
  if (!(await lstat(opts.path).catch(() => null))) {
    await rename(opts.aside, opts.path);
  }
}

/**
 * Removes stale regular-file asides; they are never a current override. The
 * rename that created an aside updated its ctime, so a fresh one may still
 * belong to a concurrent call and is left alone.
 */
async function removeStaleAsides(opts: {
  readonly path: string;
  readonly now: () => number;
}): Promise<number> {
  const asides = await listAsides(opts);
  for (const aside of asides.stale) {
    await unlinkIfPresent(aside);
  }
  return asides.stale.length;
}

/** Regular-file asides of crashed or in-flight removals, split by age. */
async function listAsides(opts: {
  readonly path: string;
  readonly now: () => number;
}): Promise<{ readonly stale: string[]; readonly fresh: string[] }> {
  const directory = dirname(opts.path);
  const names = await readdir(directory).catch(() => []);
  const stale: string[] = [];
  const fresh: string[] = [];
  for (const name of names) {
    if (!ASIDE_PATTERN.test(name)) {
      continue;
    }
    const aside = join(directory, name);
    const info = await lstat(aside).catch(() => null);
    if (info?.isFile()) {
      (opts.now() - info.ctimeMs > STALE_ASIDE_MS ? stale : fresh).push(aside);
    }
  }
  return { stale, fresh };
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error: unknown) {
    if (!(isRecord(error) && error.code === "ENOENT")) {
      throw error;
    }
  }
}

/**
 * Everything `hack doctor` checks about Compose env at rest. Counts only;
 * never a key or value.
 */
export type ComposeEnvAtRestReport = {
  readonly override: ComposeEnvOverrideAtRest;
  /** A saved adoption may pin the override; see {@link composeEnvOverrideAdoptionBound}. */
  readonly adoptionBound: boolean;
  /** Asides left by interrupted removals; each may hold literal values. */
  readonly asides: { readonly stale: number; readonly fresh: number };
};

/** Read-only inspection for the doctor check and its `--fix` plan. */
export async function inspectComposeEnvAtRest(opts: {
  readonly projectDir: string;
  /** Clock for the stale-aside age check; tests only, no authority. */
  readonly now?: () => number;
}): Promise<ComposeEnvAtRestReport> {
  const override = await inspectComposeEnvOverrideAtRest(opts);
  const asides = await listAsides({
    path: override.path,
    now: opts.now ?? Date.now,
  });
  return {
    override,
    adoptionBound:
      composeEnvOverrideMayHoldValues(override) &&
      (await composeEnvOverrideAdoptionBound(opts)),
    asides: { stale: asides.stale.length, fresh: asides.fresh.length },
  };
}

function composeEnvOverrideMayHoldValues(
  state: ComposeEnvOverrideAtRest
): boolean {
  return state.kind === "plaintext" || state.kind === "unverifiable";
}

/**
 * What `hack doctor --fix` may remove: the override while it may hold values
 * and no saved adoption pins it, and stale asides. A fresh aside may belong to
 * a removal still in progress and is left to that removal.
 */
export function composeEnvAtRestRepairs(report: ComposeEnvAtRestReport): {
  readonly override: boolean;
  readonly asides: boolean;
} {
  return {
    override:
      composeEnvOverrideMayHoldValues(report.override) && !report.adoptionBound,
    asides: report.asides.stale > 0,
  };
}

/** Supported way to drop values that a saved adoption pins; see the module doc. */
export const ADOPTED_COMPOSE_ENV_OVERRIDE_NEXT_STEP =
  "To drop them, stop the adopted containers ('hack down'), run 'hack config adopt --rollback', run 'hack up' so Hack rewrites the file with references only, then adopt again with 'hack config adopt --stop'.";

/**
 * Doctor status and message. Names the project-relative path and counts only;
 * never a key or value.
 */
export function describeComposeEnvAtRest(opts: {
  readonly report: ComposeEnvAtRestReport;
  readonly projectDirName: string;
}): { readonly status: "ok" | "warn"; readonly message: string } {
  const file = `${opts.projectDirName}/.internal/${COMPOSE_ENV_OVERRIDE_FILENAME}`;
  const described = describeOverride({
    state: opts.report.override,
    file,
    adoptionBound: opts.report.adoptionBound,
  });
  const asides = opts.report.asides.stale + opts.report.asides.fresh;
  if (asides === 0) {
    return described;
  }
  const leftover = `${asides} leftover removal file(s) (${opts.projectDirName}/.internal/.${COMPOSE_ENV_OVERRIDE_FILENAME}.<id>.remove) from an interrupted removal may hold env values (values omitted). Run 'hack doctor --fix' to remove those older than a minute.`;
  return {
    status: "warn",
    message:
      described.status === "ok" ? leftover : `${described.message} ${leftover}`,
  };
}

function describeOverride(opts: {
  readonly state: ComposeEnvOverrideAtRest;
  readonly file: string;
  readonly adoptionBound: boolean;
}): { readonly status: "ok" | "warn"; readonly message: string } {
  const { state, file } = opts;
  const next = opts.adoptionBound
    ? `A saved 'hack config adopt' generation pins this file, so 'hack doctor --fix' keeps it: removing it would break the adoption. ${ADOPTED_COMPOSE_ENV_OVERRIDE_NEXT_STEP}`
    : "Run 'hack doctor --fix' to remove it; Compose commands now write references only.";
  switch (state.kind) {
    case "absent":
      return { status: "ok", message: "No generated Compose env override" };
    case "references":
      return {
        status: "ok",
        message: `${file} holds env references only (no values at rest)`,
      };
    case "plaintext":
      return {
        status: "warn",
        message: `${file} holds ${state.values} literal env value(s) for ${state.services} service(s), written by an earlier Hack version (values omitted). ${next}`,
      };
    case "unverifiable":
      return {
        status: "warn",
        message: `${file} is not a Compose override Hack can verify and may hold env values (values omitted). ${next}`,
      };
    case "unreadable":
      return {
        status: "warn",
        message: `${file} could not be read, so Hack cannot confirm it holds no env values. Check its owner and permissions.`,
      };
    default:
      return state satisfies never;
  }
}
