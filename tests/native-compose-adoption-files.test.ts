import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LegacyComposeRetainedFileError,
  legacyComposeRetainedFileGrants,
  observeLegacyComposeRetainedFileProof,
  observeLegacyComposeRetainedFileSources,
  readLegacyComposeRetainedFileProof,
} from "../src/lib/native-compose-adoption-files.ts";
import {
  planLegacyComposeAdoption,
  planLegacyComposeRetainedFileAdoption,
} from "../src/lib/native-compose-adoption-plan.ts";
import { parseLegacyComposeAdoptionReceipt } from "../src/lib/native-compose-adoption-receipt.ts";
import { mapLegacyOwnedNetwork } from "../src/lib/native-config-import-network.ts";
import {
  mapLegacyNativeRetainedFileAdoptionBaseline,
  mapLegacyNativeRetainedFileStorage,
  mapLegacyNativeStorageAdoption,
} from "../src/lib/native-config-import-plan.ts";

const ID = "a".repeat(64);
const CANARY = "synthetic-private-file-value";
let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "retained-file-proof-")));
  await mkdir(join(root, "material"));
  await writeFile(
    join(root, "material/config"),
    Buffer.from(`${CANARY}\0binary`),
    { mode: 0o444 }
  );
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function candidate() {
  return {
    schema_version: 1,
    name: "fixture",
    services: {
      app: {
        image: "example:fixed",
        mounts: [
          { storage: "data", target: "/data", access: "read-write" },
          {
            config: "settings",
            target: "/settings",
            access: "read-only",
            mode: "0444",
          },
        ],
      },
    },
    storage: { data: { kind: "persistent", scope: "worktree" } },
    configs: {
      settings: { file: "material/config" },
      unused: { file: "missing-file" },
    },
  };
}
function original(running = true) {
  return [{ id: ID, service: "app", running }];
}
async function proof(
  opts: {
    readonly saved?: Awaited<
      ReturnType<typeof observeLegacyComposeRetainedFileProof>
    >;
    readonly running?: boolean;
    readonly mode?: string;
    readonly guestIno?: number;
    readonly guestUid?: number;
    readonly digest?: string;
    readonly beforeDigest?: () => Promise<void>;
  } = {}
) {
  const calls: readonly string[][] = [];
  const seen: string[][] = calls as string[][];
  const sources = await observeLegacyComposeRetainedFileSources({
    projectRoot: root,
    candidate: candidate(),
  });
  const source = sources[0];
  if (!source) {
    throw new Error("test source missing");
  }
  const result = await observeLegacyComposeRetainedFileProof({
    projectRoot: root,
    candidate: candidate(),
    containers: original(opts.running),
    saved: opts.saved,
    probe: async (args) => {
      seen.push([...args]);
      expect(args[0]).toBe("exec");
      expect(args[1]).toBe(ID);
      expect(args.at(-1)).toBe("/settings");
      if (args[2] === "stat") {
        return `7:${opts.guestIno ?? 11}:${opts.guestUid ?? 101}:202:${source.size}:${(0o10_0444).toString(16)}:${opts.mode ?? "444"}\n`;
      }
      if (args[2] !== "sha256sum") {
        throw new Error("unexpected guest command");
      }
      await opts.beforeDigest?.();
      return `${opts.digest ?? source.digest}  /settings\n`;
    },
  });
  return { result, calls };
}
async function refused(operation: Promise<unknown>) {
  let caught: unknown;
  try {
    await operation;
  } catch (error: unknown) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect(String(caught)).not.toContain(CANARY);
}

test("closed file family preserves explicit storage and grants without reading unused declarations", async () => {
  expect(legacyComposeRetainedFileGrants(candidate())).toEqual([
    {
      service: "app",
      kind: "config",
      name: "settings",
      file: "material/config",
      target: "/settings",
    },
  ]);
  const observed = await proof();
  expect(observed.calls).toEqual([
    ["exec", ID, "stat", "-c", "%d:%i:%u:%g:%s:%f:%a", "--", "/settings"],
    ["exec", ID, "sha256sum", "--", "/settings"],
    ["exec", ID, "stat", "-c", "%d:%i:%u:%g:%s:%f:%a", "--", "/settings"],
  ]);
  expect(observed.result.guests[0]?.uid).toBe(101);
  expect(observed.result.guests[0]?.gid).toBe(202);
  expect(JSON.stringify(observed.result)).not.toContain(CANARY);
  expect(await readFile(join(root, "material/config"))).toEqual(
    Buffer.from(`${CANARY}\0binary`)
  );
});

