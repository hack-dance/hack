import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { isRecord } from "../lib/guards.ts";
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
  nativeHttpsWriteNew,
} from "./native-https-owner-storage.ts";
import {
  inspectActiveNativeHttpsOwner,
  verifyActiveNativeHttpsConnection,
  verifyNativeHttpsHostname,
} from "./native-project-https.ts";
import type { NativeRuntimeSelection } from "./native-runtime-client.ts";

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
export class NativeHttpsLeaseAcquisitionError extends Error {
  readonly identity: NativeHttpsLeaseIdentity;
  constructor(identity: NativeHttpsLeaseIdentity) {
    super(
      "Shared native HTTPS acquisition is uncertain; use the retained exact lease identity after graph cleanup."
    );
    this.identity = identity;
  }
}

/** The exact reviewed executable is detached into its own process group. */
export async function spawnNativeHttpsOwner(opts: {
  readonly frontend: { readonly binary: string; readonly sha256: string };
  readonly configurationPath: string;
  readonly home: string;
}): Promise<void> {
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
  child.unref();
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
  if ((await realpath(runtime.home)) !== runtime.home) {
    throw nativeHttpsOwnerRefused();
  }
  for (const directory of [
    runtime.home,
    join(runtime.home, "native-https"),
    nativeHttpsOwnerRoot(runtime.home),
  ]) {
    await nativeHttpsPrivateDirectory(directory);
  }
  const { bytes } = await nativeHttpsReadFile(
    join(nativeHttpsOwnerRoot(runtime.home), "configuration.json")
  );
  const configuration: unknown = JSON.parse(bytes.toString("utf8"));
  if (
    !isNativeHttpsOwnerConfiguration(configuration) ||
    configuration.binding.runtime.home !== runtime.home ||
    configuration.binding.runtime.binary !== runtime.binary
  ) {
    throw nativeHttpsOwnerRefused();
  }
  return configuration;
}

/** No stale directory is removed. Interrupted startup is explicit recovery work. */
export async function ensureNativeHttpsOwner(opts: {
  readonly binding: NativeHttpsOwnerBinding;
  readonly spawnOwner?: typeof spawnNativeHttpsOwner;
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
    await (opts.spawnOwner ?? spawnNativeHttpsOwner)({
      frontend: binding.frontend,
      home: binding.runtime.home,
      configurationPath,
    });
    return configuration;
  }
  // Only startup publication can be retried; no acquire/release request is replayed.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const existing = await readNativeHttpsOwnerConfiguration(binding.runtime);
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

export async function connectNativeHttpsOwner(
  configuration: NativeHttpsOwnerConfiguration,
  waitForStartup = true
): Promise<Socket> {
  const deadline = Date.now() + (waitForStartup ? 15_000 : 1);
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
        Date.now() >= deadline
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
        finish(undefined, decodeNativeHttpsOwnerFrame(bytes));
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
  const configuration = await ensureNativeHttpsOwner({ binding });
  const intended = nativeHttpsLeaseIdentity(configuration, opts.lease);
  await opts.onIntent?.(intended);
  let socket: Socket;
  try {
    socket = await connectNativeHttpsOwner(configuration);
  } catch {
    throw new NativeHttpsLeaseAcquisitionError(intended);
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
    const configuration = await readNativeHttpsOwnerConfiguration(runtime);
    if (configuration.ownerGeneration !== identity.ownerGeneration) {
      return false;
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

/** Recovery never treats absent/dead helper state as permission to adopt its children. */
export async function recoverNativeHttpsLease(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly identity: NativeHttpsLeaseIdentity;
  readonly verifyReleased?: typeof verifyNativeHttpsLeaseGraph;
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
