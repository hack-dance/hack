/**
 * What `hack up` checks on the Compose backend before it starts anything, so
 * a machine that cannot run the project gets one closed line naming what is
 * missing and what to do, instead of a generic Compose failure after image
 * pulls began (HACK-2356).
 *
 * In order, each check runs only when the one before it passed
 * ({@link preflightComposeEngine} runs 1 to 3, {@link preflightSharedNetworks} runs 4):
 *
 * 1. `docker` is on PATH (`E_DOCKER_UNAVAILABLE`).
 * 2. The engine answers `docker version` (`E_PERMISSION` for a denied socket,
 *    `E_DOCKER_UNAVAILABLE` for an unreachable or hung engine; see
 *    {@link dockerEngineFailureError}).
 * 3. `docker compose version` succeeds (`E_DOCKER_UNAVAILABLE`).
 * 4. Each of Hack's shared networks the project declares as external exists
 *    (`E_GLOBAL_INFRA_DOWN`). Other external networks are the project's own
 *    and are left to Compose.
 *
 * The checks only read: they start no engine, create no network and change
 * nothing. Callers run them with the same environment Compose will get, so a
 * project that selects its engine (`DOCKER_HOST`, `DOCKER_CONTEXT`) through its
 * env is checked against that engine. Any other failure of a check (an unrecognized `docker version`
 * error, an unreadable compose file) passes, so Compose reports it as before.
 */

import { YAML } from "bun";

import {
  DEFAULT_INGRESS_NETWORK,
  DEFAULT_LOGGING_NETWORK,
} from "../constants.ts";
import { HackCliError } from "./cli-result.ts";
import {
  type ComposePsProcessResult,
  dockerEngineFailureError,
} from "./compose-ps-result.ts";
import { isRecord } from "./guards.ts";

/** Shared networks `hack global install` creates. */
const HACK_SHARED_NETWORKS: readonly string[] = [
  DEFAULT_INGRESS_NETWORK,
  DEFAULT_LOGGING_NETWORK,
];

/** Bound for each read; a healthy engine answers in well under a second. */
export const ENGINE_PREFLIGHT_TIMEOUT_MS = 20_000;

const NO_DOCKER_MESSAGE =
  "This machine has no `docker` command, and Hack's Compose runtime needs Docker Engine with Docker Compose v2. Install them, or turn on the Docker option of the cloud or sandbox environment you are in, then check with `docker info` and `docker compose version` and retry. An environment that cannot run a container engine cannot start this project with Hack.";

const NO_COMPOSE_MESSAGE =
  "Docker is running, but `docker compose version` failed: Hack needs the Docker Compose v2 plugin. Install it (on Ubuntu or Debian, the `docker-compose-v2` or `docker-compose-plugin` package), check with `docker compose version`, then retry.";

export interface ComposeEnginePreflightDeps {
  /** Whether `docker` resolves on PATH. */
  readonly dockerOnPath: () => boolean;
  /** Run a `docker` argv with stdin ignored and the given timeout. */
  readonly run: (
    argv: readonly string[],
    timeoutMs: number
  ) => Promise<ComposePsProcessResult>;
}

/**
 * Checks 1 to 3: the Docker CLI, the engine and the Compose plugin. Returns
 * the closed error to report, or null when `up` may continue.
 */
export async function preflightComposeEngine(opts: {
  readonly deps: ComposeEnginePreflightDeps;
  /** Values that must never appear in a quoted engine line. */
  readonly redactValues?: Iterable<string>;
}): Promise<HackCliError | null> {
  const redactValues = [...(opts.redactValues ?? [])];
  const { deps } = opts;
  if (!deps.dockerOnPath()) {
    return noDockerError();
  }
  const version = await runDocker(deps, [
    "docker",
    "version",
    "--format",
    "{{.Server.Version}}",
  ]);
  if (version === null) {
    return noDockerError();
  }
  if (version.exitCode !== 0) {
    return dockerEngineFailureError({
      result: version,
      command: "docker version",
      redactValues,
    });
  }
  return await preflightComposePlugin({ deps, redactValues });
}

/** What {@link inspectComposePlugin} found. */
export type ComposePluginInspection =
  | { readonly ok: true; readonly version: string }
  | { readonly ok: false; readonly error: HackCliError };

/**
 * Check 3 alone: whether `docker compose version` succeeds. `hack global
 * install` and `hack global up` run it once the engine answers, before they
 * start the proxy with Compose, and `hack doctor` reports it (HACK-2673). A
 * failure names the plugin and how to install it (`E_DOCKER_UNAVAILABLE`),
 * unless the Docker client says the engine is unreachable or denied.
 */
