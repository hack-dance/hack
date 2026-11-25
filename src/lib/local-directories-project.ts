import { resolve } from "node:path";
import { YAML } from "bun";
import { HACK_PROJECT_DIR_PRIMARY } from "../constants.ts";
import { HackCliError } from "./cli-result.ts";
import { ensureDir, readTextFile, writeTextFileIfChanged } from "./fs.ts";
import { isRecord } from "./guards.ts";
import {
  planProjectLocalDirectories,
  withLocalDirectoriesOverride,
} from "./local-directories.ts";
import {
  type ProjectContext,
  readProjectConfig,
  readProjectConfigFiles,
} from "./project.ts";

/**
 * Appends the project's `localDirectories` override (HACK-2358) to a Compose
 * file chain, reading `.hack/hack.config.json`. Refuses an invalid setting
 * with `E_CONFIG_INVALID`; `notify` gets one line per entry it cannot keep
 * local.
 */
export async function withProjectLocalDirectories(opts: {
  readonly project: ProjectContext;
  readonly composeFiles: readonly string[];
  readonly notify?: (line: string) => void;
}): Promise<string[]> {
  return await withLocalDirectoriesOverride({
    project: opts.project,
    config: await readProjectConfig(opts.project),
    composeFiles: opts.composeFiles,
    notify: opts.notify,
  });
}

/**
 * Native `up` and `restart` (HACK-2358): refuses an invalid
 * `localDirectories` before anything starts or stops, and prints the same
 * notices as Compose. The native start applies the plan itself; this only
 * reports it, in the foreground (a detached owner's output is not shown, so
 * the launcher calls this before it starts the owner).
 */
export async function reportNativeLocalDirectories(opts: {
  readonly project: ProjectContext;
  readonly warn: (line: string) => void;
}): Promise<void> {
  const { notices } = await nativeLocalDirectoriesState(opts.project);
  for (const line of notices) {
    opts.warn(line);
  }
}

/**
 * The plan's notices and its signature: one value-free line per planned
 * mount (`service target volume[ ro]`), sorted. Refuses an invalid setting.
 */
export async function nativeLocalDirectoriesState(
  project: ProjectContext
): Promise<{ readonly notices: string[]; readonly signature: string[] }> {
  const config = await readProjectConfig(project);
  if (config.localDirectoriesError) {
    throw new HackCliError({
      code: "E_CONFIG_INVALID",
      message: config.localDirectoriesError,
    });
  }
  const entries = config.localDirectories ?? [];
  if (entries.length === 0) {
    return { notices: [], signature: [] };
  }
  const text = await readTextFile(project.composeFile);
  let compose: unknown = null;
  try {
    compose = text === null ? null : YAML.parse(text);
  } catch {
    // Native start reports an unreadable Compose file itself.
    return { notices: [], signature: [] };
  }
  const { plan, notices } = await planProjectLocalDirectories({
    projectRoot: project.projectRoot,
    composeFile: project.composeFile,
    compose,
    entries,
  });
  const signature = Object.entries(plan.services)
    .flatMap(([service, mounts]) =>
      mounts.map(
        (mount) =>
          `${service} ${mount.target} ${mount.volume}${mount.readOnly ? " ro" : ""}`
      )
    )
    .sort();
  return { notices, signature };
}

/** `.hack/.internal/native-local-directories.json`: what each instance's run started with. */
const RECORD_FILE = "native-local-directories.json";

type LocalDirectoriesRecord = {
  readonly version: 1;
  readonly instances: Record<string, readonly string[]>;
};

async function readRecord(projectDir: string): Promise<LocalDirectoriesRecord> {
  const text = await readTextFile(
    resolve(projectDir, ".internal", RECORD_FILE)
  );
  try {
    const value: unknown = text === null ? null : JSON.parse(text);
    if (
      typeof value === "object" &&
      value !== null &&
      (value as { version?: unknown }).version === 1 &&
      isRecord((value as { instances?: unknown }).instances)
    ) {
      return value as LocalDirectoriesRecord;
    }
  } catch {
    // A damaged record is no record.
  }
  return { version: 1, instances: {} };
}

