import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_INGRESS_NETWORK,
  GLOBAL_CADDY_COMPOSE_FILENAME,
  GLOBAL_CADDY_DIR_NAME,
  GLOBAL_CADDY_PROJECT_NAME,
} from "../constants.ts";
import {
  ensureDir,
  pathExists,
  readTextFile,
  writeTextFileAtomicIfChanged,
} from "./fs.ts";
import { getString, isRecord } from "./guards.ts";
import { withProjectsRegistryLock } from "./projects-registry-lock.ts";
import { exec, findExecutableInPath } from "./shell.ts";

/**
 * Addresses of the global proxy (Caddy) and resolver (CoreDNS) containers on
 * the ingress network; `null` when that container is absent or not running.
 */
export interface IngressAddresses {
  readonly coreDns: string | null;
  readonly caddy: string | null;
}

type IngressService = "caddy" | "coredns";

/** Which container an address was read from. */
export interface IngressContainerIdentity {
  readonly id: string;
  readonly startedAt: string;
}

/**
 * Which state of the global stack a record belongs to. `hack global up` and
 * `down` and the doctor proxy repair replace the token and mark it unsettled
 * before they touch the stack, and replace it again, settled, afterwards.
 * Missing file: `{ token: "", settled: true }`.
 */
export interface IngressGeneration {
  readonly token: string;
  readonly settled: boolean;
}

/**
 * What Hack last read from Docker about the global stack, kept in Hack's home
 * next to the global Compose file, with the generation token read before the
 * Docker read. Only a read that found both containers running is recorded.
 *
 * A record is trusted only under the current, settled token (model:
 * tests/models/tla/ingress-address-record): a read that overlapped a
 * Hack change of the stack carries an older token and is ignored, and a
 * change that crashed midway leaves the token unsettled, so every run reads
 * Docker until the next settled change. It is also trusted only for the
 * Docker engine it was read from (`engine`): one Hack home used with another
 * `DOCKER_HOST` or Docker context reads that engine instead.
 */
export interface IngressAddressRecord {
  readonly schema: 1;
  readonly generation: string;
  /** The selected Docker engine when read; see {@link selectedDockerEngine}. */
  readonly engine: string;
  readonly coreDns: string;
  readonly caddy: string;
  readonly containers: {
    readonly coredns: IngressContainerIdentity;
    readonly caddy: IngressContainerIdentity;
  };
  readonly recordedAt: string;
}

export interface IngressAddressResult extends IngressAddresses {
  /** True when the addresses came from the record, without a Docker read. */
  readonly fromRecord: boolean;
}

export interface IngressAddressDeps {
  /** `HACK_COREDNS_IP` / `HACK_CADDY_IP` win over any Docker read or record. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** True when the global proxy stack is installed and `docker` is on PATH. */
  readonly stackInstalled: () => Promise<boolean>;
  readonly exec: (argv: readonly string[]) => Promise<{
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
  }>;
  readonly readGeneration: () => Promise<IngressGeneration>;
  /** The selected Docker engine, read without a Docker call. */
  readonly engine: () => Promise<string>;
  readonly readRecord: () => Promise<IngressAddressRecord | null>;
  readonly writeRecord: (record: IngressAddressRecord) => Promise<void>;
  readonly forgetRecord: () => Promise<void>;
  readonly now?: () => Date;
}

const COMPOSE_PROJECT_LABEL = "com.docker.compose.project";
const COMPOSE_SERVICE_LABEL = "com.docker.compose.service";

/** One line per container: project, service, running, id, start, networks. */
const INSPECT_FORMAT = [
  `{{index .Config.Labels "${COMPOSE_PROJECT_LABEL}"}}`,
  `{{index .Config.Labels "${COMPOSE_SERVICE_LABEL}"}}`,
  "{{.State.Running}}",
  "{{.Id}}",
  "{{.State.StartedAt}}",
  "{{json .NetworkSettings.Networks}}",
].join("\t");

