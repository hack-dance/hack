import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { ClosedCliError } from "./cli-result.ts";
import { resolveGlobalHackDir } from "./config-paths.ts";
import { withEnvLayerLock } from "./env-layer-lock.ts";
import {
  migrationDigest as digest,
  readMigrationFile as readState,
  migrationRefusal as refuse,
  sameMigrationFile as same,
} from "./env-migration-files.ts";
import {
  purgeMigrationPayloads,
  stageMigrationPayloads,
} from "./env-migration-payloads.ts";
import type {
  EnvMigrationFileState,
  EnvMigrationSnapshots,
} from "./env-migration-snapshot.ts";
import { envMigrationSnapshots } from "./env-migration-snapshot.ts";
import { isRecord } from "./guards.ts";
import {
  ensurePrivateDirectory,
  replacePrivateFileAtomic,
} from "./private-file.ts";
import {
  acquireLegacyEnvCleanupContext,
  assertMachineLocalFileGitPrivate,
  assertProjectEnvLayerPaths,
  isGitTrackedOrUnknownProjectPath,
  LegacyEnvCleanupError,
  type LegacyProjectEnvMigration,
  type PreparedLegacyEnvMigration,
  prepareLegacyEnvCleanupConfig,
  prepareLegacyProjectEnvMigration,
  removeLegacyProjectEnvArtifacts,
  resolveProjectEnvConfig,
  resolveProjectEnvSharedKeyLocation,
} from "./project-env-config.ts";
import { withProjectsRegistryLock } from "./projects-registry-lock.ts";

export const ENV_MIGRATION_VERSION = 1 as const;
const FILE_LIMIT = 32 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const PAYLOAD_NAME = /^[0-9]+\.payload$/;
const ENV_KEY = /^[A-Z_][A-Z0-9_]*$/;

export type EnvMigrationProject = {
  readonly projectRoot: string;
  readonly projectDir: string;
  readonly projectName: string;
  readonly serviceNames: readonly string[];
};

export type EnvMigrationPreview = {
  readonly version: 1;
  readonly project: EnvMigrationProject;
  readonly status: "ready" | "complete" | "recovery_required";
  readonly files: readonly {
    readonly path: string;
    readonly action: "write" | "change" | "removable";
    readonly keys: readonly string[];
    readonly tracked: boolean;
  }[];
  readonly journalPath: string;
};

type Publication = EnvMigrationFileState & {
  readonly kind: PreparedLegacyEnvMigration["files"][number]["kind"];
  readonly keys: readonly string[];
  readonly before: EnvMigrationFileState;
  readonly payload: string;
  readonly done: boolean;
};

type Journal = {
  readonly version: 1;
  readonly kind: "hack-env-migration";
  readonly project: EnvMigrationProject;
  readonly manifestPath: string;
  readonly state:
    | "applying"
    | "complete"
    | "cleaning"
    | "cleaned"
    | "rolled_back"
    | "rolling_back";
  readonly sources: readonly EnvMigrationFileState[];
  readonly writes: readonly Publication[];
  readonly removable: readonly string[];
  readonly overlayNames: readonly string[];
  readonly store?: { readonly path: string; readonly keyPath: string };
  readonly removed: readonly string[];
  /** Layer revision observed after a complete project startup succeeded. */
  readonly validated?: readonly EnvMigrationFileState[];
  readonly cleanupConfig?: Publication;
};

/** Test-only scheduling seam; events contain no payloads and production does not consult env flags. */
export type EnvMigrationHooks = {
  readonly boundary?: (event: {
    readonly phase:
      | "prepared"
      | "before_publish"
      | "published"
      | "recorded"
      | "verified"
      | "complete";
    readonly index: number;
  }) => Promise<void>;
};

async function canonicalProject(
  project: EnvMigrationProject
): Promise<EnvMigrationProject> {
  const projectRoot = await realpath(project.projectRoot);
  const projectDir = await realpath(project.projectDir);
  if (
    ![".hack", ".dev"].some((name) => projectDir === join(projectRoot, name))
  ) {
    throw refuse();
  }
  return {
    projectRoot,
    projectDir,
    projectName: project.projectName,
    serviceNames: [...project.serviceNames],
  };
}

/** Location calculation is read-only, including when the data home has not been created. */
export function envMigrationJournalPath(projectRoot: string): string {
  const id = createHash("sha256").update(projectRoot).digest("hex");
  return join(resolveGlobalHackDir(), "env-migrations", id, "journal.json");
}

