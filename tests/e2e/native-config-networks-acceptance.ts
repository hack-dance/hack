import { spawn } from "node:child_process";
import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readlink,
  realpath,
  symlink,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Readable } from "node:stream";
import type {
  Project,
  Workload,
} from "../../packages/config-compiler/generated/native-config.ts";
import { isRecord } from "../../src/lib/guards.ts";
import {
  type NativeComposeIdentity,
  openNativeComposeGenerationStore,
  readNativeComposeNetworkTopology,
} from "../../src/lib/native-compose-generation.ts";
import { nativeComposeProxyRoutesMatch } from "../../src/lib/native-compose-proxy-routes.ts";
import { readNativeComposeRouteMetadata } from "../../src/lib/native-compose-route-owner.ts";
import type { CliResult, Scenario, ScenarioContext } from "./harness.ts";

const ID = /^[a-f0-9]{64}$/;
const SHA = /^sha256:[a-f0-9]{64}$/;
const REVISION = /^[a-f0-9]{40}$/;
const PROJECT = "com.docker.compose.project";
const SERVICE = "com.docker.compose.service";
const VERSION = "io.hack.native-config.version";
const INSTANCE = "io.hack.native-config.instance";
const OWNER = "io.hack.native-config.owner";
const GENERATION = "io.hack.native-config.generation";
const STORAGE = "io.hack.native-config.storage";
const GLOBAL_PROJECT = "hack-dev-proxy";
const FIXTURE = "hack.e2e.native-config-networks";
const OUTPUT_LIMIT = 2 * 1024 * 1024;
const COMMAND_TIMEOUT = 180_000;
// Witness-bearing exec/up verification runs three fresh helper carriers per proof; on the
// hosted Linux engine that is ~12-15 s per exec and ~35 s per up across three checkouts.
const SCENARIO_TIMEOUT = 80 * 60_000;
const CLEANUP_TIMEOUT = 3 * 60_000;
const BUN_TAG = "oven/bun:1.4.2-slim";
const CADDY_TAG = "lucaslorentz/caddy-docker-proxy:2.10.0-alpine";
const ROOT_CA = "/data/caddy/pki/authorities/local/root.crt";
const PRIVATE_TMPFS = "rw,nosuid,nodev,noexec,size=64m,mode=0700";
const NAMES = ["peer", "reader", "vault", "web"] as const;
const REFUSAL_STAGES = [
  "unrouted_run",
  "disconnected_validation",
  "disconnected_endpoint",
  "topology_mutation",
  "routed_run",
] as const;
type RefusalStage = (typeof REFUSAL_STAGES)[number];
type Name = (typeof NAMES)[number];
type Docker = (args: readonly string[]) => Promise<string>;
type NetworkPolicy = { readonly name: string; readonly internal: boolean };
export type NativeNetworkFixtureVolume = {
  readonly name: string;
  readonly createdAt: string;
  readonly storage: string;
  readonly project: string;
  readonly owner: string;
};
export type NativeNetworkFixtureNetwork = NetworkPolicy & {
  readonly id: string;
  readonly createdAt: string;
  readonly project: string;
  readonly owner: string;
};

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

/** Fixed failure evidence only; never include argv, source, stderr or paths. */
export function nativeNetworkFixtureRefusalDiagnostic(opts: {
  readonly stage: RefusalStage;
  readonly fragmentPresent: boolean;
  readonly dockerInvoked: boolean;
}): string {
  if (
    typeof opts.stage !== "string" ||
    !REFUSAL_STAGES.includes(opts.stage) ||
    typeof opts.fragmentPresent !== "boolean" ||
    typeof opts.dockerInvoked !== "boolean"
  ) {
    return "Network refusal diagnostic unavailable";
  }
  return `Network refusal diagnostic ${JSON.stringify({
    stage: opts.stage,
    fragmentPresent: opts.fragmentPresent,
    dockerInvoked: opts.dockerInvoked,
  })}`;
}
function object(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Fixture requires complete bounded JSON; values omitted");
  }
  requireValue(
    isRecord(value),
    "Fixture requires a JSON object; values omitted"
  );
  return value;
}
function own(value: Record<string, unknown>, name: string): unknown {
  return Object.hasOwn(value, name) ? value[name] : undefined;
}

/** The mutation owner redacts admission failures to this fixed state error. */
export function nativeNetworkFixtureStateRefused(value: unknown): boolean {
  if (!isRecord(value) || own(value, "ok") !== false) {
    return false;
  }
  const error = own(value, "error");
  return (
    isRecord(error) &&
    own(error, "code") === "E_CONFIG_INVALID" &&
    own(error, "message") ===
      "Native Compose state is unsafe or changed; values omitted. Inspect owned state before recovery."
  );
}

/** Docker inspect may permute Mounts; every field and mount entry must survive. */
export function nativeNetworkFixturePreservedContainerMatches(opts: {
  readonly before: string;
  readonly after: string;
}): boolean {
  const normalize = (text: string): Record<string, unknown> | null => {
    if (Buffer.byteLength(text) > OUTPUT_LIMIT) {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return null;
    }
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 1 ||
      !isRecord(parsed[0]) ||
      typeof parsed[0].Id !== "string" ||
      !ID.test(parsed[0].Id) ||
      !Array.isArray(parsed[0].Mounts)
    ) {
      return null;
    }
    const mounts: {
      readonly destination: string;
      readonly value: Record<string, unknown>;
    }[] = [];
    const destinations = new Set<string>();
    for (const mount of parsed[0].Mounts) {
      if (
        !isRecord(mount) ||
        typeof mount.Destination !== "string" ||
        mount.Destination.length === 0 ||
        destinations.has(mount.Destination)
      ) {
        return null;
      }
      destinations.add(mount.Destination);
      mounts.push({ destination: mount.Destination, value: mount });
    }
    mounts.sort((left, right) =>
      left.destination.localeCompare(right.destination)
    );
    return { ...parsed[0], Mounts: mounts.map((mount) => mount.value) };
  };
  const before = normalize(opts.before);
  const after = normalize(opts.after);
  return (
    before !== null &&
    after !== null &&
    JSON.stringify(before) === JSON.stringify(after)
  );
}
function sameNames(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.every((name) => typeof name === "string") &&
    new Set(value).size === value.length &&
    JSON.stringify([...value].sort()) === JSON.stringify([...expected].sort())
  );
}
function identifiers(text: string): string[] {
  const values = text.split(/\s+/).filter(Boolean).sort();
  requireValue(
    values.every((id) => ID.test(id)) && new Set(values).size === values.length,
    "Fixture inventory requires unique complete engine IDs"
  );
  return values;
}
export function nativeNetworkFixtureHasNoPublication(value: unknown): boolean {
  return (
    value === null ||
    (isRecord(value) &&
      Object.entries(value).every(
        ([port, bindings]) =>
          /^\d+\/(?:tcp|udp|sctp)$/.test(port) && bindings === null
      ))
  );
}
function labelsMatch(
  value: unknown,
  identity: { readonly project: string; readonly owner: string }
): boolean {
  return (
    isRecord(value) &&
    own(value, PROJECT) === identity.project &&
    own(value, INSTANCE) === identity.project &&
    own(value, OWNER) === identity.owner &&
    own(value, VERSION) === "1"
  );
}

/** Read-only protocol admission; a binary claiming an older contract never receives fixture inputs. */
export function nativeNetworkFixtureProtocolMatches(value: unknown): boolean {
  const required = [
    "transport_version",
    "authored_version",
    "plan_version",
    "resolve_version",
    "local_version",
    "env_plan_version",
    "endpoint_plan_version",
    "process_plan_version",
    "acquisition_plan_version",
    "network_plan_version",
  ];
  return isRecord(value) && required.every((name) => own(value, name) === 1);
}

/** A captured retained volume must still exist as the exact singleton before deliberate removal. */
export function nativeNetworkFixtureVolumeMatches(
  value: unknown,
  pin: NativeNetworkFixtureVolume
): boolean {
  return (
    isRecord(value) &&
    own(value, "Name") === pin.name &&
    own(value, "CreatedAt") === pin.createdAt &&
    own(value, "Driver") === "local" &&
    labelsMatch(own(value, "Labels"), pin) &&
    isRecord(value.Labels) &&
    own(value.Labels, STORAGE) === pin.storage
  );
}
export function nativeNetworkFixtureVolumeSelectionMatches(
  names: readonly string[],
  pin: NativeNetworkFixtureVolume | null
): boolean {
  return pin === null
    ? names.length === 0
    : names.length === 1 && names[0] === pin.name;
}

