import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { nativeHttpsOwnerInvocationRunning } from "../src/backends/native-https-empty-owner-recovery.ts";
import {
  connectNativeHttpsOwner,
  ensureNativeHttpsOwner,
  type NativeHttpsSpawnedOwner,
  readNativeHttpsOwnerConfiguration,
  recoverNativeHttpsLease,
  requestNativeHttpsOwner,
} from "../src/backends/native-https-owner.ts";
import {
  type NativeHttpsLeaseIdentity,
  type NativeHttpsOwnerBinding,
  nativeHttpsLeaseIdentity,
} from "../src/backends/native-https-owner-protocol.ts";
import {
  verifyNativeHttpsLeaseGraph,
  verifyNativeHttpsOwnerIdle,
} from "../src/backends/native-https-owner-server.ts";
import {
  nativeHttpsExecutableSha256,
  nativeHttpsLeaseReleasePath,
  nativeHttpsOwnerRoot,
  nativeHttpsReadRelease,
  nativeHttpsReadRetiredOwner,
  nativeHttpsRecordRelease,
  nativeHttpsRecordRetiredOwner,
} from "../src/backends/native-https-owner-storage.ts";
import {
  type invokeNativeRuntime,
  NativeRuntimeRequestError,
} from "../src/backends/native-runtime-client.ts";

const serverModule = resolve(
  import.meta.dir,
  "../src/backends/native-https-owner-server.ts"
);
const clientModule = resolve(
  import.meta.dir,
  "../src/backends/native-https-owner.ts"
);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});
const lease = (run: string) => ({
  run: run.repeat(32),
  attempt: run.repeat(32),
  namespace: run.repeat(64),
  planId: "f".repeat(64),
});
const pause = (ms: number) =>
  new Promise((resolvePause) => setTimeout(resolvePause, ms));
async function until<T>(read: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 8000;
  for (;;) {
    try {
      return await read();
    } catch (error) {
      if (Date.now() >= deadline) {
        throw error;
      }
      await pause(20);
    }
  }
}
/** Never 0 or negative: process.kill would then signal this test's process group. */
function helperPid(text: string): number {
  const pid = Number(text);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error("helper pid is not published");
  }
  return pid;
}
/** Waits until a helper this test started has exited (signal 0 finds no process). */
async function untilExited(pid: number): Promise<void> {
  await until(async () => {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    throw new Error("owned helper still running");
  });
}
/** Appended marker files can be read partly written; wait for their complete content. */
function untilText(path: string, expected: string): Promise<string> {
  return until(async () => {
    const text = await readFile(path, "utf8");
    if (text !== expected) {
      throw new Error(`waiting for ${path}`);
    }
    return text;
  });
}
async function fixture(
  options: {
    readonly immediateExit?: boolean;
    readonly startFailure?: boolean;
    readonly hardExit?: boolean;
    readonly holdRetirement?: boolean;
    readonly releaseFault?: "graph-verification" | "idle-verification";
    /** Fault injected between control-socket publication and its first observation. */
    readonly afterPublish?: "fail" | "replace";
    /**
     * Holds the owner between endpoint publication and recording that it runs,
     * until the test writes "open" or "fail" to the startup-gate file.
     */
    readonly holdStartup?: boolean;
    /** The owner checks its pool boot; the boot ends when the test writes "boot-ended". */
    readonly poolBootEnds?: boolean;
    /** The child start takes this long before it returns (a slow authority). */
    readonly startDelayMs?: number;
    /**
     * The child start fails as the authority's expired lease wait does
     * (`authority-ready: provider_busy`), with its child cleanup confirmed or not.
     */
    readonly authorityBusy?: "confirmed" | "unconfirmed";
  } = {}
) {
  const home = await mkdtemp(join(await realpath(tmpdir()), "hk-owner-test-"));
  await chmod(home, 0o700);
  const frontend = join(home, "fixture-frontend");
  // This executable runs the real owner/socket state machine in another process.
  // The low-level Caddy pair is modeled: these tests neither start a VM nor bind TLS.
  await writeFile(
    frontend,
    `#!${process.execPath}
import { serveNativeHttpsOwner } from ${JSON.stringify(serverModule)};
import { appendFile, chmod, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { NativeRuntimeRequestError } from ${JSON.stringify(resolve(import.meta.dir, "../src/backends/native-runtime-client.ts"))};
import { NativeHttpsStartupError } from ${JSON.stringify(resolve(import.meta.dir, "../src/backends/native-https-startup-failure.ts"))};
const home = ${JSON.stringify(home)};
const fault = ${JSON.stringify(options.afterPublish ?? null)};
const releaseFault = ${JSON.stringify(options.releaseFault ?? null)};
const failRelease = (stage) => { if (releaseFault === stage) throw new NativeRuntimeRequestError({ message: "/private/fixture/secret-CANARY", nativeCode: "provider_busy" }); };
// Tests poll these markers: publish each complete, never a partly written file.
const marker = async (name, value) => { await writeFile(home + "/" + name + ".partial", value); await rename(home + "/" + name + ".partial", home + "/" + name); };
await marker("helper-pid", String(process.pid));
${options.hardExit ? "process.exit(7);" : ""}
const never = ${options.immediateExit ? 'Promise.resolve({component:"fixture",code:1})' : "new Promise(() => {})"};
try {
  await serveNativeHttpsOwner({ configurationPath: process.argv.at(-1), dependencies: {
    start: async () => {
      await appendFile(home + "/events", "start\\n");
      ${options.startFailure ? 'throw new NativeRuntimeRequestError({ message: "private child output", nativeCode: "provider_busy" });' : ""}
      ${options.authorityBusy ? `throw new NativeHttpsStartupError("authority-ready", new NativeRuntimeRequestError({ message: "private child output", nativeCode: "provider_busy" }), ${options.authorityBusy === "unconfirmed"});` : ""}
      ${options.startDelayMs ? `await Bun.sleep(${options.startDelayMs});` : ""}
      return { caPath: home + "/fake-ca", httpsPort: 19443, exited: never,
        verifyHostname: async () => ({statusCode:200}),
        close: async () => { await appendFile(home + "/events", "close\\n"); }
      };
    },
    verify: async (_binding, lease, phase) => {
      if (phase === "release") { await appendFile(home + "/release-verifies", "verify\\n"); failRelease("graph-verification"); }
      if (phase === "release" && await readFile(home + "/clean-" + lease.run, "utf8") !== "clean") { throw new Error("unproven"); }
    },
    afterPublish: async (path) => {
      await marker("published-path", path);
      if (fault === "fail") { throw new Error("injected failure after publication"); }
      // Set the foreign mode exactly even when the helper inherits a private umask.
      if (fault === "replace") { await unlink(path); await writeFile(path, "foreign replacement", { mode: 0o644 }); await chmod(path, 0o644); }
    },
    afterEndpoint: async () => {
      ${
        options.holdStartup
          ? `await marker("startup-held", "yes");
      const deadline = Date.now() + 10000;
      for (;;) { let gate = ""; try { gate = await readFile(home + "/startup-gate", "utf8"); } catch {}
        if (gate === "open") break;
        if (gate === "fail" || Date.now() > deadline) throw new Error("startup gate");
        await Bun.sleep(10);
      }`
          : ""
      }
    },
    requestAwaitingStartup: async () => { await appendFile(home + "/startup-waiters", "request\\n"); },
    ${
      options.poolBootEnds
        ? `poolBootCheckMs: 20,
    poolBootEnded: async () => { try { await readFile(home + "/boot-ended", "utf8"); return true; } catch { return false; } },`
        : ""
    }
    verifyIdle: async () => {
      failRelease("idle-verification");
      ${
        options.holdRetirement
          ? `await marker("retire-entered", "yes");
      const deadline = Date.now() + 5000;
      for (;;) { try { if (await readFile(home + "/retire-open", "utf8") === "yes") break; } catch {}
        if (Date.now() > deadline) throw new Error("retirement gate"); await Bun.sleep(10);
      }`
          : ""
      }
    },
  }});
} catch { process.exitCode = 1; }
`,
    { mode: 0o700 }
  );
  const binding: NativeHttpsOwnerBinding = {
    runtime: { home, binary: process.execPath },
    frontend: {
      binary: frontend,
      sha256: await nativeHttpsExecutableSha256(frontend),
    },
    runtimeSha256: "1".repeat(64),
    pool: {
      owner: "a".repeat(32),
      bootId: "12345678-1234-1234-1234-123456789abc",
    },
    caddyBinary: process.execPath,
    caddySha256: "2".repeat(64),
    httpsPort: 19_443,
    certificateNameLimit: 256,
  };
  const sockets: Socket[] = [];
  let pid: number | undefined;
  let socketDirectory: string | undefined;
  cleanups.push(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    if (!pid) {
      try {
        pid = helperPid(await readFile(join(home, "helper-pid"), "utf8"));
      } catch {}
    }
    if (pid) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
      await untilExited(pid);
    }
    if (socketDirectory) {
      await rm(socketDirectory, { recursive: true, force: true });
    }
    await rm(home, { recursive: true, force: true });
  });
  const start = async (independentStarter = false) => {
    let spawned: NativeHttpsSpawnedOwner | undefined;
    if (independentStarter) {
      const starter = Bun.spawn(
        [
          process.execPath,
          "-e",
          `import { ensureNativeHttpsOwner } from ${JSON.stringify(clientModule)}; await ensureNativeHttpsOwner({binding:${JSON.stringify(binding)}});`,
        ],
        { stdout: "ignore", stderr: "pipe" }
      );
      expect(await starter.exited).toBe(0);
    } else {
      await ensureNativeHttpsOwner({
        binding,
        onSpawned: (owner) => {
          spawned = owner;
        },
      });
    }
    pid = await until(async () =>
      helperPid(await readFile(join(home, "helper-pid"), "utf8"))
    );
    const configuration = await readNativeHttpsOwnerConfiguration(
      binding.runtime
    );
    // As production does: the spawner stops waiting once its owner exits.
    const socket = await connectNativeHttpsOwner(configuration, true, spawned);
    sockets.push(socket);
    const endpoint = JSON.parse(
      await readFile(join(nativeHttpsOwnerRoot(home), "endpoint.json"), "utf8")
    ) as { socket: string };
    socketDirectory = resolve(endpoint.socket, "..");
    return { configuration, socket, pid, endpoint };
  };
  const acquire = async (socket: Socket, generation: string, run: string) => {
    const result = await requestNativeHttpsOwner(socket, {
      version: 1,
      operation: "acquire",
      ownerGeneration: generation,
      lease: lease(run),
    });
    return (result as { identity: NativeHttpsLeaseIdentity }).identity;
  };
  const clean = async (run: string) => {
    await writeFile(join(home, `clean-${run.repeat(32)}`), "clean");
  };
  const release = (socket: Socket, identity: NativeHttpsLeaseIdentity) =>
    requestNativeHttpsOwner(socket, {
      version: 1,
      operation: "release",
      identity,
    });
  /** Waits until this fixture's owner has finished its own cleanup and exited. */
  const helperExited = async () =>
    untilExited(
      await until(async () =>
        helperPid(await readFile(join(home, "helper-pid"), "utf8"))
      )
    );
  return {
    home,
    binding,
    sockets,
    start,
    acquire,
    clean,
    release,
    helperExited,
  };
}

