import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Docker ownership for e2e fixtures.
 *
 * Every fixture project name created by this process is recorded here (and in
 * a per-process journal on disk). That record is the ownership proof for
 * cleanup: the harness only removes Compose containers, networks and volumes
 * whose `com.docker.compose.project` label is a recorded name or one of its
 * branch instances (`<name>--<branch>`). Unrelated projects, and e2e fixtures
 * from other concurrent runs, are never touched.
 *
 * The journal lets a later run reclaim resources from a run that was
 * SIGKILLed before its own cleanup could run: a journal whose process is no
 * longer alive is swept and then deleted.
 */

/** Compose label carrying the project name on containers, networks, volumes. */
export const COMPOSE_PROJECT_LABEL = "com.docker.compose.project";

/** Project names produced by the e2e fixtures (`e2e-<hex>[--<branch>]`). */
export const E2E_FIXTURE_PROJECT_PATTERN = /^e2e-[0-9a-f]+(?:--.+)?$/;

const DOCKER_TIMEOUT_MS = 60_000;

export type DockerResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

/** Runs `docker <args>`; injectable so the cleanup logic is unit-testable. */
export type DockerRunner = (args: readonly string[]) => Promise<DockerResult>;

export type ComposeResource = {
  readonly kind: "container" | "network" | "volume";
  readonly id: string;
  readonly name: string;
  readonly project: string;
};

export type SweepResult = {
  readonly removed: readonly ComposeResource[];
  readonly failed: readonly {
    readonly resource: ComposeResource;
    readonly error: string;
  }[];
  /** Resource kinds that could not be listed, so were not checked at all. */
  readonly unlisted: readonly ComposeResource["kind"][];
};

/** True when the sweep checked every kind and removed everything it owned. */
export function sweepComplete(sweep: SweepResult): boolean {
  return sweep.failed.length === 0 && sweep.unlisted.length === 0;
}

/** Default runner: spawn the docker CLI with a bounded timeout. */
export const runDocker: DockerRunner = async (args) => {
  const proc = Bun.spawn(["docker", ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), DOCKER_TIMEOUT_MS);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { exitCode, stdout, stderr };
};

/** Compose project of a branch instance, matching the CLI's naming. */
export function branchComposeProject(opts: {
  readonly name: string;
  readonly branch: string;
}): string {
  return `${opts.name}--${opts.branch}`;
}

/** True when `project` is a recorded fixture name or one of its branches. */
export function isOwnedComposeProject(opts: {
  readonly project: string;
  readonly names: ReadonlySet<string>;
}): boolean {
  if (opts.names.has(opts.project)) {
    return true;
  }
  const separator = opts.project.indexOf("--");
  return separator > 0 && opts.names.has(opts.project.slice(0, separator));
}

const recordedNames = new Set<string>();
let journalPath: string | null = null;

/** Directory holding per-process ownership journals. */
export function ownershipJournalDir(): string {
  const override = process.env.HACK_E2E_OWNERSHIP_DIR?.trim();
  return override && override.length > 0
    ? override
    : join(tmpdir(), "hack-e2e-ownership");
}

/**
 * Record a fixture project name as owned by this process. Synchronous so the
 * journal is on disk before any `hack up` can create resources for it.
 */
export function recordOwnedFixture(opts: { readonly name: string }): void {
  if (recordedNames.has(opts.name)) {
    return;
  }
  recordedNames.add(opts.name);
  writeJournal();
}

/** Snapshot of every fixture name recorded by this process. */
export function ownedFixtureNames(): ReadonlySet<string> {
  return new Set(recordedNames);
}

function writeJournal(): void {
  const dir = ownershipJournalDir();
  journalPath ??= join(dir, `${process.pid}.json`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    journalPath,
    `${JSON.stringify({ pid: process.pid, names: [...recordedNames] })}\n`
  );
}

/** Remove this process's journal once its resources are verified gone. */
export async function clearOwnershipJournal(): Promise<void> {
  if (journalPath !== null) {
    await rm(journalPath, { force: true });
  }
}

/**
 * End of run: sweep everything this process owns and clear its journal only
 * when the sweep listed every resource kind and every removal succeeded.
 */
export async function settleRunOwnership(opts: {
  readonly docker: DockerRunner;
}): Promise<{ readonly sweep: SweepResult; readonly journalCleared: boolean }> {
  const sweep = await sweepOwnedComposeResources({
    docker: opts.docker,
    names: ownedFixtureNames(),
  });
  const journalCleared = sweepComplete(sweep);
  if (journalCleared) {
    await clearOwnershipJournal();
  }
  return { sweep, journalCleared };
}

/**
 * List Compose-labelled resources of one kind. Returns null when docker is
 * unavailable, so callers can distinguish "none" from "could not look".
 */