/** Network deletion requires the pinned physical ID and creation identity, empty endpoints, and exact policy. */
export function nativeNetworkFixtureNetworkMatches(
  value: unknown,
  pin: NativeNetworkFixtureNetwork,
  empty: boolean
): boolean {
  return (
    isRecord(value) &&
    own(value, "Id") === pin.id &&
    own(value, "Name") === pin.name &&
    own(value, "Created") === pin.createdAt &&
    own(value, "Driver") === "bridge" &&
    own(value, "Internal") === pin.internal &&
    labelsMatch(own(value, "Labels"), pin) &&
    isRecord(value.Containers) &&
    (!empty || Object.keys(value.Containers).length === 0)
  );
}

/** Independent observed attachment check. Empty addresses are admitted only for a real created-recovery shape. */
export function nativeNetworkFixtureAttachmentMatches(opts: {
  readonly value: unknown;
  readonly networkId: string;
  readonly aliases: readonly string[];
  readonly created: boolean;
}): boolean {
  if (!(isRecord(opts.value) && ID.test(opts.networkId))) {
    return false;
  }
  const id = own(opts.value, "NetworkID");
  const aliases = own(opts.value, "Aliases");
  const emptyCreated = opts.created && (id === "" || id === undefined);
  return (
    (id === opts.networkId || emptyCreated) &&
    (sameNames(aliases, opts.aliases) ||
      (emptyCreated &&
        (aliases === null || aliases === undefined || sameNames(aliases, []))))
  );
}

/** Every operation is captured into private regular files with finite time/output bounds and a detached owned group. */
export async function runNativeNetworkFixtureCommand(opts: {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly captures: string;
  readonly timeoutMs?: number;
  readonly outputLimit?: number;
  /** Focused fault observation. A thrown capture error must kill/reap before fixture cleanup. */
  readonly afterCaptureWrite?: () => void;
}): Promise<CliResult> {
  const timeout = opts.timeoutMs ?? COMMAND_TIMEOUT;
  const limit = opts.outputLimit ?? OUTPUT_LIMIT;
  requireValue(
    timeout > 0 &&
      timeout <= COMMAND_TIMEOUT &&
      limit > 0 &&
      limit <= OUTPUT_LIMIT,
    "Fixture command budgets must be positive and bounded"
  );
  await mkdir(opts.captures, { recursive: true, mode: 0o700 });
  const token = randomBytes(16).toString("hex");
  const output = await open(
    join(opts.captures, `${token}.stdout`),
    constants.O_CREAT | constants.O_EXCL | constants.O_RDWR,
    0o600
  );
  const errors = await open(
    join(opts.captures, `${token}.stderr`),
    constants.O_CREAT | constants.O_EXCL | constants.O_RDWR,
    0o600
  );
  const started = Date.now();
  let timedOut = false;
  let oversized = false;
  let groupFailure: unknown;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const executable = opts.argv[0];
    requireValue(
      typeof executable === "string" && executable.startsWith("/"),
      "Fixture executable must be an absolute pinned path"
    );
    const launched = spawn(executable, [...opts.argv.slice(1)], {
      cwd: opts.cwd,
      env: { ...opts.env },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let killRequested = false;
    const kill = (): void => {
      if (killRequested) {
        return;
      }
      killRequested = true;
      if (launched.pid !== undefined) {
        try {
          process.kill(-launched.pid, "SIGKILL");
        } catch (error: unknown) {
          if (
            !(
              isRecord(error) &&
              (error.code === "ESRCH" ||
                (error.code === "EPERM" &&
                  (launched.exitCode !== null || launched.signalCode !== null)))
            )
          ) {
            groupFailure = error;
            // This child handle remains owned even if the group signal could not be confirmed.
            try {
              launched.kill("SIGKILL");
            } catch {
              /* The child exit is still awaited below. */
            }
          }
        }
      }
    };
    requireValue(
      launched.stdout !== null && launched.stderr !== null,
      "Owned command capture streams must exist"
    );
    const capture = async (
      stream: Readable,
      file: FileHandle
    ): Promise<void> => {
      let size = 0;
      for await (const raw of stream) {
        const chunk: Buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        const count = Math.min(chunk.length, limit - size);
        if (count > 0) {
          await file.write(chunk.subarray(0, count));
          size += count;
          opts.afterCaptureWrite?.();
        }
        if (count < chunk.length) {
          oversized = true;
          kill();
        }
      }
    };
    timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeout);
    const exited = new Promise<number>((resolveExit, reject) => {
      launched.once("error", reject);
      launched.once("exit", (code) => {
        // Reap descendants of this just-launched detached group; no stale PID reclamation.
        kill();
        resolveExit(code ?? 128);
      });
    });
    const stdoutCapture = capture(launched.stdout, output);
    const stderrCapture = capture(launched.stderr, errors);
    let exitCode: number;
    try {
      [exitCode] = await Promise.all([exited, stdoutCapture, stderrCapture]);
    } catch {
      kill();
      // No fixture ownership cleanup may overlap a command whose output transport failed.
      await Promise.allSettled([exited, stdoutCapture, stderrCapture]);
      throw new Error(
        "Fixture capture failed after owned command reap; captures retained"
      );
    }
    clearTimeout(timer);
    timer = null;
    requireValue(
      !oversized,
      "Fixture command exceeded its output bound; bounded captures retained"
    );
    const [outInfo, errInfo] = await Promise.all([
      output.stat(),
      errors.stat(),
    ]);
    const stdoutBytes = Buffer.alloc(outInfo.size),
      stderrBytes = Buffer.alloc(errInfo.size);
    await output.read(stdoutBytes, 0, stdoutBytes.length, 0);
    await errors.read(stderrBytes, 0, stderrBytes.length, 0);
    const stdout = stdoutBytes.toString("utf8"),
      stderr = stderrBytes.toString("utf8");
    requireValue(
      !timedOut,
      "Fixture command timed out; uncertain engine outcome and captures retained"
    );
    requireValue(
      groupFailure === undefined,
      "Fixture could not confirm owned group cleanup; captures retained"
    );
    return {
      command: executable,
      exitCode,
      stdout,
      stderr,
      combined: `${stdout}\n${stderr}`,
      timedOut,
      durationMs: Date.now() - started,
    };
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
    await Promise.all([output.close(), errors.close()]);
  }
}

function digest(text: string | Uint8Array): string {
  return createHash("sha256").update(text).digest("hex");
}
async function artifact(path: string, expected: string) {
  requireValue(
    ID.test(expected) && path === (await realpath(path)),
    "Fixture artifact must be canonical and hash-qualified"
  );
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    requireValue(
      info.isFile() &&
        info.nlink === 1 &&
        (info.mode & 0o111) !== 0 &&
        digest(await file.readFile()) === expected,
      "Fixture artifact identity/hash qualification failed"
    );
    const after = await file.stat();
    const named = await lstat(path);
    requireValue(
      named.isFile() &&
        !named.isSymbolicLink() &&
        [after, named].every(
          (value) =>
            value.dev === info.dev &&
            value.ino === info.ino &&
            value.nlink === 1 &&
            value.size === info.size &&
            value.mtimeMs === info.mtimeMs &&
            value.ctimeMs === info.ctimeMs
        ),
      "Fixture artifact changed during qualification"
    );
    return { path, sha256: expected, dev: info.dev, ino: info.ino };
  } finally {
    await file.close();
  }
}

/** Register only the explicitly pinned installed plugin in this owned empty Docker config. Never copy caller config/auth. */
export async function provisionNativeNetworkFixtureComposePlugin(opts: {
  readonly path: string;
  readonly expectedHash: string;
  readonly dockerConfig: string;
}) {
  const plugin = await artifact(opts.path, opts.expectedHash);
  const directory = await lstat(opts.dockerConfig);
  requireValue(
    directory.isDirectory() &&
      !directory.isSymbolicLink() &&
      directory.uid === process.getuid?.() &&
      (directory.mode & 0o777) === 0o700 &&
      (await realpath(opts.dockerConfig)) === opts.dockerConfig,
    "Compose plugin requires the canonical private fixture config"
  );
  const plugins = join(opts.dockerConfig, "cli-plugins");
  await mkdir(plugins, { mode: 0o700 });
  const pluginDirectory = await lstat(plugins);
  requireValue(
    pluginDirectory.isDirectory() &&
      !pluginDirectory.isSymbolicLink() &&
      pluginDirectory.uid === process.getuid?.() &&
      (pluginDirectory.mode & 0o777) === 0o700 &&
      (await realpath(plugins)) === plugins,
    "Compose plugin registration directory is unsafe"
  );
  const installed = join(plugins, "docker-compose");
  await symlink(plugin.path, installed);
  const named = await lstat(installed);
  requireValue(
    named.isSymbolicLink() &&
      (await readlink(installed)) === plugin.path &&
      (await realpath(installed)) === plugin.path,
    "Compose plugin registration changed"
  );
  const latest = await artifact(plugin.path, plugin.sha256);
  const config = await lstat(opts.dockerConfig);
  const finalPlugins = await lstat(plugins);
  requireValue(
    latest.dev === plugin.dev &&
      latest.ino === plugin.ino &&
      config.dev === directory.dev &&
      config.ino === directory.ino &&
      config.uid === process.getuid?.() &&
      (config.mode & 0o777) === 0o700 &&
      finalPlugins.dev === pluginDirectory.dev &&
      finalPlugins.ino === pluginDirectory.ino &&
      finalPlugins.uid === process.getuid?.() &&
      (finalPlugins.mode & 0o777) === 0o700 &&
      (await realpath(plugins)) === plugins &&
      (await realpath(opts.dockerConfig)) === opts.dockerConfig,
    "Compose plugin owner or binary changed before admission"
  );
  return { ...plugin, registeredPath: installed };
}