/** Implicit routes must resume a journal even after its first YAML file exists. */
export async function hasPendingEnvMigration(input: {
  readonly projectRoot: string;
  readonly projectDir: string;
}): Promise<boolean> {
  const project = await canonicalProject({
    ...input,
    projectName: "project",
    serviceNames: [],
  });
  const state = (
    await readJournal(envMigrationJournalPath(project.projectRoot), project)
  )?.state;
  return state === "applying" || state === "rolling_back";
}

/** A partial YAML publication must never become ordinary command input. */
export async function assertEnvMigrationFinished(input: {
  readonly projectRoot: string;
  readonly projectDir: string;
}): Promise<void> {
  if (await hasPendingEnvMigration(input)) {
    throw new ClosedCliError(
      "An env migration is unfinished. Resume with hack env migrate --apply (add --accept-tracked-env-changes for its tracked edits), or use its rollback manifest. No project command was run."
    );
  }
}

async function assertOutsideWorkingTrees(
  path: string,
  project: EnvMigrationProject
): Promise<void> {
  if (!isAbsolute(path)) {
    throw new ClosedCliError(
      "Env migration requires private journal and snapshot storage outside Git working trees. Choose a HACK_HOME outside your repositories; preview remains read-only."
    );
  }
  const inside = relative(project.projectRoot, path);
  if (
    !(inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside))
  ) {
    throw new ClosedCliError(
      "Env migration requires private journal and snapshot storage outside Git working trees. Choose a HACK_HOME outside your repositories; preview remains read-only."
    );
  }
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    for (const name of [".git"]) {
      try {
        await lstat(join(parent, name));
        throw new ClosedCliError(
          "Env migration requires private journal and snapshot storage outside Git working trees. Choose a HACK_HOME outside your repositories; preview remains read-only."
        );
      } catch (error) {
        if (!(isRecord(error) && error.code === "ENOENT")) {
          throw error;
        }
      }
    }
    if (dirname(parent) === parent) {
      break;
    }
  }
}

async function privateDirectory(path: string): Promise<void> {
  await ensurePrivateDirectory(path);
  await checkPrivateDirectory(path);
}

async function checkPrivateDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0 ||
    (await realpath(path)) !== path
  ) {
    throw refuse();
  }
}

async function writeMetadata(path: string, value: unknown): Promise<void> {
  await replacePrivateFileAtomic({
    path,
    directories: [dirname(path)],
    text: `${JSON.stringify(value, null, 2)}\n`,
    mode: 0o600,
    refusal: refuse,
  });
}

function validState(
  raw: unknown
): raw is EnvMigrationFileState & Record<string, unknown> {
  return (
    isRecord(raw) &&
    typeof raw.path === "string" &&
    isAbsolute(raw.path) &&
    (raw.sha256 === null ||
      (typeof raw.sha256 === "string" && SHA256.test(raw.sha256))) &&
    (raw.mode === null ||
      (Number.isInteger(raw.mode) &&
        Number(raw.mode) >= 0 &&
        Number(raw.mode) <= 0o777)) &&
    Number.isSafeInteger(raw.size) &&
    Number(raw.size) >= 0 &&
    Number(raw.size) <= FILE_LIMIT
  );
}

function validPublication(entry: unknown, path: string): entry is Publication {
  return (
    validState(entry) &&
    validState(entry.before) &&
    entry.before.path === entry.path &&
    entry.sha256 !== null &&
    typeof entry.payload === "string" &&
    isAbsolute(entry.payload) &&
    dirname(dirname(entry.payload)) === dirname(path) &&
    basename(dirname(entry.payload)).startsWith("payloads-") &&
    PAYLOAD_NAME.test(basename(entry.payload)) &&
    ["ignore", "key", "local_layer", "layer", "config", "compose"].includes(
      String(entry.kind)
    ) &&
    typeof entry.done === "boolean" &&
    Array.isArray(entry.keys) &&
    entry.keys.every((key) => typeof key === "string" && ENV_KEY.test(key))
  );
}

