import { dirname, isAbsolute, resolve } from "node:path";
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

/**
 * The environment Compose interpolates with and reads `COMPOSE_PROFILES`
 * from: its environment-file variables (the files `COMPOSE_ENV_FILES` names,
 * else `.env` in the project directory, the first Compose file's directory),
 * overridden by the command's own environment, as Compose does. With
 * `envFileDisabled` (Hack passes `--env-file /dev/null`) no file is read.
 * Values are used only to evaluate profiles; they are never returned to a
 * caller's output.
 */
export async function readComposeInterpolationEnv(opts: {
  readonly composeFiles: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly envFileDisabled?: boolean;
}): Promise<Record<string, string | undefined>> {
  const projectDir = opts.composeFiles[0]
    ? dirname(opts.composeFiles[0])
    : null;
  if (opts.envFileDisabled || projectDir === null) {
    return { ...opts.env };
  }
  const named = (opts.env.COMPOSE_ENV_FILES ?? "")
    .split(",")
    .map((file) => file.trim())
    .filter((file) => file.length > 0);
  const files = (named.length > 0 ? named : [".env"]).map((file) =>
    isAbsolute(file) ? file : resolve(projectDir, file)
  );
  const fromFiles: Record<string, string> = {};
  for (const file of files) {
    const text = await readTextFile(file);
    if (text) {
      expandEnvFileValues({
        entries: parseComposeEnvFile(text),
        into: fromFiles,
        env: opts.env,
      });
    }
  }
  const merged: Record<string, string | undefined> = { ...fromFiles };
  for (const [key, value] of Object.entries(opts.env)) {
    if (value !== undefined) {
      merged[key] = value;
    }
  }
  return merged;
}

/**
 * Compose expands `$VAR` references inside env-file values, from earlier
 * file values and the command's environment. A value that cannot be resolved
 * here is left unset (unknown), except COMPOSE_PROFILES, which becomes `*`:
 * an unknown profile selection must keep services active, never exclude
 * one whose migration Compose is waiting for.
 */
function expandEnvFileValues(input: {
  readonly entries: readonly ComposeEnvFileEntry[];
  readonly into: Record<string, string>;
  readonly env: Readonly<Record<string, string | undefined>>;
}): void {
  for (const { key, value: raw, expand } of input.entries) {
    let expanded: string | null = raw;
    if (raw !== null && expand) {
      expanded = interpolateComposeValue(raw, { ...input.into, ...input.env });
    }
    if (expanded !== null) {
      input.into[key] = expanded;
    } else if (key === "COMPOSE_PROFILES") {
      input.into[key] = ANY_PROFILE;
    } else {
      Reflect.deleteProperty(input.into, key);
    }
  }
}

/** One assignment of a Compose env file; a null value is unknown here. */
type ComposeEnvFileEntry = {
  readonly key: string;
  readonly value: string | null;
  /** False for single-quoted values, which Compose takes literally. */
  readonly expand: boolean;
};

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const INLINE_COMMENT = /\s#/;

/**
 * Compose's env-file syntax: `#` comment lines, an optional `export `,
 * `KEY=VALUE`. A single-quoted value is literal and a double-quoted one
 * (with `\\"`, `\\\\` and `\\n` escapes) is expanded; either may span lines,
 * and its lines are part of the value, never assignments of their own. An
 * unquoted value ends at an inline ` #` comment and is trimmed. A quote that
 * never closes makes the value unknown and ends the file.
 */
export function parseComposeEnvFile(text: string): ComposeEnvFileEntry[] {
  const entries: ComposeEnvFileEntry[] = [];
  let position = 0;
  while (position < text.length) {
    const lineEnd = endOfLine(text, position);
    const rawLine = text.slice(position, lineEnd);
    const line = rawLine.trim();
    const assignment = line.startsWith("export ")
      ? line.slice("export ".length).trimStart()
      : line;
    const eq = assignment.indexOf("=");
    const key = eq > 0 ? assignment.slice(0, eq).trim() : "";
    if (line.startsWith("#") || !ENV_KEY.test(key)) {
      position = lineEnd + 1;
      continue;
    }
    const parsed = parseEnvFileValue(text, position + rawLine.indexOf("=") + 1);
    entries.push({ key, value: parsed.value, expand: parsed.expand });
    position = parsed.next;
  }
  return entries;
}

function endOfLine(text: string, from: number): number {
  const index = text.indexOf("\n", from);
  return index < 0 ? text.length : index;
}

/** The value starting at `start`, and where the next line begins. */
function parseEnvFileValue(
  text: string,
  start: number
): {
  readonly value: string | null;
  readonly expand: boolean;
  readonly next: number;
} {
  let index = start;
  while (text[index] === " " || text[index] === "\t") {
    index += 1;
  }
  const quote = text[index];
  if (quote === "'" || quote === '"') {
    const closed = readQuoted(text, index);
    if (closed === null) {
      return { value: null, expand: quote === '"', next: text.length };
    }
    return {
      value: closed.value,
      expand: quote === '"',
      next: endOfLine(text, closed.end) + 1,
    };
  }
  const lineEnd = endOfLine(text, index);
  const raw = text.slice(index, lineEnd);
  const comment = raw.search(INLINE_COMMENT);
  return {
    value: (comment < 0 ? raw : raw.slice(0, comment)).trimEnd(),
    expand: true,
    next: lineEnd + 1,
  };
}

