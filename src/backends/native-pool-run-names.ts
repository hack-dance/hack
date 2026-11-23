/**
 * Names for the live runs that keep a running native pool in use (HACK-2535).
 *
 * The runtime reports live run ids only (`runtime status` `live_runs`). Each
 * checkout's run mappings (`<project dir>/.internal/native-runs/` for Compose
 * projects, `.internal/native-authored-runs/` for native-authored ones) record
 * the runs it owns, so the registered projects and their linked worktrees map a
 * run id to a project. Reading is best-effort and read-only: a checkout
 * whose mappings cannot be read maps nothing, and its runs count as unnamed.
 */
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { isRecord } from "../lib/guards.ts";
import {
  type ProjectsRegistry,
  readProjectsRegistry,
} from "../lib/projects-registry.ts";

/** At most this many projects are named; the rest are counted. */
const NAMED = 3;
const MAPPING_BYTES = 64 * 1024;

type Checkout = { readonly label: string; readonly projectDir: string };

function checkouts(registry: ProjectsRegistry): Checkout[] {
  const found: Checkout[] = [];
  for (const project of registry.projects) {
    found.push({ label: project.name, projectDir: project.projectDir });
    for (const worktree of project.worktrees ?? []) {
      found.push({
        label: `${project.name} (${worktree.branch ?? basename(worktree.path)})`,
        projectDir: join(worktree.path, project.projectDirName),
      });
    }
  }
  return found;
}

/** The run a mapping file records, by store and file kind; `undefined` otherwise. */
function recordRun(
  store: "native-runs" | "native-authored-runs",
  name: string,
  value: unknown
): string | undefined {
  if (!isRecord(value)) {
    return;
  }
  // Compose: `{ version, scope, run: { run, namespace, ... } }`.
  if (store === "native-runs") {
    return isRecord(value.run) && typeof value.run.run === "string"
      ? value.run.run
      : undefined;
  }
  // Native-authored, written as `{ scope, record }`: the ready record holds the run in
  // its receipt's review, the start record (all a starting run may have) in its own
  // review. Every other file in that folder is skipped.
  const record = isRecord(value.record) ? value.record : undefined;
  const receipt = isRecord(record?.receipt) ? record.receipt : undefined;
  const review = name.endsWith(".start.json")
    ? record?.review
    : receipt?.review;
  const provenance = isRecord(review) ? review.provenance : undefined;
  return isRecord(provenance) && typeof provenance.run === "string"
    ? provenance.run
    : undefined;
}

/** `<digest>.json` (ready) or `<digest>.start.json` in the native-authored store. */
const AUTHORED_FILE = /^[a-f0-9]{64}(\.start)?\.json$/;

/** The run ids this checkout's mappings record; empty when unreadable. */
async function mappedRuns(projectDir: string): Promise<string[]> {
  const runs: string[] = [];
  for (const store of ["native-runs", "native-authored-runs"] as const) {
    const root = join(projectDir, ".internal", store);
    const names = await readdir(root).catch(() => [] as string[]);
    for (const name of names.filter((entry) =>
      store === "native-runs"
        ? entry.endsWith(".json")
        : AUTHORED_FILE.test(entry)
    )) {
      const text = await readFile(join(root, name), "utf8").catch(() => "");
      if (text.length === 0 || text.length > MAPPING_BYTES) {
        continue;
      }
      try {
        const run = recordRun(store, name, JSON.parse(text));
        if (run !== undefined) {
          runs.push(run);
        }
      } catch {
        // Not a run mapping: maps nothing.
      }
    }
  }
  return runs;
}

/**
 * Who uses the pool, for a refusal: up to three project names, then "and N
 * more", where N also counts runs no registered checkout maps. When none can
 * be named, it says so.
 */
export async function describeLivePoolRuns(
  runs: readonly string[],
  opts: { readonly registry?: () => Promise<ProjectsRegistry> } = {}
): Promise<string> {
  const registry = await (opts.registry ?? readProjectsRegistry)().catch(
    () => ({ version: 1, projects: [] }) as ProjectsRegistry
  );
  const live = new Set(runs);
  const names: string[] = [];
  const named = new Set<string>();
  for (const checkout of checkouts(registry)) {
    for (const run of await mappedRuns(checkout.projectDir)) {
      if (live.has(run) && !named.has(run)) {
        named.add(run);
        if (!names.includes(checkout.label)) {
          names.push(checkout.label);
        }
      }
    }
  }
  const unnamed = live.size - named.size;
  if (names.length === 0) {
    return `${live.size} live project run${live.size === 1 ? "" : "s"} that no registered project's run mapping names`;
  }
  const shown = names.slice(0, NAMED);
  const more = names.length - shown.length + unnamed;
  return more > 0 ? `${shown.join(", ")} and ${more} more` : shown.join(", ");
}
