import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  nativeComposeEffectRefusal,
  retainNativeComposeEffectRefusal,
} from "../src/lib/native-compose-effect-diagnostics.ts";
import {
  assertNativeComposeMaterialAuthority,
  type NativeComposeGenerationStore,
  type NativeComposeMaterialBinding,
  openNativeComposeGenerationStore,
} from "../src/lib/native-compose-generation.ts";
import { assertNativeComposeStorageDockerImage } from "../src/lib/native-compose-storage-witness-docker.ts";
import {
  NATIVE_STORAGE_DOCKER_ARTIFACT,
  nativeComposeStorageDockerHelper,
  nativeComposeStorageDockerImageReference,
} from "../src/lib/native-compose-storage-witness-docker-artifact.ts";
import {
  assertNativeComposeStorageDockerCarrierVolume,
  nativeComposeStorageDockerPathsOverlap,
  observeNativeComposeStorageDockerTarget,
} from "../src/lib/native-compose-storage-witness-docker-inventory.ts";
import {
  checkNativeComposeStorageDockerCarrier,
  checkNativeComposeStorageReadonlyCarrierRecovery,
  NATIVE_STORAGE_CARRIER_LABEL,
  nativeComposeStorageDockerCarrierPolicy,
  nativeComposeStorageDockerCreateArgs,
} from "../src/lib/native-compose-storage-witness-docker-policy.ts";
import type { NativeComposeStorageXattrInvocation } from "../src/lib/native-compose-storage-witness-xattr-carrier.ts";

const roots: string[] = [],
  stores: NativeComposeGenerationStore[] = [];
const engineId = "engine-fixture";
const selection = { name: "owned_data", storage: "data" };
const createdAt = "2026-10-08T12:00:00Z";
const SPARSE_IMAGE_FIELD = /{{json ([^{}]+)}}/g;

test("cached image prerequisite emits complete sparse JSON before carrier effects", async () => {
  const fields: Readonly<Record<string, unknown>> = {
    ".Id": NATIVE_STORAGE_DOCKER_ARTIFACT.imageId,
    ".Os": "linux",
    ".Architecture": "arm64",
    '(index .Config "Volumes")': null,
  };
  const requests: string[][] = [];
  await assertNativeComposeStorageDockerImage(async (args) => {
    requests.push([...args]);
    expect(args).toHaveLength(5);
    expect(args.slice(0, 3)).toEqual(["image", "inspect", "--format"]);
    expect(args[4]).toBe(
      nativeComposeStorageDockerImageReference(NATIVE_STORAGE_DOCKER_ARTIFACT)
    );
    const format = args[3];
    if (typeof format !== "string") {
      throw new Error("Missing fixed sparse image format");
    }
    const rendered = format.replace(SPARSE_IMAGE_FIELD, (_, field: string) => {
      if (!Object.hasOwn(fields, field)) {
        throw new Error("Unexpected sparse image field");
      }
      const encoded = JSON.stringify(fields[field]);
      if (typeof encoded !== "string") {
        throw new Error("Invalid fixed sparse image field");
      }
      return encoded;
    });
    const output = `${rendered}\n`;
    expect(Buffer.byteLength(output)).toBe(124);
    return output;
  });
  expect(requests).toHaveLength(1);
});

