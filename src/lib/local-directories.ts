import { createHash } from "node:crypto";
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
  "Project localDirectories must be a list of up to 32 distinct paths relative to the project root (no '..', no leading '/', not inside .git or .hack), none inside another.";

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

function normalizeEntry(raw: string): string | null {
  const entry = raw.endsWith("/") ? raw.slice(0, -1) : raw;
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
        target: parts[0] ?? "",
        readOnly: false,
      };
    }
    const [source = "", target = "", mode = ""] = parts;
    const bind =
      source.startsWith(".") ||
      source.startsWith("/") ||
      source.startsWith("~");
    return {
      type: bind ? "bind" : "volume",
      source: bind ? resolveBindSource(source, composeDir) : source,
      target,
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
    target: value.target,
    readOnly: value.read_only === true,
  };
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
  // `~` depends on the engine's user; such a bind never maps a checkout path.
  return source.startsWith("~") ? undefined : resolve(composeDir, source);
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
    return bind.target;
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
};

/**
 * Maps entries onto a parsed Compose document. Pure: the caller reads the
 * file. A service's existing mount at the same target wins unless it is a
 * bind of that same host directory, which the volume replaces (it is the
 * shared-source copy this setting moves off the share).
 */
export function planLocalDirectories(opts: {
  readonly compose: unknown;
  readonly composeDir: string;
  readonly projectRoot: string;
  readonly entries: readonly string[];
}): LocalDirectoriesPlan {
  const services: Record<string, LocalDirectoryMount[]> = {};
  const kept: { service: string; entry: string; target: string }[] = [];
  const matched = new Set<string>();
  const declared =
    isRecord(opts.compose) && isRecord(opts.compose.services)
      ? opts.compose.services
      : {};
  for (const [name, spec] of Object.entries(declared)) {
    const mounts = serviceMounts(spec, opts.composeDir);
    const list: LocalDirectoryMount[] = [];
    for (const entry of opts.entries) {
      const hostPath = resolve(opts.projectRoot, entry);
      for (const target of entryTargets(mounts, hostPath)) {
        matched.add(entry);
        if (!replaceableTarget(mounts, target.path, hostPath)) {
          kept.push({ service: name, entry, target: target.path });
        } else if (!list.some((mount) => mount.target === target.path)) {
          list.push({
            entry,
            volume: localDirectoryVolumeName(entry),
            target: target.path,
            readOnly: target.readOnly,
          });
        }
      }
    }
    if (list.length > 0) {
      services[name] = list;
    }
  }
  return {
    services,
    unmatched: opts.entries.filter((entry) => !matched.has(entry)),
    kept,
  };
}

/** Each container path where a service's binds show `hostPath`. */
function entryTargets(
  mounts: readonly ServiceMount[],
  hostPath: string
): { readonly path: string; readonly readOnly: boolean }[] {
  return mounts.flatMap((bind) => {
    const path = containerPathFor(bind, hostPath);
    return path === null ? [] : [{ path, readOnly: bind.readOnly }];
  });
}

/** Free, or the shared-source bind of this very directory. */
function replaceableTarget(
  mounts: readonly ServiceMount[],
  target: string,
  hostPath: string
): boolean {
  const existing = mounts.find((mount) => mount.target === target);
  return (
    existing === undefined ||
    (existing.type === "bind" && existing.source === hostPath)
  );
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
export function localDirectoriesNotices(plan: LocalDirectoriesPlan): string[] {
  return [
    ...plan.unmatched.map(
      (entry) =>
        `localDirectories: ${entry} is not under any service's source mount; nothing to keep local.`
    ),
    ...plan.kept.map(
      (item) =>
        `localDirectories: service ${item.service} already mounts ${item.target}; that mount is kept for ${item.entry}.`
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
  const plan = planLocalDirectories({
    compose,
    composeDir: dirname(opts.project.composeFile),
    projectRoot: opts.project.projectRoot,
    entries,
  });
  for (const line of localDirectoriesNotices(plan)) {
    opts.notify?.(line);
  }
  const override = localDirectoriesOverride(plan);
  if (override === null) {
    return [...opts.composeFiles];
  }
  const internalDir = resolve(opts.project.projectDir, ".internal");
  await ensureDir(internalDir);
  const overridePath = resolve(internalDir, OVERRIDE_FILENAME);
  await writeTextFileIfChanged(overridePath, YAML.stringify(override));
  return [...opts.composeFiles, overridePath];
}