/** Historical recovery exercises only private files; neither owner is spawned. */
async function historicalReleaseFixture(sameGeneration = false) {
  const f = await fixture();
  const current = await ensureNativeHttpsOwner({
    binding: {
      ...f.binding,
      runtime: { ...f.binding.runtime, binary: join(f.home, "new-runtime") },
      frontend: {
        binary: join(f.home, "new-frontend"),
        sha256: "3".repeat(64),
      },
      runtimeSha256: "4".repeat(64),
    },
    spawnOwner: async () => {},
  });
  const historical = {
    ...current,
    ownerGeneration: sameGeneration ? current.ownerGeneration : "5".repeat(32),
    binding: f.binding,
  };
  const identity = nativeHttpsLeaseIdentity(historical, lease("b"));
  await nativeHttpsRecordRelease({
    version: 1,
    identity,
    binding: f.binding,
    finalOwner: true,
  });
  const configurationPath = join(
    nativeHttpsOwnerRoot(f.home),
    "configuration.json"
  );
  const releasePath = nativeHttpsLeaseReleasePath(f.home, identity);
  const siblingPath = join(
    nativeHttpsOwnerRoot(f.home),
    "leases",
    "sibling.json"
  );
  await writeFile(siblingPath, "new owner's retained evidence", {
    mode: 0o600,
  });
  const snapshot = () =>
    Promise.all(
      [configurationPath, releasePath, siblingPath].map((path) =>
        readFile(path)
      )
    );
  return { ...f, current, identity, configurationPath, snapshot };
}

test("historical HTTPS release revalidates across a new bundle generation without changing its owner", async () => {
  const f = await historicalReleaseFixture();
  const before = await f.snapshot();
  let verified = 0;
  await recoverNativeHttpsLease({
    runtime: f.binding.runtime,
    identity: f.identity,
    verifyReleased: async (binding, identity, phase) => {
      expect(binding).toEqual(f.binding);
      expect(identity).toEqual(f.identity);
      expect(phase).toBe("release");
      verified += 1;
    },
  });
  expect(verified).toBe(1);
  expect(await f.snapshot()).toEqual(before);
  // Public owner access still requires the current exact executable binding.
  await expect(
    readNativeHttpsOwnerConfiguration(f.binding.runtime)
  ).rejects.toThrow();
  expect(
    await readNativeHttpsOwnerConfiguration(f.current.binding.runtime)
  ).toEqual(f.current);
});

test("explicit prior-boot frontend recovery selects the exact native archive contract", async () => {
  const f = await fixture();
  const old = await ensureNativeHttpsOwner({
    binding: f.binding,
    spawnOwner: async () => {},
  });
  const identity = nativeHttpsLeaseIdentity(old, lease("b"));
  const selectedBinary = join(f.home, "selected-native");
  const callsPath = join(f.home, "native-calls");
  const script = (bootId: string) => `#!/bin/sh
printf '%s\\n' "$*" >> '${callsPath}'
case "$4" in
  status) printf '%s\\n' '${JSON.stringify({ phase: "running", process_alive: true, guest_boot_id: bootId })}' ;;
  archive-previous-boot-shared-https) printf '%s\\n' '${JSON.stringify({ archived: true, run: identity.run, owner_generation: identity.ownerGeneration, lease_id: identity.leaseId, data_retained: true, processes_signaled: 0 })}' ;;
  *) exit 1 ;;
esac
`;
  await writeFile(selectedBinary, script(f.binding.pool.bootId), {
    mode: 0o700,
  });
  const runtime = { home: f.home, binary: selectedBinary };
  await expect(
    recoverNativeHttpsLease({ runtime, identity })
  ).rejects.toThrow();
  await expect(
    recoverNativeHttpsLease({ runtime, identity, archivePreviousBoot: true })
  ).rejects.toThrow();
  expect((await readFile(callsPath, "utf8")).trim().split("\n")).toHaveLength(
    1
  );

  await writeFile(
    selectedBinary,
    script("22222222-2222-2222-2222-222222222222")
  );
  await recoverNativeHttpsLease({
    runtime,
    identity,
    archivePreviousBoot: true,
  });
  const calls = (await readFile(callsPath, "utf8")).trim().split("\n");
  expect(calls).toHaveLength(3);
  expect(calls.at(-1)).toContain(`--run-id ${identity.run}`);
  expect(calls.at(-1)).toContain(
    `--expect-owner-generation ${identity.ownerGeneration}`
  );
  expect(calls.at(-1)).toContain(`--expect-lease-id ${identity.leaseId}`);
  expect(calls.at(-1)).toContain(`--expect-attempt ${identity.attempt}`);
  expect(calls.at(-1)).toContain(`--expect-owner ${identity.owner}`);
  expect(calls.at(-1)).toContain(`--expect-namespace ${identity.namespace}`);
  expect(calls.at(-1)).toContain(`--expect-plan ${identity.planId}`);
});

