import YAML from "yaml";
import { readTextFile } from "./fs.ts";
import { isRecord } from "./guards.ts";

/**
 * One-shot dependencies of a Compose graph and their observed progress
 * (HACK-2310).
 *
 * A one-shot is a service that another service waits on with
 * `depends_on: <name>: condition: service_completed_successfully` (a
 * migration, a seed job). While one is running, a detached start is making
 * progress, not hanging: Compose `up -d` is waiting for it to exit before it
 * starts the services that depend on it. Those dependents stay `Created`
 * until then, and only the waiting Compose client starts them.
 */
export type ComposeOneShotGraph = {
  /** Services some other service waits on to complete successfully. */
  readonly oneShots: ReadonlySet<string>;
  /** Service to the one-shots it waits on, in file order. */
  readonly waitsOn: ReadonlyMap<string, readonly string[]>;
};

export const EMPTY_ONE_SHOT_GRAPH: ComposeOneShotGraph = {
  oneShots: new Set(),
  waitsOn: new Map(),
};

/** The one-shot graph of one parsed Compose document. */
export function composeOneShotGraph(document: unknown): ComposeOneShotGraph {
  return mergeOneShotGraphs([document]);
}

/**
 * The union of the one-shot edges of several Compose documents (a project's
 * base file and its overrides), as Compose merges `depends_on` maps.
 */
export function mergeOneShotGraphs(
  documents: readonly unknown[]
): ComposeOneShotGraph {
  const oneShots = new Set<string>();
  const waitsOn = new Map<string, string[]>();
  for (const document of documents) {
    if (!(isRecord(document) && isRecord(document.services))) {
      continue;
    }
    for (const [name, service] of Object.entries(document.services)) {
      for (const dependency of completionDependencies(service)) {
        oneShots.add(dependency);
        const list = waitsOn.get(name) ?? [];
        if (!list.includes(dependency)) {
          list.push(dependency);
        }
        waitsOn.set(name, list);
      }
    }
  }
  return { oneShots, waitsOn };
}

/** The services one Compose service waits on to complete successfully. */
function completionDependencies(service: unknown): string[] {
  if (!(isRecord(service) && isRecord(service.depends_on))) {
    return [];
  }
  return Object.entries(service.depends_on)
    .filter(
      ([, spec]) =>
        isRecord(spec) && spec.condition === "service_completed_successfully"
    )
    .map(([dependency]) => dependency);
}

/**
 * The one-shot graph of the Compose files a command runs with. A file that
 * cannot be read or parsed contributes nothing: the start then keeps the
 * plain start budget (no progress is ever observed), never a longer wait.
 */
export async function readComposeOneShotGraph(
  composeFiles: readonly string[]
): Promise<ComposeOneShotGraph> {
  const documents: unknown[] = [];
  for (const file of composeFiles) {
    const text = await readTextFile(file);
    if (!text) {
      continue;
    }
    try {
      documents.push(YAML.parse(text));
    } catch {
      // Unreadable: no evidence of one-shots from this file.
    }
  }
  return mergeOneShotGraphs(documents);
}

function entryService(entry: Readonly<Record<string, unknown>>): string | null {
  return typeof entry.Service === "string" && entry.Service.length > 0
    ? entry.Service
    : null;
}

function entryState(entry: Readonly<Record<string, unknown>>): string {
  return typeof entry.State === "string" ? entry.State.toLowerCase() : "";
}

/**
 * One-shots with a running container in `compose ps --all --format json`
 * entries, sorted. A restarting container is not progress: a crash loop must
 * not hold the start open.
 */
export function runningOneShots(opts: {
  readonly graph: ComposeOneShotGraph;
  readonly entries: readonly Readonly<Record<string, unknown>>[];
}): string[] {
  const running = new Set<string>();
  for (const entry of opts.entries) {
    const service = entryService(entry);
    if (
      service !== null &&
      opts.graph.oneShots.has(service) &&
      entryState(entry) === "running"
    ) {
      running.add(service);
    }
  }
  return [...running].sort((a, b) => a.localeCompare(b));
}

/**
 * Services whose containers are still `Created` while a one-shot they wait
 * on is running: service to those one-shots. They start only when that
 * one-shot completes and a Compose client is waiting to start them.
 */
export function waitingDependents(opts: {
  readonly graph: ComposeOneShotGraph;
  readonly entries: readonly Readonly<Record<string, unknown>>[];
}): Record<string, string[]> {
  const running = new Set(runningOneShots(opts));
  const waiting: Record<string, string[]> = {};
  for (const entry of opts.entries) {
    const service = entryService(entry);
    if (service === null || entryState(entry) !== "created") {
      continue;
    }
    const blockers = (opts.graph.waitsOn.get(service) ?? []).filter((name) =>
      running.has(name)
    );
    if (blockers.length > 0) {
      waiting[service] = blockers;
    }
  }
  return waiting;
}

/**
 * The start-phase watchdog's decision at `now` (HACK-2310): keep waiting, or
 * stop because the start made no progress for `idleBudgetMs`, or because the
 * absolute `ceilingMs` passed since the phase began. Progress is a running
 * one-shot, recorded in `lastProgressAt`; with none, the idle budget equals
 * the old wall-clock start budget.
 */
export function startWatchDecision(opts: {
  readonly now: number;
  readonly startedAt: number;
  readonly lastProgressAt: number;
  readonly idleBudgetMs: number;
  readonly ceilingMs: number;
}): "wait" | "idle" | "ceiling" {
  if (opts.now - opts.startedAt >= opts.ceilingMs) {
    return "ceiling";
  }
  if (opts.now - opts.lastProgressAt >= opts.idleBudgetMs) {
    return "idle";
  }
  return "wait";
}
