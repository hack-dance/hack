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
    return new HackCliError({
      code: "E_DOCKER_UNAVAILABLE",
      message: NO_DOCKER_MESSAGE,
    });
  }
  const version = await deps.run(
    ["docker", "version", "--format", "{{.Server.Version}}"],
    ENGINE_PREFLIGHT_TIMEOUT_MS
  );
  if (version.exitCode !== 0) {
    return dockerEngineFailureError({
      result: version,
      command: "docker version",
      redactValues,
    });
  }
  const compose = await deps.run(
    ["docker", "compose", "version", "--short"],
    ENGINE_PREFLIGHT_TIMEOUT_MS
  );
  if (compose.exitCode !== 0) {
    return (
      dockerEngineFailureError({
        result: compose,
        command: "docker compose version",
        redactValues,
      }) ??
      new HackCliError({
        code: "E_DOCKER_UNAVAILABLE",
        message: NO_COMPOSE_MESSAGE,
      })
    );
  }
  return null;
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
    const inspect = await deps.run(
      ["docker", "network", "inspect", "--format", "{{.Name}}", network],
      ENGINE_PREFLIGHT_TIMEOUT_MS
    );
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
 * with an active profile; a scoped `up` starts the named services and what
 * they depend on. Networks only an unselected service joins are left out,
 * because Compose does not need them either.
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
    const definition = services[service];
    if (!isRecord(definition)) {
      continue;
    }
    for (const key of listOrMapKeys(definition.networks)) {
      const name = shared.get(key);
      if (name !== undefined) {
        names.add(name);
      }
    }
  }
  return [...names];
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

function selectedServices(
  services: Record<string, unknown>,
  selection: ComposeServiceSelection
): ReadonlySet<string> {
  if (selection.requested.length === 0) {
    const active = new Set(selection.profiles);
    return new Set(
      Object.entries(services)
        .filter(([, definition]) => {
          const profiles = isRecord(definition)
            ? definition.profiles
            : undefined;
          return (
            !Array.isArray(profiles) ||
            profiles.length === 0 ||
            profiles.some((p) => typeof p === "string" && active.has(p))
          );
        })
        .map(([name]) => name)
    );
  }
  const selected = new Set<string>();
  const queue = [...selection.requested];
  while (queue.length > 0) {
    const name = queue.pop();
    if (name === undefined || selected.has(name)) {
      continue;
    }
    selected.add(name);
    const definition = services[name];
    if (isRecord(definition)) {
      queue.push(...listOrMapKeys(definition.depends_on));
    }
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