async function readJournal(
  path: string,
  project: EnvMigrationProject
): Promise<Journal | null> {
  const read = await readState(path);
  if (read.text === null) {
    return null;
  }
  await checkPrivateDirectory(dirname(path));
  await checkPrivateDirectory(dirname(dirname(path)));
  const info = await lstat(path);
  if (
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0 ||
    info.nlink !== 1
  ) {
    throw refuse();
  }
  let raw: unknown;
  try {
    raw = JSON.parse(read.text);
  } catch {
    throw refuse();
  }
  if (
    !(
      isRecord(raw) &&
      raw.version === 1 &&
      raw.kind === "hack-env-migration" &&
      isRecord(raw.project) &&
      raw.project.projectRoot === project.projectRoot &&
      raw.project.projectDir === project.projectDir &&
      typeof raw.manifestPath === "string" &&
      isAbsolute(raw.manifestPath) &&
      [
        "applying",
        "complete",
        "cleaning",
        "cleaned",
        "rolled_back",
        "rolling_back",
      ].includes(String(raw.state)) &&
      Array.isArray(raw.sources) &&
      raw.sources.every(validState) &&
      Array.isArray(raw.writes) &&
      raw.writes.every((entry) => validPublication(entry, path)) &&
      Array.isArray(raw.removable) &&
      raw.removable.every(
        (entry) => typeof entry === "string" && isAbsolute(entry)
      ) &&
      Array.isArray(raw.removed) &&
      raw.removed.every(
        (entry) => Array.isArray(raw.removable) && raw.removable.includes(entry)
      ) &&
      Array.isArray(raw.overlayNames) &&
      raw.overlayNames.every((entry) => typeof entry === "string") &&
      (raw.validated === undefined ||
        (Array.isArray(raw.validated) && raw.validated.every(validState))) &&
      (raw.cleanupConfig === undefined ||
        (validPublication(raw.cleanupConfig, path) &&
          raw.cleanupConfig.kind === "config" &&
          raw.cleanupConfig.path ===
            join(project.projectDir, "hack.config.json")))
    )
  ) {
    throw refuse();
  }
  // The validated wire shape contains metadata only; no source text is accepted.
  return raw as Journal;
}

async function previewPrepared(
  project: EnvMigrationProject,
  prepared: PreparedLegacyEnvMigration,
  path: string
): Promise<EnvMigrationPreview> {
  const files: EnvMigrationPreview["files"][number][] = [];
  for (const file of prepared.files) {
    files.push({
      path: file.path,
      action:
        (await readState(file.path)).state.sha256 === null ? "write" : "change",
      keys: file.keys,
      tracked: await isGitTrackedOrUnknownProjectPath({
        ...project,
        path: file.path,
      }),
    });
  }
  for (const removable of prepared.removable) {
    files.push({
      path: removable,
      action: "removable",
      keys: [],
      tracked: await isGitTrackedOrUnknownProjectPath({
        ...project,
        path: removable,
      }),
    });
  }
  return {
    version: ENV_MIGRATION_VERSION,
    project,
    status: prepared.files.length ? "ready" : "complete",
    files,
    journalPath: path,
  };
}

type Preparation = {
  readonly prepared: PreparedLegacyEnvMigration;
  readonly sources: readonly EnvMigrationFileState[];
};

async function prepareConsistent(
  project: EnvMigrationProject & { readonly repairCompose?: boolean }
): Promise<Preparation> {
  // Discover the complete inventory before the pass whose immutable payloads
  // will be published. A changed inventory or input refuses before consent.
  const discovered = await prepareLegacyProjectEnvMigration(project);
  const sources = await Promise.all(
    discovered.sourcePaths.map(async (path) => (await readState(path)).state)
  );
  const prepared = await prepareLegacyProjectEnvMigration(project);
  if (
    JSON.stringify(discovered.sourcePaths) !==
    JSON.stringify(prepared.sourcePaths)
  ) {
    throw refuse();
  }
  for (const source of sources) {
    if (!same(source, (await readState(source.path)).state)) {
      throw refuse();
    }
  }
  return { prepared, sources };
}

export async function previewEnvMigration(
  input: EnvMigrationProject
): Promise<EnvMigrationPreview> {
  const project = await canonicalProject(input);
  const path = envMigrationJournalPath(project.projectRoot);
  const journal = await readJournal(path, project);
  if (journal && journal.state !== "rolled_back") {
    const files: EnvMigrationPreview["files"][number][] = [];
    for (const file of journal.writes) {
      if (
        journal.state !== "applying" ||
        file.done ||
        same((await readState(file.path)).state, file)
      ) {
        continue;
      }
      files.push({
        path: file.path,
        action: file.before.sha256 === null ? "write" : "change",
        keys: file.keys,
        tracked: await isGitTrackedOrUnknownProjectPath({
          ...project,
          path: file.path,
        }),
      });
    }
    for (const removable of journal.removable) {
      if (journal.removed.includes(removable)) {
        continue;
      }
      files.push({
        path: removable,
        action: "removable",
        keys: [],
        tracked: await isGitTrackedOrUnknownProjectPath({
          ...project,
          path: removable,
        }),
      });
    }
    return {
      version: 1,
      project,
      status: previewStatus(journal),
      files,
      journalPath: path,
    };
  }
  return await previewPrepared(
    project,
    (await prepareConsistent(project)).prepared,
    path
  );
}