test("empty and binary material retain exact content and never get chmodded", async () => {
  await chmod(join(root, "material/config"), 0o600);
  await writeFile(join(root, "material/config"), Buffer.alloc(0));
  await chmod(join(root, "material/config"), 0o444);
  const { result } = await proof();
  expect(result.sources[0]?.size).toBe(0);
  expect(result.sources[0]?.mode).toBe(0o444);
});

test.each([
  "600",
  "400",
  "444\n",
  "0444",
  "777",
])("guest permission %s cannot stand in for the native 0444 target", async (mode) => {
  await refused(proof({ mode }));
});
test("wrong guest material and current host edits fail before a new proof is issued", async () => {
  await refused(proof({ digest: "b".repeat(64) }));
  await refused(
    proof({
      beforeDigest: async () => {
        await chmod(join(root, "material/config"), 0o600);
        await writeFile(join(root, "material/config"), "changed");
      },
    })
  );
});
test("fresh reads refuse symlink, hardlink and equal-byte inode replacement", async () => {
  const saved = (await proof()).result;
  await rename(join(root, "material/config"), join(root, "material/original"));
  await symlink("original", join(root, "material/config"));
  await refused(proof({ saved }));
  await rm(join(root, "material/config"));
  await link(join(root, "material/original"), join(root, "material/config"));
  await refused(proof({ saved }));
  await rm(join(root, "material/config"));
  await writeFile(
    join(root, "material/config"),
    Buffer.from(`${CANARY}\0binary`),
    { mode: 0o444 }
  );
  await refused(proof({ saved }));
});
test("stopped originals need a prior guest proof; saved proof parsing does not acquire missing material", async () => {
  await refused(proof({ running: false }));
  const saved = (await proof()).result;
  const observed = await proof({ saved, running: false });
  expect(observed.calls).toHaveLength(0);
  await rm(join(root, "material/config"));
  expect(
    readLegacyComposeRetainedFileProof({
      proof: saved,
      candidate: candidate(),
      containers: original(false),
    })
  ).toEqual(saved);
  await refused(proof({ saved, running: false }));
});
test("guest inode and effective UID drift cannot reuse a previous material proof", async () => {
  const saved = (await proof()).result;
  await refused(proof({ saved, guestIno: 12 }));
  await refused(proof({ saved, guestUid: 0 }));
});
test("saved proof cannot invent sources, guests, extra keys or a foreign original ID", async () => {
  const saved = (await proof()).result;
  for (const value of [
    { ...saved, leakedValue: CANARY },
    { ...saved, sources: [] },
    { ...saved, guests: [...saved.guests, saved.guests[0]] },
    { ...saved, sources: new Array(1) },
    {
      ...saved,
      guests: saved.guests.map((guest) => ({ ...guest, mode: "0600" })),
    },
    {
      ...saved,
      guests: saved.guests.map((guest) => ({
        ...guest,
        container: "b".repeat(64),
      })),
    },
  ]) {
    expect(() =>
      readLegacyComposeRetainedFileProof({
        proof: value,
        candidate: candidate(),
        containers: original(),
      })
    ).toThrow(LegacyComposeRetainedFileError);
  }
});
test("required target is own-only and a malformed mount cannot invoke inherited code", () => {
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, "target");
  let reads = 0;
  try {
    Object.defineProperty(Object.prototype, "target", {
      configurable: true,
      get() {
        reads++;
        return "/forged";
      },
    });
    const value = candidate();
    value.services.app.mounts = [Object.create(null)];
    expect(() => legacyComposeRetainedFileGrants(value)).toThrow(
      LegacyComposeRetainedFileError
    );
    expect(reads).toBe(0);
  } finally {
    if (previous) {
      Object.defineProperty(Object.prototype, "target", previous);
    } else {
      Reflect.deleteProperty(Object.prototype, "target");
    }
  }
});
test("saved proof and candidate arrays reject own index accessors and custom iteration without reads", async () => {
  const saved = (await proof()).result;
  let reads = 0;
  const accessor = (value: unknown) => {
    const array = [value];
    Object.defineProperty(array, "0", {
      enumerable: true,
      configurable: true,
      get() {
        reads++;
        return value;
      },
    });
    return array;
  };
  for (const value of [
    { ...saved, sources: accessor(saved.sources[0]) },
    { ...saved, guests: accessor(saved.guests[0]) },
  ]) {
    expect(() =>
      readLegacyComposeRetainedFileProof({
        proof: value,
        candidate: candidate(),
        containers: original(),
      })
    ).toThrow(LegacyComposeRetainedFileError);
  }
  const input = candidate();
  input.services.app.mounts = accessor(
    input.services.app.mounts[0]
  ) as typeof input.services.app.mounts;
  expect(() => legacyComposeRetainedFileGrants(input)).toThrow(
    LegacyComposeRetainedFileError
  );
  expect(() =>
    readLegacyComposeRetainedFileProof({
      proof: saved,
      candidate: candidate(),
      containers: accessor(original()[0]) as ReturnType<typeof original>,
    })
  ).toThrow(LegacyComposeRetainedFileError);
  const iterated = [saved.sources[0]];
  Object.defineProperty(iterated, Symbol.iterator, {
    get() {
      reads++;
      return Array.prototype[Symbol.iterator];
    },
  });
  expect(() =>
    readLegacyComposeRetainedFileProof({
      proof: { ...saved, sources: iterated },
      candidate: candidate(),
      containers: original(),
    })
  ).toThrow(LegacyComposeRetainedFileError);
  expect(reads).toBe(0);
});
test("first retained family refuses secret/build/job/profile/health/network intersections before material", () => {
  for (const value of [
    { ...candidate(), jobs: {} },
    { ...candidate(), networks: {} },
    {
      ...candidate(),
      services: {
        app: { ...candidate().services.app, profiles: ["inactive"] },
      },
    },
    {
      ...candidate(),
      services: {
        app: { ...candidate().services.app, readiness: { kind: "exec" } },
      },
    },
    {
      ...candidate(),
      services: {
        app: { ...candidate().services.app, build: { context: "." } },
      },
    },
    {
      ...candidate(),
      secrets: { settings: { file: "material/config" } },
      services: {
        app: {
          image: "example",
          mounts: [
            {
              secret: "settings",
              target: "/settings",
              access: "read-only",
              mode: "0444",
            },
          ],
        },
      },
    },
  ]) {
    expect(() => legacyComposeRetainedFileGrants(value)).toThrow(
      LegacyComposeRetainedFileError
    );
  }
});
test("distinct file storage mapper preserves named volume plus explicit grant and ordinary baseline refuses", () => {
  const source = {
    configText: '{"name":"fixture"}',
    composeText:
      "name: fixture\nservices:\n  app:\n    image: example:fixed\n    configs: [settings]\n    volumes: [data:/data]\nconfigs:\n  settings:\n    file: ../material/config\nvolumes:\n  data:\n    name: fixture_data\n",
  };
  expect(planLegacyComposeAdoption(source).intent).toBeUndefined();
  expect(mapLegacyNativeStorageAdoption(source).candidate).toBeUndefined();
  expect(planLegacyComposeRetainedFileAdoption(source).intent?.volumes).toEqual(
    [{ storage: "data", name: "fixture_data" }]
  );
  const mapped = mapLegacyNativeRetainedFileStorage(source).candidate;
  expect(mapped?.services).toEqual({
    app: {
      image: "example:fixed",
      mounts: [
        { storage: "data", target: "/data", access: "read-write" },
        {
          config: "settings",
          target: "/settings",
          access: "read-only",
          mode: "0444",
        },
      ],
    },
  });
});
test("issued private non-enumerable source fields survive both retained-file mapper seams", () => {
  const compose =
    "name: fixture\nservices:\n  app:\n    image: example:fixed\n    configs: [settings]\nconfigs:\n  settings:\n    file: ../material/config\n";
  const issued = Object.freeze(
    Object.defineProperties(
      {},
      {
        configText: { value: '{"name":"fixture"}' },
        composeText: { value: compose },
      }
    )
  ) as { readonly configText: string; readonly composeText: string };
  expect(Object.keys(issued)).toEqual([]);
  const baseline = mapLegacyNativeRetainedFileAdoptionBaseline(issued);
  expect(baseline.candidate?.configs).toEqual({
    settings: { file: "material/config" },
  });
  expect(baseline.candidate?.services).toEqual({
    app: {
      image: "example:fixed",
      mounts: [
        {
          config: "settings",
          target: "/settings",
          access: "read-only",
          mode: "0444",
        },
      ],
    },
  });
  const storageIssued = Object.freeze(
    Object.defineProperties(
      {},
      {
        configText: { value: issued.configText },
        composeText: {
          value: `${compose.replace(
            "    configs: [settings]",
            "    configs: [settings]\n    volumes: [data:/data]"
          )}volumes:\n  data:\n    name: fixture_data\n`,
        },
      }
    )
  ) as { readonly configText: string; readonly composeText: string };
  const storage = mapLegacyNativeRetainedFileStorage(storageIssued);
  expect(storage.candidate?.storage).toEqual({
    data: { kind: "persistent", scope: "worktree" },
  });
  expect(storage.candidate?.services).toEqual({
    app: {
      image: "example:fixed",
      mounts: [
        { storage: "data", target: "/data", access: "read-write" },
        {
          config: "settings",
          target: "/settings",
          access: "read-only",
          mode: "0444",
        },
      ],
    },
  });
});

