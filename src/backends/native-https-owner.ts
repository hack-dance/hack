import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, realpath, rmdir } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { ClosedCliError } from "../lib/cli-result.ts";
import { isRecord } from "../lib/guards.ts";
import { acquireNativeHttpsOwnerAdmission } from "./native-https-owner-admission.ts";
import {
  decodeNativeHttpsOwnerFrame,
  encodeNativeHttpsOwnerFrame,
  isNativeHttpsLeaseRequest,
  isNativeHttpsOwnerConfiguration,
  isNativeHttpsOwnerEndpoint,
  type NativeHttpsLeaseIdentity as LeaseIdentity,
  NATIVE_HTTPS_OWNER_ARGUMENT,
  NATIVE_HTTPS_OWNER_FRAME_LIMIT,
  type NativeHttpsLeaseRequest,
  type NativeHttpsOwnerBinding,
  type NativeHttpsOwnerConfiguration,
  type NativeHttpsOwnerEndpoint,
  nativeHttpsLeaseIdentity,
  nativeHttpsOwnerRefused,
  sameNativeHttpsLease,
  isNativeHttpsLeaseIdentity as validateLeaseIdentity,
} from "./native-https-owner-protocol.ts";
import {
  runNativeHttpsOwner as runOwner,
  verifyNativeHttpsLeaseGraph,
} from "./native-https-owner-server.ts";
import {
  nativeHttpsExecutableSha256,
  nativeHttpsOwnerRoot,
  nativeHttpsPrivateDirectory,
  nativeHttpsReadFile,
  nativeHttpsReadRelease,
  nativeHttpsReadRetiredOwner,
  nativeHttpsRecordRetiredOwner,
  nativeHttpsRemoveFile,
  nativeHttpsWriteNew,
} from "./native-https-owner-storage.ts";
import { nativeHttpsReleaseReplyError } from "./native-https-release-failure.ts";
import {
  NativeHttpsStartupError,
  readNativeHttpsStartupFailure,
} from "./native-https-startup-failure.ts";
import {
  inspectActiveNativeHttpsOwner,
  NATIVE_HTTPS_CHILD_STARTUP_MS,
  verifyActiveNativeHttpsConnection,
  verifyNativeHttpsHostname,
} from "./native-project-https.ts";
import {
  invokeNativeRuntime,
  type NativeRuntimeSelection,
} from "./native-runtime-client.ts";

export type NativeHttpsLeaseIdentity = LeaseIdentity;
export function isNativeHttpsLeaseIdentity(
  value: unknown
): value is NativeHttpsLeaseIdentity {
  return validateLeaseIdentity(value);
}
export function runNativeHttpsOwner(opts: {
  readonly configurationPath: string;
}): Promise<number> {
  return runOwner(opts);
}

export interface NativeHttpsLease {
  readonly identity: NativeHttpsLeaseIdentity;
  readonly caPath: string;
  readonly httpsPort: number;
  readonly exited: Promise<{ component: string; code: number }>;
  verifyHostname(
    hostname: string,
    path: string
  ): ReturnType<typeof verifyNativeHttpsHostname>;
  releaseAfterCleanup(): Promise<void>;
}
export interface NativeHttpsAcquireOptions {
  readonly runtime: NativeRuntimeSelection;
  readonly caddyBinary: string;
  readonly caddySha256: string;
  readonly httpsPort: number;
  readonly certificateNameLimit?: number;
  readonly pool: { readonly owner: string; readonly bootId: string };
  readonly lease: NativeHttpsLeaseRequest;
  /** Persist finalization ownership before any lease request can be delivered. */
  readonly onIntent?: (identity: NativeHttpsLeaseIdentity) => Promise<void>;
}
export class NativeHttpsLeaseAcquisitionError extends ClosedCliError {
  readonly identity: NativeHttpsLeaseIdentity;
  readonly startupFailure: NativeHttpsStartupError | undefined;
  constructor(
    identity: NativeHttpsLeaseIdentity,
    opts?: {
      readonly startupFailure?: unknown;
      readonly cleanupUnconfirmed?: true;
    }
  ) {
    const startupFailure =
      opts?.startupFailure instanceof NativeHttpsStartupError
        ? new NativeHttpsStartupError("frontend-start", opts.startupFailure)
        : undefined;
    super(
      `Shared native HTTPS acquisition is uncertain; use the retained exact lease identity after graph cleanup.${startupFailure ? ` ${startupFailure.message}` : ""}${opts?.cleanupUnconfirmed ? " Native startup cleanup is unconfirmed; retained ownership evidence was kept." : ""}`
    );
    this.identity = identity;
    this.startupFailure = startupFailure;
  }
}