/**
 * Container names Compose gives the first replica of `service`: the default
 * `-` form and the `COMPOSE_COMPATIBILITY` `_` form. Inspecting both by name
 * costs nothing extra and the labels below decide identity, not the name.
 */
function candidateNames(service: IngressService): readonly string[] {
  return [
    `${GLOBAL_CADDY_PROJECT_NAME}-${service}-1`,
    `${GLOBAL_CADDY_PROJECT_NAME}_${service}_1`,
  ];
}

/**
 * Resolves both global addresses.
 *
 * - `recorded`: the record wins and no Docker call runs; with no record, one
 *   read as for `fresh`. For commands that create a container and can rebuild
 *   once on a failure a stale address explains (`hack run`).
 * - `fresh`: one `docker inspect` of both containers, recorded when both run.
 *   For `up`, `restart`, `hack global up` and a rebuild.
 *
 * A container counts only when its Compose labels name the global proxy
 * project and the service, and it is running, as `compose ps -q` (which lists
 * running containers) required before. A missing name is absence: `docker
 * inspect` exits 1 but still prints the containers it found.
 */
export async function resolveIngressAddresses(
  deps: IngressAddressDeps,
  mode: "recorded" | "fresh"
): Promise<IngressAddressResult> {
  const fromEnv = {
    coredns: (deps.env.HACK_COREDNS_IP ?? "").trim() || null,
    caddy: (deps.env.HACK_CADDY_IP ?? "").trim() || null,
  } as const;
  const needed = (["coredns", "caddy"] as const).filter(
    (service) => fromEnv[service] === null
  );
  if (needed.length === 0 || !(await deps.stackInstalled())) {
    return {
      coreDns: fromEnv.coredns,
      caddy: fromEnv.caddy,
      fromRecord: false,
    };
  }

  // Read before the inspect: a change that starts after it replaces the
  // token, so this read's record is never trusted under the new one.
  const generation = await deps.readGeneration();
  const engine = await deps.engine();
  if (mode === "recorded") {
    const record = await deps.readRecord();
    if (
      record &&
      generation.settled &&
      record.generation === generation.token &&
      record.engine === engine
    ) {
      return {
        coreDns: fromEnv.coredns ?? record.coreDns,
        caddy: fromEnv.caddy ?? record.caddy,
        fromRecord: true,
      };
    }
  }

  // Both are read even when an env value covers one, so the record stays whole.
  const inspect = await deps.exec([
    "docker",
    "inspect",
    "--type",
    "container",
    "--format",
    INSPECT_FORMAT,
    ...candidateNames("coredns"),
    ...candidateNames("caddy"),
  ]);
  const found = parseInspectLines(inspect.stdout);
  const coredns = found.get("coredns");
  const caddy = found.get("caddy");
  if (coredns && caddy) {
    await deps.writeRecord({
      schema: 1,
      generation: generation.token,
      engine,
      coreDns: coredns.ip,
      caddy: caddy.ip,
      containers: { coredns: coredns.identity, caddy: caddy.identity },
      recordedAt: (deps.now?.() ?? new Date()).toISOString(),
    });
  } else if (reachedEngine(inspect)) {
    // A read that reached the engine and found a container stopped or gone
    // disproves the record; an engine failure proves nothing, so it stays.
    await deps.forgetRecord();
  }
  return {
    coreDns: fromEnv.coredns ?? coredns?.ip ?? null,
    caddy: fromEnv.caddy ?? caddy?.ip ?? null,
    fromRecord: false,
  };
}

const NO_SUCH_CONTAINER = /no such (container|object)/i;

/**
 * True when `docker inspect` answered from the engine: it exited 0, printed a
 * container, or its only errors are names that do not exist.
 */
function reachedEngine(result: {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}): boolean {
  if (result.exitCode === 0 || result.stdout.trim().length > 0) {
    return true;
  }
  const errors = result.stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return (
    errors.length > 0 && errors.every((line) => NO_SUCH_CONTAINER.test(line))
  );
}

type FoundContainer = {
  readonly ip: string;
  readonly identity: IngressContainerIdentity;
};