test("historical HTTPS release refuses a same-generation runtime mismatch before graph verification", async () => {
  const f = await historicalReleaseFixture(true);
  const before = await f.snapshot();
  let verified = false;
  await expect(
    recoverNativeHttpsLease({
      runtime: f.binding.runtime,
      identity: f.identity,
      verifyReleased: async () => {
        verified = true;
      },
    })
  ).rejects.toThrow();
  expect(verified).toBe(false);
  expect(await f.snapshot()).toEqual(before);
});

test.each([
  "malformed",
  "symlink",
  "foreign-home",
] as const)("historical HTTPS release refuses %s current configuration before graph verification", async (fault) => {
  const f = await historicalReleaseFixture();
  if (fault === "symlink") {
    const target = join(f.home, "configuration-target.json");
    await rename(f.configurationPath, target);
    await symlink(target, f.configurationPath);
  } else {
    await writeFile(
      f.configurationPath,
      JSON.stringify(
        fault === "malformed"
          ? {
              ownerGeneration: f.current.ownerGeneration,
            }
          : {
              ...f.current,
              binding: {
                ...f.current.binding,
                runtime: {
                  ...f.current.binding.runtime,
                  home: join(f.home, "foreign"),
                },
              },
            }
      )
    );
  }
  const before = await f.snapshot();
  let verified = false;
  await expect(
    recoverNativeHttpsLease({
      runtime: f.binding.runtime,
      identity: f.identity,
      verifyReleased: async () => {
        verified = true;
      },
    })
  ).rejects.toThrow();
  expect(verified).toBe(false);
  expect(await f.snapshot()).toEqual(before);
  expect((await lstat(f.configurationPath)).isSymbolicLink()).toBe(
    fault === "symlink"
  );
});

test("historical HTTPS release still refuses a dirty graph after a bundle generation change", async () => {
  const f = await historicalReleaseFixture();
  const before = await f.snapshot();
  let verified = false;
  await expect(
    recoverNativeHttpsLease({
      runtime: f.binding.runtime,
      identity: f.identity,
      verifyReleased: async (binding) => {
        expect(binding).toEqual(f.binding);
        verified = true;
        throw new Error("graph restarted");
      },
    })
  ).rejects.toThrow("graph restarted");
  expect(verified).toBe(true);
  expect(await f.snapshot()).toEqual(before);
});

test("an owner whose pool boot ended retires and keeps its lease and configuration for the archive (HACK-2456)", async () => {
  const f = await fixture({ poolBootEnds: true });
  const { configuration, socket, endpoint } = await f.start();
  const identity = await f.acquire(socket, configuration.ownerGeneration, "a");
  const root = nativeHttpsOwnerRoot(f.home);
  // A live boot keeps the owner running.
  await Bun.sleep(100);
  expect(
    (await readFile(join(f.home, "events"), "utf8")).split("\n")
  ).not.toContain("close");
  await writeFile(join(f.home, "boot-ended"), "yes");
  await f.helperExited();
  // The child pair was closed, the socket and its directory retired ...
  expect(
    (await readFile(join(f.home, "events"), "utf8")).split("\n")
  ).toContain("close");
  await expect(lstat(endpoint.socket)).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(lstat(resolve(endpoint.socket, ".."))).rejects.toMatchObject({
    code: "ENOENT",
  });
  // ... and the records the previous-boot archive selects are kept unchanged.
  expect((await readdir(root)).sort()).toEqual([
    "configuration.json",
    "endpoint.json",
    "leases",
  ]);
  expect(await readdir(join(root, "leases"))).toEqual([
    `${identity.leaseId}.json`,
  ]);
  expect(await readNativeHttpsOwnerConfiguration(f.binding.runtime)).toEqual(
    configuration
  );
});

test("detached helper outlives its spawning CLI and first release preserves the second lease", async () => {
  const f = await fixture();
  const first = await f.start(true);
  expect(() => process.kill(first.pid, 0)).not.toThrow();
  const a = await f.acquire(
    first.socket,
    first.configuration.ownerGeneration,
    "b"
  );
  const otherConfiguration = await ensureNativeHttpsOwner({
    binding: f.binding,
    spawnOwner: async () => {
      throw new Error("must reuse");
    },
  });
  const second = await connectNativeHttpsOwner(otherConfiguration);
  f.sockets.push(second);
  const b = await f.acquire(second, otherConfiguration.ownerGeneration, "c");
  await f.clean("b");
  await f.release(first.socket, a);
  expect(await readFile(join(f.home, "events"), "utf8")).toBe("start\n");
  expect(() => process.kill(first.pid, 0)).not.toThrow();
  await f.clean("c");
  await f.release(second, b);
  await until(async () => {
    await expect(lstat(nativeHttpsOwnerRoot(f.home))).rejects.toThrow();
    return true;
  });
  expect(await readFile(join(f.home, "events"), "utf8")).toBe("start\nclose\n");
}, 20_000);

test("disconnect retains the lease; recovery refuses dirty graph and retires only after proof", async () => {
  const f = await fixture();
  const started = await f.start();
  const identity = await f.acquire(
    started.socket,
    started.configuration.ownerGeneration,
    "b"
  );
  started.socket.destroy();
  const path = join(
    nativeHttpsOwnerRoot(f.home),
    "leases",
    `${identity.leaseId}.json`
  );
  expect(await readFile(path, "utf8")).toContain(identity.leaseId);
  await expect(
    recoverNativeHttpsLease({ runtime: f.binding.runtime, identity })
  ).rejects.toThrow();
  expect(await readFile(join(f.home, "events"), "utf8")).toBe("start\n");
  await f.clean("b");
  await recoverNativeHttpsLease({ runtime: f.binding.runtime, identity });
  expect(await readFile(join(f.home, "events"), "utf8")).toBe("start\nclose\n");
}, 20_000);

test("last release tombstone survives helper exit and permits fresh cleanup-verified recovery", async () => {
  const f = await fixture();
  const started = await f.start();
  const identity = await f.acquire(
    started.socket,
    started.configuration.ownerGeneration,
    "b"
  );
  await f.clean("b");
  await f.release(started.socket, identity);
  await until(async () => {
    await expect(lstat(nativeHttpsOwnerRoot(f.home))).rejects.toThrow();
    return true;
  });
  expect((await nativeHttpsReadRelease(f.home, identity)).finalOwner).toBe(
    true
  );
  let checked = 0;
  await recoverNativeHttpsLease({
    runtime: f.binding.runtime,
    identity,
    verifyReleased: async (_binding, selected, phase) => {
      expect(selected).toEqual(identity);
      expect(phase).toBe("release");
      checked += 1;
    },
  });
  expect(checked).toBe(1);
  const unadmitted = nativeHttpsLeaseIdentity(
    started.configuration,
    lease("c")
  );
  await recoverNativeHttpsLease({
    runtime: f.binding.runtime,
    identity: unadmitted,
    verifyReleased: async (_binding, selected, phase) => {
      expect(selected).toEqual(unadmitted);
      expect(phase).toBe("release");
    },
  });
  await expect(
    recoverNativeHttpsLease({
      runtime: f.binding.runtime,
      identity: { ...unadmitted, planId: "d".repeat(64) },
      verifyReleased: async () => {
        throw new Error("must refuse before proof");
      },
    })
  ).rejects.toThrow();
  await expect(
    recoverNativeHttpsLease({
      runtime: f.binding.runtime,
      identity,
      verifyReleased: async () => {
        throw new Error("graph restarted");
      },
    })
  ).rejects.toThrow();
}, 20_000);