test.each([
  { networks: { private: { internal: true } }, attached: ["private"] },
  {
    networks: { private: { internal: true }, outward: { internal: false } },
    attached: { private: {}, outward: {} },
  },
])("file8 preparation stays separate from one or two canonical owned bridges: %j", ({
  networks,
  attached,
}) => {
  const composeText = JSON.stringify({
    name: "fixture",
    networks,
    configs: { settings: { file: "../material/config" } },
    volumes: { data: { name: "fixture_data" } },
    services: {
      app: {
        image: "fixture:pinned",
        networks: attached,
        configs: ["settings"],
        volumes: ["data:/data"],
      },
    },
  });
  const source = { configText: '{"name":"fixture"}', composeText };
  expect(
    mapLegacyOwnedNetwork({
      project: "fixture",
      compose: JSON.parse(composeText),
    }).kind
  ).toBe(Object.keys(networks).length === 1 ? "owned" : "multiple");
  for (const mapped of [
    mapLegacyNativeRetainedFileAdoptionBaseline(source),
    mapLegacyNativeRetainedFileStorage(source),
  ]) {
    expect(mapped.candidate).toBeUndefined();
    expect(mapped.report.complete).toBe(false);
    expect(mapped.report.fields).toContainEqual(
      expect.objectContaining({
        pointer: "/networks",
        status: "refused",
        code: "retained_file_network_unsupported",
      })
    );
  }
  const planned = planLegacyComposeRetainedFileAdoption(source);
  expect(planned.report.supported).toBe(false);
  expect(planned.intent).toBeUndefined();
  expect(JSON.stringify(planned)).not.toContain("material/config");
});