function parseInspectLines(
  stdout: string
): Map<IngressService, FoundContainer> {
  const out = new Map<IngressService, FoundContainer>();
  for (const line of stdout.split("\n")) {
    const [project, service, running, id, startedAt, networksJson] =
      line.split("\t");
    if (
      project !== GLOBAL_CADDY_PROJECT_NAME ||
      (service !== "caddy" && service !== "coredns") ||
      running !== "true" ||
      out.has(service)
    ) {
      continue;
    }
    const ip = ingressIp(networksJson ?? "");
    if (ip !== null) {
      out.set(service, {
        ip,
        identity: { id: id ?? "", startedAt: startedAt ?? "" },
      });
    }
  }
  return out;
}

function ingressIp(networksJson: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(networksJson);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }
  const network = parsed[DEFAULT_INGRESS_NETWORK];
  if (!isRecord(network)) {
    return null;
  }
  const ip = network.IPAddress;
  return typeof ip === "string" && ip.length > 0 ? ip : null;
}

/** Parses a stored record; anything else is no record. */
export function parseIngressAddressRecord(
  value: unknown
): IngressAddressRecord | null {
  if (!isRecord(value) || value.schema !== 1) {
    return null;
  }
  const generation = value.generation;
  const engine = getString(value, "engine");
  const coreDns = getString(value, "coreDns");
  const caddy = getString(value, "caddy");
  const recordedAt = getString(value, "recordedAt");
  const containers = value.containers;
  if (
    !(
      typeof generation === "string" &&
      engine &&
      coreDns &&
      caddy &&
      recordedAt &&
      isRecord(containers)
    )
  ) {
    return null;
  }
  const coredns = parseIdentity(containers.coredns);
  const caddyIdentity = parseIdentity(containers.caddy);
  if (!(coredns && caddyIdentity)) {
    return null;
  }
  return {
    schema: 1,
    generation,
    engine,
    coreDns,
    caddy,
    containers: { coredns, caddy: caddyIdentity },
    recordedAt,
  };
}

function parseIdentity(value: unknown): IngressContainerIdentity | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = getString(value, "id");
  const startedAt = getString(value, "startedAt");
  return id && startedAt ? { id, startedAt } : null;
}

/**
 * Which Docker engine `docker` talks to, the way the CLI chooses it, without
 * a Docker call: `DOCKER_HOST`, else `DOCKER_CONTEXT`, else the
 * `currentContext` of the Docker config (`DOCKER_CONFIG`, else
 * `~/.docker`), else the default context. A context whose endpoint is edited
 * in place keeps its name; a `hack run` that then fails reads Docker again.
 */
export async function selectedDockerEngine(
  env: Readonly<Record<string, string | undefined>>
): Promise<string> {
  const host = (env.DOCKER_HOST ?? "").trim();
  if (host) {
    return `host:${host}`;
  }
  const context = (env.DOCKER_CONTEXT ?? "").trim();
  if (context) {
    return `context:${context}`;
  }
  const configDir =
    (env.DOCKER_CONFIG ?? "").trim() || join(homedir(), ".docker");
  const text = await readTextFile(join(configDir, "config.json"));
  if (text) {
    try {
      const parsed: unknown = JSON.parse(text);
      const current = isRecord(parsed)
        ? getString(parsed, "currentContext")
        : null;
      if (current) {
        return `context:${current}`;
      }
    } catch {
      // An unreadable config selects the default context, as for docker.
    }
  }
  return "context:default";
}

const RECORD_FILENAME = "ingress-addresses.json";

/** `<hack home>/caddy/ingress-addresses.json`, next to the global Compose file. */
export function ingressAddressRecordPath(hackHome: string): string {
  return join(hackHome, GLOBAL_CADDY_DIR_NAME, RECORD_FILENAME);
}

export async function readIngressAddressRecord(
  hackHome: string
): Promise<IngressAddressRecord | null> {
  const text = await readTextFile(ingressAddressRecordPath(hackHome));
  if (!text) {
    return null;
  }
  try {
    return parseIngressAddressRecord(JSON.parse(text));
  } catch {
    return null;
  }
}