/** What the frontend that spawned a shared owner knows about it: whether it exited. */
export interface NativeHttpsSpawnedOwner {
  readonly exited: () => boolean;
}

/** The exact reviewed executable is detached into its own process group. */
export async function spawnNativeHttpsOwner(opts: {
  readonly frontend: { readonly binary: string; readonly sha256: string };
  readonly configurationPath: string;
  readonly home: string;
}): Promise<NativeHttpsSpawnedOwner | undefined> {
  if (
    (await nativeHttpsExecutableSha256(opts.frontend.binary)) !==
    opts.frontend.sha256
  ) {
    throw nativeHttpsOwnerRefused();
  }
  const child = spawn(
    opts.frontend.binary,
    [NATIVE_HTTPS_OWNER_ARGUMENT, opts.configurationPath],
    {
      detached: true,
      stdio: "ignore",
      cwd: opts.home,
      env: { PATH: "/usr/bin:/bin", HOME: opts.home },
    }
  );
  await new Promise<void>((resolve, reject) => {
    child.once("error", () => reject(nativeHttpsOwnerRefused()));
    child.once("spawn", resolve);
  });
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  child.unref();
  return { exited: () => exited };
}

function sameBinding(
  a: NativeHttpsOwnerBinding,
  b: NativeHttpsOwnerBinding
): boolean {
  return (
    a.runtime.home === b.runtime.home &&
    a.runtime.binary === b.runtime.binary &&
    a.frontend.binary === b.frontend.binary &&
    a.frontend.sha256 === b.frontend.sha256 &&
    a.runtimeSha256 === b.runtimeSha256 &&
    a.pool.owner === b.pool.owner &&
    a.pool.bootId === b.pool.bootId &&
    a.caddyBinary === b.caddyBinary &&
    a.caddySha256 === b.caddySha256 &&
    a.httpsPort === b.httpsPort &&
    a.certificateNameLimit === b.certificateNameLimit
  );
}
export async function readNativeHttpsOwnerConfiguration(
  runtime: NativeRuntimeSelection
): Promise<NativeHttpsOwnerConfiguration> {
  const configuration = await readNativeHttpsOwnerConfigurationAtHome(
    runtime.home
  );
  if (configuration.binding.runtime.binary !== runtime.binary) {
    throw nativeHttpsOwnerRefused();
  }
  return configuration;
}

async function readNativeHttpsOwnerConfigurationAtHome(
  home: string
): Promise<NativeHttpsOwnerConfiguration> {
  if ((await realpath(home)) !== home) {
    throw nativeHttpsOwnerRefused();
  }
  for (const directory of [
    home,
    join(home, "native-https"),
    nativeHttpsOwnerRoot(home),
  ]) {
    await nativeHttpsPrivateDirectory(directory);
  }
  const { bytes } = await nativeHttpsReadFile(
    join(nativeHttpsOwnerRoot(home), "configuration.json")
  );
  const configuration: unknown = JSON.parse(bytes.toString("utf8"));
  if (
    !isNativeHttpsOwnerConfiguration(configuration) ||
    configuration.binding.runtime.home !== home
  ) {
    throw nativeHttpsOwnerRefused();
  }
  return configuration;
}