test("cached image prerequisite refuses the faithful truncated sparse output", async () => {
  const truncated = `{"id":"${NATIVE_STORAGE_DOCKER_ARTIFACT.imageId}","os":"linux","arch":"arm64","volumes":null\n`;
  expect(Buffer.byteLength(truncated)).toBe(123);
  expect(createHash("sha256").update(truncated).digest("hex")).toBe(
    "aea01511888599e3e1cacfc66c146dadb3ffdec207e1a620fe0136c2bca72ad8"
  );
  await expect(
    assertNativeComposeStorageDockerImage(async () => truncated)
  ).rejects.toBeInstanceOf(SyntaxError);
});

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
async function withBinding(
  run: (value: NativeComposeMaterialBinding) => Promise<void>
) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "native-storage-docker-"))
  );
  roots.push(root);
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
        await run(
          await assertNativeComposeMaterialAuthority({
            authority: mutation.materialAuthority,
            generation,
            phase: "effect",
          })
        );
        return { outcome: "complete", value: 0 };
      },
    });
  });
}
function inventory(binding: NativeComposeMaterialBinding) {
  const state = {
    present: true,
    drift: false,
    foreign: false,
    running: false,
    mounts: true,
    version: "1",
    volumeReads: 0,
    volumeOwner: binding.identity.ownerToken,
    mountType: "volume",
    mountName: selection.name,
    mountSource: `/var/lib/docker/volumes/${selection.name}/_data`,
  };
  const id = "c".repeat(64);
  const mutableCalls: string[][] = [];
  const probe = async (args: readonly string[]): Promise<string> => {
    mutableCalls.push([...args]);
    if (args[0] === "info") {
      return JSON.stringify(engineId);
    }
    if (args[0] === "volume" && args[1] === "ls") {
      return state.present ? JSON.stringify(selection.name) : "";
    }
    if (args[0] === "volume" && args[1] === "inspect") {
      state.volumeReads++;
      if (!state.present) {
        return "";
      }
      return JSON.stringify({
        ...selection,
        createdAt:
          state.drift && state.volumeReads > 1
            ? "2026-10-08T13:00:00Z"
            : createdAt,
        driver: "local",
        options: null,
        mountpoint: `/var/lib/docker/volumes/${selection.name}/_data`,
        project: binding.identity.composeProject,
        instance: binding.identity.composeProject,
        owner: state.volumeOwner,
        version: state.version,
        provision: null,
      });
    }
    if (args[0] === "container" && args[1] === "ls") {
      return state.mounts ? JSON.stringify(id) : "";
    }
    if (args[0] === "container" && args[1] === "inspect") {
      return JSON.stringify({
        id,
        createdAt,
        mounts: [
          {
            Type: state.mountType,
            Name: state.mountName,
            Source: state.mountSource,
            Destination: "/data",
            RW: true,
          },
        ],
        running: state.running,
        project: binding.identity.composeProject,
        instance: binding.identity.composeProject,
        owner: state.foreign ? "f".repeat(32) : binding.identity.ownerToken,
        version: state.version,
        generation: binding.generationId,
        carrier: null,
        carrierOwner: null,
        carrierGeneration: null,
      });
    }
    throw new Error("Unexpected synthetic Docker request");
  };
  return { state, probe, calls: mutableCalls };
}
test("full holder inventory admits stopped and exact owned running readers and preserves strict sparse reads", async () => {
  await withBinding(async (current) => {
    const fake = inventory(current);
    const target = await observeNativeComposeStorageDockerTarget({
      current,
      engineId,
      selection,
      stopped: true,
      probe: fake.probe,
    });
    expect(target.volume).toEqual({ ...selection, createdAt });
    expect(target.holders).toHaveLength(1);
    fake.state.running = true;
    expect(
      (
        await observeNativeComposeStorageDockerTarget({
          current,
          engineId,
          selection,
          stopped: false,
          probe: fake.probe,
        })
      ).holders[0]?.running
    ).toBe(true);
    expect(
      fake.calls.every(
        (args) =>
          !(
            args.includes("create") ||
            args.includes("start") ||
            args.includes("rm") ||
            args.join(" ").includes("Config.Env")
          )
      )
    ).toBe(true);
  });
});
test("full carrier target is projected into exact retained volume facts", async () => {
  await withBinding(async (current) => {
    const fake = inventory(current);
    const target = await observeNativeComposeStorageDockerTarget({
      current,
      engineId,
      selection,
      stopped: true,
      probe: fake.probe,
    });
    expect(Object.keys(target)).toHaveLength(10);
    const repeated = await observeNativeComposeStorageDockerTarget({
      current,
      engineId,
      selection: target,
      stopped: true,
      probe: fake.probe,
    });
    expect(repeated).toEqual(target);
    expect(Object.keys(repeated.volume ?? {}).sort()).toEqual([
      "createdAt",
      "name",
      "storage",
    ]);
    expect(fake.calls.every((args) => !args.includes("create"))).toBe(true);
  });
});

