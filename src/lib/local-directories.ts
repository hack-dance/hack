import { createHash } from "node:crypto";
import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, posix, relative, resolve, sep } from "node:path";
import { YAML } from "bun";
import { HackCliError } from "./cli-result.ts";
import { ensureDir, readTextFile, writeTextFileIfChanged } from "./fs.ts";
import { isRecord } from "./guards.ts";

/**
 * `localDirectories` in `.hack/hack.config.json` (HACK-2358): directories of
 * the checkout, relative to the project root, that services should keep on
 * the runtime's own disk instead of the shared source (for example
 * `node_modules` or build output). Each service whose source bind mount
 * covers an entry gets a volume mounted at the matching container path, so
 * installs and builds there never cross the host share. The checkout's own
 * copy of the directory is left as it is; it is only hidden from containers.
 *
 * One volume per entry and instance: every service that sees the same host
 * directory shares it (a `deps` installer and the app read the same files),
 * and Compose's per-instance project name keeps branch instances apart.
 */

export const LOCAL_DIRECTORIES_MAX = 32;
const SEGMENT = /^[A-Za-z0-9._@+-]{1,128}$/;
const RESERVED_FIRST_SEGMENTS = new Set([".git", ".hack"]);
/** Labels on every generated volume: what it holds, and that it can be pruned. */
export const LOCAL_DIRECTORY_LABEL = "hack.local-directory";
const DISPOSABLE_LABEL = "hack.cache.disposable";
const OVERRIDE_FILENAME = "compose.local-directories.override.yml";

export type LocalDirectoriesParse =
  | { readonly entries: readonly string[] }
  | { readonly error: string };

const ENTRY_RULE =
  "Project localDirectories must be a list of up to 32 distinct paths relative to the project root (no '..', no leading or trailing '/', not inside .git or .hack), none inside another.";

/**
 * Validates `localDirectories`. An invalid value is an error, not ignored:
 * a dropped entry would silently put installs back on the shared source.
 */
export function parseLocalDirectories(value: unknown): LocalDirectoriesParse {
  if (!Array.isArray(value) || value.length > LOCAL_DIRECTORIES_MAX) {
    return { error: ENTRY_RULE };
  }
  const entries: string[] = [];
  for (const raw of value) {
    const entry = typeof raw === "string" ? normalizeEntry(raw) : null;
    if (entry === null || entries.includes(entry)) {
      return { error: ENTRY_RULE };
    }
    entries.push(entry);
  }
  const nested = entries.some((entry) =>
    entries.some((other) => other !== entry && entry.startsWith(`${other}/`))
  );
  return nested ? { error: ENTRY_RULE } : { entries };
}

function normalizeEntry(entry: string): string | null {
  if (entry.length === 0 || entry.length > 256) {
    return null;
  }
  const parts = entry.split("/");
  const valid =
    parts.every(
      (part) => SEGMENT.test(part) && part !== "." && part !== ".."
    ) && !RESERVED_FIRST_SEGMENTS.has(parts[0] ?? "");
  return valid ? entry : null;
}

export type ServiceMount = {
  readonly type: "bind" | "volume" | "other";
  /** Resolved host path for a bind; the volume name otherwise. */
  readonly source: string | undefined;
  readonly target: string;
  readonly readOnly: boolean;
};

function readMount(value: unknown, composeDir: string): ServiceMount | null {
  if (typeof value === "string") {
    const parts = value.split(":");
    if (parts.length === 1) {
      return {
        type: "volume",
        source: undefined,
        target: normalizeTarget(parts[0] ?? ""),
        readOnly: false,
      };
    }
    const [source = "", target = "", mode = ""] = parts;
    return {
      type: shortSyntaxType(source),
      source:
        shortSyntaxType(source) === "bind"
          ? resolveBindSource(source, composeDir)
          : source,
      target: normalizeTarget(target),
      readOnly: mode.split(",").includes("ro"),
    };
  }
  if (!(isRecord(value) && typeof value.target === "string")) {
    return null;
  }
  const type = mountType(value.type);
  const source = typeof value.source === "string" ? value.source : undefined;
  return {
    type,
    source:
      type === "bind" && source
        ? resolveBindSource(source, composeDir)
        : source,
    target: normalizeTarget(value.target),
    readOnly: value.read_only === true,
  };
}

/**
 * Short syntax: a path is a bind, a name is a volume. A source with an
 * unresolved variable (`${PWD}/..`) is neither as far as this reader can
 * tell, so it never maps a checkout path.
 */
function shortSyntaxType(source: string): ServiceMount["type"] {
  if (source.includes("$")) {
    return "other";
  }
  return source.startsWith(".") ||
    source.startsWith("/") ||
    source.startsWith("~")
    ? "bind"
    : "volume";
}