test("shared receipt decoder preserves closed file8 and plural bridge11 versions without granting a mixed owner", () => {
  const checkout = {
    root: { dev: 1, ino: 2 },
    project: { dev: 1, ino: 3 },
    git: { dev: 1, ino: 4 },
  };
  const value = {
    kind: "legacy-compose-adopted",
    checkout,
    prepared: null,
    publication: null,
    pendingOperation: null,
  };
  for (const version of [1, 3, 4, 5, 6, 8, 10, 11] as const) {
    expect(
      parseLegacyComposeAdoptionReceipt(
        { ...value, adoption_receipt_version: version },
        checkout
      ).adoption_receipt_version
    ).toBe(version);
  }
  for (const version of [7, 8] as const) {
    const prepared = {
      id: "b".repeat(32),
      manifest: { dev: 1, ino: 5, hash: "c".repeat(64) },
    };
    expect(
      parseLegacyComposeAdoptionReceipt(
        { ...value, adoption_receipt_version: version, prepared },
        checkout
      ).adoption_receipt_version
    ).toBe(version);
  }
  for (const version of [2, 7, 9, 12, null, "8", "11"]) {
    expect(() =>
      parseLegacyComposeAdoptionReceipt(
        { ...value, adoption_receipt_version: version },
        checkout
      )
    ).toThrow();
  }
  expect(() =>
    parseLegacyComposeAdoptionReceipt(
      { ...value, adoption_receipt_version: 8, networks: [] },
      checkout
    )
  ).toThrow();
});

test("current job7 and file8 purposes remain separate before any material or engine acquisition", () => {
  const compose = {
    name: "fixture",
    services: {
      initialize: { image: "fixture:1", command: ["true"], restart: "no" },
      app: {
        image: "fixture:1",
        depends_on: {
          initialize: { condition: "service_completed_successfully" },
        },
        volumes: ["data:/data"],
      },
    },
    volumes: { data: { name: "fixture_data" } },
  };
  const source = {
    configText: '{"name":"fixture"}',
    composeText: JSON.stringify(compose),
  };
  const ordinary = planLegacyComposeAdoption(source);
  expect(ordinary.report.supported).toBe(true);
  expect(ordinary.intent).toBeDefined();
  for (const mapped of [
    mapLegacyNativeRetainedFileAdoptionBaseline(source),
    mapLegacyNativeRetainedFileStorage(source),
  ]) {
    expect(mapped.report.complete).toBe(false);
    expect(mapped.candidate).toBeUndefined();
  }
  const mixed = {
    ...source,
    composeText: JSON.stringify({
      ...compose,
      configs: { settings: { file: "../material/config" } },
      services: {
        ...compose.services,
        app: { ...compose.services.app, configs: ["settings"] },
      },
    }),
  };
  for (const plan of [
    planLegacyComposeAdoption(mixed),
    planLegacyComposeRetainedFileAdoption(mixed),
  ]) {
    expect(plan.report.supported).toBe(false);
    expect(plan.intent).toBeUndefined();
    expect(JSON.stringify(plan)).not.toContain("material/config");
  }
});