function previewStatus(journal: Journal): EnvMigrationPreview["status"] {
  if (["cleaning", "rolling_back"].includes(journal.state)) {
    return "recovery_required";
  }
  return journal.state === "applying" ? "ready" : "complete";
}

async function assertConsent(
  project: EnvMigrationProject,
  paths: readonly string[],
  accept: boolean
): Promise<void> {
  if (accept) {
    return;
  }
  for (const path of paths) {
    if (await isGitTrackedOrUnknownProjectPath({ ...project, path })) {
      throw new ClosedCliError(
        "Env migration needs consent to change tracked files. Run hack env migrate --apply --accept-tracked-env-changes; no files were changed."
      );
    }
  }
}

async function assertSources(
  journal: Journal,
  allowLayerChanges = false
): Promise<void> {
  for (const source of journal.sources) {
    if (journal.removed.includes(source.path)) {
      continue;
    }
    const current = (await readState(source.path)).state;
    const write = journal.writes.find((entry) => entry.path === source.path);
    if (
      allowLayerChanges &&
      (write?.kind === "layer" || write?.kind === "local_layer")
    ) {
      continue;
    }
    if (
      write?.done
        ? !same(current, write)
        : !(same(current, source) || (write && same(current, write)))
    ) {
      throw new ClosedCliError(
        `Env migration input changed: ${JSON.stringify(source.path)}. Keep the legacy files and snapshot. To restore originals while retaining later edits privately, use hack env migrate --rollback-manifest ${JSON.stringify(journal.manifestPath)} --preserve-changes (values omitted).`
      );
    }
  }
}

async function prepareJournal(
  project: EnvMigrationProject,
  path: string,
  snapshots: EnvMigrationSnapshots,
  { prepared, sources }: Preparation
): Promise<Journal> {
  const snapshot = await snapshots.capture({
    projectRoot: project.projectRoot,
    files: sources,
  });
  await assertOutsideWorkingTrees(snapshot.manifestPath, project);
  await snapshots.assertCoverage({ ...snapshot, files: sources });
  await snapshots.recordAfter({ ...snapshot, files: sources });
  const payloads = prepared.files.map((file) => {
    const text = prepared.payload(file.path);
    return { text, sha256: digest(Buffer.from(text)) };
  });
  const staged = await stageMigrationPayloads({
    journalPath: path,
    projectRoot: project.projectRoot,
    files: payloads,
  });
  const writes: Publication[] = prepared.files.map((file, index) => {
    const before = sources.find((entry) => entry.path === file.path);
    const payload = staged[index];
    const bytes = payloads[index];
    if (!(before && payload && bytes)) {
      throw refuse();
    }
    return {
      ...file,
      size: Buffer.byteLength(bytes.text),
      sha256: bytes.sha256,
      before,
      payload,
      done: false,
    };
  });
  const journal: Journal = {
    version: 1,
    kind: "hack-env-migration",
    project,
    manifestPath: snapshot.manifestPath,
    state: "applying",
    sources,
    writes,
    removable: prepared.removable,
    overlayNames: prepared.overlayNames,
    ...(prepared.store ? { store: prepared.store } : {}),
    removed: [],
  };
  await assertSources(journal);
  await writeMetadata(path, journal);
  return journal;
}