test("holder observation captures selection before the first probe await", async () => {
  await withBinding(async (current) => {
    const fake = inventory(current);
    const mutable = { ...selection };
    let changed = false;
    const target = await observeNativeComposeStorageDockerTarget({
      current,
      engineId,
      selection: mutable,
      stopped: true,
      probe: async (args) => {
        if (!changed) {
          changed = true;
          mutable.name = "substituted_data";
          mutable.storage = "substituted";
        }
        return await fake.probe(args);
      },
    });
    expect(changed).toBe(true);
    expect(target.name).toBe(selection.name);
    expect(target.storage).toBe(selection.storage);
    expect(target.volume).toEqual({ ...selection, createdAt });
    expect(fake.calls.some((args) => args.includes(mutable.name))).toBe(false);
  });
});

test.each([
  "missing",
  "rebirth",
  "foreign",
] as const)("post-create %s storage cannot admit helper start", async (failure) => {
  await withBinding(async (current) => {
    const fake = inventory(current);
    const target = await observeNativeComposeStorageDockerTarget({
      current,
      engineId,
      selection,
      stopped: true,
      probe: fake.probe,
    });
    if (failure === "missing") {
      fake.state.present = false;
    }
    if (failure === "rebirth") {
      fake.state.drift = true;
    }
    if (failure === "foreign") {
      fake.state.volumeOwner = "f".repeat(32);
    }
    let starts = 0;
    await expect(
      (async () => {
        await assertNativeComposeStorageDockerCarrierVolume({
          current,
          target,
          probe: fake.probe,
        });
        starts++;
      })()
    ).rejects.toThrow("values omitted");
    expect(starts).toBe(0);
  });
});
test("post-create storage proof preserves the full target snapshot across its read", async () => {
  await withBinding(async (current) => {
    const fake = inventory(current);
    const observed = await observeNativeComposeStorageDockerTarget({
      current,
      engineId,
      selection,
      stopped: true,
      probe: fake.probe,
    });
    const target = {
      ...observed,
      volume: observed.volume ? { ...observed.volume } : null,
    };
    await assertNativeComposeStorageDockerCarrierVolume({
      current,
      target,
      probe: async (args) => {
        target.name = "substituted_data";
        target.storage = "substituted";
        target.mountpoint = "/var/lib/docker/volumes/substituted_data/_data";
        if (target.volume) {
          target.volume.createdAt = "2026-10-08T13:00:00Z";
        }
        return await fake.probe(args);
      },
    });
    expect(fake.calls.at(-1)?.at(-1)).toBe(selection.name);
  });
});