const SERVER = [
  'if(!["web","peer","vault","reader"].includes(process.env.ROLE ?? "")) process.exit(23);',
  'Bun.serve({hostname:"0.0.0.0",port:3000,fetch(){return new Response(`${process.env.MARKER}:${process.env.ROLE}`)}});',
].join("\n");
function authored(opts: {
  readonly name: string;
  readonly image: string;
  readonly marker: string;
  readonly inside?: boolean;
  readonly routed?: boolean;
}): Project {
  const workload = (
    name: Name,
    network: string,
    alias: string,
    target: Name
  ): Workload => ({
    image: opts.image,
    pull_policy: "never",
    init: true,
    restart: { kind: "no" },
    command: { exec: ["bun", "-e", SERVER] },
    networks: { [network]: { aliases: [alias] } },
    environment: {
      ROLE: { literal: name },
      MARKER: { literal: opts.marker },
      NO_PROXY: { literal: "*" },
      no_proxy: { literal: "*" },
      PEER_ORIGIN: {
        endpoint: {
          kind: "service",
          name: target,
          port: 3000,
          protocol: "http",
        },
      },
    },
    ...(name === "web"
      ? {
          mounts: [
            {
              storage: "state",
              target: "/state",
              access: "read-write" as const,
            },
          ],
        }
      : {}),
    readiness: {
      kind: "exec",
      command: {
        exec: [
          "bun",
          "-e",
          'const r=await fetch("http://127.0.0.1:3000/",{signal:AbortSignal.timeout(3000)});process.exit(r.ok?0:1)',
        ],
      },
      interval: "1s",
      timeout: "5s",
      retries: 20,
    },
  });
  return {
    schema_version: 1,
    name: opts.name,
    source: { root: ".", mode: "host-mounted" },
    storage: { state: { kind: "persistent", scope: "worktree" } },
    networks: {
      outbound: { internal: false },
      inside: { internal: opts.inside ?? true },
    },
    services: {
      web: workload("web", "outbound", "web-alias", "peer"),
      peer: workload("peer", "outbound", "peer-alias", "web"),
      vault: workload("vault", "inside", "vault-alias", "reader"),
      reader: workload("reader", "inside", "reader-alias", "vault"),
    },
    ...(opts.routed
      ? {
          routes: {
            domain: "network-fixture.test",
            http: {
              app: {
                service: "web",
                port: 3000,
                protocol: "http" as const,
                hostname: "project" as const,
              },
            },
          },
        }
      : {}),
  };
}
type Checkout = {
  readonly root: string;
  readonly name: string;
  readonly marker: string;
  readonly path: string;
  readonly text: string;
};
async function saved(root: string) {
  const store = await openNativeComposeGenerationStore({
    projectRoot: root,
    instance: null,
    mode: "saved",
  });
  try {
    const state = await store.loadCurrent();
    const generation = state.generation ?? (await store.loadPending());
    requireValue(generation !== null, "Fixture saved generation must exist");
    const document = await store.withLease({
      generation,
      run: () => store.readGenerationDocument(generation),
    });
    const topology = readNativeComposeNetworkTopology(document, store.identity);
    requireValue(
      isRecord(document.volumes) &&
        isRecord(document.volumes.state) &&
        typeof document.volumes.state.name === "string",
      "Fixture must retain the authored physical state volume"
    );
    return {
      identity: store.identity,
      state,
      generation,
      document,
      topology,
      volumeName: document.volumes.state.name,
    };
  } finally {
    await store.close();
  }
}
type Saved = Awaited<ReturnType<typeof saved>>;
type Snapshot = {
  readonly containers: readonly string[];
  readonly networks: readonly NativeNetworkFixtureNetwork[];
  readonly volume: NativeNetworkFixtureVolume;
  readonly generation: string;
};

async function inspect(
  docker: Docker,
  kind: "container" | "network" | "volume",
  id: string
): Promise<Record<string, unknown>> {
  const result: unknown = JSON.parse(await docker([kind, "inspect", id]));
  requireValue(
    Array.isArray(result) && result.length === 1 && isRecord(result[0]),
    "Fixture requires a single exact inspected resource"
  );
  return result[0];
}
async function inventory(
  docker: Docker,
  kind: "container" | "network" | "volume",
  project: string
): Promise<string[]> {
  const prefix =
    kind === "container"
      ? ["container", "ls", "-aq", "--no-trunc"]
      : [kind, "ls", "-q", ...(kind === "network" ? ["--no-trunc"] : [])];
  const values = (
    await docker([...prefix, "--filter", `label=${PROJECT}=${project}`])
  )
    .split(/\s+/)
    .filter(Boolean)
    .sort();
  requireValue(
    new Set(values).size === values.length &&
      (kind === "volume" || values.every((id) => ID.test(id))),
    "Fixture inventories must use unique physical identities"
  );
  return values;
}
/** Fixture test seam: validate the actual inventory invocation and response together. */
export { inventory as nativeNetworkFixtureInventory };
function runtimeLabels(source: Saved) {
  return {
    project: source.identity.composeProject,
    owner: source.identity.ownerToken,
  };
}

async function observedContainer(opts: {
  readonly docker: Docker;
  readonly source: Saved;
  readonly id: string;
  readonly image: string;
  readonly networks: readonly NativeNetworkFixtureNetwork[];
  readonly created: boolean;
}): Promise<string> {
  const { docker, source, id, image, networks, created } = opts;
  const expected = runtimeLabels(source);
  const value = await inspect(docker, "container", id);
  requireValue(
    isRecord(value.Config) &&
      isRecord(value.Config.Labels) &&
      isRecord(value.HostConfig) &&
      isRecord(value.NetworkSettings) &&
      isRecord(value.State),
    "Container inspection shape must be complete"
  );
  const labels = value.Config.Labels;
  const service = own(labels, SERVICE);
  requireValue(
    value.Id === id &&
      labelsMatch(labels, expected) &&
      own(labels, GENERATION) === source.generation.generationId &&
      typeof service === "string" &&
      NAMES.includes(service as Name) &&
      own(labels, "io.hack.native-config.workload") === "service" &&
      own(labels, "com.docker.compose.oneoff") === "False" &&
      value.Image === image &&
      value.HostConfig.PublishAllPorts === false &&
      nativeNetworkFixtureHasNoPublication(value.HostConfig.PortBindings) &&
      nativeNetworkFixtureHasNoPublication(value.NetworkSettings.Ports),
    "Fixture container image/ownership/publication differs from the saved qualification"
  );
  requireValue(
    value.State.Status === (created ? "created" : "running") &&
      (created ||
        (isRecord(value.State.Health) &&
          value.State.Health.Status === "healthy")),
    "Fixture must observe actual created state or healthy readiness"
  );
  const policy = source.topology.workloads.find(
    (entry) => entry.service === service
  );
  requireValue(
    policy &&
      isRecord(value.NetworkSettings.Networks) &&
      sameNames(
        Object.keys(value.NetworkSettings.Networks),
        policy.networks.map((entry) => entry.name)
      ),
    "Container attachments must match exact saved network selection"
  );
  for (const attachment of policy.networks) {
    const networkId = attachment.external
      ? (await inspect(docker, "network", attachment.name)).Id
      : networks.find((network) => network.name === attachment.name)?.id;
    requireValue(
      typeof networkId === "string" && typeof value.Name === "string",
      "Attachment requires its pinned physical network"
    );
    const aliases = [value.Name.slice(1), service, ...attachment.aliases];
    requireValue(
      nativeNetworkFixtureAttachmentMatches({
        value: own(value.NetworkSettings.Networks, attachment.name),
        networkId,
        aliases,
        created,
      }),
      "Actual NetworkID/aliases must match configured attachment"
    );
    if (!(created || attachment.external)) {
      const network = await inspect(docker, "network", networkId);
      requireValue(
        isRecord(network.Containers) && Object.hasOwn(network.Containers, id),
        "Actual bridge must contain every reciprocal workload endpoint"
      );
    }
  }
  return service;
}

