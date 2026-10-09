import { expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "../src/lib/guards.ts";
import { runCommand } from "./e2e/harness.ts";
import {
  assertSourceBindFixtureHostBytes,
  prepareSourceBindFixtureSources,
  SOURCE_BIND_FIXTURE_OWNER_FORMAT,
  sourceBindFixtureDirectorySnapshot,
  sourceBindFixtureMountObservation,
  sourceBindFixtureMutationAllowed,
  sourceBindFixtureReadAllowed,
} from "./e2e/scenarios/native-compose-adoption-source-bind-inputs.ts";
import {
  cleanupOwnedAdoptionFixture,
  sourceBindFixtureCommand,
} from "./e2e/scenarios/native-compose-adoption-worktrees.ts";
import { withDockerContainerFormatFixture } from "./helpers/docker-container-format.ts";
import { retainedSourceBindFixture } from "./helpers/retained-source-bind-adoption.ts";

const ID = "a".repeat(64),
  OTHER = "b".repeat(64);
const ANCHOR = {
  id: "e".repeat(32),
  manifest: { dev: 1, ino: 2, hash: "f".repeat(64) },
};
const ACTIVE = {
  adoption_receipt_version: 12,
  prepared: ANCHOR,
  publication: { phase: "active", generation: ANCHOR },
  pendingOperation: {
    operation: "start",
    generation: ANCHOR,
    services: ["db", "worker"],
  },
};
const RECOVER = ["down", "--recover", "--json"];
const CANARY = "synthetic-private-fixture-output";

async function emitted(opts: {
  readonly args: string[];
  readonly receipt?: unknown;
  readonly effect?: readonly string[];
  readonly engineId?: string;
  readonly mutateCaller?: boolean;
}) {
  const outer = await mkdtemp(join(tmpdir(), "source-bind-guard-"));
  const root = join(outer, "checkout"),
    forwarded = join(outer, "forwarded"),
    engine = join(outer, "synthetic-engine");
  const instance = {
    root,
    name: "fixture",
    marker: "synthetic-sql-marker",
    sourceBinds: "first" as const,
  };
  const saved = join(
    root,
    ".hack/.internal/legacy-compose-adoption-v1/receipt.json"
  );
  try {
    await chmod(outer, 0o700);
    await mkdir(join(root, ".hack/.internal/legacy-compose-adoption-v1"), {
      recursive: true,
      mode: 0o700,
    });
    const before = JSON.stringify(opts.receipt ?? ACTIVE);
    await writeFile(saved, before, { mode: 0o600 });
    await writeFile(
      engine,
      [
        `#!${process.execPath}`,
        "import {appendFile} from 'node:fs/promises';",
        "const args=process.argv.slice(2);",
        `await appendFile(${JSON.stringify(forwarded)},JSON.stringify(args)+'\\n');`,
        `if(JSON.stringify(args)===JSON.stringify(['info','--format','{{json .ID}}'])){console.log(${JSON.stringify(opts.engineId ?? "synthetic-daemon")});process.exit(0);}`,
        `if(JSON.stringify(args)===JSON.stringify(['container','stop',${JSON.stringify(ID)}]))process.exit(0);`,
        "process.exit(97);",
      ].join("\n"),
      { mode: 0o700 }
    );
    let invocation: readonly string[] = [];
    const result = await sourceBindFixtureCommand(
      {
        ctx: { tempRoot: outer },
        engine,
        engineId: "synthetic-daemon",
        anchors: new Map([
          [
            instance,
            {
              source: "synthetic-original-source",
              resources: {
                container: [
                  { id: ID, service: "db" },
                  { id: OTHER, service: "worker" },
                ],
                network: [{ id: "d".repeat(64) }],
                volume: [{ id: "fixture_data" }],
              },
            },
          ],
        ]),
        rawCli: async (selected, args, env) => {
          expect(selected).toBe(instance);
          invocation = args;
          if (opts.mutateCaller) {
            opts.args.splice(0, opts.args.length, "up");
          }
          return await runCommand({
            argv: ["docker", ...(opts.effect ?? ["container", "stop", ID])],
            cwd: root,
            env,
            timeoutMs: 5000,
          });
        },
      },
      instance,
      opts.args
    );
    const calls: readonly unknown[] = (await Bun.file(forwarded).exists())
      ? (await readFile(forwarded, "utf8"))
          .trim()
          .split("\n")
          .map((line): unknown => JSON.parse(line))
      : [];
    return {
      result,
      calls,
      invocation,
      before,
      after: await readFile(saved, "utf8"),
    };
  } finally {
    await rm(outer, { recursive: true, force: true });
  }
}

test("emitted v12 recovery stop uses the exact snapshotted capability and original ID", async () => {
  const observed = await emitted({ args: [...RECOVER], mutateCaller: true });
  expect(observed.invocation).toEqual(RECOVER);
  expect(Object.isFrozen(observed.invocation)).toBe(true);
  expect(observed.result.exitCode).toBe(0);
  expect(observed.result.timedOut).toBe(false);
  expect(observed.calls).toEqual([
    ["info", "--format", "{{json .ID}}"],
    ["container", "stop", ID],
  ]);
  expect(observed.after).toBe(observed.before);
});

for (const [name, args] of [
  ["ordinary", ["down", "--json"]],
  ["reordered", ["down", "--json", "--recover"]],
  ["extended", [...RECOVER, "--force"]],
] as const) {
  test(`emitted v12 pending start rejects ${name} recovery without forwarding`, async () => {
    const observed = await emitted({ args: [...args] });
    expect(observed.result.exitCode).toBe(94);
    expect(observed.calls).toEqual([]);
    expect(observed.after).toBe(observed.before);
  });
}

for (const [name, receipt] of [
  ["unpublished", { ...ACTIVE, publication: null }],
  ["foreign-version", { ...ACTIVE, adoption_receipt_version: 9 }],
  [
    "foreign-generation",
    { ...ACTIVE, prepared: { ...ANCHOR, id: "0".repeat(32) } },
  ],
  ["malformed-anchor", { ...ACTIVE, prepared: { id: ANCHOR.id } }],
  [
    "partial-services",
    {
      ...ACTIVE,
      pendingOperation: { ...ACTIVE.pendingOperation, services: ["db"] },
    },
  ],
] as const) {
  test(`emitted v12 ${name} journal cannot authorize a stop`, async () => {
    const observed = await emitted({ args: [...RECOVER], receipt });
    expect(observed.result.exitCode).toBe(94);
    expect(observed.calls).toEqual([]);
  });
}

test("emitted v12 changed daemon refuses before the exact stop", async () => {
  const observed = await emitted({
    args: [...RECOVER],
    engineId: "foreign-daemon",
  });
  expect(observed.result.exitCode).toBe(95);
  expect(observed.calls).toEqual([["info", "--format", "{{json .ID}}"]]);
});

for (const [name, effect, code] of [
  ["build", ["compose", "build"], 93],
  ["allocation", ["container", "create", "fixture"], 93],
  ["foreign-ID", ["container", "stop", "c".repeat(64)], 94],
  [
    "private-format",
    ["container", "inspect", "--format", "{{json .Config.Env}}", ID],
    93,
  ],
] as const) {
  test(`both symbolic preview wiring and v12 ${name} passthrough stay closed`, async () => {
    const observed = await emitted({
      args: ["config", "adopt", "--dry-run", "--stop", "--json"],
      effect,
    });
    expect(observed.result.exitCode).toBe(code);
    expect(observed.calls).toEqual([]);
    expect(observed.after).toBe(observed.before);
  });
}

test("the emitted read allowlist admits the actual shipping v12 preparation queries", async () => {
  const h = await retainedSourceBindFixture();
  const store = await h.store();
  try {
    await store.prepare({ binary: h.compiler });
    const receipt = await h.receipt();
    if (
      !(isRecord(receipt.prepared) && typeof receipt.prepared.id === "string")
    ) {
      throw new Error("Synthetic generation missing");
    }
    const generationId = receipt.prepared.id;
    const commands = await h.commands();
    const inspect = commands.filter(
      (args) =>
        args[0] === "container" &&
        args[1] === "inspect" &&
        args[3]?.includes(".Mounts")
    );
    expect(inspect.length).toBeGreaterThan(0);
    expect(
      inspect.every((args) => args[3] === SOURCE_BIND_FIXTURE_OWNER_FORMAT)
    ).toBe(true);
    expect(
      commands.every((args) =>
        sourceBindFixtureReadAllowed({
          args,
          projectRoot: h.root,
          project: "fixture",
          containerIds: [ID],
          networkId: OTHER,
          volumeName: "fixture_data",
          generationId,
        })
      )
    ).toBe(true);
  } finally {
    await store.close();
    await h.cleanup();
  }
}, 30_000);

test("source-bind mount oracle preserves every Source/Target/access row and rejects duplicates", () => {
  const instance = { root: "/synthetic/checkout", name: "fixture" };
  const mounts = [
    {
      type: "volume",
      name: "fixture_data",
      source: null,
      target: "/var/lib/postgresql/data",
      rw: false,
    },
    ...[
      ["bind-ro", "/source-ro", false],
      ["bind-rw", "/source-rw", true],
      ["bind-generated", "/source-generated", false],
      [".", "/checkout", false],
    ].map(([path, target, rw]) => ({
      type: "bind",
      name: null,
      source: join(instance.root, String(path)),
      target,
      rw,
    })),
  ];
  const value = sourceBindFixtureMountObservation({
    instance,
    service: "worker",
    mounts,
  });
  expect(value).toContain("/source-rw");
  for (const changed of [
    [...mounts, mounts[1]],
    mounts.slice(1),
    mounts.map((row) =>
      row.target === "/source-ro" ? { ...row, rw: true } : row
    ),
    mounts.map((row) =>
      row.target === "/source-rw" ? { ...row, source: "/foreign" } : row
    ),
  ]) {
    expect(() =>
      sourceBindFixtureMountObservation({
        instance,
        service: "worker",
        mounts: changed,
      })
    ).toThrow("values omitted");
  }
});

test("same directory allows runtime contents, while replacement retains cleanup authority", async () => {
  const outer = await mkdtemp(join(tmpdir(), "source-bind-cleanup-"));
  const instance = {
    root: outer,
    name: "fixture",
    marker: CANARY,
    sourceBinds: "first" as const,
  };
  try {
    await chmod(outer, 0o700);
    await prepareSourceBindFixtureSources(instance);
    const original = await sourceBindFixtureDirectorySnapshot(outer);
    await writeFile(
      join(outer, "bind-rw/runtime-marker"),
      "source-bind-fixture-rw-written\n"
    );
    await assertSourceBindFixtureHostBytes(instance);
    expect(await sourceBindFixtureDirectorySnapshot(outer)).toBe(original);
    await rename(join(outer, "bind-rw"), join(outer, "original"));
    await mkdir(join(outer, "bind-rw"), { mode: 0o700 });
    let removals = 0,
      resourceReads = 0;
    const resources = {
      container: [{ id: ID, service: "db" }],
      network: [],
      volume: [],
    };
    await expect(
      cleanupOwnedAdoptionFixture({
        engineId: "synthetic-daemon",
        instances: [instance],
        anchors: new Map([
          [instance, { resources, source: "synthetic-source" }],
        ]),
        sourceBindAnchors: new Map([[instance, original]]),
        resources: async () => {
          resourceReads++;
          return resources;
        },
        probe: async () => "synthetic-daemon",
        owned: async () => ({ id: ID }),
        list: async () => [],
        effect: async () => {
          removals++;
          throw new Error("Unexpected removal");
        },
      })
    ).rejects.toThrow("values omitted");
    expect(removals).toBe(0);
    expect(resourceReads).toBe(0);
  } finally {
    await rm(outer, { recursive: true, force: true });
  }
});

test("full v12 selection alone does not authorize a malformed generation", () => {
  expect(
    sourceBindFixtureMutationAllowed({
      args: ["container", "stop", ID],
      recoverPendingStartStop: true,
      scope: {
        projectRoot: "/synthetic",
        project: "fixture",
        containerIds: [ID, OTHER],
        db: ID,
        worker: OTHER,
        networkId: "d".repeat(64),
        volumeName: "fixture_data",
      },
      receipt: {
        ...ACTIVE,
        prepared: { ...ANCHOR, manifest: { ...ANCHOR.manifest, hash: CANARY } },
      },
    })
  ).toBe(false);
});

const docker = process.env.HACK_TEST_DOCKER_FORMAT_BINARY;
const dockerHash = process.env.HACK_TEST_DOCKER_FORMAT_SHA256;
(docker && dockerHash ? test : test.skip)(
  "real pinned Docker formats absent bind Name on an owned synthetic endpoint",
  async () => {
    if (!(docker && dockerHash)) {
      throw new Error("Explicit pinned Docker fixture missing");
    }
    const container = {
      Id: ID,
      Name: "/fixture-db-1",
      Config: { Labels: {} },
      State: { Running: false },
      NetworkSettings: { Networks: {} },
      Mounts: [
        {
          Type: "bind",
          Source: "/synthetic/checkout",
          Destination: "/work",
          RW: false,
        },
      ],
    };
    await withDockerContainerFormatFixture({
      binary: docker,
      sha256: dockerHash,
      container,
      observe: async (probe) => {
        await expect(
          probe(
            SOURCE_BIND_FIXTURE_OWNER_FORMAT.replace(
              'json (index $m "Name")',
              "json $m.Name"
            )
          )
        ).rejects.toThrow();
        const value: unknown = JSON.parse(
          await probe(SOURCE_BIND_FIXTURE_OWNER_FORMAT)
        );
        if (!(isRecord(value) && Array.isArray(value.mounts))) {
          throw new Error("Synthetic mount row missing");
        }
        expect(value.mounts).toEqual([
          {
            type: "bind",
            name: null,
            source: "/synthetic/checkout",
            target: "/work",
            rw: false,
          },
        ]);
      },
    });
  },
  30_000
);