test.each([
  "foreign",
  "running",
  "drift",
  "version",
] as const)("selected holder or volume %s refuses before any effects", async (failure) => {
  await withBinding(async (current) => {
    const fake = inventory(current);
    if (failure === "version") {
      fake.state.version = "2";
    } else {
      fake.state[failure] = true;
    }
    await expect(
      observeNativeComposeStorageDockerTarget({
        current,
        engineId,
        selection,
        stopped: true,
        probe: fake.probe,
      })
    ).rejects.toThrow("values omitted");
    expect(
      fake.calls.every(
        (args) =>
          !(
            args.includes("create") ||
            args.includes("start") ||
            args.includes("rm")
          )
      )
    ).toBe(true);
  });
});
test("genuinely absent cold storage needs an empty complete holder selection", async () => {
  await withBinding(async (current) => {
    const fake = inventory(current);
    fake.state.present = false;
    fake.state.mounts = false;
    expect(
      (
        await observeNativeComposeStorageDockerTarget({
          current,
          engineId,
          selection,
          stopped: true,
          probe: fake.probe,
        })
      ).volume
    ).toBeNull();
    fake.state.mounts = true;
    await expect(
      observeNativeComposeStorageDockerTarget({
        current,
        engineId,
        selection,
        stopped: true,
        probe: fake.probe,
      })
    ).rejects.toThrow();
  });
});
test.each([
  "/var/lib/docker/volumes",
  "/var/lib/docker/volumes/owned_data/",
  "/var/lib/docker/volumes/owned_data/_data/",
  "/var/lib/docker/volumes/owned_data/_data/child",
  "/var/lib/docker/volumes/other/../owned_data/_data",
] as const)("foreign overlapping bind %s refuses rather than disappearing from holder selection", async (source) => {
  await withBinding(async (current) => {
    const fake = inventory(current);
    fake.state.foreign = true;
    fake.state.mountType = "bind";
    fake.state.mountName = "";
    fake.state.mountSource = source;
    await expect(
      observeNativeComposeStorageDockerTarget({
        current,
        engineId,
        selection,
        stopped: true,
        probe: fake.probe,
      })
    ).rejects.toThrow("values omitted");
    expect(
      fake.calls.every(
        (args) =>
          !(
            args.includes("create") ||
            args.includes("start") ||
            args.includes("rm")
          )
      )
    ).toBe(true);
  });
});
test("complete holder inventory keeps a similarly named foreign sibling independent", async () => {
  await withBinding(async (current) => {
    const fake = inventory(current);
    fake.state.foreign = true;
    fake.state.mountType = "bind";
    fake.state.mountName = "";
    fake.state.mountSource = "/var/lib/docker/volumes/owned_data_other/_data";
    expect(
      (
        await observeNativeComposeStorageDockerTarget({
          current,
          engineId,
          selection,
          stopped: true,
          probe: fake.probe,
        })
      ).holders
    ).toEqual([]);
  });
  expect(
    nativeComposeStorageDockerPathsOverlap(
      "relative/path",
      "/var/lib/docker/volumes/owned_data/_data"
    )
  ).toBe(false);
});
function input(): NativeComposeStorageXattrInvocation {
  return {
    recordCreated: async () => {},
    invocationId: "a".repeat(32),
    artifact: NATIVE_STORAGE_DOCKER_ARTIFACT,
    target: {
      ...selection,
      engineId,
      runtimeIdentity: "owned",
      ownerToken: "b".repeat(32),
      volume: { ...selection, createdAt },
      mountpoint: `/var/lib/docker/volumes/${selection.name}/_data`,
      driver: "local",
      options: {},
      holders: [],
    },
    readonly: true,
    uid: 70,
    gid: 70,
    request: { kind: "directory-xattr", version: 1, operation: "root" },
    scope: {
      generationId: "d".repeat(32),
      currentGenerationId: "d".repeat(32),
      pendingGenerationId: null,
      pendingToken: null,
    },
  };
}
function carrier(input: NativeComposeStorageXattrInvocation) {
  const program = "/private-owned/helper.mjs";
  const rootMount = {
    Type: "volume",
    Name: input.target.name,
    Source: input.target.mountpoint,
    Destination: "/hack-storage-witness",
    Driver: "local",
    Mode: "",
    RW: !input.readonly,
    Propagation: "",
  };
  const volumeOptions: Record<string, unknown> = { NoCopy: true };
  const rootConfig: Record<string, unknown> = {
    Type: "volume",
    Source: input.target.name,
    Target: "/hack-storage-witness",
    ...(input.readonly ? { ReadOnly: true } : {}),
    VolumeOptions: volumeOptions,
  };
  const mounts: Record<string, unknown>[] = [
    {
      Type: "bind",
      Source: program,
      Destination: "/hack-storage-witness-helper.mjs",
      RW: false,
      Propagation: "rprivate",
    },
    rootMount,
  ];
  const value = {
    id: "e".repeat(64),
    createdAt,
    image: input.artifact.imageId,
    configImage: nativeComposeStorageDockerImageReference(input.artifact),
    user: "70:70",
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
      OomKillDisable: false as false | null | true,
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
        rootConfig,
      ],
    },
    mounts,
    state: {},
    execIds: null as null | string[],
  };
  return { program, value, rootMount, rootConfig, volumeOptions };
}