/** No stale directory is removed. Interrupted startup is explicit recovery work. */
export async function ensureNativeHttpsOwner(opts: {
  readonly binding: NativeHttpsOwnerBinding;
  /** Test seam; a stand-in that reports nothing gives no exit observation. */
  readonly spawnOwner?: (
    opts: Parameters<typeof spawnNativeHttpsOwner>[0]
  ) => Promise<unknown>;
  /** This call spawned the owner: how its caller can tell that it exited. */
  readonly onSpawned?: (owner: NativeHttpsSpawnedOwner) => void;
}): Promise<NativeHttpsOwnerConfiguration> {
  const { binding } = opts;
  const root = nativeHttpsOwnerRoot(binding.runtime.home);
  const configuration: NativeHttpsOwnerConfiguration = {
    version: 1,
    ownerGeneration: randomBytes(16).toString("hex"),
    binding,
  };
  if (!isNativeHttpsOwnerConfiguration(configuration)) {
    throw nativeHttpsOwnerRefused();
  }
  await nativeHttpsPrivateDirectory(binding.runtime.home);
  await nativeHttpsPrivateDirectory(dirname(root), true);
  const admission = await acquireNativeHttpsOwnerAdmission({
    home: binding.runtime.home,
    waitMs: 15_000,
  });
  try {
    let created = false;
    try {
      await mkdir(root, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (!isRecord(error) || error.code !== "EEXIST") {
        throw nativeHttpsOwnerRefused();
      }
    }
    if (created) {
      await mkdir(join(root, "leases"), { mode: 0o700 });
      const configurationPath = join(root, "configuration.json");
      await nativeHttpsWriteNew(configurationPath, configuration);
      const spawned = await (opts.spawnOwner ?? spawnNativeHttpsOwner)({
        frontend: binding.frontend,
        home: binding.runtime.home,
        configurationPath,
      });
      if (isRecord(spawned) && typeof spawned.exited === "function") {
        const exited = spawned.exited;
        opts.onSpawned?.({ exited: () => exited() === true });
      }
      return configuration;
    }
    // Only startup publication can be retried; no acquire/release request is replayed.
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      try {
        const existing = await readNativeHttpsOwnerConfiguration(
          binding.runtime
        );
        if (!sameBinding(existing.binding, binding)) {
          throw nativeHttpsOwnerRefused();
        }
        return existing;
      } catch (error) {
        if (!isRecord(error) || error.code !== "ENOENT") {
          throw error;
        }
        await Bun.sleep(25);
      }
    }
    throw nativeHttpsOwnerRefused();
  } finally {
    await admission.release();
  }
}

async function endpointFor(
  configuration: NativeHttpsOwnerConfiguration
): Promise<NativeHttpsOwnerEndpoint> {
  const current = await readNativeHttpsOwnerConfiguration(
    configuration.binding.runtime
  );
  if (
    current.ownerGeneration !== configuration.ownerGeneration ||
    !sameBinding(current.binding, configuration.binding)
  ) {
    throw nativeHttpsOwnerRefused();
  }
  const startupFailure = await readNativeHttpsStartupFailure(configuration);
  if (startupFailure) {
    throw startupFailure;
  }
  const { bytes } = await nativeHttpsReadFile(
    join(
      nativeHttpsOwnerRoot(configuration.binding.runtime.home),
      "endpoint.json"
    )
  );
  const endpoint: unknown = JSON.parse(bytes.toString("utf8"));
  if (
    !isNativeHttpsOwnerEndpoint(endpoint) ||
    endpoint.ownerGeneration !== configuration.ownerGeneration
  ) {
    throw nativeHttpsOwnerRefused();
  }
  await nativeHttpsPrivateDirectory(dirname(endpoint.socket));
  const stat = await lstat(endpoint.socket);
  if (
    !stat.isSocket() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o600 ||
    stat.dev !== endpoint.dev ||
    stat.ino !== endpoint.ino
  ) {
    throw nativeHttpsOwnerRefused();
  }
  return endpoint;
}

/**
 * How long a connector waits for a starting shared owner to publish its
 * endpoint: longer than the owner's whole child startup (the authority's lease
 * wait included), so no connector gives up on an owner that is still starting,
 * then finds nothing it can release or recover. That holds for every connector,
 * not only the frontend that spawned the owner: a second project that found the
 * configuration and waited only 15 s had its run aborted and its recovery left
 * unconfirmed (#1260 review, M2). A failed owner still fails fast: its recorded
 * startup failure ends the wait (`endpointFor`).
 */
export const NATIVE_HTTPS_OWNER_STARTUP_WAIT_MS =
  NATIVE_HTTPS_CHILD_STARTUP_MS + 15_000;

