import {
  chmod,
  lstat,
  mkdtemp,
  readdir,
  realpath,
  rmdir,
  unlink,
} from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "../lib/guards.ts";
import { listenPublishedUnixSocket } from "../lib/unix-socket-publish.ts";
import {
  decodeNativeHttpsOwnerFrame,
  encodeNativeHttpsOwnerFrame,
  isNativeHttpsOwnerConfiguration,
  NATIVE_HTTPS_OWNER_FRAME_LIMIT,
  type NativeHttpsLeaseIdentity,
  type NativeHttpsLeaseRequest,
  type NativeHttpsOwnerBinding,
  type NativeHttpsOwnerConfiguration,
  type NativeHttpsOwnerRequest,
  nativeHttpsLeaseIdentity,
  nativeHttpsOwnerRefused,
  parseNativeHttpsOwnerRequest,
  sameNativeHttpsLease,
} from "./native-https-owner-protocol.ts";
import {
  type NativeHttpsFileIdentity,
  nativeHttpsExecutableSha256,
  nativeHttpsOwnerRoot,
  nativeHttpsPrivateDirectory,
  nativeHttpsReadFile,
  nativeHttpsReadRelease,
  nativeHttpsRecordRelease,
  nativeHttpsRecordRetiredOwner,
  nativeHttpsRemoveFile,
  nativeHttpsWriteNew,
} from "./native-https-owner-storage.ts";
import { startNativeProjectHttps } from "./native-project-https.ts";
import { invokeNativeRuntime } from "./native-runtime-client.ts";

type Frontend = Awaited<ReturnType<typeof startNativeProjectHttps>>;
export interface NativeHttpsOwnerServerDependencies {
  readonly start: (binding: NativeHttpsOwnerBinding) => Promise<Frontend>;
  readonly verify: (
    binding: NativeHttpsOwnerBinding,
    lease: NativeHttpsLeaseRequest,
    phase: "acquire" | "release"
  ) => Promise<void>;
  readonly verifyIdle: (binding: NativeHttpsOwnerBinding) => Promise<void>;
}

function verifyCleanGraphObservations(
  receipt: Record<string, unknown>,
  observations: unknown
): void {
  if (
    !(
      ["stopped-data-retained", "removed"].includes(String(receipt.phase)) &&
      isRecord(receipt.resources) &&
      isRecord(observations)
    )
  ) {
    throw nativeHttpsOwnerRefused();
  }
  for (const [key, resource] of Object.entries(receipt.resources)) {
    if (
      !(
        isRecord(resource) &&
        ["container", "network", "volume"].includes(String(resource.kind))
      )
    ) {
      throw nativeHttpsOwnerRefused();
    }
    const observed = observations[key];
    const state =
      resource.kind === "volume" && receipt.phase === "stopped-data-retained"
        ? "present"
        : "absent";
    if (!isRecord(observed) || observed.state !== state) {
      throw nativeHttpsOwnerRefused();
    }
  }
}

/** Binds release to fresh native graph and publication observations, not a disconnected client. */
export async function verifyNativeHttpsLeaseGraph(
  binding: NativeHttpsOwnerBinding,
  lease: NativeHttpsLeaseRequest,
  phase: "acquire" | "release",
  invoke: typeof invokeNativeRuntime = invokeNativeRuntime
): Promise<void> {
  const call = (args: readonly string[]) =>
    invoke({
      runtime: binding.runtime,
      cwd: binding.runtime.home,
      args,
      timeoutMs: 30_000,
    });
  const status = await call(["runtime", "status", "--json"]);
  if (
    !isRecord(status) ||
    status.phase !== "running" ||
    status.process_alive !== true ||
    status.guest_boot_id !== binding.pool.bootId
  ) {
    throw nativeHttpsOwnerRefused();
  }
  const inspect = async () => {
    const value = await call([
      "graph",
      "inspect",
      "--run-id",
      lease.run,
      "--json",
    ]);
    if (
      !isRecord(value) ||
      value.journal_incomplete !== false ||
      !isRecord(value.receipt) ||
      value.receipt.run !== lease.run ||
      value.receipt.owner !== binding.pool.owner ||
      value.receipt.namespace !== lease.namespace ||
      value.receipt.plan_id !== lease.planId
    ) {
      throw nativeHttpsOwnerRefused();
    }
    if (phase === "acquire") {
      if (value.receipt.phase !== "ready-observed") {
        throw nativeHttpsOwnerRefused();
      }
    } else {
      verifyCleanGraphObservations(value.receipt, value.observations);
    }
  };
  await inspect();
  if (phase === "release") {
    const bridges = await call([
      "graph",
      "bridges",
      "--run-id",
      lease.run,
      "--json",
    ]);
    const claims = await call(["runtime", "publication-hostnames", "--json"]);
    if (
      !isRecord(bridges) ||
      bridges.run !== lease.run ||
      !isRecord(bridges.slots) ||
      Object.keys(bridges.slots).length !== 0 ||
      !isRecord(claims) ||
      claims.scope !== "durable-ownership-only" ||
      !Array.isArray(claims.claims) ||
      claims.claims.some(
        (entry) =>
          !isRecord(entry) ||
          typeof entry.run !== "string" ||
          entry.run === lease.run
      )
    ) {
      throw nativeHttpsOwnerRefused();
    }
    await inspect();
  }
}