function instanceKey(branch: string | null | undefined): string {
  return branch ?? "";
}

export const NATIVE_LOCAL_DIRECTORIES_CHANGED_NOTICE =
  "localDirectories: the declared directories changed since this run started; run hack restart to apply them.";
export const NATIVE_LOCAL_DIRECTORIES_APPLIED_NOTICE =
  "localDirectories: this restart applies the changed declared directories.";

function sameSignature(
  left: readonly string[],
  right: readonly string[]
): boolean {
  return (
    left.length === right.length && left.every((line, i) => line === right[i])
  );
}

/**
 * Native `up`, `restart` and the `up` that finds its run already running
 * (HACK-2358): compares the current plan with what this instance's run
 * started with, says so when they differ, and records the plan a start or
 * restart launches. The record is best-effort: one that cannot be read or
 * written only loses the message, never the start. An invalid
 * `localDirectories` still refuses here, as on every other path.
 *
 * Known limit: the record is written when a start or restart is launched,
 * not when it is confirmed, so a launch that then fails leaves a record of a
 * plan that is not running; only the next "changed" or "applies" message is
 * affected, never what runs.
 */
export async function trackNativeLocalDirectories(opts: {
  readonly project: ProjectContext;
  readonly branch: string | null | undefined;
  readonly mode: "start" | "restart" | "running";
  readonly warn: (line: string) => void;
}): Promise<void> {
  const { signature } = await nativeLocalDirectoriesState(opts.project);
  const record = await readRecord(opts.project.projectDir).catch(() => ({
    version: 1 as const,
    instances: {} as Record<string, readonly string[]>,
  }));
  const key = instanceKey(opts.branch);
  // Own entries only: a branch named like an Object property (`constructor`)
  // must not read the prototype's value.
  const saved = Object.hasOwn(record.instances, key)
    ? record.instances[key]
    : undefined;
  const previous =
    Array.isArray(saved) && saved.every((line) => typeof line === "string")
      ? saved
      : undefined;
  // No record: the run started without the setting (or before native
  // applied it), so it has none of these volumes; any planned mount is a
  // change. A project that never declares the setting writes no record.
  const changed =
    previous === undefined
      ? signature.length > 0
      : !sameSignature(previous, signature);
  if (opts.mode === "running") {
    if (changed) {
      opts.warn(NATIVE_LOCAL_DIRECTORIES_CHANGED_NOTICE);
    }
    return;
  }
  if (opts.mode === "restart" && changed) {
    opts.warn(NATIVE_LOCAL_DIRECTORIES_APPLIED_NOTICE);
  }
  if (previous === undefined && signature.length === 0) {
    return;
  }
  const next: LocalDirectoriesRecord = {
    version: 1,
    instances: { ...record.instances, [key]: signature },
  };
  try {
    const dir = resolve(opts.project.projectDir, ".internal");
    await ensureDir(dir, 0o700);
    await writeTextFileIfChanged(
      resolve(dir, RECORD_FILE),
      `${JSON.stringify(next, null, 2)}\n`,
      0o600
    );
  } catch {
    // Best-effort: only the next comparison is lost.
  }
}

/**
 * Adopted, authored and imported native projects do not read
 * `localDirectories`: `up` and `restart` say so once, instead of silently
 * leaving installs on the shared source.
 */
export async function warnLocalDirectoriesNotApplied(opts: {
  readonly projectRoot: string;
  readonly kind: string;
  readonly warn: (line: string) => void;
}): Promise<void> {
  const config = await readProjectConfigFiles(
    resolve(opts.projectRoot, HACK_PROJECT_DIR_PRIMARY)
  ).catch(() => null);
  if (config === null) {
    return;
  }
  if (
    (config.localDirectories?.length ?? 0) > 0 ||
    config.localDirectoriesError
  ) {
    opts.warn(
      `localDirectories is not applied to ${opts.kind} projects on the native backend; services keep those directories on the shared source.`
    );
  }
}