export async function connectNativeHttpsOwner(
  configuration: NativeHttpsOwnerConfiguration,
  waitForStartup = true,
  /**
   * The frontend that spawned this owner also stops waiting once that process
   * exits. Every connector waits for the whole startup
   * ({@link NATIVE_HTTPS_OWNER_STARTUP_WAIT_MS}).
   */
  spawned?: NativeHttpsSpawnedOwner
): Promise<Socket> {
  const deadline =
    Date.now() + (waitForStartup ? NATIVE_HTTPS_OWNER_STARTUP_WAIT_MS : 1);
  for (;;) {
    try {
      const endpoint = await endpointFor(configuration);
      const socket = connect(endpoint.socket);
      socket.on("error", () => undefined);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          socket.destroy();
          reject(nativeHttpsOwnerRefused());
        }, 2000);
        socket.once("connect", () => {
          clearTimeout(timer);
          resolve();
        });
        socket.once("error", () => {
          clearTimeout(timer);
          reject(nativeHttpsOwnerRefused());
        });
      });
      try {
        const after = await endpointFor(configuration);
        if (after.dev !== endpoint.dev || after.ino !== endpoint.ino) {
          throw nativeHttpsOwnerRefused();
        }
        return socket;
      } catch (error) {
        socket.destroy();
        throw error;
      }
    } catch (error) {
      if (
        !isRecord(error) ||
        error.code !== "ENOENT" ||
        Date.now() >= deadline ||
        spawned?.exited()
      ) {
        throw error;
      }
      await Bun.sleep(25);
    }
  }
}

/** One request per connection at a time; uncertainty is never retried. */
export async function requestNativeHttpsOwner(
  socket: Socket,
  value: unknown
): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    let bytes = Buffer.alloc(0);
    const finish = (error?: Error, reply?: unknown) => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("close", onClose);
      socket.off("error", onClose);
      if (error) {
        socket.destroy();
        reject(error);
      } else {
        resolve(reply);
      }
    };
    const onClose = () => finish(nativeHttpsOwnerRefused());
    const onData = (chunk: Buffer) => {
      if (bytes.length + chunk.length > NATIVE_HTTPS_OWNER_FRAME_LIMIT) {
        finish(nativeHttpsOwnerRefused());
        return;
      }
      bytes = Buffer.concat([bytes, chunk]);
      if (!bytes.includes(10)) {
        return;
      }
      try {
        const reply = decodeNativeHttpsOwnerFrame(bytes);
        if (
          isRecord(value) &&
          value.operation === "release" &&
          isNativeHttpsLeaseIdentity(value.identity)
        ) {
          finish(nativeHttpsReleaseReplyError(reply, value.identity), reply);
          return;
        }
        finish(undefined, reply);
      } catch {
        finish(nativeHttpsOwnerRefused());
      }
    };
    const timer = setTimeout(onClose, 120_000);
    socket.on("data", onData);
    socket.once("close", onClose);
    socket.once("error", onClose);
    try {
      socket.write(encodeNativeHttpsOwnerFrame(value));
    } catch {
      finish(nativeHttpsOwnerRefused());
    }
  });
}
async function release(
  socket: Socket,
  identity: NativeHttpsLeaseIdentity
): Promise<void> {
  const reply = await requestNativeHttpsOwner(socket, {
    version: 1,
    operation: "release",
    identity,
  });
  if (
    !isRecord(reply) ||
    reply.version !== 1 ||
    reply.ok !== true ||
    reply.released !== identity.leaseId
  ) {
    throw nativeHttpsOwnerRefused();
  }
}
export async function acquireNativeHttpsLease(
  opts: NativeHttpsAcquireOptions
): Promise<NativeHttpsLease> {
  if (
    !(Bun.main.startsWith("/$bunfs/") && isNativeHttpsLeaseRequest(opts.lease))
  ) {
    throw nativeHttpsOwnerRefused();
  }
  const binding: NativeHttpsOwnerBinding = {
    runtime: opts.runtime,
    frontend: {
      binary: process.execPath,
      sha256: await nativeHttpsExecutableSha256(process.execPath),
    },
    runtimeSha256: await nativeHttpsExecutableSha256(opts.runtime.binary),
    pool: opts.pool,
    caddyBinary: opts.caddyBinary,
    caddySha256: opts.caddySha256,
    httpsPort: opts.httpsPort,
    certificateNameLimit: opts.certificateNameLimit ?? 256,
  };
  let spawned: NativeHttpsSpawnedOwner | undefined;
  const configuration = await ensureNativeHttpsOwner({
    binding,
    onSpawned: (owner) => {
      spawned = owner;
    },
  });
  const intended = nativeHttpsLeaseIdentity(configuration, opts.lease);
  await opts.onIntent?.(intended);
  let socket: Socket;
  try {
    // A starting owner may be waiting out a `hack down` of the same run for
    // the provider lease (HACK-2707): wait for its whole startup rather than
    // give up while it is still starting.
    socket = await connectNativeHttpsOwner(configuration, true, spawned);
  } catch (startupFailure) {
    throw new NativeHttpsLeaseAcquisitionError(intended, { startupFailure });
  }
  const exited = new Promise<{ component: string; code: number }>((resolve) => {
    socket.once("close", () =>
      resolve({ component: "shared-https-owner", code: 1 })
    );
  });
  try {
    const reply = await requestNativeHttpsOwner(socket, {
      version: 1,
      operation: "acquire",
      ownerGeneration: configuration.ownerGeneration,
      lease: opts.lease,
    });
    if (
      !isRecord(reply) ||
      reply.version !== 1 ||
      reply.ok !== true ||
      !isNativeHttpsLeaseIdentity(reply.identity)
    ) {
      throw nativeHttpsOwnerRefused();
    }
    const identity = reply.identity;
    if (!sameNativeHttpsLease(identity, intended)) {
      throw nativeHttpsOwnerRefused();
    }
    const owner = await inspectActiveNativeHttpsOwner({
      runtime: opts.runtime,
    });
    if (
      owner.httpsPort !== binding.httpsPort ||
      owner.caddyBinary !== binding.caddyBinary
    ) {
      throw nativeHttpsOwnerRefused();
    }
    const selected = identity;
    let released = false;
    return {
      identity: selected,
      caPath: owner.caPath,
      httpsPort: binding.httpsPort,
      exited,
      verifyHostname: (hostname, path) =>
        verifyNativeHttpsHostname(
          hostname,
          binding.httpsPort,
          owner.caPath,
          path,
          (peerPort) =>
            verifyActiveNativeHttpsConnection({
              runtime: opts.runtime,
              owner,
              peerPort,
            })
        ),
      releaseAfterCleanup: async () => {
        if (released) {
          return;
        }
        await release(socket, selected);
        released = true;
        socket.end();
      },
    };
  } catch {
    // A durable acquire may have committed; disconnect preserves that lease for recovery.
    socket.destroy();
    throw new NativeHttpsLeaseAcquisitionError(intended);
  }
}