async function publishEntry(
  project: EnvMigrationProject,
  entry: Publication
): Promise<void> {
  const run = async () => {
    await checkPrivateDirectory(dirname(entry.payload));
    const current = await readState(entry.path);
    if (same(current.state, entry)) {
      return;
    }
    if (!same(current.state, entry.before)) {
      throw refuse();
    }
    const payload = await readState(entry.payload);
    const payloadInfo = await lstat(entry.payload);
    if (
      payload.state.sha256 !== entry.sha256 ||
      payload.text === null ||
      payloadInfo.uid !== process.getuid?.() ||
      payloadInfo.nlink !== 1 ||
      (payloadInfo.mode & 0o077) !== 0
    ) {
      throw refuse();
    }
    if (entry.kind === "local_layer") {
      await assertMachineLocalFileGitPrivate({
        ...project,
        path: entry.path,
      });
    }
    if (entry.kind === "layer" || entry.kind === "local_layer") {
      await assertProjectEnvLayerPaths(project);
    }
    await replacePrivateFileAtomic({
      path: entry.path,
      directories: [dirname(entry.path)],
      text: payload.text,
      mode: entry.mode ?? 0o600,
      refusal: refuse,
      beforeRename: async () => {
        if (!same((await readState(entry.path)).state, entry.before)) {
          throw refuse();
        }
      },
    });
    if (!same((await readState(entry.path)).state, entry)) {
      throw refuse();
    }
  };
  if (entry.kind === "key") {
    const shared = await resolveProjectEnvSharedKeyLocation(project);
    await withProjectsRegistryLock({
      lockPath: `${shared?.path ?? entry.path}.lock`,
      label: "project env key",
      run,
    });
  } else if (
    entry.kind === "ignore" &&
    dirname(entry.path) === project.projectRoot
  ) {
    await run();
  } else {
    await withEnvLayerLock({ layerPath: entry.path, run });
  }
}

function retainedPayloads(journal: Journal | null): readonly string[] {
  if (!(journal && ["applying", "cleaning"].includes(journal.state))) {
    return [];
  }
  const files = journal.writes.map((write) => write.payload);
  if (journal.cleanupConfig) {
    files.push(journal.cleanupConfig.payload);
  }
  return files;
}

/** Uses recorded before/after images; an unrecorded successful rename is adopted on resume. */
export async function applyEnvMigration(input: {
  readonly project: EnvMigrationProject;
  readonly acceptTrackedChanges: boolean;
  readonly snapshots: EnvMigrationSnapshots;
  readonly hooks?: EnvMigrationHooks;
  readonly repairCompose?: boolean;
}) {
  const project = await canonicalProject(input.project);
  const path = envMigrationJournalPath(project.projectRoot);
  await assertOutsideWorkingTrees(path, project);
  const existing = await readJournal(path, project);
  if (existing?.state === "rolling_back") {
    throw new ClosedCliError(
      `Env rollback is unfinished. Resume hack env migrate --rollback-manifest ${JSON.stringify(existing.manifestPath)}; no migration files were changed.`
    );
  }
  if (existing && ["complete", "cleaned"].includes(existing.state)) {
    return await withProjectsRegistryLock({
      lockPath: `${path}.lock`,
      label: "env migration",
      run: async () => ({
        status: "already_complete" as const,
        journalPath: path,
        manifestPath: existing.manifestPath,
        payloadCleanup: (await purgeMigrationPayloads({
          journalPath: path,
          projectRoot: project.projectRoot,
          retain: [],
        }))
          ? "complete"
          : "kept",
      }),
    });
  }
  const preparation =
    existing && existing.state !== "rolled_back"
      ? null
      : await prepareConsistent({
          ...project,
          repairCompose: input.repairCompose,
        });
  const changed =
    existing && existing.state !== "rolled_back"
      ? existing.writes.map((entry) => entry.path)
      : (preparation?.prepared.files.map((entry) => entry.path) ?? []);
  await assertConsent(project, changed, input.acceptTrackedChanges);
  if (
    preparation &&
    preparation.prepared.files.length === 0 &&
    preparation.prepared.removable.length === 0
  ) {
    return {
      status: "already_complete" as const,
      journalPath: path,
      manifestPath: null,
    };
  }
  await privateDirectory(dirname(dirname(path)));
  await privateDirectory(dirname(path));
  return await withProjectsRegistryLock({
    lockPath: `${path}.lock`,
    label: "env migration",
    run: async () => {
      const retained = await readJournal(path, project);
      const retain = retainedPayloads(retained);
      await purgeMigrationPayloads({
        journalPath: path,
        projectRoot: project.projectRoot,
        retain,
      });
      let journal =
        retained && retained.state !== "rolled_back"
          ? retained
          : await prepareJournal(
              project,
              path,
              input.snapshots,
              preparation ??
                (await prepareConsistent({
                  ...project,
                  repairCompose: input.repairCompose,
                }))
            );
      await assertConsent(
        project,
        journal.writes.map((entry) => entry.path),
        input.acceptTrackedChanges
      );
      if (journal.state !== "applying") {
        return {
          status: "already_complete" as const,
          journalPath: path,
          manifestPath: journal.manifestPath,
        };
      }
      await input.hooks?.boundary?.({ phase: "prepared", index: -1 });
      await assertSources(journal);
      for (const [index, entry] of journal.writes.entries()) {
        if (entry.done) {
          continue;
        }
        await input.hooks?.boundary?.({ phase: "before_publish", index });
        await publishEntry(project, entry);
        await input.hooks?.boundary?.({ phase: "published", index });
        await input.snapshots.recordAfter({
          manifestPath: journal.manifestPath,
          files: [entry],
        });
        journal = {
          ...journal,
          writes: journal.writes.map((write, current) =>
            current === index ? { ...write, done: true } : write
          ),
        };
        await writeMetadata(path, journal);
        await input.hooks?.boundary?.({ phase: "recorded", index });
      }
      await assertSources(journal);
      for (const envName of [null, ...journal.overlayNames]) {
        if (!(await resolveProjectEnvConfig({ ...project, envName }))) {
          throw refuse();
        }
      }
      await input.hooks?.boundary?.({ phase: "verified", index: -1 });
      journal = { ...journal, state: "complete" };
      await writeMetadata(path, journal);
      await input.hooks?.boundary?.({ phase: "complete", index: -1 });
      const payloadCleanup = await purgeMigrationPayloads({
        journalPath: path,
        projectRoot: project.projectRoot,
        retain: [],
      });
      return {
        payloadCleanup: payloadCleanup ? "complete" : "kept",
        status: "applied" as const,
        journalPath: path,
        manifestPath: journal.manifestPath,
      };
    },
  });
}