test("exact undelivered acquire intent is recoverable without guessing admission", async () => {
  const f = await fixture();
  const started = await f.start();
  const intended = nativeHttpsLeaseIdentity(started.configuration, lease("b"));
  await f.clean("b");
  await f.release(started.socket, intended);
  expect((await nativeHttpsReadRelease(f.home, intended)).finalOwner).toBe(
    true
  );
  expect(await readFile(join(f.home, "events"), "utf8")).toBe("start\nclose\n");
}, 20_000);

test("released attempt cannot be resurrected by a delayed acquire while sibling remains", async () => {
  const f = await fixture();
  const started = await f.start();
  const a = await f.acquire(
    started.socket,
    started.configuration.ownerGeneration,
    "b"
  );
  const intentSocket = await connectNativeHttpsOwner(started.configuration);
  f.sockets.push(intentSocket);
  const canceled = nativeHttpsLeaseIdentity(started.configuration, lease("c"));
  await f.clean("c");
  await f.release(intentSocket, canceled);
  const delayed = await connectNativeHttpsOwner(started.configuration);
  f.sockets.push(delayed);
  await expect(
    f.acquire(delayed, started.configuration.ownerGeneration, "c")
  ).rejects.toThrow();
  expect(await readFile(join(f.home, "events"), "utf8")).toBe("start\n");
  await f.clean("b");
  await f.release(started.socket, a);
}, 20_000);

test("serialized last release refuses an acquire queued during retirement", async () => {
  const f = await fixture({ holdRetirement: true });
  const started = await f.start();
  const identity = await f.acquire(
    started.socket,
    started.configuration.ownerGeneration,
    "b"
  );
  const joining = await connectNativeHttpsOwner(started.configuration);
  f.sockets.push(joining);
  await f.clean("b");
  const released = f.release(started.socket, identity);
  void released.catch(() => {});
  await until(() => readFile(join(f.home, "retire-entered"), "utf8"));
  const intent = nativeHttpsLeaseIdentity(started.configuration, lease("c"));
  const acquired = f.acquire(
    joining,
    started.configuration.ownerGeneration,
    "c"
  );
  void acquired.catch(() => {});
  await writeFile(join(f.home, "retire-open"), "yes");
  await released;
  await expect(acquired).rejects.toThrow();
  expect(await readFile(join(f.home, "events"), "utf8")).toBe("start\nclose\n");
  const recover = () =>
    recoverNativeHttpsLease({
      runtime: f.binding.runtime,
      identity: intent,
      verifyReleased: async (_binding, selected, phase) => {
        expect(selected).toEqual(intent);
        expect(phase).toBe("release");
        expect(
          await readFile(join(f.home, `clean-${intent.run}`), "utf8")
        ).toBe("clean");
      },
    });
  await expect(recover()).rejects.toThrow();
  await f.clean("c");
  await recover();
  const replacement = await f.start();
  expect(replacement.configuration.ownerGeneration).not.toBe(
    started.configuration.ownerGeneration
  );
  const next = await f.acquire(
    replacement.socket,
    replacement.configuration.ownerGeneration,
    "c"
  );
  await f.release(replacement.socket, next);
}, 20_000);

test("tombstone plus active lease retries native cleanup proof without rewriting ownership", async () => {
  const f = await fixture();
  const started = await f.start();
  const identity = await f.acquire(
    started.socket,
    started.configuration.ownerGeneration,
    "b"
  );
  await nativeHttpsRecordRelease({
    version: 1,
    identity,
    binding: f.binding,
    finalOwner: false,
  });
  await expect(
    recoverNativeHttpsLease({ runtime: f.binding.runtime, identity })
  ).rejects.toThrow();
  await f.clean("b");
  await recoverNativeHttpsLease({ runtime: f.binding.runtime, identity });
  expect(await readFile(join(f.home, "events"), "utf8")).toBe("start\nclose\n");
}, 20_000);

test("oversized real socket frame is refused without preventing a later valid lease", async () => {
  const f = await fixture();
  const started = await f.start();
  const closed = new Promise<void>((resolveClosed) =>
    started.socket.once("close", () => resolveClosed())
  );
  started.socket.write(Buffer.alloc(8193, 65));
  await closed;
  const next = await connectNativeHttpsOwner(started.configuration);
  f.sockets.push(next);
  const identity = await f.acquire(
    next,
    started.configuration.ownerGeneration,
    "b"
  );
  await f.clean("b");
  await f.release(next, identity);
}, 20_000);

test("child exit during startup never publishes a reusable running endpoint", async () => {
  const f = await fixture({ immediateExit: true });
  await ensureNativeHttpsOwner({ binding: f.binding });
  await until(async () => {
    expect(await readFile(join(f.home, "events"), "utf8")).toBe(
      "start\nclose\n"
    );
    return true;
  });
  // "close" is logged while the listener and its temporary socket directory
  // are still being retired; the owner exits only once that has finished.
  await f.helperExited();
  await expect(
    lstat(join(nativeHttpsOwnerRoot(f.home), "endpoint.json"))
  ).rejects.toThrow();
  const configuration = await readNativeHttpsOwnerConfiguration(
    f.binding.runtime
  );
  await expect(connectNativeHttpsOwner(configuration, false)).rejects.toThrow();
}, 20_000);

/**
 * endpoint.json is visible before the owner records that it runs, so a fresh
 * owner's first client can deliver its request inside that window. Hold the
 * owner there and release it only once the request is known to be waiting.
 */
async function requestDuringStartup(run: string) {
  const f = await fixture({ holdStartup: true });
  const started = await f.start();
  // The endpoint is linked before the hold begins, so wait for the hold itself.
  await untilText(join(f.home, "startup-held"), "yes");
  const acquired = f.acquire(
    started.socket,
    started.configuration.ownerGeneration,
    run
  );
  void acquired.catch(() => {});
  await Promise.race([
    untilText(join(f.home, "startup-waiters"), "request\n"),
    acquired.then(() => {
      throw new Error("acquire was answered before startup settled");
    }),
  ]);
  expect(await readFile(join(f.home, "startup-waiters"), "utf8")).toBe(
    "request\n"
  );
  const leases = join(nativeHttpsOwnerRoot(f.home), "leases");
  expect(await readdir(leases)).toEqual([]);
  return { f, started, acquired, leases };
}

test("a first request delivered before a fresh owner records running waits and is admitted", async () => {
  const { f, started, acquired, leases } = await requestDuringStartup("b");
  await writeFile(join(f.home, "startup-gate"), "open");
  const identity = await acquired;
  expect(identity).toEqual(
    nativeHttpsLeaseIdentity(started.configuration, lease("b"))
  );
  expect(await readdir(leases)).toEqual([`${identity.leaseId}.json`]);
  await f.clean("b");
  await f.release(started.socket, identity);
  expect(await readFile(join(f.home, "events"), "utf8")).toBe("start\nclose\n");
}, 20_000);

test("a first request waiting on a startup that then fails is refused without admitting a lease", async () => {
  const { f, started, acquired, leases } = await requestDuringStartup("b");
  await writeFile(join(f.home, "startup-gate"), "fail");
  await expect(acquired).rejects.toThrow(
    "ownership is unavailable or unconfirmed"
  );
  expect(await readdir(leases)).toEqual([]);
  await expect(
    recoverNativeHttpsLease({
      runtime: f.binding.runtime,
      identity: nativeHttpsLeaseIdentity(started.configuration, lease("b")),
      verifyReleased: async () => {
        throw new Error("must refuse before proof");
      },
    })
  ).rejects.toThrow("endpoint-publication");
  // Clients are disconnected before the frontend pair closes; the owner exits
  // only after its failure cleanup has finished.
  await untilExited(started.pid);
  expect(await readFile(join(f.home, "events"), "utf8")).toBe("start\nclose\n");
}, 20_000);