/** Removes the record; the next `hack run` reads Docker once. */
export async function forgetIngressAddressRecord(
  hackHome: string
): Promise<void> {
  await rm(ingressAddressRecordPath(hackHome), { force: true });
}

const GENERATION_FILENAME = "ingress-generation.json";

function ingressGenerationPath(hackHome: string): string {
  return join(hackHome, GLOBAL_CADDY_DIR_NAME, GENERATION_FILENAME);
}

export async function readIngressGeneration(
  hackHome: string
): Promise<IngressGeneration> {
  const text = await readTextFile(ingressGenerationPath(hackHome));
  if (!text) {
    return { token: "", settled: true };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      isRecord(parsed) &&
      typeof parsed.token === "string" &&
      typeof parsed.settled === "boolean"
    ) {
      return { token: parsed.token, settled: parsed.settled };
    }
  } catch {
    // An unreadable token trusts no record.
  }
  return { token: "unreadable", settled: false };
}

async function writeIngressGeneration(
  hackHome: string,
  settled: boolean
): Promise<void> {
  await ensureDir(join(hackHome, GLOBAL_CADDY_DIR_NAME));
  await writeTextFileAtomicIfChanged(
    ingressGenerationPath(hackHome),
    `${JSON.stringify({ token: crypto.randomUUID(), settled })}\n`
  );
}

/** A `hack global up` may pull images while a second change waits. */
const INGRESS_CHANGE_LOCK_TIMEOUT_MS = 15 * 60_000;

/**
 * Runs a Hack change of the global stack (`global up`/`down`, doctor proxy
 * repair) between an unsettled and a settled new generation token, so no
 * record read before or during it is trusted afterwards. The token is settled
 * even when `change` fails: the stack is then whatever it is, and every
 * record from before is already untrusted.
 *
 * Changes are serialized across processes: without that, one change's settled
 * token could land while another change is still moving the containers, and a
 * read in between would be trusted (model control `unlocked`). The lock is
 * reclaimed only from an owner whose process is gone; a crashed change leaves
 * its token unsettled until the next change settles it.
 */
export async function withIngressChange<T>(
  hackHome: string,
  change: () => Promise<T>
): Promise<T> {
  await ensureDir(join(hackHome, GLOBAL_CADDY_DIR_NAME));
  return await withProjectsRegistryLock({
    lockPath: join(hackHome, GLOBAL_CADDY_DIR_NAME, CHANGE_LOCK_FILENAME),
    timeoutMs: INGRESS_CHANGE_LOCK_TIMEOUT_MS,
    label: "Global proxy change",
    run: async () => {
      await writeIngressGeneration(hackHome, false);
      try {
        return await change();
      } finally {
        await writeIngressGeneration(hackHome, true);
      }
    },
  });
}

const CHANGE_LOCK_FILENAME = "ingress-change.lock";

/** The real Docker and record IO for the global stack under `hackHome`. */
export function defaultIngressAddressDeps(
  hackHome: string
): IngressAddressDeps {
  return {
    env: process.env,
    stackInstalled: async () =>
      findExecutableInPath("docker") !== null &&
      (await pathExists(
        join(hackHome, GLOBAL_CADDY_DIR_NAME, GLOBAL_CADDY_COMPOSE_FILENAME)
      )),
    exec: async (argv) => await exec(argv, { stdin: "ignore" }),
    readGeneration: async () => await readIngressGeneration(hackHome),
    engine: async () => await selectedDockerEngine(process.env),
    readRecord: async () => await readIngressAddressRecord(hackHome),
    forgetRecord: async () => await forgetIngressAddressRecord(hackHome),
    writeRecord: async (record) => {
      const path = ingressAddressRecordPath(hackHome);
      await ensureDir(join(hackHome, GLOBAL_CADDY_DIR_NAME));
      await writeTextFileAtomicIfChanged(
        path,
        `${JSON.stringify(record, null, 2)}\n`
      );
    },
  };
}
