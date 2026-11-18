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
  /** Service to every service it depends on, whatever the condition. */
  readonly dependsOn: ReadonlyMap<string, readonly string[]>;
};

export const EMPTY_ONE_SHOT_GRAPH: ComposeOneShotGraph = {
  oneShots: new Set(),
  waitsOn: new Map(),
  dependsOn: new Map(),
};

/**
 * The part of `graph` a service-scoped start waits on: Compose starts the
 * selected services and, unless `noDeps`, everything they depend on, and
 * waits only for the one-shots those services wait on. An unrelated
 * one-shot running elsewhere in the project is not this start's progress.
 * Without selected services the whole graph is in scope.
 */
export function scopeOneShotGraph(
  graph: ComposeOneShotGraph,
  scope: {
    readonly services?: readonly string[];
    readonly noDeps?: boolean;
  }
): ComposeOneShotGraph {
  if (!scope.services || scope.services.length === 0) {
    return graph;
  }
  if (scope.noDeps) {
    // `--no-deps` starts only the selected services and waits for nothing.
    return { ...graph, oneShots: new Set(), waitsOn: new Map() };
  }
  const started = new Set<string>();
  const pending = [...scope.services];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (started.has(next)) {
      continue;
    }
    started.add(next);
    pending.push(...(graph.dependsOn.get(next) ?? []));
  }
  const oneShots = new Set<string>();
  const waitsOn = new Map<string, readonly string[]>();
  for (const [service, blockers] of graph.waitsOn) {
    if (!started.has(service)) {
      continue;
    }
    waitsOn.set(service, blockers);
    for (const blocker of blockers) {
      oneShots.add(blocker);
    }
  }
  return { oneShots, waitsOn, dependsOn: graph.dependsOn };
}

/**
 * The Compose profiles a command runs with: its `--profile` values, else
 * `COMPOSE_PROFILES` from the delivered environment, else from this process.
 */
export function effectiveComposeProfiles(opts: {
  readonly cliProfiles: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
}): string[] {
  if (opts.cliProfiles.length > 0) {
    return [...opts.cliProfiles];
  }
  const raw = Object.hasOwn(opts.env, "COMPOSE_PROFILES")
    ? opts.env.COMPOSE_PROFILES
    : process.env.COMPOSE_PROFILES;
  return (raw ?? "")
    .split(",")
    .map((profile) => profile.trim())
    .filter((profile) => profile.length > 0);
}

/** Which services' `depends_on` count: all, or those active under these profiles. */
export type OneShotGraphOptions = {
  readonly activeProfiles?: readonly string[];
  /**
   * The environment Compose interpolates the files with (the command's
   * environment); `profiles` values are interpolated with it, as Compose
   * does before applying them. Without it they are taken literally.
   */
  readonly interpolationEnv?: Readonly<Record<string, string | undefined>>;
};

/** The one-shot graph of one parsed Compose document. */
export function composeOneShotGraph(
  document: unknown,
  options: OneShotGraphOptions = {}
): ComposeOneShotGraph {
  return mergeOneShotGraphs([document], options);
}

/**
 * The one-shot graph of several Compose documents (a project's base file and
 * its overrides), merged as Compose merges them: per service, each
 * `depends_on` entry of a later document replaces that entry's condition, so
 * an override that turns a completion dependency into `service_started`
 * removes the one-shot edge. Edges come from the effective conditions only.
 */
export function mergeOneShotGraphs(
  documents: readonly unknown[],
  options: OneShotGraphOptions = {}
): ComposeOneShotGraph {
  // Service -> dependency -> effective condition, in first-seen order.
  const effective = new Map<string, Map<string, string>>();
  // Service -> its `profiles`, as the last document that sets them says.
  const serviceProfiles = new Map<string, readonly string[]>();
  for (const document of documents) {
    if (!(isRecord(document) && isRecord(document.services))) {
      continue;
    }
    for (const [name, service] of Object.entries(document.services)) {
      const conditions = effective.get(name) ?? new Map<string, string>();
      for (const [dependency, condition] of dependencyConditions(service)) {
        conditions.set(dependency, condition);
      }
      effective.set(name, conditions);
      const profiles = declaredProfiles(service, options.interpolationEnv);
      if (profiles !== null) {
        serviceProfiles.set(name, profiles);
      }
    }
  }
  return graphFromConditions({
    effective,
    serviceProfiles,
    activeProfiles: options.activeProfiles,
  });
}

/** The graph edges of the effective per-service conditions. */
function graphFromConditions(input: {
  readonly effective: ReadonlyMap<string, ReadonlyMap<string, string>>;
  readonly serviceProfiles: ReadonlyMap<string, readonly string[]>;
  readonly activeProfiles: readonly string[] | undefined;
}): ComposeOneShotGraph {
  const oneShots = new Set<string>();
  const waitsOn = new Map<string, string[]>();
  const dependsOn = new Map<string, string[]>();
  for (const [name, conditions] of input.effective) {
    // A service its profiles leave out never starts, so it waits on nothing:
    // its completion edges would make a long-running service look like a
    // one-shot (HACK-2310).
    if (!serviceActive(input.serviceProfiles.get(name), input.activeProfiles)) {
      continue;
    }
    if (conditions.size > 0) {
      dependsOn.set(name, [...conditions.keys()]);
    }
    const completions = [...conditions]
      .filter(([, condition]) => condition === COMPLETED)
      .map(([dependency]) => dependency);
    for (const dependency of completions) {
      oneShots.add(dependency);
    }
    if (completions.length > 0) {
      waitsOn.set(name, completions);
    }
  }
  return { oneShots, waitsOn, dependsOn };
}