test("a failure or replacement right after publication closes the listener and retires only its own endpoint", async () => {
  for (const fault of ["fail", "replace"] as const) {
    const f = await fixture({ afterPublish: fault });
    await ensureNativeHttpsOwner({ binding: f.binding });
    const published = await until(() =>
      readFile(join(f.home, "published-path"), "utf8")
    );
    const pid = await until(async () =>
      helperPid(await readFile(join(f.home, "helper-pid"), "utf8"))
    );
    // The owner exits: a listener left open would keep it running.
    await untilExited(pid);
    await expect(
      lstat(join(nativeHttpsOwnerRoot(f.home), "endpoint.json"))
    ).rejects.toThrow();
    if (fault === "fail") {
      // Its own endpoint and private socket directory are gone.
      await expect(lstat(published)).rejects.toThrow();
      await expect(lstat(dirname(published))).rejects.toThrow();
    } else {
      // The replacement is kept exactly: never removed, adopted or chmodded.
      const stat = await lstat(published);
      expect(stat.isFile()).toBe(true);
      expect(stat.mode & 0o777).toBe(0o644);
      expect(await readFile(published, "utf8")).toBe("foreign replacement");
      await rm(dirname(published), { recursive: true, force: true });
    }
  }
  // A later owner starts and serves normally.
  const f = await fixture();
  const started = await f.start();
  const identity = await f.acquire(
    started.socket,
    started.configuration.ownerGeneration,
    "b"
  );
  await f.clean("b");
  await f.release(started.socket, identity);
}, 40_000);

test("dead helper and mismatched generation or binary binding are never adopted", async () => {
  const f = await fixture();
  const started = await f.start();
  const identity = await f.acquire(
    started.socket,
    started.configuration.ownerGeneration,
    "b"
  );
  for (const changed of [
    { ...f.binding, httpsPort: 19_444 },
    {
      ...f.binding,
      frontend: { ...f.binding.frontend, sha256: "9".repeat(64) },
    },
    {
      ...f.binding,
      pool: {
        ...f.binding.pool,
        bootId: "87654321-1234-1234-1234-123456789abc",
      },
    },
  ]) {
    await expect(
      ensureNativeHttpsOwner({ binding: changed })
    ).rejects.toThrow();
  }
  await expect(
    recoverNativeHttpsLease({
      runtime: f.binding.runtime,
      identity: { ...identity, ownerGeneration: "9".repeat(32) },
    })
  ).rejects.toThrow();
  process.kill(started.pid, "SIGKILL");
  await pause(50);
  await expect(
    recoverNativeHttpsLease({ runtime: f.binding.runtime, identity })
  ).rejects.toThrow();
  let launched = false;
  await ensureNativeHttpsOwner({
    binding: f.binding,
    spawnOwner: async () => {
      launched = true;
    },
  });
  expect(launched).toBe(false);
  expect(
    await readFile(
      join(nativeHttpsOwnerRoot(f.home), "leases", `${identity.leaseId}.json`),
      "utf8"
    )
  ).toContain(identity.leaseId);
}, 20_000);

test("replacement lease receipt and socket are preserved on release refusal", async () => {
  const f = await fixture();
  const started = await f.start();
  const identity = await f.acquire(
    started.socket,
    started.configuration.ownerGeneration,
    "b"
  );
  await f.clean("b");
  const path = join(
    nativeHttpsOwnerRoot(f.home),
    "leases",
    `${identity.leaseId}.json`
  );
  await rename(path, `${path}.old`);
  await writeFile(path, JSON.stringify(identity), { mode: 0o600 });
  await expect(f.release(started.socket, identity)).rejects.toThrow();
  expect(await readFile(path, "utf8")).toBe(JSON.stringify(identity));
  const g = await fixture();
  const other = await g.start();
  const otherIdentity = await g.acquire(
    other.socket,
    other.configuration.ownerGeneration,
    "c"
  );
  await g.clean("c");
  await rename(other.endpoint.socket, `${other.endpoint.socket}.old`);
  await writeFile(other.endpoint.socket, "replacement", { mode: 0o600 });
  await expect(g.release(other.socket, otherIdentity)).rejects.toThrow();
  expect(await readFile(other.endpoint.socket, "utf8")).toBe("replacement");
}, 20_000);

test("native release proof rejects live compute, pending journals, bridges, and foreign graph identity", async () => {
  const binding = {
    runtime: { home: "/unused", binary: "/unused/native" },
    pool: { owner: "a".repeat(32), bootId: "boot" },
  } as NativeHttpsOwnerBinding;
  const selected = lease("b");
  const graph = {
    journal_incomplete: false,
    receipt: {
      run: selected.run,
      owner: binding.pool.owner,
      namespace: selected.namespace,
      plan_id: selected.planId,
      phase: "stopped-data-retained",
      resources: { "container:web": { kind: "container" } },
    },
    observations: { "container:web": { state: "absent" } },
  };
  let changed: unknown = graph;
  let bridges: unknown = { run: selected.run, slots: {} };
  const invoke: typeof invokeNativeRuntime = async ({ args }) => {
    if (args[1] === "status") {
      return { phase: "running", process_alive: true, guest_boot_id: "boot" };
    }
    if (args[1] === "inspect") {
      return changed;
    }
    if (args[1] === "bridges") {
      return bridges;
    }
    return { scope: "durable-ownership-only", claims: [] };
  };
  await verifyNativeHttpsLeaseGraph(binding, selected, "release", invoke);
  for (const value of [
    { ...graph, journal_incomplete: true },
    { ...graph, observations: { "container:web": { state: "present" } } },
    { ...graph, receipt: { ...graph.receipt, owner: "c".repeat(32) } },
    { ...graph, receipt: { ...graph.receipt, phase: "ready-observed" } },
  ]) {
    changed = value;
    await expect(
      verifyNativeHttpsLeaseGraph(binding, selected, "release", invoke)
    ).rejects.toThrow();
  }
  changed = graph;
  bridges = { run: selected.run, slots: { 0: {} } };
  await expect(
    verifyNativeHttpsLeaseGraph(binding, selected, "release", invoke)
  ).rejects.toThrow();
});

/**
 * HACK-2669 rows 1, 3 and 4, HACK-2708 and HACK-2709: every leased read the
 * shared owner makes for an acquire or a release refused `provider_busy` at
 * once whenever a command (or the ready owner's own restart tick) held the
 * provider lease at that moment. The frontend then stopped the whole run (a
 * refused acquire) or exited 1 (an unconfirmed release). The reads now wait out
 * contention inside one bound, retry nothing else, and still refuse a lasting
 * holder with its own refusal.
 */
