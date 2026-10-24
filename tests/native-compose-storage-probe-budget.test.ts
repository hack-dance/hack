import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { resolveNativeStorageTimeoutMs } from "../src/lib/compose-startup-budget.ts";
import { runNativeComposeStorageVerifiedExec } from "../src/lib/native-compose-command-storage.ts";
import { nativeComposeEffectRefusal } from "../src/lib/native-compose-effect-diagnostics.ts";
import {
  assertNativeComposeMaterialAuthority,
  type NativeComposeGenerationStore,
  type NativeComposeMaterialAuthority,
  type NativeComposeMaterialBinding,
  openNativeComposeGenerationStore,
} from "../src/lib/native-compose-generation.ts";
import * as ownership from "../src/lib/native-compose-ownership.ts";
import { parseNativeComposeStorageCommandRecord } from "../src/lib/native-compose-storage-command-record.ts";
import {
  createNativeComposeDockerStorageXattrCarrier,
  NATIVE_STORAGE_CLEANUP_FLOOR_MS,
  NATIVE_STORAGE_PROBE_CEILING_MS,
  nativeComposeStorageProbeTimeoutMs,
} from "../src/lib/native-compose-storage-witness-docker.ts";
import {
  NATIVE_STORAGE_DOCKER_ARTIFACT,
  nativeComposeStorageDockerImageReference,
} from "../src/lib/native-compose-storage-witness-docker-artifact.ts";
import {
  NATIVE_STORAGE_CARRIER_FORMAT,
  NATIVE_STORAGE_CARRIER_LABEL,
} from "../src/lib/native-compose-storage-witness-docker-policy.ts";
import {
  type NativeComposeStorageXattrInvocation,
  nativeComposeStorageXattrCarrierPorts,
} from "../src/lib/native-compose-storage-witness-xattr-carrier.ts";
import {
  createNativeComposeStorageXattrMarker,
  encodeNativeComposeStorageXattrResponse,
  type NativeComposeStorageXattrRequest,
  type NativeComposeStorageXattrResponse,
  refuseNativeComposeStorageXattr,
} from "../src/lib/native-compose-storage-witness-xattr-codec.ts";
import * as shell from "../src/lib/shell.ts";

// HACK-1369: storage probes are bounded by the carrier's remaining
// HACK_NATIVE_STORAGE_TIMEOUT_MS budget, not by fixed 15 s/10 s caps. The engine
// below is in-process: reads are answered by a stubbed probe, and each daemon
// command runs as a local /bin/sh child. Nothing reaches a Docker socket, the
// real HOME or the repository root; elapsed engine time is a virtual clock.
// Recorded (original-command) proofs also run the host's read-only process
// identity reads (`/bin/ps`, and `sysctl` on macOS) for their stopped children.

const engineId = "engine-fixture";
const selection = { name: "owned_data", storage: "data" };
const createdAt = "2026-10-08T12:00:00Z";
const helperRoot = { device: "1", inode: "42", uid: 70, gid: 70 };
const carrierId = "e".repeat(64);
const invocationId = "a".repeat(32);
/** Virtual helper start duration: above the former fixed 15 s start cap. */
const SLOW_START_MS = 20_000;
const roots: string[] = [];
const stores: NativeComposeGenerationStore[] = [];
const ENV_KEYS = [
  "PATH",
  "HOME",
  "HACK_HOME",
  "DOCKER_CONFIG",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_API_VERSION",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CERT_PATH",
  "HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK",
] as const;
let savedEnv: Record<string, string | undefined> = {};
let tripwire = "";

async function tempDirectory(prefix: string): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  roots.push(path);
  return path;
}