function readonlyRecovery() {
  const selected = { ...input() };
  selected.request = {
    kind: "directory-xattr",
    version: 1,
    operation: "verify",
    name: `user.hack.storage.${"a".repeat(64)}`,
    valueHex: "ab".repeat(32),
    root: { device: "1", inode: "42", uid: 70, gid: 70 },
  };
  const fake = carrier(selected);
  const value = {
    ...fake.value,
    host: {
      ...fake.value.host,
      RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
    },
    state: {
      Status: "created",
      Running: false,
      Pid: 0,
      ExitCode: 0,
      Paused: false,
      Restarting: false,
      OOMKilled: false,
      Dead: false,
      Error: "",
    } as Record<string, unknown>,
  };
  return {
    input: selected,
    value,
    program: fake.program,
    imageIds: [selected.artifact.imageId],
    created: { id: value.id, createdAt },
    fake,
  };
}

test.each([
  "created",
  "exited",
])("readonly recovery admits only retained %s observations, with no completion inference", (status) => {
  const fixture = readonlyRecovery();
  fixture.value.state.Status = status;
  fixture.value.state.ExitCode = status === "exited" ? 1 : 0;
  const value = checkNativeComposeStorageReadonlyCarrierRecovery(fixture);
  expect(value.state.Status).toBe(status);
  expect(value.id).toBe(fixture.created.id);
  expect(value).not.toHaveProperty("settled");
  expect(value).not.toHaveProperty("complete");
});

test.each([
  ["Running", true],
  ["Pid", 123],
  ["Status", "running"],
  ["Paused", true],
  ["Restarting", true],
  ["OOMKilled", true],
  ["Dead", true],
  ["Error", "private-canary"],
  ["ExitCode", Number.NaN],
  ["ExitCode", undefined],
] as const)("readonly recovery refuses unsafe or incomplete helper state %s", (field, value) => {
  const fixture = readonlyRecovery();
  fixture.value.state[field] = value;
  expect(() =>
    checkNativeComposeStorageReadonlyCarrierRecovery(fixture)
  ).toThrow("values omitted");
});

test.each([
  "id",
  "birth",
  "exec",
  "retry",
  "writable",
  "root",
  "seed",
  "helper-bind",
  "volume-bind",
] as const)("readonly recovery keeps exact %s policy fences", (failure) => {
  const fixture = readonlyRecovery();
  if (failure === "id") {
    fixture.created.id = "f".repeat(64);
  }
  if (failure === "birth") {
    fixture.created.createdAt = "2026-10-08T12:01:00Z";
  }
  if (failure === "exec") {
    fixture.value.execIds = ["f".repeat(64)];
  }
  if (failure === "retry") {
    fixture.value.host.RestartPolicy.MaximumRetryCount = 1;
  }
  if (failure === "writable") {
    fixture.input.readonly = false;
  }
  if (failure === "root") {
    fixture.input.request = {
      kind: "directory-xattr",
      version: 1,
      operation: "root",
    };
  }
  if (failure === "seed" && fixture.input.request.operation === "verify") {
    fixture.input.request = { ...fixture.input.request, operation: "seed" };
  }
  if (failure === "helper-bind") {
    fixture.program = "/foreign/helper.mjs";
  }
  if (failure === "volume-bind") {
    fixture.fake.rootMount.RW = true;
  }
  expect(() =>
    checkNativeComposeStorageReadonlyCarrierRecovery(fixture)
  ).toThrow("values omitted");
});