function mountType(value: unknown): ServiceMount["type"] {
  if (value === "bind" || value === "volume") {
    return value;
  }
  return "other";
}

export function serviceMounts(
  spec: unknown,
  composeDir: string
): ServiceMount[] {
  if (!(isRecord(spec) && Array.isArray(spec.volumes))) {
    return [];
  }
  return spec.volumes
    .map((value) => readMount(value, composeDir))
    .filter((mount): mount is ServiceMount => mount !== null);
}

function resolveBindSource(
  source: string,
  composeDir: string
): string | undefined {
  // `~` depends on the engine's user, and a variable is unresolved here;
  // such a bind never maps a checkout path.
  return source.startsWith("~") || source.includes("$")
    ? undefined
    : resolve(composeDir, source);
}

/** The container path where `hostPath` appears through `bind`, if it does. */
export function containerPathFor(
  bind: ServiceMount,
  hostPath: string
): string | null {
  if (bind.type !== "bind" || bind.source === undefined) {
    return null;
  }
  const rel = relative(bind.source, hostPath);
  if (rel === "") {
    return normalizeTarget(bind.target);
  }
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return null;
  }
  return posix.join(bind.target, ...rel.split(sep));
}

export function localDirectoryVolumeName(entry: string): string {
  const slug = entry
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 40);
  const hash = createHash("sha256").update(entry).digest("hex").slice(0, 8);
  return `hack-local-${slug || "dir"}-${hash}`;
}

export type LocalDirectoryMount = {
  readonly entry: string;
  readonly volume: string;
  readonly target: string;
  readonly readOnly: boolean;
};

export type LocalDirectoriesPlan = {
  /** Service name to the volumes it gets, in entry order. */
  readonly services: Readonly<Record<string, readonly LocalDirectoryMount[]>>;
  /** Entries no service's source bind covers; nothing is mounted for them. */
  readonly unmatched: readonly string[];
  /** A service already mounts something else at the entry's path; that mount is kept. */
  readonly kept: readonly {
    readonly service: string;
    readonly entry: string;
    readonly target: string;
  }[];
  /**
   * A source bind would show the entry at `target`, but a more specific
   * mount at `by` shows something else there; nothing is mounted.
   */
  readonly hidden: readonly {
    readonly service: string;
    readonly entry: string;
    readonly target: string;
    readonly by: string;
  }[];
};

/** What one candidate path gets; see `planLocalDirectories`. */
export type LocalDirectoryDecision =
  | { readonly kind: "replace"; readonly readOnly: boolean }
  | { readonly kind: "kept" }
  | { readonly kind: "hidden"; readonly by: string };

/**
 * Maps entries onto a parsed Compose document. Pure: the caller reads the
 * file. A candidate path is decided by the mount it resolves through (the
 * most specific one at or above it):
 * - a bind that shows the entry there: the volume replaces what it shows,
 *   with that bind's access mode;
 * - another mount exactly at the path: kept, and reported;
 * - a more specific mount above the path that shows something else (a
 *   volume, or a bind of another directory): the entry is not visible there,
 *   so nothing is mounted for it.
 */
export function planLocalDirectories(opts: {
  readonly compose: unknown;
  readonly composeDir: string;
  readonly projectRoot: string;
  readonly entries: readonly string[];
}): LocalDirectoriesPlan {
  const services: Record<string, LocalDirectoryMount[]> = {};
  const kept: { service: string; entry: string; target: string }[] = [];
  const hidden: {
    service: string;
    entry: string;
    target: string;
    by: string;
  }[] = [];
  const matched = new Set<string>();
  const declared =
    isRecord(opts.compose) && isRecord(opts.compose.services)
      ? opts.compose.services
      : {};
  for (const [name, spec] of Object.entries(declared)) {
    const result = planService({
      mounts: serviceMounts(spec, opts.composeDir),
      projectRoot: opts.projectRoot,
      entries: opts.entries,
    });
    for (const entry of result.matched) {
      matched.add(entry);
    }
    for (const item of result.kept) {
      kept.push({ service: name, ...item });
    }
    for (const item of result.hidden) {
      hidden.push({ service: name, ...item });
    }
    if (result.list.length > 0) {
      services[name] = result.list;
    }
  }
  return {
    services,
    unmatched: opts.entries.filter((entry) => !matched.has(entry)),
    kept,
    hidden,
  };
}