/** Explicit later action: a snapshot and fresh legacy-to-current delivery proof are both required. */
export async function cleanupEnvMigration(input: {
  readonly project: EnvMigrationProject;
  readonly acceptTrackedChanges: boolean;
  readonly snapshots: EnvMigrationSnapshots;
}) {
  const project = await canonicalProject(input.project);
  const path = envMigrationJournalPath(project.projectRoot);
  if (!(await readJournal(path, project))) {
    throw refuse();
  }
  return await withProjectsRegistryLock({
    lockPath: `${path}.lock`,
    label: "env migration",
    run: () => cleanupLocked(input, project, path),
  });
}

async function cleanupLocked(
  input: {
    readonly acceptTrackedChanges: boolean;
    readonly snapshots: EnvMigrationSnapshots;
  },
  project: EnvMigrationProject,
  path: string
) {
  const selected = await readJournal(path, project);
  if (
    !selected ||
    selected.state === "applying" ||
    selected.state === "rolled_back" ||
    selected.state === "rolling_back"
  ) {
    throw new ClosedCliError(
      "Finish the env migration before requesting cleanup; no legacy files were removed."
    );
  }
  let journal: Journal = selected;
  if (journal.state === "cleaned") {
    return {
      status: "already_cleaned" as const,
      journalPath: path,
      manifestPath: journal.manifestPath,
      removed: journal.removed,
    };
  }
  if (journal.state === "cleaning") {
    throw new ClosedCliError(
      "Previous legacy cleanup was interrupted. Restore its snapshot with hack env migrate --rollback-manifest before retrying; remaining files were kept."
    );
  }
  if (!journal.validated) {
    throw new ClosedCliError(
      "Start the complete project successfully with hack up before requesting legacy cleanup; no files were removed."
    );
  }
  for (const validated of journal.validated) {
    if (!same((await readState(validated.path)).state, validated)) {
      throw new ClosedCliError(
        "Env layers changed since the successful project run. Start the project again before cleanup; no files were removed."
      );
    }
  }
  const repair =
    journal.store && journal.removable.includes(journal.store.path)
      ? await prepareLegacyEnvCleanupConfig(project)
      : null;
  await assertConsent(
    project,
    [...journal.removable, ...(repair ? [repair.path] : [])],
    input.acceptTrackedChanges
  );
  await input.snapshots.assertCoverage({
    manifestPath: journal.manifestPath,
    files: journal.sources,
  });
  await assertSources(journal, true);
  const context = await acquireLegacyEnvCleanupContext({
    ...project,
    overlayNames: journal.overlayNames,
    paths: journal.sources
      .filter(
        (source) => !journal.writes.some((write) => write.path === source.path)
      )
      .map((source) => source.path),
    ...(journal.store ? { store: journal.store } : {}),
  });
  if (repair) {
    const payload = (
      await stageMigrationPayloads({
        journalPath: path,
        projectRoot: project.projectRoot,
        files: [
          { text: repair.text, sha256: digest(Buffer.from(repair.text)) },
        ],
      })
    )[0];
    if (!payload) {
      throw refuse();
    }
    journal = {
      ...journal,
      cleanupConfig: {
        path: repair.path,
        kind: "config",
        keys: [],
        mode: repair.mode,
        size: Buffer.byteLength(repair.text),
        sha256: digest(Buffer.from(repair.text)),
        before: (await readState(repair.path)).state,
        payload,
        done: false,
      },
    };
  }
  await assertSources(journal, true);
  journal = { ...journal, state: "cleaning" };
  await writeMetadata(path, journal);
  const recordCleanup = async (removed: readonly string[]) => {
    journal = {
      ...journal,
      removed: [...new Set([...journal.removed, ...removed])],
    };
    await writeMetadata(path, journal);
    if (
      journal.cleanupConfig &&
      journal.store &&
      journal.removed.includes(journal.store.path)
    ) {
      await publishEntry(project, journal.cleanupConfig);
      await input.snapshots.recordAfter({
        manifestPath: journal.manifestPath,
        files: [journal.cleanupConfig],
      });
      journal = {
        ...journal,
        cleanupConfig: { ...journal.cleanupConfig, done: true },
      };
      await writeMetadata(path, journal);
    }
    await input.snapshots.recordAfter({
      manifestPath: journal.manifestPath,
      files: journal.removed.map((removed) => ({
        path: removed,
        sha256: null,
        mode: null,
        size: 0,
      })),
    });
  };
  let removed: readonly string[] = [];
  try {
    removed = await removeLegacyProjectEnvArtifacts({
      ...project,
      paths: journal.removable,
      context,
    });
  } catch (error) {
    if (error instanceof LegacyEnvCleanupError) {
      removed = error.removedPaths;
      // Preserve the original failure and confirmed removals even if repair fails.
      await recordCleanup(removed).catch(() => undefined);
    }
    throw error;
  }
  await recordCleanup(removed);
  await writeMetadata(path, {
    ...journal,
    state: "cleaned",
    removed: [...new Set([...journal.removed, ...removed])],
  });
  await purgeMigrationPayloads({
    journalPath: path,
    projectRoot: project.projectRoot,
    retain: [],
  });
  return {
    status: "cleaned" as const,
    journalPath: path,
    manifestPath: journal.manifestPath,
    removed,
  };
}