/** Tests supply a fake child pair while retaining the real lease process/socket boundary. */
export async function serveNativeHttpsOwner(opts: {
  readonly configurationPath: string;
  readonly dependencies: NativeHttpsOwnerServerDependencies;
  readonly startupGraceMs?: number;
}): Promise<void> {
  const configurationFile = await nativeHttpsReadFile(opts.configurationPath);
  const parsed: unknown = JSON.parse(configurationFile.bytes.toString("utf8"));
  if (!isNativeHttpsOwnerConfiguration(parsed)) {
    throw nativeHttpsOwnerRefused();
  }
  const configuration: NativeHttpsOwnerConfiguration = parsed;
  const { binding, ownerGeneration } = configuration;
  const root = nativeHttpsOwnerRoot(binding.runtime.home);
  if (opts.configurationPath !== join(root, "configuration.json")) {
    throw nativeHttpsOwnerRefused();
  }
  await nativeHttpsPrivateDirectory(root);
  const rootIdentity = await lstat(root);
  const leaseRoot = join(root, "leases");
  await nativeHttpsPrivateDirectory(leaseRoot);
  const leaseRootIdentity = await lstat(leaseRoot);
  if ((await readdir(leaseRoot)).length !== 0) {
    throw nativeHttpsOwnerRefused();
  }
  const directory = await mkdtemp(
    join(await realpath(tmpdir()), "hk-https-leases-")
  );
  await nativeHttpsPrivateDirectory(directory);
  const directoryIdentity = await lstat(directory);
  const socketPath = join(directory, "control.sock");
  const leases = new Map<
    string,
    {
      identity: NativeHttpsLeaseIdentity;
      file: NativeHttpsFileIdentity;
      socket: Socket | null;
    }
  >();
  const clients = new Set<Socket>();
  let state: "starting" | "running" | "closing" | "closed" | "failed" =
    "starting";
  let queue = Promise.resolve();
  let endpointIdentity: NativeHttpsFileIdentity | undefined;
  let socketIdentity: { dev: number; ino: number } | undefined;
  let frontend: Frontend | undefined;
  let frontendFailed = false;
  let finish: () => void = () => undefined;
  let fail: (error: Error) => void = () => undefined;
  const completed = new Promise<void>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  // Attach immediately: startup may fail before the final await is reached.
  void completed.catch(() => undefined);
  const serialize = (operation: () => Promise<void>) => {
    const result = queue.then(operation);
    queue = result.catch(() => undefined);
    return result;
  };
  const checkPaths = async () => {
    await nativeHttpsPrivateDirectory(root);
    await nativeHttpsPrivateDirectory(directory);
    const currentRoot = await lstat(root);
    const currentDirectory = await lstat(directory);
    const currentLeases = await lstat(leaseRoot);
    const currentSocket = await lstat(socketPath);
    if (
      currentRoot.dev !== rootIdentity.dev ||
      currentRoot.ino !== rootIdentity.ino ||
      currentDirectory.dev !== directoryIdentity.dev ||
      currentDirectory.ino !== directoryIdentity.ino ||
      currentLeases.dev !== leaseRootIdentity.dev ||
      currentLeases.ino !== leaseRootIdentity.ino ||
      !currentLeases.isDirectory() ||
      !socketIdentity ||
      !currentSocket.isSocket() ||
      currentSocket.dev !== socketIdentity.dev ||
      currentSocket.ino !== socketIdentity.ino
    ) {
      throw nativeHttpsOwnerRefused();
    }
  };
  const closeServer = async () => {
    // Refuse before closing when any owned path changed. The runtime's close-time
    // unlink reaches only the retired staging name (listenPublishedUnixSocket).
    await checkPaths();
    for (const client of clients) {
      client.destroy();
    }
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
    await retireSocketPath();
  };
  const retireSocketPath = async () => {
    let current: Awaited<ReturnType<typeof lstat>>;
    try {
      current = await lstat(socketPath);
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") {
        return;
      }
      throw nativeHttpsOwnerRefused();
    }
    if (
      !(socketIdentity && current.isSocket()) ||
      current.dev !== socketIdentity.dev ||
      current.ino !== socketIdentity.ino
    ) {
      throw nativeHttpsOwnerRefused();
    }
    await unlink(socketPath);
  };
  const failOwner = async () => {
    if (state === "failed" || state === "closed") {
      return;
    }
    state = "failed";
    for (const client of clients) {
      client.destroy();
    }
    // Retain configuration and lease evidence on every failure; never recreate.
    const results = await Promise.allSettled([
      frontend?.close(),
      socketIdentity ? closeServer() : Promise.resolve(),
    ]);
    if (results.every((result) => result.status === "fulfilled")) {
      try {
        const current = await lstat(directory);
        if (
          current.dev === directoryIdentity.dev &&
          current.ino === directoryIdentity.ino
        ) {
          await rmdir(directory);
        }
      } catch {
        // A nonempty or replaced temporary directory remains recovery evidence.
      }
    }
    fail(nativeHttpsOwnerRefused());
  };
  const retire = async (released?: {
    socket: Socket;
    identity: NativeHttpsLeaseIdentity;
    file?: NativeHttpsFileIdentity;
  }) => {
    await checkPaths();
    await opts.dependencies.verifyIdle(binding);
    state = "closing";
    await frontend?.close();
    await checkPaths();
    if (released) {
      await nativeHttpsRecordRelease({
        version: 1,
        identity: released.identity,
        binding,
        finalOwner: true,
      });
      if (released.file) {
        await nativeHttpsRemoveFile(
          join(leaseRoot, `${released.identity.leaseId}.json`),
          released.file
        );
      }
      leases.delete(released.identity.leaseId);
    }
    if (leases.size !== 0 || (await readdir(leaseRoot)).length !== 0) {
      throw nativeHttpsOwnerRefused();
    }
    await nativeHttpsRecordRetiredOwner(configuration);
    // Stop admission before retiring the registry. Keep the releasing socket long
    // enough to acknowledge only after the owned child pair and records retire.
    const closedServer = new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
    void closedServer.catch(() => undefined);
    if (endpointIdentity) {
      await nativeHttpsRemoveFile(
        join(root, "endpoint.json"),
        endpointIdentity
      );
    }
    await nativeHttpsRemoveFile(
      opts.configurationPath,
      configurationFile.identity
    );
    await rmdir(leaseRoot);
    await rmdir(root);
    if (released) {
      await new Promise<void>((resolve, reject) =>
        released.socket.write(
          encodeNativeHttpsOwnerFrame({
            version: 1,
            ok: true,
            released: released.identity.leaseId,
          }),
          (error) => (error ? reject(error) : resolve())
        )
      );
      released.socket.end();
      released.socket.destroySoon();
    }
    for (const client of clients) {
      if (client !== released?.socket) {
        client.destroy();
      }
    }
    await closedServer;
    await retireSocketPath();
    await rmdir(directory);
    state = "closed";
    finish();
  };
  const acquireLease = async (
    socket: Socket,
    request: Extract<NativeHttpsOwnerRequest, { operation: "acquire" }>
  ) => {
    if (
      request.ownerGeneration !== ownerGeneration ||
      [...leases.values()].some(
        (entry) =>
          entry.identity.run === request.lease.run || entry.socket === socket
      )
    ) {
      throw nativeHttpsOwnerRefused();
    }
    const identity = nativeHttpsLeaseIdentity(configuration, request.lease);
    try {
      await nativeHttpsReadRelease(binding.runtime.home, identity);
      throw nativeHttpsOwnerRefused();
    } catch (error) {
      if (!isRecord(error) || error.code !== "ENOENT") {
        throw error;
      }
    }
    await opts.dependencies.verify(binding, request.lease, "acquire");
    if (frontendFailed) {
      throw nativeHttpsOwnerRefused();
    }
    const file = await nativeHttpsWriteNew(
      join(leaseRoot, `${identity.leaseId}.json`),
      identity
    );
    leases.set(identity.leaseId, {
      identity,
      file,
      socket: socket.destroyed ? null : socket,
    });
    if (frontendFailed) {
      throw nativeHttpsOwnerRefused();
    }
    socket.write(
      encodeNativeHttpsOwnerFrame({ version: 1, ok: true, identity })
    );
    return;
  };
  const releaseUnadmittedLease = async (
    socket: Socket,
    identity: NativeHttpsLeaseIdentity
  ) => {
    if (
      !sameNativeHttpsLease(
        nativeHttpsLeaseIdentity(configuration, identity),
        identity
      )
    ) {
      throw nativeHttpsOwnerRefused();
    }
    await opts.dependencies.verify(binding, identity, "release");
    try {
      await lstat(join(leaseRoot, `${identity.leaseId}.json`));
      throw nativeHttpsOwnerRefused();
    } catch (error) {
      if (!isRecord(error) || error.code !== "ENOENT") {
        throw error;
      }
    }
    if (leases.size === 0) {
      await retire({ socket, identity });
      return;
    }
    // A persisted acquire intent may never have been delivered. Only this
    // generation's live serialized owner can certify it was never admitted.
    try {
      await nativeHttpsReadRelease(binding.runtime.home, identity);
    } catch (error) {
      if (!isRecord(error) || error.code !== "ENOENT") {
        throw error;
      }
      await nativeHttpsRecordRelease({
        version: 1,
        identity,
        binding,
        finalOwner: false,
      });
    }
    socket.end(
      encodeNativeHttpsOwnerFrame({
        version: 1,
        ok: true,
        released: identity.leaseId,
      })
    );
    return;
  };
  const handle = async (socket: Socket, request: NativeHttpsOwnerRequest) => {
    if (state !== "running" || frontendFailed) {
      throw nativeHttpsOwnerRefused();
    }
    await checkPaths();
    if (request.operation === "acquire") {
      return acquireLease(socket, request);
    }
    const entry = leases.get(request.identity.leaseId);
    if (!entry) {
      return releaseUnadmittedLease(socket, request.identity);
    }
    if (!sameNativeHttpsLease(entry.identity, request.identity)) {
      throw nativeHttpsOwnerRefused();
    }
    await opts.dependencies.verify(binding, entry.identity, "release");
    if (leases.size === 1) {
      await retire({ socket, identity: entry.identity, file: entry.file });
      return;
    }
    await nativeHttpsRecordRelease({
      version: 1,
      identity: entry.identity,
      binding,
      finalOwner: false,
    });
    await nativeHttpsRemoveFile(
      join(leaseRoot, `${entry.identity.leaseId}.json`),
      entry.file
    );
    leases.delete(entry.identity.leaseId);
    // Reply before closing sockets; a lost reply remains an uncertain client result.
    await new Promise<void>((resolve, reject) =>
      socket.write(
        encodeNativeHttpsOwnerFrame({
          version: 1,
          ok: true,
          released: entry.identity.leaseId,
        }),
        (error) => (error ? reject(error) : resolve())
      )
    );
    if (entry.socket && entry.socket !== socket) {
      entry.socket.end();
    }
    socket.end();
  };
  const server = createServer((socket) => {
    clients.add(socket);
    let bytes = Buffer.alloc(0);
    let busy = false;
    socket.setTimeout(2000, () => socket.destroy());
    socket.on("error", () => undefined);
    socket.on("close", () => {
      clients.delete(socket);
      for (const entry of leases.values()) {
        if (entry.socket === socket) {
          entry.socket = null;
        }
      }
    });
    socket.on("data", (chunk: Buffer) => {
      if (
        busy ||
        bytes.length + chunk.length > NATIVE_HTTPS_OWNER_FRAME_LIMIT
      ) {
        socket.destroy();
        return;
      }
      bytes = Buffer.concat([bytes, chunk]);
      if (!bytes.includes(10)) {
        return;
      }
      let request: NativeHttpsOwnerRequest;
      try {
        request = parseNativeHttpsOwnerRequest(
          decodeNativeHttpsOwnerFrame(bytes)
        );
      } catch {
        socket.destroy();
        return;
      }
      bytes = Buffer.alloc(0);
      busy = true;
      socket.setTimeout(0);
      void serialize(() => handle(socket, request))
        .catch(() => {
          socket.destroy();
          // If retirement began, never accept another lease in a half-closed state.
          if (state === "closing") {
            void serialize(failOwner);
          }
        })
        .finally(() => {
          busy = false;
        });
    });
  });
  const onSignal = () => {
    void serialize(failOwner);
  };
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    frontend = await opts.dependencies.start(binding);
    const exited = () => {
      frontendFailed = true;
      if (state === "running") {
        void serialize(failOwner);
      }
    };
    void frontend.exited.then(exited, exited);
    // Published by link from a staging name: closing the server never removes
    // the control endpoint, which only retireSocketPath removes by identity.
    await listenPublishedUnixSocket(server, socketPath);
    const before = await lstat(socketPath);
    await chmod(socketPath, 0o600);
    const after = await lstat(socketPath);
    if (
      !after.isSocket() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      after.uid !== process.getuid?.()
    ) {
      throw nativeHttpsOwnerRefused();
    }
    socketIdentity = { dev: after.dev, ino: after.ino };
    if (frontendFailed) {
      throw nativeHttpsOwnerRefused();
    }
    endpointIdentity = await nativeHttpsWriteNew(join(root, "endpoint.json"), {
      version: 1,
      ownerGeneration,
      socket: socketPath,
      ...socketIdentity,
    });
    if (frontendFailed) {
      throw nativeHttpsOwnerRefused();
    }
    state = "running";
    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);
    startupTimer = setTimeout(() => {
      void serialize(async () => {
        if (state === "running" && leases.size === 0) {
          await retire();
        }
      }).catch(() => {
        // Claims can precede their frontend lease. Unproven idle is retained.
        if (state === "closing") {
          void serialize(failOwner);
        }
      });
    }, opts.startupGraceMs ?? 30_000);
    await completed;
  } catch {
    await failOwner();
    throw nativeHttpsOwnerRefused();
  } finally {
    if (startupTimer) {
      clearTimeout(startupTimer);
    }
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  }
}