export async function inspectComposePlugin(opts: {
  readonly deps: Pick<ComposeEnginePreflightDeps, "run">;
  /** Values that must never appear in a quoted engine line. */
  readonly redactValues?: Iterable<string>;
}): Promise<ComposePluginInspection> {
  const compose = await runDocker(opts.deps, [
    "docker",
    "compose",
    "version",
    "--short",
  ]);
  if (compose === null) {
    return { ok: false, error: noDockerError() };
  }
  if (compose.exitCode === 0) {
    return { ok: true, version: compose.stdout.trim() };
  }
  return {
    ok: false,
    error:
      dockerEngineFailureError({
        result: compose,
        command: "docker compose version",
        redactValues: [...(opts.redactValues ?? [])],
      }) ?? noComposePluginError(),
  };
}

/** {@link inspectComposePlugin} as a refusal: the error, or null to continue. */
export async function preflightComposePlugin(opts: {
  readonly deps: Pick<ComposeEnginePreflightDeps, "run">;
  readonly redactValues?: Iterable<string>;
}): Promise<HackCliError | null> {
  const inspection = await inspectComposePlugin(opts);
  return inspection.ok ? null : inspection.error;
}

function noComposePluginError(): HackCliError {
  return new HackCliError({
    code: "E_DOCKER_UNAVAILABLE",
    message: NO_COMPOSE_MESSAGE,
    startBlocker: {
      thing: "docker compose",
      problem:
        "v2 plugin missing · install docker-compose-v2 or docker-compose-plugin on debian or ubuntu",
    },
  });
}

/**
 * Check 4: Hack's shared networks the project declares as external. Run it
 * after any offer to start Hack's global services, which creates them.
 *
 * @param composeYaml The project's main compose file text, or null when it
 *   could not be read (the check is then skipped).
 */
export async function preflightSharedNetworks(opts: {
  readonly composeYaml: string | null;
  readonly selection: ComposeServiceSelection;
  readonly deps: Pick<ComposeEnginePreflightDeps, "run">;
  /** Values that must never appear in a quoted engine line. */
  readonly redactValues?: Iterable<string>;
}): Promise<HackCliError | null> {
  const redactValues = [...(opts.redactValues ?? [])];
  const { deps } = opts;
  for (const network of sharedExternalNetworks(
    opts.composeYaml,
    opts.selection
  )) {
    const inspect = await runDocker(deps, [
      "docker",
      "network",
      "inspect",
      "--format",
      "{{.Name}}",
      network,
    ]);
    if (inspect === null) {
      return noDockerError();
    }
    if (inspect.exitCode === 0) {
      continue;
    }
    const engine = dockerEngineFailureError({
      result: inspect,
      command: "docker network inspect",
      redactValues,
    });
    if (engine !== null) {
      return engine;
    }
    if (inspect.stderr.toLowerCase().includes("not found")) {
      return missingSharedNetworkError(network);
    }
  }
  return null;
}

function missingSharedNetworkError(network: string): HackCliError {
  return new HackCliError({
    code: "E_GLOBAL_INFRA_DOWN",
    message: `This project joins Hack's shared network ${network}, which does not exist on this Docker engine yet. Run \`hack global install\` once on this machine to create it and start Hack's proxy, then retry. Creating the network and starting the proxy need no sudo; its DNS and certificate trust steps can ask for it and can be skipped.`,
    detail: { network },
  });
}

/** Which services `up` starts, for the network check. */
export interface ComposeServiceSelection {
  /** Services named on the command line; empty for the whole project. */
  readonly requested: readonly string[];
  /** Active Compose profiles (CLI and COMPOSE_PROFILES). */
  readonly profiles: readonly string[];
}

/**
 * Hack's shared networks, declared external at the top level of the compose
 * file, that the services `up` will start join, by engine name (`name:` or
 * the key). A whole-project `up` starts every service without `profiles` or
 * with an active profile; a scoped `up` starts the named services. Either way
 * Compose also starts their dependencies, except an optional one
 * (`required: false`) that is not active. A service with no `networks` joins
 * the implicit `default` network; `network_mode` joins none. Networks only an
 * unselected service joins are left out, because Compose does not need them.
 */