function planService(opts: {
  readonly mounts: readonly ServiceMount[];
  readonly projectRoot: string;
  readonly entries: readonly string[];
}): {
  readonly list: LocalDirectoryMount[];
  readonly kept: { entry: string; target: string }[];
  readonly hidden: { entry: string; target: string; by: string }[];
  readonly matched: string[];
} {
  const list: LocalDirectoryMount[] = [];
  const kept: { entry: string; target: string }[] = [];
  const hidden: { entry: string; target: string; by: string }[] = [];
  const matched: string[] = [];
  for (const entry of opts.entries) {
    const hostPath = resolve(opts.projectRoot, entry);
    for (const path of entryTargets(opts.mounts, hostPath)) {
      // A bind covers the entry even where a deeper mount hides it, so it
      // is never reported as "not under a source bind".
      matched.push(entry);
      const decision = localDirectoryDecision(opts.mounts, path, hostPath);
      if (decision.kind === "hidden") {
        hidden.push({ entry, target: path, by: decision.by });
      } else if (decision.kind === "kept") {
        kept.push({ entry, target: path });
      } else if (!list.some((mount) => mount.target === path)) {
        list.push({
          entry,
          volume: localDirectoryVolumeName(entry),
          target: path,
          readOnly: decision.readOnly,
        });
      }
    }
  }
  return { list, kept, hidden, matched };
}

/** Each distinct container path where one of a service's binds would show `hostPath`. */
function entryTargets(
  mounts: readonly ServiceMount[],
  hostPath: string
): string[] {
  const paths = mounts.flatMap((bind) => {
    const path = containerPathFor(bind, hostPath);
    return path === null ? [] : [path];
  });
  return [...new Set(paths)];
}

function normalizeTarget(target: string): string {
  const normalized = posix.normalize(target);
  return normalized.length > 1 && normalized.endsWith("/")
    ? normalized.slice(0, -1)
    : normalized;
}

/**
 * The mount a container path resolves through: the one with the longest
 * target at or above it. Undefined when no mount covers the path.
 */
export function effectiveMount(
  mounts: readonly ServiceMount[],
  path: string
): ServiceMount | undefined {
  const wanted = normalizeTarget(path);
  let best: ServiceMount | undefined;
  let bestLength = -1;
  for (const mount of mounts) {
    const target = normalizeTarget(mount.target);
    const prefix = target === "/" ? "/" : `${target}/`;
    const covers = wanted === target || wanted.startsWith(prefix);
    if (covers && target.length > bestLength) {
      best = mount;
      bestLength = target.length;
    }
  }
  return best;
}

/**
 * The decision for one candidate container path of checkout directory
 * `hostPath`, shared by the planner and `hack doctor` so the hint never
 * names a directory `up` would leave alone.
 */
export function localDirectoryDecision(
  mounts: readonly ServiceMount[],
  path: string,
  hostPath: string
): LocalDirectoryDecision {
  const mount = effectiveMount(mounts, path);
  if (mount === undefined) {
    return { kind: "hidden", by: path };
  }
  const showsEntry =
    mount.type === "bind" && containerPathFor(mount, hostPath) === path;
  if (showsEntry) {
    return { kind: "replace", readOnly: mount.readOnly };
  }
  const target = normalizeTarget(mount.target);
  return target === normalizeTarget(path)
    ? { kind: "kept" }
    : { kind: "hidden", by: target };
}

/** The Compose override for a plan: service mounts plus labeled volumes. */
export function localDirectoriesOverride(
  plan: LocalDirectoriesPlan
): Record<string, unknown> | null {
  const names = Object.keys(plan.services);
  if (names.length === 0) {
    return null;
  }
  const volumes: Record<string, unknown> = {};
  const services: Record<string, unknown> = {};
  for (const name of names) {
    const mounts = plan.services[name] ?? [];
    services[name] = {
      volumes: mounts.map((mount) => ({
        type: "volume",
        source: mount.volume,
        target: mount.target,
        ...(mount.readOnly ? { read_only: true } : {}),
      })),
    };
    for (const mount of mounts) {
      volumes[mount.volume] = {
        labels: {
          [LOCAL_DIRECTORY_LABEL]: mount.entry,
          [DISPOSABLE_LABEL]: "true",
        },
      };
    }
  }
  return { services, volumes };
}

/** One line per entry this start cannot keep local, or null when there is none. */
export function localDirectoriesNotices(
  plan: LocalDirectoriesPlan,
  composeFile = "the Compose file"
): string[] {
  return [
    ...plan.unmatched.map(
      (entry) =>
        `localDirectories: no service's source bind in ${composeFile} shows ${entry}; nothing kept local for it (mounts from variables, extends, include or other -f files are not read).`
    ),
    ...plan.kept.map(
      (item) =>
        `localDirectories: service ${item.service} already mounts ${item.target}; that mount is kept for ${item.entry}.`
    ),
    ...plan.hidden.map(
      (item) =>
        `localDirectories: service ${item.service} mounts something else at ${item.by}, so ${item.entry} is not visible at ${item.target}; nothing mounted there.`
    ),
  ];
}

