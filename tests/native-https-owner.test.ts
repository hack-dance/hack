import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdtemp,
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
import {
  connectNativeHttpsOwner,
  ensureNativeHttpsOwner,
  readNativeHttpsOwnerConfiguration,
  recoverNativeHttpsLease,
  requestNativeHttpsOwner,
} from "../src/backends/native-https-owner.ts";
import {
  type NativeHttpsLeaseIdentity,
  type NativeHttpsOwnerBinding,
  nativeHttpsLeaseIdentity,
} from "../src/backends/native-https-owner-protocol.ts";
import { verifyNativeHttpsLeaseGraph } from "../src/backends/native-https-owner-server.ts";
import {
  nativeHttpsExecutableSha256,
  nativeHttpsLeaseReleasePath,
  nativeHttpsOwnerRoot,
  nativeHttpsReadRelease,
  nativeHttpsRecordRelease,
} from "../src/backends/native-https-owner-storage.ts";
import type { invokeNativeRuntime } from "../src/backends/native-runtime-client.ts";

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
async function fixture(
  options: {
    readonly immediateExit?: boolean;
    readonly startFailure?: boolean;
    readonly hardExit?: boolean;
    readonly holdRetirement?: boolean;
    /** Fault injected between control-socket publication and its first observation. */
    readonly afterPublish?: "fail" | "replace";
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
import { appendFile, chmod, readFile, unlink, writeFile } from "node:fs/promises";
import { NativeRuntimeRequestError } from ${JSON.stringify(resolve(import.meta.dir, "../src/backends/native-runtime-client.ts"))};
const home = ${JSON.stringify(home)};
const fault = ${JSON.stringify(options.afterPublish ?? null)};
await writeFile(home + "/helper-pid", String(process.pid));
${options.hardExit ? "process.exit(7);" : ""}
const never = ${options.immediateExit ? 'Promise.resolve({component:"fixture",code:1})' : "new Promise(() => {})"};
try {
  await serveNativeHttpsOwner({ configurationPath: process.argv.at(-1), dependencies: {
    start: async () => {
      await appendFile(home + "/events", "start\\n");
      ${options.startFailure ? 'throw new NativeRuntimeRequestError({ message: "private child output", nativeCode: "provider_busy" });' : ""}
      return { caPath: home + "/fake-ca", httpsPort: 19443, exited: never,
        verifyHostname: async () => ({statusCode:200}),
        close: async () => { await appendFile(home + "/events", "close\\n"); }
      };
    },
    verify: async (_binding, lease, phase) => {
      if (phase === "release" && await readFile(home + "/clean-" + lease.run, "utf8") !== "clean") { throw new Error("unproven"); }
    },
    afterPublish: async (path) => {
      await writeFile(home + "/published-path", path);
      if (fault === "fail") { throw new Error("injected failure after publication"); }
      // Set the foreign mode exactly even when the helper inherits a private umask.
      if (fault === "replace") { await unlink(path); await writeFile(path, "foreign replacement", { mode: 0o644 }); await chmod(path, 0o644); }
    },
    verifyIdle: async () => {
      ${
        options.holdRetirement
          ? `await writeFile(home + "/retire-entered", "yes");
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
        pid = Number(await readFile(join(home, "helper-pid"), "utf8"));
      } catch {}
    }
    if (pid) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
      const ownedPid = pid;
      await until(async () => {
        try {
          process.kill(ownedPid, 0);
        } catch {
          return true;
        }
        throw new Error("owned helper still exiting");
      });
    }
    if (socketDirectory) {
      await rm(socketDirectory, { recursive: true, force: true });
    }
    await rm(home, { recursive: true, force: true });
  });
  const start = async (independentStarter = false) => {
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
      await ensureNativeHttpsOwner({ binding });
    }
    pid = Number(await until(() => readFile(join(home, "helper-pid"), "utf8")));
    const configuration = await readNativeHttpsOwnerConfiguration(
      binding.runtime
    );
    const socket = await connectNativeHttpsOwner(configuration);
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
  return { home, binding, sockets, start, acquire, clean, release };
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
  await expect(
    lstat(join(nativeHttpsOwnerRoot(f.home), "endpoint.json"))
  ).rejects.toThrow();
  const configuration = await readNativeHttpsOwnerConfiguration(
    f.binding.runtime
  );
  await expect(connectNativeHttpsOwner(configuration, false)).rejects.toThrow();
}, 20_000);

test("a failure or replacement right after publication closes the listener and retires only its own endpoint", async () => {
  for (const fault of ["fail", "replace"] as const) {
    const f = await fixture({ afterPublish: fault });
    await ensureNativeHttpsOwner({ binding: f.binding });
    const published = await until(() =>
      readFile(join(f.home, "published-path"), "utf8")
    );
    const pid = Number(
      await until(() => readFile(join(f.home, "helper-pid"), "utf8"))
    );
    // The owner exits: a listener left open would keep it running.
    await until(async () => {
      try {
        process.kill(pid, 0);
      } catch {
        return true;
      }
      throw new Error("owner still running");
    });
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
});

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