const COMPLETED = "service_completed_successfully";

/**
 * A service's `profiles`, interpolated, or null when it does not set them.
 * A value that cannot be interpolated here makes the service count as active
 * (`[ANY_PROFILE]`): a real one-shot must never lose its wait over a profile
 * expression Hack does not evaluate.
 */
function declaredProfiles(
  service: unknown,
  env: Readonly<Record<string, string | undefined>> | undefined
): readonly string[] | null {
  if (!(isRecord(service) && Array.isArray(service.profiles))) {
    return null;
  }
  const profiles: string[] = [];
  for (const raw of service.profiles) {
    if (typeof raw !== "string") {
      continue;
    }
    const value = env ? interpolateComposeValue(raw, env) : raw;
    if (value === null) {
      return [ANY_PROFILE];
    }
    if (value.length > 0) {
      profiles.push(value);
    }
  }
  return profiles;
}

/** Marks a service whose profiles could not be evaluated: always active. */
const ANY_PROFILE = "*";

const INTERPOLATION = /\$\$|\$\{([^}]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;
const BRACED = /^([A-Za-z_][A-Za-z0-9_]*)(?:(:?-)(.*))?$/s;

/**
 * Compose interpolation of one value: `$$`, `$VAR`, `${VAR}`,
 * `${VAR:-default}` and `${VAR-default}`, using only variables set in `env`.
 * Compose also reads variables from its `.env` and `COMPOSE_ENV_FILES`,
 * which this does not see, so a reference to a variable `env` does not set
 * is unknown (null), even with a default, as is any other form (`:?`, `:+`,
 * nesting).
 */
export function interpolateComposeValue(
  value: string,
  env: Readonly<Record<string, string | undefined>>
): string | null {
  let unknown = false;
  const out = value.replace(INTERPOLATION, (match, braced, bare) => {
    const resolved = resolveReference({ match, braced, bare, env });
    if (resolved === null) {
      unknown = true;
      return "";
    }
    return resolved;
  });
  return unknown ? null : out;
}

/** One `$...` reference, or null when Hack cannot know its value. */
function resolveReference(input: {
  readonly match: string;
  readonly braced: unknown;
  readonly bare: unknown;
  readonly env: Readonly<Record<string, string | undefined>>;
}): string | null {
  if (input.match === "$$") {
    return "$";
  }
  if (typeof input.bare === "string") {
    // Possibly set by an interpolation env file Hack does not read.
    return input.env[input.bare] ?? null;
  }
  const parts = BRACED.exec(String(input.braced));
  if (!parts || (parts[3] ?? "").includes("$")) {
    return null;
  }
  const [, name, operator, fallback] = parts;
  const current = input.env[name as string];
  if (current === undefined) {
    return null;
  }
  if (operator === ":-") {
    return current ? current : (fallback ?? "");
  }
  return current;
}

/**
 * Compose runs a service with no profiles always, and one with profiles only
 * when one of them is active. Without known active profiles every service
 * counts.
 */
function serviceActive(
  profiles: readonly string[] | undefined,
  activeProfiles: readonly string[] | undefined
): boolean {
  if (!(profiles && profiles.length > 0 && activeProfiles)) {
    return true;
  }
  // A profile Hack could not evaluate: assume Compose starts the service.
  if (profiles.includes(ANY_PROFILE)) {
    return true;
  }
  // Compose's `*` (`--profile '*'`, `COMPOSE_PROFILES='*'`) enables every profile.
  if (activeProfiles.includes("*")) {
    return true;
  }
  return profiles.some((profile) => activeProfiles.includes(profile));
}

/**
 * One service's `depends_on` entries and their conditions. The short list
 * form and an entry without a condition mean `service_started`.
 */
function dependencyConditions(service: unknown): [string, string][] {
  if (!isRecord(service)) {
    return [];
  }
  const dependsOn = service.depends_on;
  if (Array.isArray(dependsOn)) {
    return dependsOn
      .filter((name): name is string => typeof name === "string")
      .map((name) => [name, "service_started"]);
  }
  if (!isRecord(dependsOn)) {
    return [];
  }
  return Object.entries(dependsOn).map(([dependency, spec]) => [
    dependency,
    isRecord(spec) && typeof spec.condition === "string"
      ? spec.condition
      : "service_started",
  ]);
}

/**
 * The one-shot graph of the Compose files a command runs with. A file that
 * cannot be read or parsed contributes nothing: the start then keeps the
 * plain start budget (no progress is ever observed), never a longer wait.
 */
export async function readComposeOneShotGraph(
  composeFiles: readonly string[],
  options: OneShotGraphOptions = {}
): Promise<ComposeOneShotGraph> {
  const documents: unknown[] = [];
  for (const file of composeFiles) {
    const text = await readTextFile(file);
    if (!text) {
      continue;
    }
    try {
      // Compose resolves YAML merge keys (`<<: *defaults`), which the yaml
      // library leaves off by default; a depends_on inherited from an
      // extension anchor must count too.
      documents.push(YAML.parse(text, { merge: true }));
    } catch {
      // Unreadable: no evidence of one-shots from this file.
    }
  }
  return mergeOneShotGraphs(documents, options);
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