beforeEach(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const home = await tempDirectory("native-storage-budget-home-");
  const bin = join(home, "bin");
  await mkdir(bin);
  tripwire = join(home, "docker-executed");
  // A `docker` that only records that something executed it. Every engine read
  // is stubbed and every daemon command is rewritten, so it must never run.
  await writeFile(
    join(bin, "docker"),
    `#!/bin/sh\nprintf executed > '${tripwire}'\nexit 97\n`
  );
  await chmod(join(bin, "docker"), 0o755);
  process.env.PATH = `${bin}:/usr/bin:/bin`;
  process.env.HOME = home;
  process.env.HACK_HOME = join(home, "hack");
  process.env.DOCKER_CONFIG = join(home, "docker-config");
  // A TCP host with an explicit API version is never an admitted Unix socket,
  // so engine-ID fences use the stubbed CLI probe, never a direct socket read.
  process.env.DOCKER_HOST = "tcp://127.0.0.1:9";
  process.env.DOCKER_API_VERSION = "1.43";
  process.env.HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK = "1";
  for (const key of [
    "DOCKER_CONTEXT",
    "DOCKER_TLS_VERIFY",
    "DOCKER_CERT_PATH",
  ]) {
    delete process.env[key];
  }
});

afterEach(async () => {
  mock.restore();
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

/** Runs `effect` inside one owned generation effect with its material authority. */
async function withAuthority(
  effect: (opts: {
    readonly store: NativeComposeGenerationStore;
    readonly authority: NativeComposeMaterialAuthority;
    readonly binding: NativeComposeMaterialBinding;
  }) => Promise<void>
): Promise<void> {
  const root = await tempDirectory("native-storage-budget-project-");
  await mkdir(join(root, ".hack"));
  await Bun.write(
    join(root, ".hack/hack.project.json"),
    JSON.stringify({ schema_version: 1, name: "storage" })
  );
  const store = await openNativeComposeGenerationStore({
    projectRoot: root,
    instance: null,
  });
  stores.push(store);
  await store.withMutation(async (mutation) => {
    const reservation = mutation.reserveGeneration();
    const labels = {
      "io.hack.native-config.version": "1",
      "io.hack.native-config.owner": store.identity.ownerToken,
      "io.hack.native-config.instance": store.identity.composeProject,
    };
    const generation = await mutation.publish({
      reservation,
      profiles: [],
      inputRevision: "a".repeat(64),
      assertFresh: async () => {},
      composeJson: JSON.stringify({
        name: store.identity.composeProject,
        services: {
          app: {
            image: "synthetic:1",
            labels: {
              ...labels,
              "io.hack.native-config.generation": reservation.generationId,
              "io.hack.native-config.workload": "service",
            },
          },
        },
        volumes: {
          data: {
            name: selection.name,
            labels: {
              ...labels,
              "io.hack.native-config.storage": selection.storage,
            },
          },
        },
      }),
    });
    await mutation.runEffect({
      generation,
      operation: "up",
      assertOwned: async () => {},
      assertFresh: async () => {},
      effect: async () => {
        const authority = mutation.materialAuthority;
        await effect({
          store,
          authority,
          binding: await assertNativeComposeMaterialAuthority({
            authority,
            generation,
            phase: "effect",
          }),
        });
        return { outcome: "complete", value: 0 };
      },
    });
  });
}

type Engine = {
  readonly probeTimeouts: number[];
  readonly commands: {
    readonly verb: string;
    readonly timeoutMs: number;
    readonly elapsed: number;
  }[];
  /** Virtual time the engine has consumed so far. */
  elapsed: number;
};

/**
 * One in-process engine holding the selected owned volume and, once created,
 * the exact helper carrier. `startMs` is the helper start's virtual duration: a
 * start whose granted timeout is shorter times out at that timeout, like a real
 * `docker start -ai` would.
 */
function installEngine(opts: {
  readonly binding: NativeComposeMaterialBinding;
  readonly store: NativeComposeGenerationStore;
  readonly input: () => NativeComposeStorageXattrInvocation;
  readonly startMs: number;
  readonly response: NativeComposeStorageXattrResponse;
  readonly cleanupInspectMs?: number;
}): Engine {
  const engine: Engine = { probeTimeouts: [], commands: [], elapsed: 0 };
  const { binding, store } = opts;
  const now = Date.now();
  spyOn(Date, "now").mockImplementation(() => now + engine.elapsed);
  const program = join(
    store.identity.checkoutRoot,
    ".hack",
    ".internal",
    "native-compose",
    store.identity.instanceId,
    "storage-carriers",
    invocationId,
    "helper.mjs"
  );
  let carrierState: "absent" | "created" | "exited" = "absent";
  let cleanupInspected = false;
  const carrierValue = () => {
    const input = opts.input();
    return {
      id: carrierId,
      createdAt,
      image: input.artifact.imageId,
      configImage: nativeComposeStorageDockerImageReference(input.artifact),
      user: `${input.uid}:${input.gid}`,
      entrypoint: ["/usr/local/bin/bun"],
      cmd: ["--no-env-file", "/hack-storage-witness-helper.mjs"],
      openStdin: true,
      tty: false,
      labels: {
        [NATIVE_STORAGE_CARRIER_LABEL]: input.invocationId,
        "io.hack.storage-witness.owner": input.target.ownerToken,
        "io.hack.storage-witness.generation": input.scope.generationId,
        "io.hack.storage-witness.helper": input.artifact.helperHash,
      },
      host: {
        Privileged: false,
        ReadonlyRootfs: true,
        NetworkMode: "none",
        Memory: 268_435_456,
        NanoCpus: 1_000_000_000,
        PidsLimit: 32,
        CapDrop: ["ALL"],
        CapAdd: null,
        SecurityOpt: ["no-new-privileges:true"],
        LogConfig: { Type: "none", Config: {} },
        RestartPolicy: { Name: "no" },
        Binds: null,
        Tmpfs: null,
        Devices: [],
        DeviceRequests: null,
        PortBindings: {},
        OomKillDisable: false,
        Mounts: [
          {
            Type: "bind",
            Source: program,
            Target: "/hack-storage-witness-helper.mjs",
            ReadOnly: true,
            BindOptions: {
              NonRecursive: true,
              Propagation: "rprivate",
              CreateMountpoint: false,
            },
          },
          {
            Type: "volume",
            Source: input.target.name,
            Target: "/hack-storage-witness",
            ...(input.readonly ? { ReadOnly: true } : {}),
            VolumeOptions: { NoCopy: true },
          },
        ],
      },
      mounts: [
        {
          Type: "bind",
          Source: program,
          Destination: "/hack-storage-witness-helper.mjs",
          RW: false,
          Propagation: "rprivate",
        },
        {
          Type: "volume",
          Name: input.target.name,
          Source: input.target.mountpoint,
          Destination: "/hack-storage-witness",
          Driver: "local",
          Mode: "",
          RW: !input.readonly,
          Propagation: "",
        },
      ],
      state: {
        Status: carrierState,
        Running: false,
        Pid: 0,
        ExitCode: 0,
        Paused: false,
        Restarting: false,
        OOMKilled: false,
        Dead: false,
        Error: "",
      },
      execIds: null,
    };
  };
  const answer = (args: readonly string[]): string => {
    const [noun, verb] = args;
    if (noun === "info" && verb === "--format" && args.length === 3) {
      return args[2] === "{{json .ID}}"
        ? `${JSON.stringify(engineId)}\n`
        : `${JSON.stringify({ id: engineId, os: "linux", arch: "arm64" })}\n`;
    }
    if (noun === "image" && verb === "inspect") {
      return `${JSON.stringify({
        id: NATIVE_STORAGE_DOCKER_ARTIFACT.imageId,
        os: "linux",
        arch: "arm64",
        volumes: null,
      })}\n`;
    }
    if (noun === "volume" && verb === "ls") {
      return `${JSON.stringify(selection.name)}\n`;
    }
    if (noun === "volume" && verb === "inspect") {
      return `${JSON.stringify({
        name: selection.name,
        createdAt,
        driver: "local",
        options: null,
        mountpoint: `/var/lib/docker/volumes/${selection.name}/_data`,
        project: binding.identity.composeProject,
        instance: binding.identity.composeProject,
        owner: binding.identity.ownerToken,
        version: "1",
        storage: selection.storage,
        provision: null,
      })}\n`;
    }
    // No workload holds the volume; the helper carrier is answered by its
    // exact inspect only, and every inventory stays empty.
    if (noun === "container" && verb === "ls") {
      return "";
    }
    if (
      noun === "container" &&
      verb === "inspect" &&
      args[3] === NATIVE_STORAGE_CARRIER_FORMAT &&
      args[4] === carrierId &&
      carrierState !== "absent"
    ) {
      if (carrierState === "exited" && !cleanupInspected) {
        cleanupInspected = true;
        engine.elapsed += opts.cleanupInspectMs ?? 0;
      }
      return `${JSON.stringify(carrierValue())}\n`;
    }
    throw new Error("Unexpected synthetic Docker request");
  };
  spyOn(ownership, "createNativeComposeProbe").mockImplementation((probe) => {
    const timeoutMs = probe.timeoutMs ?? Number.NaN;
    engine.probeTimeouts.push(timeoutMs);
    if (!(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1)) {
      throw new Error("Unbounded synthetic probe");
    }
    return (args) => Promise.resolve(answer(args));
  });
  const run = shell.run;
  spyOn(shell, "run").mockImplementation((argv, options = {}) => {
    // [/bin/sh, -c, wrapper, name, docker, ...daemon arguments]. A recorded
    // command's wrapper stops itself before exec; the replacement child keeps
    // that wrapper, so its publication handshake runs unchanged.
    if (basename(argv[4] ?? "") !== "docker") {
      // Host identity reads of recorded commands (`/bin/ps`, `sysctl`).
      return run(argv, options);
    }
    const daemon = argv.slice(5);
    const timeoutMs = options.timeoutMs ?? Number.NaN;
    const verb = daemon[0] === "volume" ? "volume create" : (daemon[0] ?? "");
    engine.commands.push({ verb, timeoutMs, elapsed: engine.elapsed });
    // `effect` is the daemon-side change, applied when the child exits: a
    // recorded command re-checks admission (the helper still `created`) after
    // its child is spawned and before it resumes.
    const child = (
      script: string,
      step: { readonly granted?: number; readonly effect?: () => void } = {}
    ) =>
      run([...argv.slice(0, 4), "/bin/sh", "-c", script], {
        ...options,
        timeoutMs: step.granted ?? timeoutMs,
        onExit: (event) => {
          step.effect?.();
          return options.onExit?.(event) ?? Promise.resolve();
        },
      });
    if (daemon[0] === "create") {
      return child(`printf '%s\\n' ${carrierId}`, {
        effect: () => {
          carrierState = "created";
        },
      });
    }
    if (daemon[0] === "start" && daemon[2] === carrierId) {
      if (!(timeoutMs >= opts.startMs)) {
        // The granted bound expires first: the engine is still starting the
        // helper when the timeout fires, so the virtual clock reaches it.
        engine.elapsed += Number.isFinite(timeoutMs) ? timeoutMs : 0;
        return child("sleep 5", { granted: 20 });
      }
      const response = encodeNativeComposeStorageXattrResponse(opts.response);
      return child(`printf '%s' '${response.trimEnd()}'; printf '\\n'`, {
        effect: () => {
          engine.elapsed += opts.startMs;
          carrierState = "exited";
        },
      });
    }
    if (daemon[0] === "rm" && daemon[1] === carrierId) {
      return child(`printf '%s\\n' ${carrierId}`, {
        effect: () => {
          carrierState = "absent";
        },
      });
    }
    throw new Error("Unexpected synthetic Docker command");
  });
  return engine;
}

function invocation(opts: {
  readonly binding: NativeComposeMaterialBinding;
  readonly target: NativeComposeStorageXattrInvocation["target"];
  readonly request: NativeComposeStorageXattrRequest;
}): NativeComposeStorageXattrInvocation {
  const { binding, target, request } = opts;
  return {
    recordCreated: async () => {},
    invocationId,
    artifact: NATIVE_STORAGE_DOCKER_ARTIFACT,
    target,
    readonly: true,
    uid: 70,
    gid: 70,
    request,
    scope: {
      generationId: binding.generationId,
      currentGenerationId: binding.currentGenerationId,
      pendingGenerationId: binding.pendingGenerationId,
      pendingToken: binding.pendingToken,
    },
  };
}

type Proof = {
  readonly engine: Engine;
  readonly result: unknown;
  readonly error: unknown;
  /** Original-command record of a recorded proof, read after it returned. */
  readonly record: string | null;
};

/**
 * One readonly proof whose helper start takes {@link SLOW_START_MS}. The default
 * is an unrecorded `root` request. `recorded` builds the carrier exactly as
 * `exec` and `up` storage proofs do (`prepareNativeComposeCommandStorage`:
 * `originalCommandRecords: true`) and sends a readonly `verify` request, so every
 * helper command takes the recorded original-command branch.
 */
async function proveWithSlowStart(opts: {
  readonly budgetMs: number;
  readonly cleanupInspectMs?: number;
  readonly recorded?: true;
}): Promise<Proof> {
  let outcome: Proof | null = null;
  await withAuthority(async ({ store, authority, binding }) => {
    let input: NativeComposeStorageXattrInvocation | null = null;
    const marker = createNativeComposeStorageXattrMarker();
    const request: NativeComposeStorageXattrRequest = opts.recorded
      ? { ...marker, operation: "verify", root: helperRoot }
      : { kind: "directory-xattr", version: 1, operation: "root" };
    const engine = installEngine({
      binding,
      store,
      input: () => input ?? refuseNativeComposeStorageXattr(),
      startMs: SLOW_START_MS,
      response: opts.recorded
        ? {
            kind: "directory-xattr",
            version: 1,
            outcome: "verified",
            root: helperRoot,
            valueHex: marker.valueHex,
          }
        : {
            kind: "directory-xattr",
            version: 1,
            outcome: "root",
            root: helperRoot,
          },
      cleanupInspectMs: opts.cleanupInspectMs,
    });
    const handle = await createNativeComposeDockerStorageXattrCarrier({
      authority,
      store,
      engineId,
      signal: new AbortController().signal,
      deadline: Date.now() + opts.budgetMs,
      ...(opts.recorded ? { originalCommandRecords: true as const } : {}),
    });
    const ports = nativeComposeStorageXattrCarrierPorts(handle);
    // Callers pass the carrier's own observed target, as storage proofs do.
    const target = await ports.inspect(selection);
    input = invocation({
      binding,
      target: target as NativeComposeStorageXattrInvocation["target"],
      request,
    });
    let result: unknown = null;
    let error: unknown = null;
    try {
      result = await ports.invoke(input);
    } catch (caught) {
      error = caught;
    }
    const recordPath = join(
      store.identity.checkoutRoot,
      ".hack",
      ".internal",
      "native-compose",
      store.identity.instanceId,
      "storage-carriers",
      invocationId,
      "commands.json"
    );
    const record =
      opts.recorded && existsSync(recordPath)
        ? await readFile(recordPath, "utf8")
        : null;
    if (opts.recorded && result !== null) {
      // A recorded proof defers file retirement to finish() with the carrier
      // journal's completion. Only that journal issues one, so a synthetic
      // completion refuses; finish still closes the held invocation directories.
      await expect(
        ports.finish?.({ input, completion: Object.freeze({}) })
      ).rejects.toThrow("values omitted");
    }
    outcome = { engine, result, error, record };
  });
  if (!outcome) {
    throw new Error("Storage proof fixture did not run");
  }
  return outcome;
}

test("a helper start slower than the former 15 s cap completes within the default storage budget", async () => {
  // The default per-carrier budget used by `exec` and `up` storage proofs.
  const budgetMs = resolveNativeStorageTimeoutMs({ env: {} });
  expect(budgetMs).toBe(90_000);
  const { engine, result, error } = await proveWithSlowStart({ budgetMs });
  expect(nativeComposeEffectRefusal(error)).toBeUndefined();
  expect(error).toBeNull();
  expect(result).toMatchObject({
    outcome: "complete",
    exitCode: 0,
    carrierId,
    containersAfterCleanup: [],
  });
  expect(engine.commands.map(({ verb }) => verb)).toEqual([
    "create",
    "start",
    "rm",
  ]);
  const [create, start, remove] = engine.commands;
  // Create and start get the remaining carrier budget, never more.
  for (const command of [create, start]) {
    expect(command?.timeoutMs).toBeGreaterThan(SLOW_START_MS);
    expect(command?.timeoutMs).toBeLessThanOrEqual(budgetMs);
  }
  // Removal keeps its own finite cleanup bound.
  expect(remove?.timeoutMs).toBeGreaterThanOrEqual(
    NATIVE_STORAGE_CLEANUP_FLOOR_MS
  );
  expect(remove?.timeoutMs).toBeLessThanOrEqual(
    NATIVE_STORAGE_PROBE_CEILING_MS
  );
  expect(engine.probeTimeouts.length).toBeGreaterThan(0);
  expect(
    engine.probeTimeouts.every(
      (value) => value >= 1 && value <= NATIVE_STORAGE_PROBE_CEILING_MS
    )
  ).toBe(true);
  expect(engine.elapsed).toBe(SLOW_START_MS);
  expect(existsSync(tripwire)).toBe(false);
}, 30_000);

// The exec/up path: prepareNativeComposeCommandStorage creates every carrier
// with `originalCommandRecords: true`, so readonly `verify` proofs run each
// helper command through the recorded original-command branch (publication,
// boundary deadline and settlement). That branch computes its own child bound,
// so it needs its own slow-start proof.
test("a recorded exec/up verify proof completes a helper start slower than the former 15 s cap", async () => {
  const budgetMs = resolveNativeStorageTimeoutMs({ env: {} });
  expect(budgetMs).toBe(90_000);
  const { engine, result, error, record } = await proveWithSlowStart({
    budgetMs,
    recorded: true,
  });
  expect(nativeComposeEffectRefusal(error)).toBeUndefined();
  expect(error).toBeNull();
  expect(result).toMatchObject({
    outcome: "complete",
    exitCode: 0,
    carrierId,
    containersAfterCleanup: [],
  });
  expect(engine.commands.map(({ verb }) => verb)).toEqual([
    "create",
    "start",
    "rm",
  ]);
  const [create, start, remove] = engine.commands;
  // The recorded child bound is the remaining carrier budget, never more.
  for (const command of [create, start]) {
    expect(command?.timeoutMs).toBeGreaterThan(SLOW_START_MS);
    expect(command?.timeoutMs).toBeLessThanOrEqual(budgetMs);
  }
  expect(remove?.timeoutMs).toBeGreaterThan(0);
  expect(remove?.timeoutMs).toBeLessThanOrEqual(
    NATIVE_STORAGE_PROBE_CEILING_MS
  );
  // Every helper command was published and settled as an original command.
  expect(record).not.toBeNull();
  const { commands } = parseNativeComposeStorageCommandRecord(record ?? "");
  expect(commands.map(({ kind }) => kind)).toEqual([
    "create",
    "start",
    "remove",
  ]);
  for (const command of commands) {
    expect(command.child).not.toBeNull();
    expect(command.settlement).toMatchObject({
      exitCode: 0,
      timedOut: false,
      cancelled: false,
    });
  }
  expect(engine.elapsed).toBe(SLOW_START_MS);
  expect(existsSync(tripwire)).toBe(false);
}, 30_000);

test("a helper start that outlasts the whole storage budget still refuses at the budget's end", async () => {
  const budgetMs = 12_000;
  const { engine, result, error } = await proveWithSlowStart({ budgetMs });
  expect(result).toBeNull();
  // The start was granted only the carrier's remaining budget; its timeout
  // lands at the carrier's end and names that exhausted budget.
  expect(nativeComposeEffectRefusal(error)).toEqual({
    stage: "storage-helper-start",
    reason: "storage-budget",
  });
  expect(engine.commands.map(({ verb }) => verb)).toEqual(["create", "start"]);
  const start = engine.commands[1];
  expect(start?.timeoutMs).toBeGreaterThan(0);
  expect(start?.timeoutMs).toBeLessThanOrEqual(budgetMs);
  expect(existsSync(tripwire)).toBe(false);
}, 30_000);

test("cleanup crossing the storage deadline still removes the exited helper and refuses the proof", async () => {
  const budgetMs = SLOW_START_MS + 1000;
  const cleanupInspectMs = 2000;
  const { engine, result, error } = await proveWithSlowStart({
    budgetMs,
    cleanupInspectMs,
  });
  expect(engine.commands.map(({ verb }) => verb)).toEqual([
    "create",
    "start",
    "rm",
  ]);
  const start = engine.commands[1];
  expect(start?.timeoutMs).toBeGreaterThan(SLOW_START_MS);
  const remove = engine.commands[2];
  expect(remove?.elapsed).toBe(SLOW_START_MS + cleanupInspectMs);
  expect(remove?.elapsed).toBeGreaterThan(budgetMs);
  expect(remove?.timeoutMs).toBeGreaterThan(0);
  expect(remove?.timeoutMs).toBe(NATIVE_STORAGE_CLEANUP_FLOOR_MS);
  expect(remove?.timeoutMs).toBeLessThanOrEqual(
    NATIVE_STORAGE_PROBE_CEILING_MS
  );
  expect(result).toBeNull();
  expect(nativeComposeEffectRefusal(error)).toMatchObject({
    reason: "storage-budget",
  });
  expect(existsSync(tripwire)).toBe(false);
}, 30_000);

test("probe timeouts follow the remaining carrier budget with a finite cleanup bound", () => {
  const now = 1_000_000;
  const at = (remaining: number) => ({ deadline: now + remaining, now });
  // Commands get exactly the remaining budget, however large.
  expect(
    nativeComposeStorageProbeTimeoutMs({ kind: "command", ...at(80_000) })
  ).toBe(80_000);
  expect(
    nativeComposeStorageProbeTimeoutMs({ kind: "command", ...at(600_000) })
  ).toBe(600_000);
  // Reads follow the budget but keep the probe's own 60 s ceiling.
  expect(
    nativeComposeStorageProbeTimeoutMs({ kind: "read", ...at(40_000) })
  ).toBe(40_000);
  expect(
    nativeComposeStorageProbeTimeoutMs({ kind: "read", ...at(90_000) })
  ).toBe(NATIVE_STORAGE_PROBE_CEILING_MS);
  // An exhausted budget leaves a non-positive bound: the probe or command
  // refuses before it spawns.
  expect(
    nativeComposeStorageProbeTimeoutMs({ kind: "read", ...at(0) })
  ).toBeLessThanOrEqual(0);
  expect(
    nativeComposeStorageProbeTimeoutMs({ kind: "command", ...at(-5) })
  ).toBeLessThanOrEqual(0);
  // Cleanup has its own bound: a floor after the deadline, a ceiling before it.
  expect(
    nativeComposeStorageProbeTimeoutMs({ kind: "cleanup", ...at(-30_000) })
  ).toBe(NATIVE_STORAGE_CLEANUP_FLOOR_MS);
  expect(
    nativeComposeStorageProbeTimeoutMs({ kind: "cleanup", ...at(25_000) })
  ).toBe(25_000);
  expect(
    nativeComposeStorageProbeTimeoutMs({ kind: "cleanup", ...at(600_000) })
  ).toBe(NATIVE_STORAGE_PROBE_CEILING_MS);
});

// Documented exec contract: the closing proof runs after the guest command and
// is fail-closed. Its refusal (for example a storage probe timeout) fails exec
// even though the command already ran; the command's exit code is not reported.
test("a closing storage proof refusal fails saved exec after its command ran", async () => {
  const order: string[] = [];
  const refusal = new Error("closing storage proof refused");
  await expect(
    runNativeComposeStorageVerifiedExec({
      signal: new AbortController().signal,
      assertSaved: async (options) => {
        order.push(options.adjacentProof ? "opening" : "closing");
        if (!options.adjacentProof) {
          throw refusal;
        }
      },
      run: async () => {
        order.push("command");
        return 0;
      },
    })
  ).rejects.toBe(refusal);
  expect(order).toEqual(["opening", "command", "closing"]);
});