/** Called only by successful full-project startup paths, never by preview or env resolution. */
export async function recordEnvMigrationProjectRun(
  input: EnvMigrationProject
): Promise<void> {
  const project = await canonicalProject(input);
  const path = envMigrationJournalPath(project.projectRoot);
  const existing = await readJournal(path, project);
  if (!existing || existing.state !== "complete") {
    return;
  }
  await withProjectsRegistryLock({
    lockPath: `${path}.lock`,
    label: "env migration",
    run: async () => {
      const journal = await readJournal(path, project);
      if (!journal || journal.state !== "complete") {
        return;
      }
      const validated = await Promise.all(
        journal.writes
          .filter(
            (entry) => entry.kind === "layer" || entry.kind === "local_layer"
          )
          .map(async (entry) => (await readState(entry.path)).state)
      );
      await writeMetadata(path, { ...journal, validated });
    },
  });
}

/** Restore is delegated to the snapshot owner with current-state guards for all migration effects. */
export async function rollbackEnvMigration(input: {
  readonly project: EnvMigrationProject;
  readonly manifestPath: string;
  readonly snapshots: EnvMigrationSnapshots;
  readonly preserveChanges?: boolean;
}) {
  const project = await canonicalProject(input.project);
  const path = envMigrationJournalPath(project.projectRoot);
  if (!(await readJournal(path, project))) {
    throw refuse();
  }
  return await withProjectsRegistryLock({
    lockPath: `${path}.lock`,
    label: "env migration",
    run: () => rollbackLocked(input, project, path),
  });
}