async function hasActiveNativeHttpsLease(
  runtime: NativeRuntimeSelection,
  identity: NativeHttpsLeaseIdentity
): Promise<boolean> {
  try {
    // A newer owner may pin a different bundle. Its validated generation can
    // exclude this historical lease without authorizing access to that owner.
    const configuration = await readNativeHttpsOwnerConfigurationAtHome(
      runtime.home
    );
    if (configuration.ownerGeneration !== identity.ownerGeneration) {
      return false;
    }
    if (configuration.binding.runtime.binary !== runtime.binary) {
      throw nativeHttpsOwnerRefused();
    }
    await lstat(
      join(
        nativeHttpsOwnerRoot(runtime.home),
        "leases",
        `${identity.leaseId}.json`
      )
    );
    return true;
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function archivePreviousBootSharedHttps(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly identity: NativeHttpsLeaseIdentity;
}): Promise<boolean> {
  let configuration: NativeHttpsOwnerConfiguration | undefined;
  try {
    configuration = await readNativeHttpsOwnerConfigurationAtHome(
      opts.runtime.home
    );
  } catch (error) {
    if (!isRecord(error) || error.code !== "ENOENT") {
      throw error;
    }
  }
  const status = await invokeNativeRuntime({
    runtime: opts.runtime,
    cwd: opts.runtime.home,
    args: ["runtime", "status", "--json"],
    timeoutMs: 30_000,
  });
  if (
    !isRecord(status) ||
    status.phase !== "running" ||
    status.process_alive !== true ||
    typeof status.guest_boot_id !== "string"
  ) {
    throw nativeHttpsOwnerRefused();
  }
  if (
    !configuration ||
    (configuration.ownerGeneration === opts.identity.ownerGeneration &&
      configuration.binding.pool.bootId !== status.guest_boot_id)
  ) {
    const archived = await invokeNativeRuntime({
      runtime: opts.runtime,
      cwd: opts.runtime.home,
      args: [
        "runtime",
        "archive-previous-boot-shared-https",
        "--run-id",
        opts.identity.run,
        "--expect-owner-generation",
        opts.identity.ownerGeneration,
        "--expect-lease-id",
        opts.identity.leaseId,
        "--expect-attempt",
        opts.identity.attempt,
        "--expect-owner",
        opts.identity.owner,
        "--expect-namespace",
        opts.identity.namespace,
        "--expect-plan",
        opts.identity.planId,
        "--json",
      ],
      // The archive waits up to 20 s for a retiring owner and up to 35 s for the
      // HTTPS port to leave TIME_WAIT (shared_https_recovery.rs).
      timeoutMs: 90_000,
    });
    if (
      !isRecord(archived) ||
      archived.archived !== true ||
      archived.run !== opts.identity.run ||
      archived.owner_generation !== opts.identity.ownerGeneration ||
      archived.lease_id !== opts.identity.leaseId ||
      archived.data_retained !== true ||
      archived.processes_signaled !== 0
    ) {
      throw nativeHttpsOwnerRefused();
    }
    return true;
  }
  return false;
}

/** Absence as a value; anything other than ENOENT (a foreign entry) refuses. */
async function nativeHttpsPathAbsent(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return true;
    }
    throw nativeHttpsOwnerRefused();
  }
}