async function snapshot(
  docker: Docker,
  source: Saved,
  image: string,
  created = false,
  policy: { readonly inside: boolean; readonly routed: boolean } = {
    inside: true,
    routed: false,
  }
): Promise<Snapshot> {
  const expected = runtimeLabels(source);
  requireValue(
    isRecord(source.document.networks) &&
      sameNames(
        Object.keys(source.document.networks),
        policy.routed
          ? ["inside", "outbound", "ingress"]
          : ["inside", "outbound"]
      ) &&
      isRecord(own(source.document.networks, "inside")) &&
      isRecord(own(source.document.networks, "outbound")),
    "Saved generated network definitions must match independently authored fixture names"
  );
  const inside = own(source.document.networks, "inside");
  const outbound = own(source.document.networks, "outbound");
  requireValue(
    isRecord(inside) &&
      inside.internal === policy.inside &&
      isRecord(outbound) &&
      outbound.internal === false,
    "Saved generated policies must match independently authored internal/outbound intent"
  );
  for (const workload of source.topology.workloads) {
    const logical = ["web", "peer"].includes(workload.service)
      ? "outbound"
      : "inside";
    requireValue(
      NAMES.includes(workload.service as Name) &&
        sameNames(
          workload.networks.map((n) => n.logicalName),
          policy.routed && workload.service === "web"
            ? [logical, "ingress"]
            : [logical]
        ) &&
        workload.networks.every((n) =>
          sameNames(
            n.aliases,
            n.logicalName === "ingress" ? [] : [`${workload.service}-alias`]
          )
        ),
      "Saved generated attachments/aliases must match independently authored fixture selection"
    );
  }
  const networks: NativeNetworkFixtureNetwork[] = [];
  const selectedNetworks = await inventory(docker, "network", expected.project);
  requireValue(
    selectedNetworks.length === 2,
    "Exactly two authored bridges must be allocated per checkout"
  );
  for (const policy of source.topology.networks) {
    const value = await inspect(docker, "network", policy.name);
    requireValue(
      typeof value.Id === "string" &&
        ID.test(value.Id) &&
        typeof value.Created === "string" &&
        selectedNetworks.includes(value.Id) &&
        value.Name === policy.name &&
        labelsMatch(value.Labels, expected),
      "Observed network must match the saved exact physical ownership"
    );
    const pin = {
      ...expected,
      id: value.Id,
      name: policy.name,
      createdAt: value.Created,
      internal: policy.internal,
    };
    requireValue(
      nativeNetworkFixtureNetworkMatches(value, pin, created),
      "Observed bridge driver/internal policy or created emptiness differs"
    );
    networks.push(pin);
  }
  const containers = await inventory(docker, "container", expected.project);
  requireValue(
    containers.length === NAMES.length,
    "Exactly four fixture services must be allocated"
  );
  const observedNames = new Set<string>();
  for (const id of containers) {
    const service = await observedContainer({
      docker,
      source,
      id,
      image,
      networks,
      created,
    });
    requireValue(
      !observedNames.has(service),
      "Fixture may not count duplicate observed service names"
    );
    observedNames.add(service);
  }

  const volume = await inspect(docker, "volume", source.volumeName);
  requireValue(
    typeof volume.CreatedAt === "string",
    "Retained fixture volume requires creation identity"
  );
  const pin = {
    ...expected,
    name: source.volumeName,
    createdAt: volume.CreatedAt,
    storage: "state",
  };
  requireValue(
    nativeNetworkFixtureVolumeMatches(volume, pin) &&
      nativeNetworkFixtureVolumeSelectionMatches(
        await inventory(docker, "volume", expected.project),
        pin
      ),
    "Fixture requires exactly the owned persistent state volume"
  );
  return {
    containers,
    networks: networks.sort((a, b) => a.name.localeCompare(b.name)),
    volume: pin,
    generation: source.generation.generationId,
  };
}

function resultOk(result: CliResult, expected = 0): void {
  requireValue(
    result.exitCode === expected && !result.timedOut,
    `Fixture command must exit ${expected}; captures retained`
  );
}
function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** A deliberately failed up materializes only the exact saved document's create operation. */
export function nativeNetworkFixtureCreateArgs(
  args: readonly string[],
  project: string
): readonly string[] | null {
  if (
    !(
      args.length === 8 &&
      args[0] === "compose" &&
      args[1] === "-p" &&
      args[2] === project &&
      args[3] === "-f" &&
      args[4]?.startsWith("/") &&
      args[4].endsWith("/compose.json") &&
      args[5] === "up" &&
      args[6] === "-d" &&
      args[7] === "--remove-orphans"
    )
  ) {
    return null;
  }
  return [...args.slice(0, 5), "create", "--no-build", "--pull", "never"];
}

/** Fixture-only fault injection; up admission must match the shipping command exactly. */
export async function nativeNetworkFixtureShim(opts: {
  readonly root: string;
  readonly engine: string;
  readonly bun: string;
  readonly identity: NativeComposeIdentity;
  readonly create: boolean;
  readonly receipt: string;
}): Promise<string> {
  await mkdir(opts.root, { mode: 0o700 });
  const path = join(opts.root, "docker");
  const script = opts.create
    ? [
        `#!${opts.bun}`,
        'import { lstat } from "node:fs/promises";',
        `const engine=${JSON.stringify(opts.engine)},project=${JSON.stringify(opts.identity.composeProject)},owner=${JSON.stringify(opts.identity.ownerToken)},receipt=${JSON.stringify(opts.receipt)};`,
        "const a=process.argv.slice(2);",
        'if(a.includes("up")){',
        'if(!(a.length===8&&a[0]==="compose"&&a[1]==="-p"&&a[2]===project&&a[3]==="-f"&&a[4]?.startsWith("/")&&a[4].endsWith("/compose.json")&&a[5]==="up"&&a[6]==="-d"&&a[7]==="--remove-orphans") || await Bun.file(receipt).exists())process.exit(98);',
        "const st=await lstat(a[4]);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>8388608)process.exit(98);",
        'const d=await Bun.file(a[4]).json();if(!d.services||Object.keys(d.services).length!==4||Object.values(d.services).some(s=>s.labels?.["io.hack.native-config.owner"]!==owner||s.labels?.["io.hack.native-config.instance"]!==project))process.exit(98);',
        'await Bun.write(receipt,"create-admitted");const p=Bun.spawn([engine,...a.slice(0,5),"create","--no-build","--pull","never"],{stdin:"ignore",stdout:"inherit",stderr:"inherit"});const code=await p.exited;process.exit(code===0?71:code);',
        "}",
        `const p=Bun.spawn([engine,...a],{stdin:"inherit",stdout:"inherit",stderr:"inherit"});process.exit(await p.exited);`,
        "",
      ].join("\n")
    : [
        "#!/bin/sh",
        `printf '%s\\n' blocked > ${quote(opts.receipt)}`,
        "exit 98",
        "",
      ].join("\n");
  await Bun.write(path, script);
  await chmod(path, 0o700);
  return opts.root;
}

async function qualifyArtifacts(
  ctx: ScenarioContext,
  execute: (argv: readonly string[]) => Promise<CliResult>
) {
  const binary = process.env.HACK_E2E_CLI_BIN;
  const revision = process.env.HACK_E2E_NETWORK_SOURCE_REVISION;
  const cliHash = process.env.HACK_E2E_NETWORK_CLI_SHA256;
  const compilerHash = process.env.HACK_E2E_NETWORK_COMPILER_SHA256;
  const pluginPath = process.env.HACK_E2E_COMPOSE_PLUGIN_PATH;
  const pluginHash = process.env.HACK_E2E_COMPOSE_PLUGIN_SHA256;
  requireValue(
    binary &&
      revision &&
      REVISION.test(revision) &&
      cliHash &&
      compilerHash &&
      pluginPath &&
      pluginHash,
    "Network acceptance requires explicit source revision and CLI/compiler/Compose plugin pins"
  );
  const cli = await artifact(resolve(binary), cliHash);
  const compiler = await artifact(
    join(dirname(cli.path), "hack-config-compiler"),
    compilerHash
  );
  const git = Bun.which("git");
  requireValue(
    typeof git === "string" && git.startsWith("/"),
    "Fixture Git must be available"
  );
  const head = await execute([git, "-C", ctx.repoRoot, "rev-parse", "HEAD"]);
  resultOk(head);
  requireValue(
    head.stdout.trim() === revision,
    "Fixture source revision differs from qualified artifact manifest"
  );
  const dirty = await execute([
    git,
    "-C",
    ctx.repoRoot,
    "status",
    "--porcelain",
    "--",
    "src",
    "index.ts",
    "packages/config-compiler",
  ]);
  resultOk(dirty);
  requireValue(
    dirty.stdout.trim() === "",
    "Fixture product source must be a clean frozen checkpoint"
  );
  const protocol = await execute([compiler.path, "--protocol"]);
  resultOk(protocol);
  requireValue(
    nativeNetworkFixtureProtocolMatches(object(protocol.stdout)),
    "Compiler lacks the versioned network contract"
  );
  return {
    version: 1,
    revision,
    cli,
    compiler,
    composePlugin: await artifact(pluginPath, pluginHash),
    fixtureHash: digest(
      await Bun.file(import.meta.path)
        .arrayBuffer()
        .then((buffer) => new Uint8Array(buffer))
    ),
  };
}