/**
 * Writes the Compose override for the project's `localDirectories` and
 * returns the compose file list with it appended (after Hack's other
 * overrides, so its mounts are the last word for their targets). Refuses an
 * invalid setting. No entries, or no covered service: the list unchanged.
 */
export async function withLocalDirectoriesOverride(opts: {
  readonly project: {
    readonly projectRoot: string;
    readonly projectDir: string;
    readonly composeFile: string;
  };
  readonly config: {
    readonly localDirectories?: readonly string[];
    readonly localDirectoriesError?: string;
  };
  readonly composeFiles: readonly string[];
  readonly notify?: (line: string) => void;
}): Promise<string[]> {
  if (opts.config.localDirectoriesError) {
    throw new HackCliError({
      code: "E_CONFIG_INVALID",
      message: opts.config.localDirectoriesError,
    });
  }
  const entries = opts.config.localDirectories ?? [];
  if (entries.length === 0) {
    return [...opts.composeFiles];
  }
  const text = await readTextFile(opts.project.composeFile);
  let compose: unknown = null;
  try {
    compose = text === null ? null : YAML.parse(text);
  } catch {
    // Compose reports a malformed file itself, with its own message.
    return [...opts.composeFiles];
  }
  const notFiles: string[] = [];
  for (const entry of entries) {
    if (await isNonDirectory(resolve(opts.project.projectRoot, entry))) {
      opts.notify?.(
        `localDirectories: ${entry} is a file in the checkout, not a directory; skipped.`
      );
    } else {
      notFiles.push(entry);
    }
  }
  const plan = planLocalDirectories({
    compose,
    composeDir: dirname(opts.project.composeFile),
    projectRoot: opts.project.projectRoot,
    entries: notFiles,
  });
  const composeLabel =
    relative(opts.project.projectRoot, opts.project.composeFile) ||
    opts.project.composeFile;
  for (const line of localDirectoriesNotices(plan, composeLabel)) {
    opts.notify?.(line);
  }
  const override = localDirectoriesOverride(plan);
  if (override === null) {
    return [...opts.composeFiles];
  }
  await createMountedEntries({
    projectRoot: opts.project.projectRoot,
    plan,
  });
  const internalDir = resolve(opts.project.projectDir, ".internal");
  await ensureDir(internalDir);
  const overridePath = resolve(internalDir, OVERRIDE_FILENAME);
  await writeTextFileIfChanged(overridePath, YAML.stringify(override));
  return [...opts.composeFiles, overridePath];
}

/** True when `path` exists and is (or links to) something other than a directory. */
async function isNonDirectory(path: string): Promise<boolean> {
  try {
    await lstat(path);
  } catch {
    return false;
  }
  try {
    return !(await stat(path)).isDirectory();
  } catch {
    // A dangling link: the engine cannot mount over it either.
    return true;
  }
}

/**
 * Creates each mounted entry's checkout directory as the invoking user
 * before Compose runs. On a Linux engine, a missing mountpoint inside a bind
 * would otherwise be created by the engine as root, and host tools (a host
 * `next build`, `rm -rf`) would then fail on it.
 */
async function createMountedEntries(opts: {
  readonly projectRoot: string;
  readonly plan: LocalDirectoriesPlan;
}): Promise<void> {
  const entries = new Set(
    Object.values(opts.plan.services).flatMap((mounts) =>
      mounts.map((mount) => mount.entry)
    )
  );
  const root = await realpath(opts.projectRoot).catch(() => null);
  if (root === null) {
    return;
  }
  for (const entry of entries) {
    const path = resolve(opts.projectRoot, entry);
    // Through a symlinked parent the directory could land outside the
    // checkout; leave that one to the engine.
    if (await insideCheckout({ root, path })) {
      await mkdir(path, { recursive: true });
    }
  }
}

/** True when the nearest existing ancestor of `path` resolves inside `root`. */
async function insideCheckout(opts: {
  readonly root: string;
  readonly path: string;
}): Promise<boolean> {
  let current = opts.path;
  for (;;) {
    const real = await realpath(current).catch(() => null);
    if (real !== null) {
      const rel = relative(opts.root, real);
      return !(rel.startsWith("..") || isAbsolute(rel));
    }
    const parent = dirname(current);
    if (parent === current) {
      return false;
    }
    current = parent;
  }
}