/**
 * A startup failure that admitted nothing by contract: the hostname authority's
 * lease wait expired (`authority-ready: provider_busy`, "no operation was
 * admitted") and the owner confirmed its child pair stopped.
 */
function admittedNothing(
  failure: NativeHttpsStartupError | undefined
): boolean {
  return (
    failure !== undefined &&
    failure.diagnostic.stage === "authority-ready" &&
    failure.diagnostic.nativeCode === "provider_busy" &&
    !failure.diagnostic.cleanupUnconfirmed
  );
}

/**
 * Retire the current owner generation of `identity` when its startup failed
 * having admitted nothing (#1260 review, M3; HACK-2707 for any stop length).
 *
 * The authority waits 30 s for the provider lease, but a graph stop holds it
 * for as long as the run's stop grace periods take (up to 540 s). A `hack down`
 * right after `up -d` whose stop outlasts the wait made the shared owner's
 * startup fail, and that failure was retained: the frontend's recovery of its
 * lease could not be confirmed (`down` exited 1) and every later acquisition
 * found the failed generation (the next `up` needed recovery). The retained
 * record now no longer blocks once a recovery of a lease of that generation
 * runs, which the frontend does only after its graph owner has settled and
 * `down` only after the stop:
 *
 * - The record proves the generation never ran: the owner records a startup
 *   failure only while still starting, so it never admitted a lease, and with
 *   no `endpoint.json` no client could ever reach it. The lease directory must
 *   still be empty and the child pair confirmed stopped.
 * - Only `authority-ready: provider_busy` qualifies (see `admittedNothing`).
 *   Every other startup failure is still retained as evidence, unchanged.
 * - Under the owner admission lock (which also serializes a new owner's
 *   creation) it writes the retired-owner record, moves the diagnostic beside
 *   it as evidence, and removes the root by exact identity. Every step is
 *   repeatable, so an interrupted retirement resumes on the next recovery.
 *
 * The caller's retired-owner branch then verifies this lease's release through
 * the graph (graph, bridges and publication claims), as for an idle-retired
 * owner; no lease is acknowledged here.
 */