export async function listComposeResources(opts: {
  readonly docker: DockerRunner;
  readonly kind: ComposeResource["kind"];
}): Promise<ComposeResource[] | null> {
  // Volumes have no ID placeholder; their name is the removal identifier.
  const identity = {
    container: "{{.ID}}\t{{.Names}}",
    network: "{{.ID}}\t{{.Name}}",
    volume: "{{.Name}}\t{{.Name}}",
  }[opts.kind];
  const format = `${identity}\t{{.Label "${COMPOSE_PROJECT_LABEL}"}}`;
  const args =
    opts.kind === "container"
      ? ["ps", "-a", "--format", format]
      : [opts.kind, "ls", "--format", format];
  const result = await opts.docker([
    ...args,
    "--filter",
    `label=${COMPOSE_PROJECT_LABEL}`,
  ]);
  if (result.exitCode !== 0) {
    return null;
  }
  const resources: ComposeResource[] = [];
  for (const line of result.stdout.split("\n")) {
    const [id, name, project] = line.trim().split("\t");
    if (id && name && project) {
      resources.push({ kind: opts.kind, id, name, project });
    }
  }
  return resources;
}

/** Networks whose Compose project looks like an e2e fixture (any run). */
export async function listFixtureNetworks(opts: {
  readonly docker: DockerRunner;
}): Promise<ComposeResource[] | null> {
  const networks = await listComposeResources({
    docker: opts.docker,
    kind: "network",
  });
  return (
    networks?.filter((network) =>
      E2E_FIXTURE_PROJECT_PATTERN.test(network.project)
    ) ?? null
  );
}

/** Networks that belong to the given owned fixture names. */
export async function listOwnedNetworks(opts: {
  readonly docker: DockerRunner;
  readonly names: ReadonlySet<string>;
}): Promise<ComposeResource[] | null> {
  const networks = await listComposeResources({
    docker: opts.docker,
    kind: "network",
  });
  return (
    networks?.filter((network) =>
      isOwnedComposeProject({ project: network.project, names: opts.names })
    ) ?? null
  );
}

/**
 * Remove every container, network and volume owned by `names` (containers
 * first so networks and volumes are free). Only exact resource IDs that pass
 * the ownership check are removed; nothing is pruned.
 */
export async function sweepOwnedComposeResources(opts: {
  readonly docker: DockerRunner;
  readonly names: ReadonlySet<string>;
}): Promise<SweepResult> {
  const removed: ComposeResource[] = [];
  const failed: { resource: ComposeResource; error: string }[] = [];
  const unlisted: ComposeResource["kind"][] = [];
  if (opts.names.size === 0) {
    return { removed, failed, unlisted };
  }
  for (const kind of ["container", "network", "volume"] as const) {
    const resources = await listComposeResources({
      docker: opts.docker,
      kind,
    });
    if (resources === null) {
      unlisted.push(kind);
      continue;
    }
    for (const resource of resources) {
      if (
        !isOwnedComposeProject({ project: resource.project, names: opts.names })
      ) {
        continue;
      }
      const args =
        kind === "container"
          ? ["rm", "-f", "-v", resource.id]
          : [kind, "rm", resource.id];
      const result = await opts.docker(args);
      if (result.exitCode === 0) {
        removed.push(resource);
      } else {
        failed.push({ resource, error: result.stderr.trim() });
      }
    }
  }
  return { removed, failed, unlisted };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    // EPERM: the pid exists but belongs to someone else; treat as alive.
    return (error as { code?: string }).code === "EPERM";
  }
}

/**
 * Sweep resources recorded by e2e runs that died without cleaning up (for
 * example after SIGKILL). Journals of live processes are left alone, so a
 * concurrent run is never disturbed.
 */
export async function recoverStaleOwnership(opts: {
  readonly docker: DockerRunner;
  readonly isAlive?: (pid: number) => boolean;
}): Promise<{ readonly recovered: SweepResult[] }> {
  const dir = ownershipJournalDir();
  const isAlive = opts.isAlive ?? isProcessAlive;
  const recovered: SweepResult[] = [];
  await mkdir(dir, { recursive: true });
  for (const entry of await readdir(dir)) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    const path = join(dir, entry);
    const text = await readJournal(path);
    const journal = text === null ? null : parseJournal(text);
    if (journal === null || journal.pid === process.pid) {
      continue;
    }
    if (isAlive(journal.pid)) {
      continue;
    }
    const result = await sweepOwnedComposeResources({
      docker: opts.docker,
      names: new Set(journal.names),
    });
    recovered.push(result);
    // Keep the journal until every kind was listed and every removal worked.
    if (sweepComplete(result)) {
      await rm(path, { force: true });
    }
  }
  return { recovered };
}

/** Journal text, or null when another run removed it after readdir. */
async function readJournal(path: string): Promise<string | null> {
  try {
    return await Bun.file(path).text();
  } catch (error: unknown) {
    if ((error as { code?: string }).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function parseJournal(
  text: string
): { readonly pid: number; readonly names: readonly string[] } | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "pid" in parsed &&
      "names" in parsed &&
      typeof parsed.pid === "number" &&
      Array.isArray(parsed.names)
    ) {
      return {
        pid: parsed.pid,
        names: parsed.names.filter(
          (name): name is string => typeof name === "string"
        ),
      };
    }
  } catch {
    // unreadable journal: leave it for a human
  }
  return null;
}

/** One-line description of resources for logs and failure messages. */
export function describeResources(
  resources: readonly ComposeResource[]
): string {
  return resources
    .map(
      (resource) => `${resource.kind} ${resource.name} (${resource.project})`
    )
    .join(", ");
}