describe("shared HTTPS graph verification and provider-lease contention", () => {
  const binding = {
    runtime: { home: "/unused", binary: "/unused/native" },
    pool: { owner: "a".repeat(32), bootId: "boot" },
  } as NativeHttpsOwnerBinding;
  const selected = lease("b");
  const receipt = (phase: string) => ({
    journal_incomplete: false,
    receipt: {
      run: selected.run,
      owner: binding.pool.owner,
      namespace: selected.namespace,
      plan_id: selected.planId,
      phase,
      resources: { "container:web": { kind: "container" } },
    },
    observations: {
      "container:web": {
        state: phase === "ready-observed" ? "running" : "absent",
      },
    },
  });
  const holder =
    "Provider lease acquisition refused; recorded holder: exec; no operation was admitted.";
  const busy = () =>
    new NativeRuntimeRequestError({
      message: holder,
      nativeCode: "provider_busy",
    });
  /** The leased reads refuse while `held()`; the record of every call is kept. */
  function contended(phase: string, held: () => boolean) {
    const calls: string[] = [];
    const invoke: typeof invokeNativeRuntime = async ({ args }) => {
      const name = `${args[0]} ${args[1]}`;
      calls.push(name);
      if (args[1] === "status") {
        return { phase: "running", process_alive: true, guest_boot_id: "boot" };
      }
      if (held()) {
        throw busy();
      }
      if (args[1] === "inspect") {
        return receipt(phase);
      }
      if (args[1] === "bridges") {
        return { run: selected.run, slots: {} };
      }
      return { scope: "durable-ownership-only", claims: [] };
    };
    return { invoke, calls };
  }

  test("an acquire at the ready line waits out a briefly held lease", async () => {
    const until = performance.now() + 300;
    const { invoke, calls } = contended(
      "ready-observed",
      () => performance.now() < until
    );
    const started = performance.now();
    await verifyNativeHttpsLeaseGraph(binding, selected, "acquire", invoke);
    expect(performance.now() - started).toBeGreaterThanOrEqual(250);
    // Only the refused read was retried; status ran once.
    expect(calls.filter((call) => call === "runtime status")).toHaveLength(1);
    expect(
      calls.filter((call) => call === "graph inspect").length
    ).toBeGreaterThan(1);
  });

  test("a release after a stop waits out a command that took the lease", async () => {
    let refusals = 0;
    const { invoke, calls } = contended("stopped-data-retained", () => {
      refusals += 1;
      // Each leased read is refused twice before the command lets go.
      return refusals % 3 !== 0;
    });
    await verifyNativeHttpsLeaseGraph(binding, selected, "release", invoke);
    expect(calls).toContain("graph bridges");
    expect(calls).toContain("runtime publication-hostnames");
  });

  test("the idle check before retirement waits out a briefly held lease", async () => {
    const until = performance.now() + 200;
    const { invoke } = contended("stopped-data-retained", () => {
      return performance.now() < until;
    });
    await verifyNativeHttpsOwnerIdle(binding, invoke);
  });

  test("a lasting holder is still refused, with its own refusal", async () => {
    const { invoke } = contended("ready-observed", () => true);
    const started = performance.now();
    const failure = await verifyNativeHttpsLeaseGraph(
      binding,
      selected,
      "acquire",
      invoke,
      { busyWaitMs: 300 }
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(NativeRuntimeRequestError);
    expect((failure as Error).message).toBe(holder);
    expect(performance.now() - started).toBeGreaterThanOrEqual(250);
    expect(performance.now() - started).toBeLessThan(5000);
    await expect(
      verifyNativeHttpsOwnerIdle(binding, invoke, { busyWaitMs: 100 })
    ).rejects.toThrow(holder);
  });

  test("the owner's shutdown ends a wait at once", async () => {
    const { invoke } = contended("ready-observed", () => true);
    const stopping = new AbortController();
    setTimeout(() => stopping.abort(), 150);
    const started = performance.now();
    await expect(
      verifyNativeHttpsLeaseGraph(binding, selected, "acquire", invoke, {
        signal: stopping.signal,
      })
    ).rejects.toThrow(holder);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  test("a refusal after acquisition is never retried", async () => {
    let inspections = 0;
    const invoke: typeof invokeNativeRuntime = async ({ args }) => {
      if (args[1] === "status") {
        return { phase: "running", process_alive: true, guest_boot_id: "boot" };
      }
      inspections += 1;
      throw new NativeRuntimeRequestError({
        message: "graph_owner_recovery",
        nativeCode: "graph_owner_recovery",
      });
    };
    await expect(
      verifyNativeHttpsLeaseGraph(binding, selected, "acquire", invoke)
    ).rejects.toThrow("graph_owner_recovery");
    expect(inspections).toBe(1);
  });
});

test("detached startup failure reports only its generation-bound diagnostic and refuses recovery", async () => {
  const f = await fixture({ startFailure: true });
  await expect(f.start()).rejects.toThrow("frontend-start: provider_busy");
  const configuration = await readNativeHttpsOwnerConfiguration(
    f.binding.runtime
  );
  const root = nativeHttpsOwnerRoot(f.home);
  const diagnostic = await readFile(join(root, "startup-failure.json"), "utf8");
  expect(diagnostic).not.toContain("private child output");
  expect(diagnostic).not.toContain(f.home);
  expect(await readFile(join(f.home, "events"), "utf8")).toBe("start\n");
  let verified = false;
  await expect(
    recoverNativeHttpsLease({
      runtime: f.binding.runtime,
      identity: nativeHttpsLeaseIdentity(configuration, lease("b")),
      verifyReleased: async () => {
        verified = true;
      },
    })
  ).rejects.toThrow("frontend-start: provider_busy");
  expect(verified).toBe(false);
  expect(await readFile(join(root, "startup-failure.json"), "utf8")).toBe(
    diagnostic
  );
  await expect(readFile(join(root, "endpoint.json"))).rejects.toThrow();
  // The failure is recorded before the owner removes its temporary socket directory.
  await f.helperExited();
});

/**
 * #1260 review, M3: a `hack down` whose graph stop holds the provider lease
 * longer than the authority's 30 s wait made the shared owner's startup fail
 * (`authority-ready: provider_busy`). That failure was retained, so the
 * frontend's recovery of its lease was refused (`down` exited 1) and the next
 * acquisition found the failed generation (the next `up` needed recovery).
 */
test("a startup that admitted nothing is retired by its lease recovery, and the next owner starts", async () => {
  const f = await fixture({ authorityBusy: "confirmed" });
  await expect(f.start()).rejects.toThrow("authority-ready: provider_busy");
  const configuration = await readNativeHttpsOwnerConfiguration(
    f.binding.runtime
  );
  const root = nativeHttpsOwnerRoot(f.home);
  const recorded = await readFile(join(root, "startup-failure.json"), "utf8");
  await f.helperExited();
  const identity = nativeHttpsLeaseIdentity(configuration, lease("b"));
  const verified: string[] = [];
  const verifyReleased: typeof verifyNativeHttpsLeaseGraph = async (
    binding,
    verifiedLease,
    phase
  ) => {
    expect(binding).toEqual(configuration.binding);
    expect(verifiedLease).toEqual(identity);
    verified.push(phase);
  };
  await recoverNativeHttpsLease({
    runtime: f.binding.runtime,
    identity,
    verifyReleased,
  });
  // The release is still verified through the graph, as for a retired owner.
  expect(verified).toEqual(["release"]);
  await expect(lstat(root)).rejects.toThrow("ENOENT");
  expect(
    await nativeHttpsReadRetiredOwner(f.home, configuration.ownerGeneration)
  ).toEqual(configuration);
  // The whole failed owner root is kept beside the retired record as evidence.
  const evidence = join(
    f.home,
    "native-https",
    "released-leases",
    configuration.ownerGeneration,
    "failed-owner"
  );
  expect(await readFile(join(evidence, "startup-failure.json"), "utf8")).toBe(
    recorded
  );
  expect(
    JSON.parse(await readFile(join(evidence, "configuration.json"), "utf8"))
  ).toEqual(configuration);
  // Repeating the recovery (another lifetime of the same generation, or `down`
  // after the frontend) verifies again and changes nothing.
  await recoverNativeHttpsLease({
    runtime: f.binding.runtime,
    identity,
    verifyReleased,
  });
  expect(verified).toEqual(["release", "release"]);
  // The next `up` creates a new owner generation instead of finding the failure.
  const next = await ensureNativeHttpsOwner({
    binding: f.binding,
    spawnOwner: async () => undefined,
  });
  expect(next.ownerGeneration).not.toBe(configuration.ownerGeneration);
});

/**
 * The retirement has two durable steps: the retired-owner record, then one
 * rename of the whole root. A crash at any point must leave a state the next
 * recovery finishes, never a root whose failure record is gone (every later
 * `up` would then wait for an endpoint that never comes).
 */
test("an interrupted retirement is finished by the next recovery", async () => {
  const f = await fixture({ authorityBusy: "confirmed" });
  await expect(f.start()).rejects.toThrow("authority-ready: provider_busy");
  const configuration = await readNativeHttpsOwnerConfiguration(
    f.binding.runtime
  );
  await f.helperExited();
  const root = nativeHttpsOwnerRoot(f.home);
  const identity = nativeHttpsLeaseIdentity(configuration, lease("b"));
  let verified = 0;
  const recover = () =>
    recoverNativeHttpsLease({
      runtime: f.binding.runtime,
      identity,
      verifyReleased: async () => {
        verified += 1;
      },
    });
  // Interrupted after step 1: the retired record exists, the root is intact.
  await nativeHttpsRecordRetiredOwner(configuration);
  expect(await readFile(join(root, "startup-failure.json"), "utf8")).toContain(
    "authority-ready"
  );
  await recover();
  expect(verified).toBe(1);
  await expect(lstat(root)).rejects.toThrow("ENOENT");
  const evidence = join(
    f.home,
    "native-https",
    "released-leases",
    configuration.ownerGeneration,
    "failed-owner"
  );
  expect((await readdir(evidence)).sort()).toEqual([
    "configuration.json",
    "leases",
    "startup-failure.json",
  ]);
  // Interrupted after step 2 (the rename): nothing is left to resume.
  await recover();
  expect(verified).toBe(2);
  const next = await ensureNativeHttpsOwner({
    binding: f.binding,
    spawnOwner: async () => undefined,
  });
  expect(next.ownerGeneration).not.toBe(configuration.ownerGeneration);
});

/**
 * A connector that read a configuration must not wait out the whole startup
 * budget once that owner is gone (retired, or replaced by a new generation):
 * it will never publish an endpoint. Only a missing endpoint is waited for.
 */
test("a connector refuses at once when its owner's configuration is gone or replaced", async () => {
  const f = await fixture();
  const stub = { spawnOwner: async () => undefined };
  const configuration = await ensureNativeHttpsOwner({
    binding: f.binding,
    ...stub,
  });
  const root = nativeHttpsOwnerRoot(f.home);
  await rm(root, { recursive: true });
  let started = performance.now();
  await expect(connectNativeHttpsOwner(configuration)).rejects.toThrow(
    "Shared native HTTPS ownership is unavailable"
  );
  expect(performance.now() - started).toBeLessThan(2000);
  const replacement = await ensureNativeHttpsOwner({
    binding: f.binding,
    ...stub,
  });
  expect(replacement.ownerGeneration).not.toBe(configuration.ownerGeneration);
  started = performance.now();
  await expect(connectNativeHttpsOwner(configuration)).rejects.toThrow(
    "Shared native HTTPS ownership is unavailable"
  );
  expect(performance.now() - started).toBeLessThan(2000);
});

test("a startup failure with unconfirmed child cleanup stays retained and refuses recovery", async () => {
  const f = await fixture({ authorityBusy: "unconfirmed" });
  await expect(f.start()).rejects.toThrow("child cleanup unconfirmed");
  const configuration = await readNativeHttpsOwnerConfiguration(
    f.binding.runtime
  );
  await f.helperExited();
  let verified = false;
  await expect(
    recoverNativeHttpsLease({
      runtime: f.binding.runtime,
      identity: nativeHttpsLeaseIdentity(configuration, lease("b")),
      verifyReleased: async () => {
        verified = true;
      },
    })
  ).rejects.toThrow("authority-ready: provider_busy");
  expect(verified).toBe(false);
  const root = nativeHttpsOwnerRoot(f.home);
  await expect(
    readFile(join(root, "startup-failure.json"), "utf8")
  ).resolves.toContain("authority-ready");
  await expect(
    nativeHttpsReadRetiredOwner(f.home, configuration.ownerGeneration)
  ).rejects.toThrow("ENOENT");
});

/**
 * #1260 review, M2: owner startup can take about 40 s (the authority's lease
 * wait plus readiness), but a connector that found the configuration instead
 * of spawning the owner gave up after 15 s: its run was aborted and its
 * recovery ended unconfirmed. Every connector now waits for the whole startup.
 */
test("a second connector waits for a slow owner startup as long as the spawner does", async () => {
  const f = await fixture({ startDelayMs: 16_000 });
  let spawned: NativeHttpsSpawnedOwner | undefined;
  const configuration = await ensureNativeHttpsOwner({
    binding: f.binding,
    onSpawned: (owner) => {
      spawned = owner;
    },
  });
  expect(spawned).toBeDefined();
  // The second project finds the configuration; it spawns nothing.
  const joined = await ensureNativeHttpsOwner({
    binding: f.binding,
    spawnOwner: async () => {
      throw new Error("the second connector must not spawn an owner");
    },
  });
  expect(joined).toEqual(configuration);
  const started = performance.now();
  const [first, second] = await Promise.all([
    connectNativeHttpsOwner(configuration, true, spawned),
    connectNativeHttpsOwner(joined),
  ]);
  f.sockets.push(first, second);
  expect(performance.now() - started).toBeGreaterThan(15_000);
  const endpoint = JSON.parse(
    await readFile(join(nativeHttpsOwnerRoot(f.home), "endpoint.json"), "utf8")
  ) as { socket: string };
  cleanups.push(async () => {
    await rm(dirname(endpoint.socket), { recursive: true, force: true });
  });
  const a = await requestNativeHttpsOwner(first, {
    version: 1,
    operation: "acquire",
    ownerGeneration: configuration.ownerGeneration,
    lease: lease("b"),
  });
  const b = await requestNativeHttpsOwner(second, {
    version: 1,
    operation: "acquire",
    ownerGeneration: configuration.ownerGeneration,
    lease: lease("c"),
  });
  expect(a).toMatchObject({ ok: true });
  expect(b).toMatchObject({ ok: true });
}, 40_000);

test("helper exit without a failure receipt remains unknown and cannot authorize recovery", async () => {
  const f = await fixture({ hardExit: true });
  await expect(f.start()).rejects.toThrow("ENOENT");
  const configuration = await readNativeHttpsOwnerConfiguration(
    f.binding.runtime
  );
  const before = await readFile(
    join(nativeHttpsOwnerRoot(f.home), "configuration.json")
  );
  let verified = false;
  await expect(
    recoverNativeHttpsLease({
      runtime: f.binding.runtime,
      identity: nativeHttpsLeaseIdentity(configuration, lease("b")),
      verifyReleased: async () => {
        verified = true;
      },
    })
  ).rejects.toThrow("ENOENT");
  expect(verified).toBe(false);
  expect(
    await readFile(join(nativeHttpsOwnerRoot(f.home), "configuration.json"))
  ).toEqual(before);
  await expect(
    readFile(join(nativeHttpsOwnerRoot(f.home), "startup-failure.json"))
  ).rejects.toThrow();
}, 25_000);
test.each([
  "graph-verification",
  "idle-verification",
] as const)("release %s failure preserves evidence and reports a safe code without acknowledgement", async (stage) => {
  const f = await fixture({ releaseFault: stage });
  const started = await f.start();
  const identity = await f.acquire(
    started.socket,
    started.configuration.ownerGeneration,
    "b"
  );
  await f.clean("b");
  const root = nativeHttpsOwnerRoot(f.home);
  const paths = [
    join(root, "configuration.json"),
    join(root, "endpoint.json"),
    join(root, "leases", `${identity.leaseId}.json`),
  ];
  const before = await Promise.all(paths.map((path) => readFile(path)));
  await expect(f.release(started.socket, identity)).rejects.toThrow(
    `${stage}: provider_busy`
  );
  expect(await Promise.all(paths.map((path) => readFile(path)))).toEqual(
    before
  );
  expect(await readFile(join(f.home, "events"), "utf8")).toBe("start\n");
  expect(await readFile(join(f.home, "release-verifies"), "utf8")).toBe(
    "verify\n"
  );
  expect(
    await Bun.file(nativeHttpsLeaseReleasePath(f.home, identity)).exists()
  ).toBe(false);
});

test("foreign release identity is refused before verification and leaves the exact lease intact", async () => {
  const f = await fixture();
  const started = await f.start();
  const identity = await f.acquire(
    started.socket,
    started.configuration.ownerGeneration,
    "b"
  );
  const leasePath = join(
    nativeHttpsOwnerRoot(f.home),
    "leases",
    `${identity.leaseId}.json`
  );
  const before = await readFile(leasePath);
  await expect(
    f.release(started.socket, { ...identity, attempt: "c".repeat(32) })
  ).rejects.toThrow("lease-validation");
  expect(await readFile(leasePath)).toEqual(before);
  expect(await Bun.file(join(f.home, "release-verifies")).exists()).toBe(false);
  expect(
    await Bun.file(nativeHttpsLeaseReleasePath(f.home, identity)).exists()
  ).toBe(false);
  expect(await readFile(join(f.home, "events"), "utf8")).toBe("start\n");
});

test("extra release request data is refused without verification or changing the lease", async () => {
  const f = await fixture();
  const started = await f.start();
  const identity = await f.acquire(
    started.socket,
    started.configuration.ownerGeneration,
    "b"
  );
  const path = join(
    nativeHttpsOwnerRoot(f.home),
    "leases",
    `${identity.leaseId}.json`
  );
  const before = await readFile(path);
  await expect(
    requestNativeHttpsOwner(started.socket, {
      version: 1,
      operation: "release",
      identity,
      extra: "secret-CANARY",
    })
  ).rejects.toThrow("ownership is unavailable or unconfirmed");
  expect(await readFile(path)).toEqual(before);
  expect(await Bun.file(join(f.home, "release-verifies")).exists()).toBe(false);
  expect(await readFile(join(f.home, "events"), "utf8")).toBe("start\n");
});

/**
 * HACK-2720: a ready owner killed outright (`kill -9`). Its lease could never be
 * released or recovered, so `hack down` failed with "unavailable or
 * unconfirmed" and the next `up -d` refused `E_RECOVERY_REQUIRED`. These run the
 * real owner process and kill it; the child pair and the pool boot are stand-ins
 * (`exitedOwner`), and the owner-process check is the production one.
 */
describe("a shared owner that exited while serving", () => {
  async function killedOwner() {
    const f = await fixture();
    const started = await f.start();
    const identity = await f.acquire(
      started.socket,
      started.configuration.ownerGeneration,
      "b"
    );
    await f.clean("b");
    const configurationPath = join(
      nativeHttpsOwnerRoot(f.home),
      "configuration.json"
    );
    // The production check sees the live owner by its exact invocation.
    expect(await nativeHttpsOwnerInvocationRunning({ configurationPath })).toBe(
      true
    );
    process.kill(started.pid, "SIGKILL");
    await f.helperExited();
    expect(await nativeHttpsOwnerInvocationRunning({ configurationPath })).toBe(
      false
    );
    const children: unknown[] = [];
    const verified: string[] = [];
    const recover = (
      exitedOwner: Parameters<
        typeof recoverNativeHttpsLease
      >[0]["exitedOwner"] = {}
    ) =>
      recoverNativeHttpsLease({
        runtime: f.binding.runtime,
        identity,
        verifyReleased: async (binding, verifiedLease, phase) => {
          expect(binding).toEqual(started.configuration.binding);
          expect(verifiedLease).toEqual(identity);
          verified.push(phase);
        },
        exitedOwner: {
          poolBoot: async () => f.binding.pool.bootId,
          retireChildren: async (opts) => {
            children.push(opts);
          },
          ...exitedOwner,
        },
      });
    const retained = async () => ({
      configuration: await readFile(configurationPath, "utf8"),
      lease: await readFile(
        join(
          nativeHttpsOwnerRoot(f.home),
          "leases",
          `${identity.leaseId}.json`
        ),
        "utf8"
      ),
    });
    return { f, started, identity, children, verified, recover, retained };
  }

  test("is retired by its lease recovery once its children are gone, and the next owner starts", async () => {
    const { f, started, identity, children, verified, recover } =
      await killedOwner();
    const generation = started.configuration.ownerGeneration;
    await recover();
    // The release is still verified through the graph, as for a retired owner.
    expect(verified).toEqual(["release"]);
    expect(children).toEqual([
      { runtime: f.binding.runtime, httpsPort: f.binding.httpsPort },
    ]);
    await expect(lstat(nativeHttpsOwnerRoot(f.home))).rejects.toThrow("ENOENT");
    expect(await nativeHttpsReadRetiredOwner(f.home, generation)).toEqual(
      started.configuration
    );
    // The whole owner root is kept beside the retired record as evidence.
    const evidence = join(
      f.home,
      "native-https",
      "released-leases",
      generation,
      "exited-owner"
    );
    expect((await readdir(evidence)).sort()).toEqual([
      "configuration.json",
      "endpoint.json",
      "leases",
    ]);
    expect(await readdir(join(evidence, "leases"))).toEqual([
      `${identity.leaseId}.json`,
    ]);
    // `down` after the frontend recovers again: verified, nothing retired twice.
    await recover();
    expect(verified).toEqual(["release", "release"]);
    expect(children).toHaveLength(1);
    // The next `up` creates a new owner generation instead of needing recovery.
    const next = await ensureNativeHttpsOwner({
      binding: f.binding,
      spawnOwner: async () => undefined,
    });
    expect(next.ownerGeneration).not.toBe(generation);
  }, 25_000);

  test("is left alone while its exact owner invocation still runs", async () => {
    const { children, verified, recover, retained } = await killedOwner();
    const before = await retained();
    await expect(recover({ ownerRunning: async () => true })).rejects.toThrow(
      "ownership is unavailable or unconfirmed"
    );
    expect(children).toEqual([]);
    expect(verified).toEqual([]);
    expect(await retained()).toEqual(before);
  }, 25_000);

  test("of an ended pool boot is left to the previous-boot archive", async () => {
    const { children, verified, recover, retained } = await killedOwner();
    const before = await retained();
    await expect(
      recover({ poolBoot: async () => "87654321-1234-1234-1234-123456789abc" })
    ).rejects.toThrow("ownership is unavailable or unconfirmed");
    expect(children).toEqual([]);
    expect(verified).toEqual([]);
    expect(await retained()).toEqual(before);
  }, 25_000);

  test("whose children cannot be proven gone keeps every record", async () => {
    const { f, started, verified, recover, retained } = await killedOwner();
    const before = await retained();
    await expect(
      recover({
        retireChildren: async () => {
          throw new Error("Caddy still holds the port");
        },
      })
    ).rejects.toThrow("Caddy still holds the port");
    expect(verified).toEqual([]);
    expect(await retained()).toEqual(before);
    await expect(
      nativeHttpsReadRetiredOwner(f.home, started.configuration.ownerGeneration)
    ).rejects.toThrow("ENOENT");
  }, 25_000);

  test("a live owner is never retired", async () => {
    const f = await fixture();
    const started = await f.start();
    const identity = await f.acquire(
      started.socket,
      started.configuration.ownerGeneration,
      "b"
    );
    const children: unknown[] = [];
    // Its graph is not clean, so the live owner refuses the release itself.
    await expect(
      recoverNativeHttpsLease({
        runtime: f.binding.runtime,
        identity,
        exitedOwner: {
          poolBoot: async () => f.binding.pool.bootId,
          ownerRunning: async () => false,
          retireChildren: async (opts) => {
            children.push(opts);
          },
        },
      })
    ).rejects.toThrow();
    expect(children).toEqual([]);
    expect(
      await readFile(
        join(
          nativeHttpsOwnerRoot(f.home),
          "leases",
          `${identity.leaseId}.json`
        ),
        "utf8"
      )
    ).toContain(identity.leaseId);
  }, 25_000);
});