async function rollbackLocked(
  input: {
    readonly manifestPath: string;
    readonly snapshots: EnvMigrationSnapshots;
    readonly preserveChanges?: boolean;
  },
  project: EnvMigrationProject,
  path: string
) {
  const selected = await readJournal(path, project);
  if (!selected || selected.manifestPath !== resolve(input.manifestPath)) {
    throw refuse();
  }
  let journal: Journal = selected;
  await input.snapshots.assertCoverage({
    manifestPath: journal.manifestPath,
    files: journal.sources,
  });
  // Restore legacy sources first, then reverse publication: encrypted layers
  // leave resolution before a newly-created project key can be moved aside.
  const retainedKeys = journal.writes.filter((write) => write.kind === "key");
  const retainedPaths = new Set(retainedKeys.map((write) => write.path));
  if (
    retainedKeys.some(
      (write) => write.path === join(project.projectRoot, ".hack.secret.key")
    )
  ) {
    retainedPaths.add(join(project.projectRoot, ".gitignore"));
  }
  const restoreOrder = [
    ...journal.sources.filter(
      (source) => !journal.writes.some((write) => write.path === source.path)
    ),
    ...[...journal.writes].reverse(),
  ].filter((source) => !retainedPaths.has(source.path));
  const expectedCurrent: EnvMigrationFileState[] = [];
  for (const source of restoreOrder) {
    const current = (await readState(source.path)).state;
    const removed =
      journal.removed.includes(source.path) ||
      (journal.state === "cleaning" &&
        journal.removable.includes(source.path) &&
        current.sha256 === null);
    let expected =
      journal.writes.find((write) => write.path === source.path) ?? source;
    if (removed) {
      expected = { ...source, sha256: null, mode: null, size: 0 };
    } else if (
      journal.cleanupConfig?.path === source.path &&
      same(current, journal.cleanupConfig)
    ) {
      expected = journal.cleanupConfig;
    }
    expectedCurrent.push(expected);
  }
  journal = {
    ...journal,
    state: "rolling_back",
    removed: [
      ...new Set([
        ...journal.removed,
        ...expectedCurrent
          .filter(
            (file) =>
              file.sha256 === null && journal.removable.includes(file.path)
          )
          .map((file) => file.path),
      ]),
    ],
  };
  await writeMetadata(path, journal);
  const result = await input.snapshots.rollback({
    manifestPath: journal.manifestPath,
    expectedCurrent,
    preserveChanges: input.preserveChanges,
  });
  if (result.status !== "restored") {
    return result;
  }
  await writeMetadata(path, { ...journal, state: "rolled_back" });
  await purgeMigrationPayloads({
    journalPath: path,
    projectRoot: project.projectRoot,
    retain: [],
  });
  return { ...result, retained: [...retainedPaths] };
}

/** Compatibility bridge for existing implicit command routes; publication is journalled and cleanup is deferred. */
export async function migrateLegacyEnvForCommand(
  project: EnvMigrationProject & { readonly materialize: boolean }
): Promise<LegacyProjectEnvMigration> {
  const canonical = await canonicalProject(project);
  const path = envMigrationJournalPath(canonical.projectRoot);
  const retained = await readJournal(path, canonical);
  const preparation =
    retained && retained.state !== "rolled_back"
      ? null
      : await prepareConsistent({ ...canonical, repairCompose: false });
  const preview =
    retained && retained.state !== "rolled_back"
      ? await previewEnvMigration(canonical)
      : await previewPrepared(
          canonical,
          preparation?.prepared ??
            (await prepareConsistent({ ...canonical, repairCompose: false }))
              .prepared,
          path
        );
  const result = await applyEnvMigration({
    project,
    acceptTrackedChanges: false,
    snapshots: await envMigrationSnapshots(),
    repairCompose: false,
  });
  return {
    legacyDetected: result.status === "applied",
    wroteFiles: preview.files
      .filter((file) => file.action !== "removable")
      .map((file) => file.path),
    migratedOverlays: [],
    movedPlainValues: preview.files
      .filter(
        (file) =>
          file.action !== "removable" && file.path.endsWith(".local.yaml")
      )
      .flatMap((file) => file.keys.map((key) => ({ key, path: file.path }))),
    updatedProjectConfig: preview.files.some(
      (file) =>
        file.path === join(project.projectDir, "hack.config.json") &&
        file.action === "change"
    ),
    cleanupCandidates: preview.files
      .filter((file) => file.action === "removable")
      .map((file) => file.path),
    blockedCleanupCandidates:
      preparation?.prepared.blockedCleanupCandidates ?? [],
    composeEnvFileReferences: [],
    retainedEnvFiles: preparation?.prepared.retainedEnvFiles ?? [],
  };
}