/** A quoted value from its opening quote at `open`, or null if it never closes. */
function readQuoted(
  text: string,
  open: number
): { readonly value: string; readonly end: number } | null {
  const quote = text[open];
  if (quote === "'") {
    const close = text.indexOf("'", open + 1);
    return close < 0
      ? null
      : { value: text.slice(open + 1, close), end: close };
  }
  let value = "";
  for (let index = open + 1; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\" && index + 1 < text.length) {
      const next = text[index + 1];
      value += next === "n" ? "\n" : next;
      index += 1;
    } else if (char === '"') {
      return { value, end: index };
    } else {
      value += char;
    }
  }
  return null;
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
  /**
   * Services that have containers in this instance: they run whatever the
   * current command's profiles are (a one-shot started under another
   * `--profile` is still waited on), so they always count.
   */
  readonly presentServices?: ReadonlySet<string>;
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
    presentServices: options.presentServices,
  });
}

/** The graph edges of the effective per-service conditions. */
function graphFromConditions(input: {
  readonly effective: ReadonlyMap<string, ReadonlyMap<string, string>>;
  readonly serviceProfiles: ReadonlyMap<string, readonly string[]>;
  readonly activeProfiles: readonly string[] | undefined;
  readonly presentServices: ReadonlySet<string> | undefined;
}): ComposeOneShotGraph {
  const oneShots = new Set<string>();
  const waitsOn = new Map<string, string[]>();
  const dependsOn = new Map<string, string[]>();
  for (const [name, conditions] of input.effective) {
    // A service its profiles leave out never starts, so it waits on nothing:
    // its completion edges would make a long-running service look like a
    // one-shot (HACK-2310).
    if (
      !(
        input.presentServices?.has(name) ||
        serviceActive(input.serviceProfiles.get(name), input.activeProfiles)
      )
    ) {
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
    const document = await readComposeDocument(file);
    if (document !== null) {
      documents.push(await resolveExtends({ document, file, depth: 0 }));
    }
  }
  return mergeOneShotGraphs(documents, options);
}

/** A parsed Compose file, or null when it cannot be read or parsed. */
async function readComposeDocument(file: string): Promise<unknown> {
  const text = await readTextFile(file);
  if (!text) {
    return null;
  }
  try {
    // Compose resolves YAML merge keys (`<<: *defaults`), which the yaml
    // library leaves off by default; a depends_on inherited from an
    // extension anchor must count too.
    return YAML.parse(text, { merge: true });
  } catch {
    return null;
  }
}

/** Bound on nested `extends`; deeper (or cyclic) chains stop inheriting. */
const MAX_EXTENDS_DEPTH = 8;

/**
 * `document` with each service's `extends` applied to the keys the graph
 * reads: the base service's `depends_on` entries (the extending service's own
 * entries win) and its `profiles` (unless the service sets its own), as
 * Compose merges them. The base may live in this document or, with
 * `extends.file`, in another file resolved from this file's directory.
 */
async function resolveExtends(input: {
  readonly document: unknown;
  readonly file: string;
  readonly depth: number;
}): Promise<unknown> {
  const { document } = input;
  if (!(isRecord(document) && isRecord(document.services))) {
    return document;
  }
  const services: Record<string, unknown> = {};
  for (const [name, service] of Object.entries(document.services)) {
    services[name] = await resolveServiceExtends({
      service,
      services: document.services,
      file: input.file,
      depth: input.depth,
    });
  }
  return { ...document, services };
}

async function resolveServiceExtends(input: {
  readonly service: unknown;
  readonly services: Readonly<Record<string, unknown>>;
  readonly file: string;
  readonly depth: number;
}): Promise<unknown> {
  const { service } = input;
  if (!isRecord(service) || service.extends === undefined) {
    return service;
  }
  if (input.depth >= MAX_EXTENDS_DEPTH) {
    return service;
  }
  const target = extendsTarget(service.extends);
  if (target === null) {
    return service;
  }
  let baseFile = input.file;
  let baseServices = input.services;
  if (target.file !== null) {
    baseFile = isAbsolute(target.file)
      ? target.file
      : resolve(dirname(input.file), target.file);
    const other = await readComposeDocument(baseFile);
    if (!(isRecord(other) && isRecord(other.services))) {
      return service;
    }
    baseServices = other.services;
  }
  const base = await resolveServiceExtends({
    service: baseServices[target.service],
    services: baseServices,
    file: baseFile,
    depth: input.depth + 1,
  });
  if (!isRecord(base)) {
    return service;
  }
  return {
    ...service,
    depends_on: Object.fromEntries([
      ...dependencyConditions(base).map(([dependency, condition]) => [
        dependency,
        { condition },
      ]),
      ...dependencyConditions(service).map(([dependency, condition]) => [
        dependency,
        { condition },
      ]),
    ]),
    ...(service.profiles === undefined && base.profiles !== undefined
      ? { profiles: base.profiles }
      : {}),
  };
}

/** `extends: name` or `extends: { service, file? }`. */
function extendsTarget(
  value: unknown
): { readonly service: string; readonly file: string | null } | null {
  if (typeof value === "string" && value.length > 0) {
    return { service: value, file: null };
  }
  if (isRecord(value) && typeof value.service === "string") {
    return {
      service: value.service,
      file: typeof value.file === "string" ? value.file : null,
    };
  }
  return null;
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