test("carrier policy accepts the Docker 28 empty DriverConfig default beside NoCopy", () => {
  const selected = input();
  const fixture = carrier(selected);
  fixture.volumeOptions.DriverConfig = {};
  const checked = checkNativeComposeStorageDockerCarrier({
    value: fixture.value,
    input: selected,
    program: fixture.program,
    imageIds: [selected.artifact.imageId],
  });
  expect(typeof nativeComposeStorageDockerCarrierPolicy(checked)).toBe(
    "string"
  );
  for (const extra of [{ Labels: {} }, { Subpath: "" }] as const) {
    const refused = carrier(selected);
    Object.assign(refused.volumeOptions, extra);
    let caught: unknown;
    try {
      checkNativeComposeStorageDockerCarrier({
        value: refused.value,
        input: selected,
        program: refused.program,
        imageIds: [selected.artifact.imageId],
      });
    } catch (error) {
      caught = error;
    }
    expect(nativeComposeEffectRefusal(caught)).toEqual({
      stage: "storage-helper-policy",
      reason: "helper-storage-request",
    });
  }
});
test.each([
  "helper-shape",
  "helper-command",
  "helper-labels",
  "helper-host-policy",
  "helper-mount-cardinality",
  "helper-program-mount",
  "helper-storage-request",
  "helper-storage-identity",
  "helper-storage-mount",
  "helper-policy-stability",
] as const)("carrier policy identifies the closed %s conjunct without values", (reason) => {
  const selected = input();
  const fixture = carrier(selected);
  const { value } = fixture;
  switch (reason) {
    case "helper-shape":
      value.id = "private-shape-canary";
      break;
    case "helper-command":
      value.user = "private-user-canary";
      break;
    case "helper-labels":
      value.labels["io.hack.storage-witness.owner"] = "private-owner-canary";
      break;
    case "helper-host-policy":
      value.host.NetworkMode = "private-network-canary";
      break;
    case "helper-mount-cardinality":
      fixture.rootConfig.Target = "/hack-storage-witness-helper.mjs";
      break;
    case "helper-program-mount":
      value.mounts[0] = { ...value.mounts[0], Source: "private-mount-canary" };
      break;
    case "helper-storage-request":
      fixture.volumeOptions.DriverConfig = { Name: "private-driver-canary" };
      break;
    case "helper-storage-identity":
      fixture.rootMount.Driver = "private-driver-canary";
      break;
    case "helper-storage-mount":
      fixture.rootMount.RW = true;
      break;
    case "helper-policy-stability":
      value.host.OomKillDisable = true;
      break;
    default:
      throw new Error("Unknown fixed policy discriminator");
  }
  let caught: unknown;
  try {
    const checked = checkNativeComposeStorageDockerCarrier({
      value,
      input: selected,
      program: fixture.program,
      imageIds: [selected.artifact.imageId],
    });
    nativeComposeStorageDockerCarrierPolicy(checked);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect(caught instanceof Error ? caught.message : null).toBe(
    "Native storage xattr proof refused; values omitted."
  );
  retainNativeComposeEffectRefusal(caught, {
    stage: "storage-enrollment",
    reason: "unclassified",
  });
  expect(nativeComposeEffectRefusal(caught)).toEqual({
    stage: "storage-helper-policy",
    reason,
  });
  expect(JSON.stringify(nativeComposeEffectRefusal(caught))).not.toContain(
    "canary"
  );
});
test.each([
  "omitted",
  "null",
  "empty",
] as const)("Engine empty Tmpfs representation %s preserves the exact carrier projection", (representation) => {
  const selected = { ...input(), uid: 0, gid: 0 };
  const fake = carrier(selected);
  fake.value.user = "0:0";
  const host: Record<string, unknown> = fake.value.host;
  if (representation === "omitted") {
    Reflect.deleteProperty(host, "Tmpfs");
  } else {
    host.Tmpfs = representation === "null" ? null : {};
  }
  // Exercise the serialized Engine shape, including both unchanged mount rows.
  const value: unknown = JSON.parse(JSON.stringify(fake.value));
  const checked = checkNativeComposeStorageDockerCarrier({
    value,
    input: selected,
    program: fake.program,
    imageIds: [selected.artifact.imageId],
  });
  expect(checked.id).toBe(fake.value.id);
  const policy = JSON.parse(nativeComposeStorageDockerCarrierPolicy(checked));
  expect(Object.hasOwn(policy.host, "Tmpfs")).toBe(
    representation !== "omitted"
  );
  expect(policy.mounts).toHaveLength(2);
  expect(policy.host.Mounts).toHaveLength(2);
});
test.each([
  NATIVE_STORAGE_DOCKER_ARTIFACT.imageId,
  "oven/bun:1.4.2-slim",
  `foreign/bun@${NATIVE_STORAGE_DOCKER_ARTIFACT.imageId}`,
  `oven/bun@sha256:${"f".repeat(64)}`,
])("configured image must remain the exact immutable repository reference: %s", (configImage) => {
  const selected = input(),
    fake = carrier(selected);
  fake.value.configImage = configImage;
  expect(() =>
    checkNativeComposeStorageDockerCarrier({
      value: fake.value,
      input: selected,
      program: fake.program,
      imageIds: [selected.artifact.imageId],
    })
  ).toThrow("values omitted");
});
test.each([
  { label: "mount", value: { "/extra": "rw" } },
  { label: "array", value: [] },
  { label: "string", value: "" },
  { label: "number", value: 0 },
  { label: "boolean", value: false },
  { label: "own undefined", value: undefined },
])("Tmpfs $label cannot qualify a helper", ({ value }) => {
  const selected = input(),
    fake = carrier(selected);
  const host: Record<string, unknown> = fake.value.host;
  host.Tmpfs = value;
  expect(() =>
    checkNativeComposeStorageDockerCarrier({
      value: fake.value,
      input: selected,
      program: fake.program,
      imageIds: [selected.artifact.imageId],
    })
  ).toThrow("values omitted");
});

test("helper args require the cached dependency, unchanged program bind and exact nocopy volume", () => {
  const selected = input(),
    fake = carrier(selected);
  expect(nativeComposeStorageDockerHelper().length).toBeGreaterThan(1000);
  const args = nativeComposeStorageDockerCreateArgs({
    input: selected,
    program: fake.program,
  });
  expect(args.slice(-3)).toEqual([
    nativeComposeStorageDockerImageReference(selected.artifact),
    "--no-env-file",
    "/hack-storage-witness-helper.mjs",
  ]);
  expect(args).toContain("never");
  expect(args).toContain("none");
  expect(
    args
      .filter((value) => value.startsWith("type=bind,"))
      .every((value) => value.includes("readonly,bind-recursive=disabled"))
  ).toBe(true);
  expect(args.filter((value) => value.startsWith("type=bind,"))).toHaveLength(
    1
  );
  expect(args.filter((value) => value.startsWith("type=volume,"))).toEqual([
    `type=volume,src=${selected.target.name},dst=/hack-storage-witness,volume-nocopy,readonly`,
  ]);
  expect(args.some((value) => value.includes("bind-create-src"))).toBe(false);
  checkNativeComposeStorageDockerCarrier({
    value: fake.value,
    input: selected,
    program: fake.program,
    imageIds: [selected.artifact.imageId],
  });
});
test.each([
  "empty",
  "subset",
  "duplicate",
  "writable",
  "copying",
  "logging",
] as const)("physical/configured projection %s cannot qualify a helper", (failure) => {
  const selected = input(),
    fake = carrier(selected);
  if (failure === "empty") {
    fake.value.mounts = [];
  }
  if (failure === "subset") {
    fake.value.mounts.pop();
  }
  if (failure === "duplicate") {
    fake.value.mounts[1] = fake.value.mounts[0]!;
  }
  if (failure === "writable") {
    fake.value.mounts[1]!.RW = true;
  }
  if (failure === "copying") {
    fake.volumeOptions.NoCopy = false;
  }
  if (failure === "logging") {
    fake.value.host.LogConfig.Type = "json-file";
  }
  expect(() =>
    checkNativeComposeStorageDockerCarrier({
      value: fake.value,
      input: selected,
      program: fake.program,
      imageIds: [selected.artifact.imageId],
    })
  ).toThrow("values omitted");
});
test("cold seed accepts only the Engine's omitted or explicit false writable default", () => {
  const selected = { ...input(), readonly: false };
  const fake = carrier(selected);
  const check = () =>
    checkNativeComposeStorageDockerCarrier({
      value: fake.value,
      input: selected,
      program: fake.program,
      imageIds: [selected.artifact.imageId],
    });
  expect(check().id).toBe(fake.value.id);
  fake.rootConfig.ReadOnly = false;
  expect(check().id).toBe(fake.value.id);
  fake.rootConfig.ReadOnly = null;
  expect(check).toThrow("values omitted");
  expect(
    nativeComposeStorageDockerCreateArgs({
      input: selected,
      program: fake.program,
    })
  ).toContain(
    `type=volume,src=${selected.target.name},dst=/hack-storage-witness,volume-nocopy`
  );
});
test.each([
  "bind",
  "name",
  "source",
  "driver",
  "propagation",
  "subpath",
  "driver-options",
  "missing-nocopy",
  "missing-ro",
] as const)("named-volume projection %s cannot substitute the selected root", (failure) => {
  const selected = input(),
    fake = carrier(selected);
  if (failure === "bind") {
    fake.rootConfig.Type = "bind";
    fake.rootMount.Type = "bind";
  }
  if (failure === "name") {
    fake.rootMount.Name = "foreign_data";
  }
  if (failure === "source") {
    fake.rootMount.Source = "/var/lib/docker/volumes/foreign_data/_data";
  }
  if (failure === "driver") {
    fake.rootMount.Driver = "foreign";
  }
  if (failure === "propagation") {
    fake.rootMount.Propagation = "rslave";
  }
  if (failure === "subpath") {
    fake.volumeOptions.Subpath = "data";
  }
  if (failure === "driver-options") {
    fake.volumeOptions.DriverConfig = { Name: "local", Options: {} };
  }
  if (failure === "missing-nocopy") {
    Reflect.deleteProperty(fake.volumeOptions, "NoCopy");
  }
  if (failure === "missing-ro") {
    Reflect.deleteProperty(fake.rootConfig, "ReadOnly");
  }
  expect(() =>
    checkNativeComposeStorageDockerCarrier({
      value: fake.value,
      input: selected,
      program: fake.program,
      imageIds: [selected.artifact.imageId],
    })
  ).toThrow("values omitted");
});
test("policy comparison preserves all physical fields/duplicates and closes only observed optional defaults", () => {
  const selected = input(),
    fake = carrier(selected);
  const checked = () =>
    checkNativeComposeStorageDockerCarrier({
      value: fake.value,
      input: selected,
      program: fake.program,
      imageIds: [selected.artifact.imageId],
    });
  const before = nativeComposeStorageDockerCarrierPolicy(checked());
  fake.value.mounts.reverse();
  fake.value.host.OomKillDisable = null;
  fake.value.execIds = [];
  expect(nativeComposeStorageDockerCarrierPolicy(checked())).toBe(before);
  fake.value.host.OomKillDisable = true;
  expect(() => nativeComposeStorageDockerCarrierPolicy(checked())).toThrow();
});