async function retireUnadmittedNativeHttpsOwner(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly identity: NativeHttpsLeaseIdentity;
}): Promise<void> {
  const home = opts.runtime.home;
  const root = nativeHttpsOwnerRoot(home);
  // Anything else (no owner, another generation, a live or foreign one, an
  // unreadable record) is left to the rest of recovery, exactly as before.
  const current = async () => {
    try {
      const configuration = await readNativeHttpsOwnerConfiguration(
        opts.runtime
      );
      if (
        configuration.ownerGeneration === opts.identity.ownerGeneration &&
        configuration.binding.pool.owner === opts.identity.owner &&
        admittedNothing(await readNativeHttpsStartupFailure(configuration))
      ) {
        return configuration;
      }
    } catch {
      // Left to the rest of recovery.
    }
    return;
  };
  if (!(await current())) {
    return;
  }
  const admission = await acquireNativeHttpsOwnerAdmission({
    home,
    waitMs: 15_000,
  });
  try {
    // Everything again under admission: nothing can create or publish here now.
    const configuration = await current();
    if (!configuration) {
      return;
    }
    // An endpoint was published: a client could have reached this owner.
    if (!(await nativeHttpsPathAbsent(join(root, "endpoint.json")))) {
      return;
    }
    await nativeHttpsPrivateDirectory(join(root, "leases"));
    if ((await readdir(join(root, "leases"))).length !== 0) {
      return;
    }
    const configurationFile = await nativeHttpsReadFile(
      join(root, "configuration.json")
    );
    const failureFile = await nativeHttpsReadFile(
      join(root, "startup-failure.json")
    );
    const generation = configuration.ownerGeneration;
    try {
      await nativeHttpsReadRetiredOwner(home, generation);
    } catch (error) {
      if (!isRecord(error) || error.code !== "ENOENT") {
        throw error;
      }
      await nativeHttpsRecordRetiredOwner(configuration);
    }
    const evidence = join(
      home,
      "native-https",
      "released-leases",
      generation,
      "startup-failure.json"
    );
    if (await nativeHttpsPathAbsent(evidence)) {
      await nativeHttpsWriteNew(
        evidence,
        JSON.parse(failureFile.bytes.toString("utf8"))
      );
    }
    await nativeHttpsRemoveFile(
      join(root, "startup-failure.json"),
      failureFile.identity
    );
    await nativeHttpsRemoveFile(
      join(root, "configuration.json"),
      configurationFile.identity
    );
    await rmdir(join(root, "leases"));
    await rmdir(root);
  } finally {
    await admission.release();
  }
}

/** Recovery never treats absent/dead helper state as permission to adopt its children. */
export async function recoverNativeHttpsLease(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly identity: NativeHttpsLeaseIdentity;
  readonly verifyReleased?: typeof verifyNativeHttpsLeaseGraph;
  /** Only an explicit v3 dead-frontend recovery may select prior-boot archival. */
  readonly archivePreviousBoot?: true;
}): Promise<void> {
  if (!isNativeHttpsLeaseIdentity(opts.identity)) {
    throw nativeHttpsOwnerRefused();
  }
  try {
    const released = await nativeHttpsReadRelease(
      opts.runtime.home,
      opts.identity
    );
    if (released.binding.runtime.binary !== opts.runtime.binary) {
      throw nativeHttpsOwnerRefused();
    }
    const activeLease = await hasActiveNativeHttpsLease(
      opts.runtime,
      opts.identity
    );
    if (!activeLease) {
      await (opts.verifyReleased ?? verifyNativeHttpsLeaseGraph)(
        released.binding,
        opts.identity,
        "release"
      );
      return;
    }
  } catch (error) {
    if (!isRecord(error) || error.code !== "ENOENT") {
      throw error;
    }
  }
  // An owner generation whose startup failed having admitted nothing is
  // retired first; the retired-owner branch below then verifies the release.
  await retireUnadmittedNativeHttpsOwner(opts);
  try {
    const retired = await nativeHttpsReadRetiredOwner(
      opts.runtime.home,
      opts.identity.ownerGeneration
    );
    if (
      retired.binding.runtime.binary !== opts.runtime.binary ||
      !sameNativeHttpsLease(
        nativeHttpsLeaseIdentity(retired, opts.identity),
        opts.identity
      )
    ) {
      throw nativeHttpsOwnerRefused();
    }
    await (opts.verifyReleased ?? verifyNativeHttpsLeaseGraph)(
      retired.binding,
      opts.identity,
      "release"
    );
    return;
  } catch (error) {
    if (!isRecord(error) || error.code !== "ENOENT") {
      throw error;
    }
  }
  if (
    opts.archivePreviousBoot === true &&
    (await archivePreviousBootSharedHttps(opts))
  ) {
    return;
  }
  const configuration = await readNativeHttpsOwnerConfiguration(opts.runtime);
  if (
    configuration.ownerGeneration !== opts.identity.ownerGeneration ||
    configuration.binding.pool.owner !== opts.identity.owner
  ) {
    throw nativeHttpsOwnerRefused();
  }
  const socket = await connectNativeHttpsOwner(configuration, false);
  try {
    await release(socket, opts.identity);
  } finally {
    socket.destroy();
  }
}