/** Actual native-only custom bridge qualification. Requires the root's exclusive Docker slot and exact artifact manifest. */
export const nativeConfigNetworksScenario: Scenario = {
  name: "native-config-networks",
  tier: "docker",
  summary:
    "custom bridge policy/DNS, three worktrees, created recovery, ownership, retained data and routed ingress",
  run: async (ctx) => {
    const started = Date.now();
    const captures = join(ctx.tempRoot, "network-captures");
    const privateHome = join(ctx.tempRoot, "network-home");
    const dockerConfig = join(privateHome, ".docker");
    const host = process.env.HACK_E2E_DOCKER_HOST ?? process.env.DOCKER_HOST;
    requireValue(
      typeof host === "string" &&
        host.startsWith("unix:///") &&
        !/[\x00-\x20?#]/.test(host),
      "Fixture requires an explicit absolute Unix Docker socket"
    );
    const socket = host.slice("unix://".length);
    requireValue(
      (await lstat(socket)).isSocket(),
      "Fixture Docker socket must exist"
    );
    await mkdir(dockerConfig, { recursive: true, mode: 0o700 });
    await mkdir(join(privateHome, "tmp"), { mode: 0o700 });
    await Bun.write(join(dockerConfig, "config.json"), "{}\n");
    const env = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: privateHome,
      TMPDIR: join(privateHome, "tmp"),
      LANG: "C",
      LC_ALL: "C",
      DOCKER_HOST: host,
      DOCKER_CONFIG: dockerConfig,
      HACK_HOME: ctx.hackHome,
      HACK_NO_INTERACTIVE: "1",
      NO_COLOR: "1",
      HACK_RUNTIME_BACKEND: "compose",
      HACK_DAEMON_DISABLE_DOCKER_EVENTS: "1",
    };
    const engine = Bun.which("docker");
    const git = Bun.which("git");
    const bun = await realpath(process.execPath);
    requireValue(
      typeof engine === "string" &&
        engine.startsWith("/") &&
        typeof git === "string" &&
        git.startsWith("/"),
      "Fixture requires absolute Docker and Git executables"
    );
    let cleanupStarted: number | null = null;
    const execute = async (
      argv: readonly string[],
      cwd = ctx.tempRoot,
      extra: Readonly<Record<string, string>> = {}
    ): Promise<CliResult> => {
      const remaining =
        cleanupStarted === null
          ? SCENARIO_TIMEOUT - (Date.now() - started)
          : CLEANUP_TIMEOUT - (Date.now() - cleanupStarted);
      requireValue(
        remaining > 0,
        "Network scenario exceeded its whole-run budget"
      );
      return await runNativeNetworkFixtureCommand({
        argv,
        cwd,
        env: { ...env, ...extra },
        captures,
        timeoutMs: Math.min(COMMAND_TIMEOUT, remaining),
      });
    };
    const manifest = await qualifyArtifacts(ctx, execute);
    const composePlugin = await provisionNativeNetworkFixtureComposePlugin({
      path: manifest.composePlugin.path,
      expectedHash: manifest.composePlugin.sha256,
      dockerConfig,
    });
    requireValue(
      composePlugin.dev === manifest.composePlugin.dev &&
        composePlugin.ino === manifest.composePlugin.ino,
      "Compose plugin changed between artifact and private registration checks"
    );
    const pluginVersion = await execute([
      composePlugin.registeredPath,
      "version",
      "--short",
    ]);
    resultOk(pluginVersion);
    const composeVersion = pluginVersion.stdout.trim();
    requireValue(
      /^v?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9._-]+)?$/.test(composeVersion),
      "Compose plugin version is not a canonical version response"
    );
    const docker: Docker = async (args) => {
      const result = await execute([engine, ...args]);
      resultOk(result);
      return result.stdout.trim();
    };
    const raw = (
      checkout: Checkout,
      args: readonly string[],
      extra: Readonly<Record<string, string>> = {}
    ) => execute([manifest.cli.path, ...args], checkout.root, extra);
    const cli = async (
      checkout: Checkout,
      args: readonly string[]
    ): Promise<CliResult> => {
      const result = await raw(checkout, args);
      resultOk(result);
      return result;
    };
    requireValue(
      (await docker(["info", "--format", "{{.OSType}}"])) === "linux",
      "Fixture requires a Linux engine"
    );
    requireValue(
      (await docker(["compose", "version", "--short"])) === composeVersion,
      "Private Docker config must discover the exact pinned Compose plugin"
    );
    const image = await docker([
      "image",
      "inspect",
      BUN_TAG,
      "--format",
      "{{.Id}}",
    ]);
    const caddyImage = await docker([
      "image",
      "inspect",
      CADDY_TAG,
      "--format",
      "{{.Id}}",
    ]);
    requireValue(
      SHA.test(image) && SHA.test(caddyImage),
      "Fixture images must already be cached and pinned"
    );
    const token = randomBytes(16).toString("hex");
    const name = `e2e-net-${token.slice(0, 12)}`;
    const root = join(await realpath(ctx.tempRoot), name);
    await mkdir(join(root, ".hack"), { recursive: true, mode: 0o700 });
    const baseText = `${JSON.stringify(authored({ name, image, marker: "primary" }))}\n`;
    await Bun.write(join(root, ".hack", "hack.project.json"), baseText);
    await Bun.write(
      join(root, ".gitignore"),
      ".hack/.internal/\nimage-pin.json\n"
    );
    for (const args of [
      ["init", "-q"],
      ["add", "."],
      [
        "-c",
        "user.name=Native fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        "-qm",
        "Fixture native networks",
      ],
    ]) {
      resultOk(await execute([git, ...args], root));
    }
    const checkouts: Checkout[] = [
      {
        root,
        name,
        marker: "primary",
        path: join(root, ".hack", "hack.project.json"),
        text: baseText,
      },
    ];
    for (const branch of ["sibling-a", "sibling-b"]) {
      const linked = join(ctx.tempRoot, `${name}-${branch}`);
      resultOk(
        await execute([git, "worktree", "add", "-qb", branch, linked], root)
      );
      const text = `${JSON.stringify(authored({ name, image, marker: branch }))}\n`;
      const checkout = {
        root: await realpath(linked),
        name,
        marker: branch,
        path: join(linked, ".hack", "hack.project.json"),
        text,
      };
      await Bun.write(checkout.path, text);
      checkouts.push(checkout);
    }
    const qualificationPath = join(ctx.tempRoot, "network-qualification.json");
    await Bun.write(
      qualificationPath,
      `${JSON.stringify({ ...manifest, composePlugin: { ...composePlugin, version: composeVersion }, images: { bun: image, caddy: caddyImage }, limits: { milliseconds: SCENARIO_TIMEOUT, cleanupMilliseconds: CLEANUP_TIMEOUT, commandMilliseconds: COMMAND_TIMEOUT, outputBytes: OUTPUT_LIMIT, peakContainers: 13, ownedBridges: 6, ownedVolumes: 3 }, inputs: checkouts.map((checkout) => ({ root: checkout.root, authoredHash: digest(checkout.text) })) })}\n`
    );
    await chmod(qualificationPath, 0o600);
    const volumePins = new Map<string, NativeNetworkFixtureVolume>();
    const acceptedPolicies = new Map(
      checkouts.map((checkout) => [
        checkout.root,
        { inside: true, routed: false },
      ])
    );
    const startedRoots = new Set<string>();
    let proxy: {
      id: string;
      name: string;
      created: string;
      networkId: string;
      preserved: ReadonlyMap<string, string>;
    } | null = null;
    let canary: {
      id: string;
      name: string;
      networkId: string;
      networkName: string;
      created: string;
    } | null = null;
    let tamper: NativeNetworkFixtureNetwork | null = null;
    let failure: unknown;
    const primary = checkouts[0];
    requireValue(primary, "Primary checkout must exist");

    const observe = async (
      checkout: Checkout,
      created = false
    ): Promise<Snapshot> => {
      const source = await saved(checkout.root);
      const next = await snapshot(
        docker,
        source,
        image,
        created,
        acceptedPolicies.get(checkout.root)
      );
      const old = volumePins.get(checkout.root);
      requireValue(
        !old || JSON.stringify(old) === JSON.stringify(next.volume),
        "Persistent volume must survive every generation transition"
      );
      volumePins.set(checkout.root, next.volume);
      return next;
    };
    const exec = async (
      checkout: Checkout,
      service: Name,
      script: string
    ): Promise<void> => {
      resultOk(
        await raw(checkout, ["exec", service, "--", "bun", "-e", script])
      );
    };
    const markers = async (checkout: Checkout): Promise<void> => {
      for (const [service, target, alias] of [
        ["web", "peer", "peer-alias"],
        ["peer", "web", "web-alias"],
        ["vault", "reader", "reader-alias"],
        ["reader", "vault", "vault-alias"],
      ] as const) {
        const expected = JSON.stringify(`${checkout.marker}:${target}`);
        await exec(
          checkout,
          service,
          `if(process.env.PEER_ORIGIN!==${JSON.stringify(`http://${target}:3000`)})process.exit(23);for(const url of [process.env.PEER_ORIGIN,${JSON.stringify(`http://${alias}:3000/`)}]){const r=await fetch(url,{signal:AbortSignal.timeout(4000)});if(!r.ok||await r.text()!==${expected})process.exit(24)}`
        );
      }
      await exec(
        checkout,
        "web",
        `if(await Bun.file("/state/marker").text()!==${JSON.stringify(checkout.marker)})process.exit(25)`
      );
    };
    const siblings = checkouts.slice(1);
    const siblingsBefore = new Map<string, string>();
    const continuity = async (): Promise<void> => {
      for (const checkout of siblings) {
        await markers(checkout);
        requireValue(
          JSON.stringify(await observe(checkout)) ===
            siblingsBefore.get(checkout.root),
          "Primary operations must preserve sibling healthy IDs, bridges, data and generation"
        );
      }
    };
    const noForward = async (
      checkout: Checkout,
      args: readonly string[],
      fragment: string,
      stage: RefusalStage
    ): Promise<void> => {
      const source = await saved(checkout.root);
      const before = await observe(checkout);
      const path = join(
        ctx.tempRoot,
        `no-effect-${randomBytes(8).toString("hex")}`
      );
      const receipt = join(path, "invoked");
      const shim = await nativeNetworkFixtureShim({
        root: path,
        engine,
        bun,
        identity: source.identity,
        create: false,
        receipt,
      });
      const result = await raw(checkout, args, { PATH: `${shim}:${env.PATH}` });
      resultOk(result, 1);
      const fragmentPresent = result.combined.includes(fragment);
      const dockerInvoked = await Bun.file(receipt).exists();
      if (!fragmentPresent || dockerInvoked) {
        ctx.log(
          nativeNetworkFixtureRefusalDiagnostic({
            stage,
            fragmentPresent,
            dockerInvoked,
          })
        );
      }
      requireValue(
        fragmentPresent && !dockerInvoked,
        "Expected precise refusal before any Docker subprocess"
      );
      const after = await saved(checkout.root);
      requireValue(
        after.generation.generationId === source.generation.generationId &&
          after.state.pending === null &&
          JSON.stringify(await observe(checkout)) === JSON.stringify(before),
        "Pre-effect refusal must preserve exact saved generation and inventory"
      );
      await continuity();
    };
    const removeCanary = async (): Promise<void> => {
      if (!canary) {
        return;
      }
      const selected = canary;
      const verify = async (stopped: boolean) => {
        const value = await inspect(docker, "container", selected.id);
        requireValue(
          value.Id === selected.id &&
            value.Name === `/${selected.name}` &&
            value.Created === selected.created &&
            value.Image === image &&
            isRecord(value.Config) &&
            isRecord(value.Config.Labels) &&
            own(value.Config.Labels, FIXTURE) === token &&
            isRecord(value.State) &&
            value.State.Status === (stopped ? "exited" : "running") &&
            isRecord(value.NetworkSettings) &&
            isRecord(value.NetworkSettings.Networks) &&
            isRecord(value.HostConfig) &&
            value.HostConfig.NetworkMode === selected.networkId &&
            Object.keys(value.NetworkSettings.Networks).length === 1 &&
            Object.hasOwn(
              value.NetworkSettings.Networks,
              selected.networkName
            ) &&
            Object.values(value.NetworkSettings.Networks).every(
              (endpoint) =>
                isRecord(endpoint) &&
                (endpoint.NetworkID === selected.networkId ||
                  (stopped && endpoint.NetworkID === ""))
            ),
          "Canary cleanup requires exact fixture ID/name/image/creation/network/state"
        );
      };
      await verify(false);
      await docker(["container", "stop", "--time", "5", selected.id]);
      await verify(true);
      await docker(["container", "rm", selected.id]);
      requireValue(
        !identifiers(
          await docker([
            "container",
            "ls",
            "-aq",
            "--no-trunc",
            "--filter",
            `label=${FIXTURE}=${token}`,
          ])
        ).includes(selected.id),
        "Exact canary removal must be observed"
      );
      canary = null;
    };
    const removeTamper = async (): Promise<void> => {
      if (!tamper) {
        return;
      }
      const pin = tamper;
      for (let round = 0; round < 2; round++) {
        const value = await inspect(docker, "network", pin.id);
        requireValue(
          nativeNetworkFixtureNetworkMatches(value, pin, true) &&
            isRecord(value.Labels) &&
            own(value.Labels, FIXTURE) === token,
          "Tamper cleanup requires exact pinned empty network and fixture token"
        );
      }
      await docker(["network", "rm", pin.id]);
      tamper = null;
    };
    const resourceAbsent = async (checkout: Checkout): Promise<void> => {
      const source = await saved(checkout.root);
      requireValue(
        (await inventory(docker, "container", source.identity.composeProject))
          .length === 0 &&
          (await inventory(docker, "network", source.identity.composeProject))
            .length === 0 &&
          source.state.pending === null &&
          source.state.stopped,
        "Product saved down must retire all exact fixture containers/bridges and clear intent"
      );
    };

    const verifyProxy = async (running: boolean): Promise<void> => {
      requireValue(proxy !== null, "Exact proxy pin must exist before effects");
      const selected = proxy;
      const value = await inspect(docker, "container", selected.id);
      requireValue(
        value.Id === selected.id &&
          value.Name === `/${selected.name}` &&
          value.Created === selected.created &&
          value.Image === caddyImage &&
          isRecord(value.Config) &&
          isRecord(value.Config.Labels) &&
          own(value.Config.Labels, FIXTURE) === token &&
          own(value.Config.Labels, PROJECT) === GLOBAL_PROJECT &&
          own(value.Config.Labels, SERVICE) === "caddy" &&
          isRecord(value.State) &&
          value.State.Running === running &&
          isRecord(value.HostConfig) &&
          value.HostConfig.NetworkMode === selected.networkId &&
          value.HostConfig.PublishAllPorts === false &&
          nativeNetworkFixtureHasNoPublication(value.HostConfig.PortBindings) &&
          isRecord(value.NetworkSettings) &&
          nativeNetworkFixtureHasNoPublication(value.NetworkSettings.Ports) &&
          isRecord(value.NetworkSettings.Networks) &&
          sameNames(Object.keys(value.NetworkSettings.Networks), [
            "hack-dev",
          ]) &&
          isRecord(value.NetworkSettings.Networks["hack-dev"]) &&
          (value.NetworkSettings.Networks["hack-dev"].NetworkID ===
            selected.networkId ||
            (!running &&
              value.NetworkSettings.Networks["hack-dev"].NetworkID === "")) &&
          isRecord(value.HostConfig.Tmpfs) &&
          Object.keys(value.HostConfig.Tmpfs).length === 2 &&
          value.HostConfig.Tmpfs["/data"] === PRIVATE_TMPFS &&
          value.HostConfig.Tmpfs["/config"] === PRIVATE_TMPFS &&
          Array.isArray(value.Mounts) &&
          value.Mounts.length === 1 &&
          value.Mounts.every(
            (mount) =>
              isRecord(mount) &&
              mount.Type === "bind" &&
              mount.Source === "/var/run/docker.sock" &&
              mount.Destination === "/var/run/docker.sock" &&
              mount.RW === false
          ),
        "Proxy cleanup requires exact no-port/tmpfs/readonly-socket fixture identity"
      );
    };
    const runPhases = async (): Promise<void> => {
      const store = await openNativeComposeGenerationStore({
        projectRoot: primary.root,
        instance: null,
      });
      const identity = store.identity;
      await store.close();
      const shimRoot = join(ctx.tempRoot, "created-up");
      const createReceipt = join(shimRoot, "created");
      const shim = await nativeNetworkFixtureShim({
        root: shimRoot,
        engine,
        bun,
        identity,
        create: true,
        receipt: createReceipt,
      });
      startedRoots.add(primary.root);
      const controlledUp = await raw(primary, ["up", "--detach", "--json"], {
        PATH: `${shim}:${env.PATH}`,
      });
      resultOk(controlledUp, 1);
      requireValue(
        await Bun.file(createReceipt).exists(),
        "Controlled startup must reach actual Compose create"
      );
      const pending = await saved(primary.root);
      requireValue(
        pending.state.pending?.operation === "up",
        "Created failure must retain exact uncertain startup intent"
      );
      await observe(primary, true);
      for (const id of await inventory(
        docker,
        "container",
        identity.composeProject
      )) {
        const value = await inspect(docker, "container", id);
        requireValue(
          isRecord(value.NetworkSettings) &&
            isRecord(value.NetworkSettings.Networks) &&
            Object.values(value.NetworkSettings.Networks).every(
              (endpoint) => isRecord(endpoint) && endpoint.NetworkID === ""
            ),
          "Controlled create must expose the actual empty NetworkID recovery window"
        );
      }
      resultOk(await raw(primary, ["up", "--detach", "--json"]), 1);
      await cli(primary, ["down", "--recover", "--json"]);
      await resourceAbsent(primary);
      ctx.log(
        "Actual created-before-start empty network identity recovered through owned saved down"
      );
      for (const checkout of checkouts) {
        startedRoots.add(checkout.root);
        await cli(checkout, ["up", "--detach", "--json"]);
        await observe(checkout);
        await exec(
          checkout,
          "web",
          `await Bun.write("/state/marker",${JSON.stringify(checkout.marker)})`
        );
        await markers(checkout);
        await cli(checkout, ["ps", "--json"]);
      }
      const all = await Promise.all(
        checkouts.map((checkout) => observe(checkout))
      );
      requireValue(
        new Set(
          all.flatMap((entry) => entry.networks.map((network) => network.id))
        ).size === 6 &&
          new Set(
            all.flatMap((entry) =>
              entry.networks.map((network) => network.name)
            )
          ).size === 6 &&
          new Set(all.map((entry) => entry.volume.name)).size === 3,
        "Three real checkouts must allocate six disjoint bridges and three disjoint volumes"
      );
      for (const checkout of siblings) {
        siblingsBefore.set(
          checkout.root,
          JSON.stringify(await observe(checkout))
        );
      }
      const beforeWarm = await observe(primary);
      await cli(primary, ["up", "--detach", "--json"]);
      const afterWarm = await observe(primary);
      requireValue(
        sameNames(afterWarm.containers, beforeWarm.containers) &&
          JSON.stringify(afterWarm.networks) ===
            JSON.stringify(beforeWarm.networks),
        "Warm startup must preserve healthy physical container and bridge identities"
      );
      await noForward(
        primary,
        ["run", "web", "--", "bun", "-e", "process.exit(0)"],
        "requires qualified one-off attachment behavior",
        "unrouted_run"
      );
      await cli(primary, ["restart", "--json"]);
      await observe(primary);
      await markers(primary);
      await continuity();
      await cli(primary, ["down", "--json"]);
      await resourceAbsent(primary);
      await continuity();
      await cli(primary, ["up", "--detach", "--json"]);
      await observe(primary);
      await markers(primary);
      await continuity();

      const disconnected = authored({ name, image, marker: primary.marker });
      requireValue(
        disconnected.services?.web,
        "Disconnected control requires web"
      );
      disconnected.services.web.environment = {
        ...disconnected.services.web.environment,
        PEER_ORIGIN: {
          endpoint: {
            kind: "service",
            name: "vault",
            port: 3000,
            protocol: "http",
          },
        },
      };
      await Bun.write(primary.path, `${JSON.stringify(disconnected)}\n`);
      await noForward(
        primary,
        ["config", "validate", "--json"],
        "disconnected_endpoint_target",
        "disconnected_validation"
      );
      await noForward(
        primary,
        ["up", "--detach", "--json"],
        "Native execution inputs are invalid or changed",
        "disconnected_endpoint"
      );
      await Bun.write(primary.path, primary.text);
      await Bun.write(
        primary.path,
        `${JSON.stringify(authored({ name, image, marker: primary.marker, inside: false }))}\n`
      );
      await noForward(
        primary,
        ["up", "--detach", "--json"],
        "network topology changed",
        "topology_mutation"
      );
      await cli(primary, ["down", "--json"]);
      await resourceAbsent(primary);
      await cli(primary, ["up", "--detach", "--json"]);
      acceptedPolicies.set(primary.root, { inside: false, routed: false });
      await observe(primary);
      await markers(primary);
      await continuity();
      await cli(primary, ["down", "--json"]);
      await Bun.write(primary.path, primary.text);
      await cli(primary, ["up", "--detach", "--json"]);
      acceptedPolicies.set(primary.root, { inside: true, routed: false });
      await observe(primary);
      await markers(primary);
      await continuity();

      const original = await saved(primary.root);
      const originalSnapshot = await observe(primary);
      const outbound = originalSnapshot.networks.find(
        (network) => !network.internal
      );
      requireValue(
        outbound,
        "Foreign endpoint control requires exact outbound bridge"
      );
      const canaryName = `e2e-net-canary-${token}`;
      const canaryId = await docker([
        "container",
        "create",
        "--pull=never",
        "--name",
        canaryName,
        "--network",
        outbound.id,
        "--label",
        `${FIXTURE}=${token}`,
        image,
        "bun",
        "-e",
        "setInterval(()=>{},60000)",
      ]);
      requireValue(
        ID.test(canaryId),
        "Canary create must return a complete ID"
      );
      const canaryValue = await inspect(docker, "container", canaryId);
      requireValue(
        typeof canaryValue.Created === "string",
        "Canary requires creation pin"
      );
      canary = {
        id: canaryId,
        name: canaryName,
        networkId: outbound.id,
        networkName: outbound.name,
        created: canaryValue.Created,
      };
      await docker(["container", "start", canaryId]);
      const activeCanary = await inspect(docker, "container", canaryId);
      const occupiedBridge = await inspect(docker, "network", outbound.id);
      requireValue(
        activeCanary.Id === canaryId &&
          activeCanary.Created === canary.created &&
          isRecord(activeCanary.State) &&
          activeCanary.State.Status === "running" &&
          occupiedBridge.Id === outbound.id &&
          isRecord(occupiedBridge.Containers) &&
          Object.hasOwn(occupiedBridge.Containers, canaryId),
        "Foreign endpoint must be running on the pinned bridge before admission"
      );
      const foreign = await raw(primary, ["up", "--detach", "--json"]);
      resultOk(foreign, 1);
      const foreignState = await saved(primary.root);
      const foreignSnapshot = await observe(primary);
      requireValue(
        nativeNetworkFixtureStateRefused(object(foreign.stdout)),
        "Foreign endpoint must produce the fixed redacted state refusal"
      );
      requireValue(
        foreignState.state.pending === null &&
          foreignState.generation.generationId ===
            original.generation.generationId &&
          JSON.stringify(foreignSnapshot) === JSON.stringify(originalSnapshot),
        "Foreign endpoint must refuse without mutating owned saved state"
      );
      await continuity();
      await removeCanary();
      await markers(primary);
      await cli(primary, ["down", "--json"]);
      await resourceAbsent(primary);
      const labels = [PROJECT, INSTANCE].flatMap((key) => [
        "--label",
        `${key}=${original.identity.composeProject}`,
      ]);
      const wrongId = await docker([
        "network",
        "create",
        "--driver",
        "bridge",
        "--internal",
        ...labels,
        "--label",
        `${OWNER}=${original.identity.ownerToken}`,
        "--label",
        `${VERSION}=1`,
        "--label",
        `${FIXTURE}=${token}`,
        outbound.name,
      ]);
      requireValue(
        ID.test(wrongId),
        "Wrong-policy network requires a full pinned ID"
      );
      const wrong = await inspect(docker, "network", wrongId);
      requireValue(
        typeof wrong.Created === "string",
        "Tamper network creation identity is required"
      );
      tamper = {
        ...outbound,
        id: wrongId,
        createdAt: wrong.Created,
        internal: true,
      };
      const beforeTamper = await saved(primary.root);
      resultOk(await raw(primary, ["up", "--detach", "--json"]), 1);
      requireValue(
        (await inventory(docker, "container", original.identity.composeProject))
          .length === 0 &&
          (await saved(primary.root)).state.pending === null &&
          (await saved(primary.root)).generation.generationId ===
            beforeTamper.generation.generationId,
        "Wrong bridge policy must refuse before creation or intent publication"
      );
      await removeTamper();
      await cli(primary, ["up", "--detach", "--json"]);
      await observe(primary);
      await markers(primary);
      await continuity();
      ctx.log(
        "Custom aliases, isolation, policy/refusal and retained-data lifecycle passed; checking mixed routed ingress"
      );

      // Reuse the established no-host-publication proxy contract, preserving any stopped real selector.
      const selectors = [
        "--filter",
        `label=${PROJECT}=${GLOBAL_PROJECT}`,
        "--filter",
        `label=${SERVICE}=caddy`,
      ];
      requireValue(
        (await docker([
          "container",
          "ls",
          "-q",
          "--no-trunc",
          ...selectors,
        ])) === "",
        "Mixed routing fixture requires no running global Caddy selector"
      );
      const existing = identifiers(
        await docker(["container", "ls", "-aq", "--no-trunc", ...selectors])
      );
      const preserved = new Map<string, string>();
      for (const id of existing) {
        preserved.set(id, await docker(["container", "inspect", id]));
      }
      const ingress = await inspect(docker, "network", "hack-dev");
      requireValue(
        typeof ingress.Id === "string" && ID.test(ingress.Id),
        "Mixed fixture requires exact existing ingress ID"
      );
      const proxyName = `e2e-net-proxy-${token}`;
      const canaryHost = `net-canary-${token}.test`;
      const canaryMarker = `canary-${token}`;
      const proxyId = await docker([
        "container",
        "create",
        "--pull=never",
        "--name",
        proxyName,
        "--network",
        ingress.Id,
        "--label",
        `${FIXTURE}=${token}`,
        "--label",
        `${PROJECT}=${GLOBAL_PROJECT}`,
        "--label",
        `${SERVICE}=caddy`,
        "--label",
        `caddy=https://${canaryHost}`,
        "--label",
        `caddy.respond=${canaryMarker} 200`,
        "--label",
        "caddy.tls=internal",
        "--env",
        "CADDY_INGRESS_NETWORKS=hack-dev",
        "--mount",
        "type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock,readonly",
        "--tmpfs",
        `/data:${PRIVATE_TMPFS}`,
        "--tmpfs",
        `/config:${PRIVATE_TMPFS}`,
        caddyImage,
        "docker-proxy",
        "--polling-interval",
        "1s",
      ]);
      requireValue(
        ID.test(proxyId),
        "Mixed fixture proxy requires exact full ID"
      );
      const proxyInfo = await inspect(docker, "container", proxyId);
      requireValue(
        typeof proxyInfo.Created === "string",
        "Mixed proxy requires creation pin"
      );
      proxy = {
        id: proxyId,
        name: proxyName,
        created: proxyInfo.Created,
        networkId: ingress.Id,
        preserved,
      };
      await verifyProxy(false);
      await docker(["container", "start", proxyId]);
      await verifyProxy(true);
      const tls = async (hostname: string, marker: string): Promise<void> => {
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          await verifyProxy(true);
          const result = await execute([
            engine,
            "exec",
            proxyId,
            "curl",
            "--disable",
            "--silent",
            "--show-error",
            "--fail",
            "--proxy",
            "",
            "--noproxy",
            "*",
            "--proto",
            "=https",
            "--max-redirs",
            "0",
            "--connect-timeout",
            "2",
            "--max-time",
            "5",
            "--cacert",
            ROOT_CA,
            "--resolve",
            `${hostname}:443:127.0.0.1`,
            "--url",
            `https://${hostname}/`,
          ]);
          if (result.exitCode === 0 && result.stdout === marker) {
            return;
          }
          await Bun.sleep(250);
        }
        throw new Error(
          "Mixed route requires strict TLS and exact marker; captures retained"
        );
      };
      await tls(canaryHost, canaryMarker);
      const ca = new X509Certificate(
        await docker(["exec", proxyId, "cat", ROOT_CA])
      );
      requireValue(
        ca.ca &&
          ca.verify(ca.publicKey) &&
          Date.parse(ca.validFrom) <= Date.now() &&
          Date.parse(ca.validTo) > Date.now(),
        "Mixed TLS uses only the live valid fixture root"
      );
      await cli(primary, ["down", "--json"]);
      await Bun.write(
        primary.path,
        `${JSON.stringify(authored({ name, image, marker: primary.marker, routed: true }))}\n`
      );
      await cli(primary, ["up", "--detach", "--json"]);
      acceptedPolicies.set(primary.root, { inside: true, routed: true });
      const routed = await saved(primary.root);
      const metadata = readNativeComposeRouteMetadata({
        generationId: routed.generation.generationId,
        document: routed.document,
      });
      requireValue(
        metadata?.binding.proxyId === proxyId &&
          metadata.binding.networkId === ingress.Id,
        "Product saved routing must bind the exact isolated proxy and ingress ID"
      );
      await observe(primary);
      await markers(primary);
      await continuity();
      const routedHost = `${name}.network-fixture.test`;
      await tls(routedHost, "primary:web");
      requireValue(
        routed.topology.workloads
          .find((entry) => entry.service === "web")
          ?.networks.some(
            (network) => network.external && network.name === "hack-dev"
          ),
        "Saved routed target must retain explicit ingress plus authored custom attachment"
      );
      await noForward(
        primary,
        ["run", "web", "--", "bun", "-e", "process.exit(0)"],
        "requires qualified one-off attachment behavior",
        "routed_run"
      );
      await cli(primary, ["down", "--json"]);
      await resourceAbsent(primary);
      await continuity();
      const config = await docker([
        "exec",
        proxyId,
        "curl",
        "--disable",
        "--silent",
        "--show-error",
        "--fail",
        "--proxy",
        "",
        "--noproxy",
        "*",
        "--max-time",
        "10",
        "--url",
        "http://127.0.0.1:2019/config/apps/http/servers",
      ]);
      requireValue(
        nativeComposeProxyRoutesMatch({
          servers: JSON.parse(config),
          expected: [],
          absentHostnames: [routedHost],
        }),
        "Owned saved down must retire the exact mixed routed hostname"
      );
      await tls(canaryHost, canaryMarker);
    };
    try {
      await runPhases();
    } catch (error: unknown) {
      failure = error;
    }

    cleanupStarted = Date.now();
    const cleanup = async (): Promise<void> => {
      await removeCanary();
      await removeTamper();
      let removedVolumes = 0;
      let retiredContainers = 0;
      let retiredNetworks = 0;
      for (const checkout of [...checkouts].reverse()) {
        if (!startedRoots.has(checkout.root)) {
          continue;
        }
        const beforeStop = await saved(checkout.root);
        retiredContainers += (
          await inventory(
            docker,
            "container",
            beforeStop.identity.composeProject
          )
        ).length;
        retiredNetworks += (
          await inventory(docker, "network", beforeStop.identity.composeProject)
        ).length;
        await cli(checkout, ["down", "--recover", "--json"]);
        await resourceAbsent(checkout);
        const source = await saved(checkout.root);
        const pin = volumePins.get(checkout.root) ?? null;
        requireValue(
          nativeNetworkFixtureVolumeSelectionMatches(
            await inventory(docker, "volume", source.identity.composeProject),
            pin
          ),
          "Cleanup refuses extra/missing unpinned persistent volume"
        );
        if (pin) {
          requireValue(
            nativeNetworkFixtureVolumeMatches(
              await inspect(docker, "volume", pin.name),
              pin
            ),
            "Cleanup requires unchanged pinned state volume after saved down"
          );
          requireValue(
            nativeNetworkFixtureVolumeMatches(
              await inspect(docker, "volume", pin.name),
              pin
            ),
            "Cleanup effect recheck refuses volume rebinding"
          );
          await docker(["volume", "rm", pin.name]);
          removedVolumes++;
          requireValue(
            (await inventory(docker, "volume", source.identity.composeProject))
              .length === 0,
            "Owned persistent volume removal must be observed"
          );
        }
      }
      if (proxy) {
        const selected = proxy;

        await verifyProxy(true);
        await docker(["container", "stop", "--time", "5", selected.id]);
        await verifyProxy(false);
        await docker(["container", "rm", selected.id]);
        requireValue(
          (await inspect(docker, "network", "hack-dev")).Id ===
            selected.networkId,
          "External ingress network identity must remain unchanged"
        );
        for (const [id, before] of selected.preserved) {
          requireValue(
            nativeNetworkFixturePreservedContainerMatches({
              before,
              after: await docker(["container", "inspect", id]),
            }),
            "Stopped user Caddy containers must remain unchanged"
          );
        }
        proxy = null;
      }
      requireValue(
        removedVolumes === volumePins.size &&
          (failure !== undefined || removedVolumes === 3),
        "Cleanup must account for every exact retained fixture volume"
      );
      requireValue(
        (await docker([
          "container",
          "ls",
          "-aq",
          "--no-trunc",
          "--filter",
          `label=${FIXTURE}=${token}`,
        ])) === "",
        "No exact fixture canary/proxy may remain"
      );
      ctx.log(
        `Exact cleanup complete: ${retiredContainers} observed service containers and ${retiredNetworks} observed bridges retired by saved down; ${removedVolumes} pinned retained volumes deliberately removed`
      );
      await artifact(manifest.cli.path, manifest.cli.sha256);
      await artifact(manifest.compiler.path, manifest.compiler.sha256);
    };
    try {
      await cleanup();
    } catch (cleanupError: unknown) {
      ctx.retainFixtures(
        "Custom-network cleanup could not prove exact completion; private evidence retained"
      );
      if (failure === undefined) {
        failure = cleanupError;
      } else {
        ctx.log(
          "Cleanup also failed; original failure retained in private captures"
        );
      }
    }
    if (failure !== undefined) {
      throw failure;
    }
    ctx.log(
      `Custom-network actual acceptance complete in ${Date.now() - started}ms; configuration/isolation proof, no performance claim`
    );
  },
};