/** Production entrypoint: exact compiled candidate and pinned native tools only. */
async function runPinnedNativeHttpsOwner(opts: {
  readonly configurationPath: string;
}): Promise<void> {
  const { bytes } = await nativeHttpsReadFile(opts.configurationPath);
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  if (
    !(
      Bun.main.startsWith("/$bunfs/") && isNativeHttpsOwnerConfiguration(value)
    ) ||
    value.binding.frontend.binary !== process.execPath
  ) {
    throw nativeHttpsOwnerRefused();
  }
  const { binding } = value;
  for (const [path, hash] of [
    [binding.frontend.binary, binding.frontend.sha256],
    [binding.runtime.binary, binding.runtimeSha256],
    [binding.caddyBinary, binding.caddySha256],
  ] as const) {
    if ((await nativeHttpsExecutableSha256(path)) !== hash) {
      throw nativeHttpsOwnerRefused();
    }
  }
  await serveNativeHttpsOwner({
    configurationPath: opts.configurationPath,
    dependencies: {
      start: (selected) => startNativeProjectHttps(selected),
      verify: verifyNativeHttpsLeaseGraph,
      verifyIdle: async (selected) => {
        const claims = await invokeNativeRuntime({
          runtime: selected.runtime,
          cwd: selected.runtime.home,
          args: ["runtime", "publication-hostnames", "--json"],
          timeoutMs: 30_000,
        });
        if (
          !isRecord(claims) ||
          claims.scope !== "durable-ownership-only" ||
          !Array.isArray(claims.claims) ||
          claims.claims.length !== 0
        ) {
          throw nativeHttpsOwnerRefused();
        }
      },
    },
  });
}

export async function runNativeHttpsOwner(opts: {
  readonly configurationPath: string;
}): Promise<number> {
  try {
    await runPinnedNativeHttpsOwner(opts);
    return 0;
  } catch {
    process.stderr.write(
      "Shared native HTTPS owner failed; retained ownership requires inspection.\n"
    );
    return 1;
  }
}