export function sharedExternalNetworks(
  composeYaml: string | null,
  selection: ComposeServiceSelection = { requested: [], profiles: [] }
): readonly string[] {
  if (composeYaml === null) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = YAML.parse(composeYaml);
  } catch {
    return [];
  }
  if (!isRecord(parsed)) {
    return [];
  }
  const shared = sharedNetworksByKey(parsed.networks);
  if (shared.size === 0) {
    return [];
  }
  const services = isRecord(parsed.services) ? parsed.services : {};
  const names = new Set<string>();
  for (const service of selectedServices(services, selection)) {
    for (const key of serviceNetworks(services[service])) {
      const name = shared.get(key);
      if (name !== undefined) {
        names.add(name);
      }
    }
  }
  return [...names];
}

/**
 * The network keys a service joins: its `networks` entries, or Compose's
 * implicit `default` when it names none (unless it `extends` another
 * service, whose networking this file cannot settle). `network_mode` joins
 * none.
 */
function serviceNetworks(definition: unknown): readonly string[] {
  if (!isRecord(definition) || definition.network_mode !== undefined) {
    return [];
  }
  if (definition.networks === undefined) {
    // A service that `extends` another can inherit `network_mode` or its
    // networks from a file this check does not read, so its implicit
    // default network cannot be known here; it is left to Compose.
    return definition.extends === undefined ? ["default"] : [];
  }
  return listOrMapKeys(definition.networks);
}

/** Top-level network keys that are external Hack shared networks, to engine names. */
function sharedNetworksByKey(networks: unknown): ReadonlyMap<string, string> {
  const shared = new Map<string, string>();
  if (!isRecord(networks)) {
    return shared;
  }
  for (const [key, value] of Object.entries(networks)) {
    if (!(isRecord(value) && value.external === true)) {
      continue;
    }
    const name = typeof value.name === "string" ? value.name : key;
    if (HACK_SHARED_NETWORKS.includes(name)) {
      shared.set(key, name);
    }
  }
  return shared;
}

function profileActive(
  definition: unknown,
  active: ReadonlySet<string>
): boolean {
  const profiles = isRecord(definition) ? definition.profiles : undefined;
  return (
    !Array.isArray(profiles) ||
    profiles.length === 0 ||
    profiles.some((p) => typeof p === "string" && active.has(p))
  );
}

/**
 * Dependencies Compose starts with a service: every `depends_on` entry,
 * except an optional one (`required: false`) whose service is not active.
 */
function startedDependencies(
  definition: unknown,
  services: Record<string, unknown>,
  active: ReadonlySet<string>
): readonly string[] {
  if (!isRecord(definition)) {
    return [];
  }
  const dependsOn = definition.depends_on;
  return listOrMapKeys(dependsOn).filter((name) => {
    const entry = isRecord(dependsOn) ? dependsOn[name] : undefined;
    const optional = isRecord(entry) && entry.required === false;
    return !optional || profileActive(services[name], active);
  });
}

function selectedServices(
  services: Record<string, unknown>,
  selection: ComposeServiceSelection
): ReadonlySet<string> {
  const active = new Set(selection.profiles);
  const roots =
    selection.requested.length > 0
      ? selection.requested
      : Object.keys(services).filter((name) =>
          profileActive(services[name], active)
        );
  const selected = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const name = queue.pop();
    if (name === undefined || selected.has(name)) {
      continue;
    }
    selected.add(name);
    queue.push(...startedDependencies(services[name], services, active));
  }
  return selected;
}

/** Keys of a Compose list-or-map field (`networks`, `depends_on`). */
function listOrMapKeys(value: unknown): readonly string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }
  return isRecord(value) ? Object.keys(value) : [];
}

/**
 * Run one bounded Docker read. Null when PATH named a `docker` that cannot be
 * started (removed since the lookup, a dangling link, no execute bit): the
 * same answer as none. Any other failure still throws.
 */
async function runDocker(
  deps: Pick<ComposeEnginePreflightDeps, "run">,
  argv: readonly string[]
): Promise<ComposePsProcessResult | null> {
  try {
    return await deps.run(argv, ENGINE_PREFLIGHT_TIMEOUT_MS);
  } catch (error: unknown) {
    if (isSpawnNotFound(error)) {
      return null;
    }
    throw error;
  }
}

function noDockerError(): HackCliError {
  return new HackCliError({
    code: "E_DOCKER_UNAVAILABLE",
    message: NO_DOCKER_MESSAGE,
    startBlocker: {
      thing: "docker",
      problem: "cli missing · install docker engine with compose v2",
    },
  });
}

function isSpawnNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "EACCES")
  );
}
