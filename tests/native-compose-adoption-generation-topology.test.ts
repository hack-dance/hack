import { test as boundedTest, expect } from "bun:test";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tryLegacyComposeAdoptedCommand } from "../src/lib/native-compose-adoption-command.ts";
import { openLegacyComposeAdoptedGenerationStore } from "../src/lib/native-compose-adoption-generation.ts";
import { previewLegacyComposeAdoption } from "../src/lib/native-compose-adoption-preview.ts";
import { restoreEnv } from "./helpers/env.ts";
import { createAdoptionGenerationFixture } from "./helpers/native-compose-adoption-generation-fixture.ts";

const context = createAdoptionGenerationFixture();
const {
  ADOPTION_CASE_TIMEOUT_MS,
  retainedOperationCaseTimeout,
  test,
  ID,
  NETWORK,
  CREATED,
  save,
  ownedBridge,
  twoOwnedBridges,
  container,
  volume,
  network,
  compiler,
  stateRoot,
  prepared,
  dependencyFixture,
  combinedBridgeHealthFixture,
  mutationCommands,
  completedJobFixture,
  artifactPath,
  refusal,
  readReceipt,
  writeReceipt,
  originalSnapshots,
  expectOriginals,
} = context;

test("v6 static owned bridge preserves the selected original IDs through saved publication and rollback", async () => {
  await ownedBridge();
  const original = await readFile(
    join(context.projectRoot, ".hack/docker-compose.yml"),
    "utf8"
  );
  const binary = await compiler();
  const preview = await previewLegacyComposeAdoption({
    projectRoot: context.projectRoot,
    binary,
  });
  expect(preview.complete).toBe(true);
  const store = await openLegacyComposeAdoptedGenerationStore({
    projectRoot: context.projectRoot,
  });
  try {
    const generation = await store.prepare({ binary });
    expect(generation.report.adoption_generation_version).toBe(6);
    const receipt = JSON.parse(
      await readFile(join(stateRoot(), "receipt.json"), "utf8")
    );
    expect(receipt.adoption_receipt_version).toBe(6);
    const meta = JSON.parse(
      await readFile(await artifactPath("manifest.json"), "utf8")
    );
    expect(meta.adoption_generation_version).toBe(6);
    expect(meta.binding.binding_version).toBe(3);
    expect(meta.binding.network).toEqual({
      id: NETWORK,
      name: "fixture_lab",
      createdAt: CREATED,
      logical: "lab",
      internal: true,
    });
    await store.publish({ generation, binary });
    await store.close();
    const saved = await openLegacyComposeAdoptedGenerationStore({
      projectRoot: context.projectRoot,
      mode: "saved",
    });
    try {
      const active = await saved.loadActive();
      expect(active?.report.adoption_generation_version).toBe(6);
      if (!active) {
        throw new Error("Expected active owned bridge adoption");
      }
      await saved.withLease({
        generation: active,
        run: async (input) => {
          expect(input.binding.containers[0]?.id).toBe(ID);
          if (input.binding.binding_version !== 3) {
            throw new Error("Expected one owned bridge binding");
          }
          expect(input.binding.network.id).toBe(NETWORK);
          expect(input.binding.volumes[0]?.createdAt).toBe(CREATED);
          expect(JSON.stringify(input)).toBe("{}");
        },
      });
      await saved.rollback();
      expect(
        await readFile(
          join(context.projectRoot, ".hack/docker-compose.yml"),
          "utf8"
        )
      ).toBe(original);
      expect(context.fixture.container[0]?.id).toBe(ID);
      expect(context.fixture.network[0]?.id).toBe(NETWORK);
    } finally {
      await saved.close();
    }
  } finally {
    await store.close();
  }
});

test("v11 two static bridges retain both original identities through publication and rollback", async () => {
  await twoOwnedBridges();
  const original = await readFile(
    join(context.projectRoot, ".hack/docker-compose.yml"),
    "utf8"
  );
  const binary = await compiler();
  const store = await openLegacyComposeAdoptedGenerationStore({
    projectRoot: context.projectRoot,
  });
  try {
    const generation = await store.prepare({ binary });
    expect(generation.report.adoption_generation_version).toBe(11);
    expect((await readReceipt()).adoption_receipt_version).toBe(11);
    const meta = JSON.parse(
      await readFile(await artifactPath("manifest.json"), "utf8")
    );
    expect(meta.binding.binding_version).toBe(5);
    expect(meta.binding.networks).toEqual([
      {
        id: "e".repeat(64),
        name: "fixture_edge",
        createdAt: CREATED,
        logical: "edge",
        internal: false,
      },
      {
        id: NETWORK,
        name: "fixture_lab",
        createdAt: CREATED,
        logical: "lab",
        internal: true,
      },
    ]);
    await store.publish({ generation, binary });
    await store.withLease({
      generation,
      run: async (input) => {
        expect(input.binding.containers[0]?.id).toBe(ID);
        expect(input.binding.binding_version).toBe(5);
        if (input.binding.binding_version !== 5) {
          throw new Error("missing plural binding");
        }
        expect(input.binding.networks.map((network) => network.id)).toEqual([
          "e".repeat(64),
          NETWORK,
        ]);
      },
    });
    await store.rollback();
    expect(
      await readFile(
        join(context.projectRoot, ".hack/docker-compose.yml"),
        "utf8"
      )
    ).toBe(original);
    expect(container().id).toBe(ID);
    expect(context.fixture.network.map((network) => network.id).sort()).toEqual(
      [NETWORK, "e".repeat(64)].sort()
    );
    expect(volume().createdAt).toBe(CREATED);
  } finally {
    await store.close();
  }
});

test("v11 rejects crossed saved receipt and foreign bridge membership before callback", async () => {
  await twoOwnedBridges();
  const binary = await compiler();
  const store = await openLegacyComposeAdoptedGenerationStore({
    projectRoot: context.projectRoot,
  });
  try {
    const generation = await store.prepare({ binary });
    const original = await readReceipt();
    for (const foreignVersion of [5, 6, 7, 8, 9, 10]) {
      await writeReceipt({
        ...original,
        adoption_receipt_version: foreignVersion,
      });
      await refusal(store.loadPrepared());
    }
    await writeReceipt(original);
    await store.publish({ generation, binary });
    context.fixture.network[1]!.containers = ["f".repeat(64)];
    await save();
    let calls = 0;
    await refusal(
      store.withLease({
        generation,
        run: async () => {
          calls++;
        },
      })
    );
    expect(calls).toBe(0);
    expect((await readReceipt()).adoption_receipt_version).toBe(11);
  } finally {
    await store.close();
  }
});

test("v11 saved source drift refuses before callback and rollback can prepare a plain owner", async () => {
  const composePath = join(context.projectRoot, ".hack/docker-compose.yml");
  const plainCompose = await readFile(composePath, "utf8");
  await twoOwnedBridges();
  const binary = await compiler();
  const store = await openLegacyComposeAdoptedGenerationStore({
    projectRoot: context.projectRoot,
  });
  try {
    const generation = await store.prepare({ binary });
    await store.publish({ generation, binary });
    const activePath = join(context.projectRoot, ".hack/hack.project.json");
    const active = await readFile(activePath, "utf8");
    await writeFile(activePath, `${active}\n`);
    let calls = 0;
    await refusal(
      store.withLease({
        generation,
        run: async () => {
          calls++;
        },
      })
    );
    expect(calls).toBe(0);
    // A byte-exact restoration permits only the selected old owner to roll back.
    await writeFile(activePath, active);
    await store.rollback();
    context.fixture.container[0]!.networks = [
      { name: "fixture_default", id: NETWORK },
    ];
    context.fixture.network = [
      {
        ...context.fixture.network[0],
        id: NETWORK,
        name: "fixture_default",
        logical: "default",
        internal: false,
      },
    ];
    await writeFile(composePath, plainCompose);
    await save();
    const plain = await store.prepare({ binary });
    expect(plain.report.adoption_generation_version).toBe(1);
    expect((await readReceipt()).adoption_receipt_version).toBe(1);
    expect(container().id).toBe(ID);
    expect(volume().createdAt).toBe(CREATED);
  } finally {
    await store.close();
  }
});

test("two bridges with health dependencies refuse before generation writes or effects", async () => {
  const worker = await combinedBridgeHealthFixture();
  const composePath = join(context.projectRoot, ".hack/docker-compose.yml");
  const compose = JSON.parse(await readFile(composePath, "utf8"));
  compose.networks.edge = { driver: "bridge", internal: false };
  compose.services.db.networks.edge = { aliases: ["writer"] };
  compose.services.web.networks.edge = { aliases: ["reader"] };
  await writeFile(composePath, JSON.stringify(compose));
  for (const row of context.fixture.container) {
    if (!Array.isArray(row.networks)) {
      throw new Error("fixture networks missing");
    }
    row.networks = [
      ...row.networks,
      { name: "fixture_edge", id: "e".repeat(64), aliases: [] },
    ];
  }
  context.fixture.network.push({
    ...network(),
    id: "e".repeat(64),
    name: "fixture_edge",
    logical: "edge",
    internal: false,
  });
  await save();
  const binary = await compiler();
  const store = await openLegacyComposeAdoptedGenerationStore({
    projectRoot: context.projectRoot,
  });
  try {
    const receipt = await readReceipt();
    await refusal(store.prepare({ binary }), "E_LEGACY_ADOPTION_UNSUPPORTED");
    expect(await readReceipt()).toEqual(receipt);
    expect(await readdir(join(stateRoot(), "generations"))).toEqual([]);
    expect(await mutationCommands()).toEqual([]);
    expect(context.fixture.container.map((row) => row.id)).toEqual([
      ID,
      worker,
    ]);
    expect(context.fixture.network.map((row) => row.id).sort()).toEqual(
      [NETWORK, "e".repeat(64)].sort()
    );
    expect(volume().createdAt).toBe(CREATED);
  } finally {
    await store.close();
  }
});

boundedTest(
  "v10 binds the original bridge while starting and stopping healthy dependencies in order",
  async () => {
    const worker = await combinedBridgeHealthFixture();
    const original = await originalSnapshots();
    const binary = await compiler();
    const store = await openLegacyComposeAdoptedGenerationStore({
      projectRoot: context.projectRoot,
    });
    const priorCompiler = process.env.HACK_CONFIG_COMPILER_BINARY;
    try {
      process.env.HACK_CONFIG_COMPILER_BINARY = binary;
      const generation = await store.prepare({ binary });
      expect(generation.report.adoption_generation_version).toBe(10);
      expect((await readReceipt()).adoption_receipt_version).toBe(10);
      const meta = JSON.parse(
        await readFile(await artifactPath("manifest.json"), "utf8")
      );
      expect(meta.adoption_generation_version).toBe(10);
      expect(meta.binding.binding_version).toBe(3);
      expect(meta.binding.network).toMatchObject({
        id: NETWORK,
        logical: "lab",
        internal: true,
      });
      await store.publish({ generation, binary });
      expect(
        await tryLegacyComposeAdoptedCommand({
          cwd: context.projectRoot,
          operation: "up",
          detach: true,
        })
      ).toBe(0);
      expect(await mutationCommands()).toEqual([
        ["container", "start", ID],
        ["container", "start", worker],
      ]);
      expect(
        await tryLegacyComposeAdoptedCommand({
          cwd: context.projectRoot,
          operation: "down",
        })
      ).toBe(0);
      expect((await mutationCommands()).slice(2)).toEqual([
        ["container", "stop", worker],
        ["container", "stop", ID],
      ]);
      context.fixture = JSON.parse(
        await readFile(join(context.root, "fixture.json"), "utf8")
      );
      expect((await readReceipt()).pendingOperation).toBeNull();
      expect(network().id).toBe(NETWORK);
      expect(network().containers).toEqual([ID, worker]);
      expect(context.fixture.states).toEqual({ [ID]: false, [worker]: false });
      expect(volume().createdAt).toBe(CREATED);
      await store.rollback();
      await expectOriginals(original);
    } finally {
      restoreEnv("HACK_CONFIG_COMPILER_BINARY", priorCompiler);
      await store.close();
    }
  },
  retainedOperationCaseTimeout(2)
);

test("v10 saved bridge and health owner rejects other contract receipts", async () => {
  const worker = await combinedBridgeHealthFixture();
  const { store, generation } = await prepared();
  try {
    expect(generation.report.adoption_generation_version).toBe(10);
    const current = await readReceipt();
    for (const foreignVersion of [5, 6, 7, 8, 9, 11]) {
      await writeReceipt({
        ...current,
        adoption_receipt_version: foreignVersion,
      });
      await refusal(store.loadPrepared());
      expect((await readReceipt()).adoption_receipt_version).toBe(
        foreignVersion
      );
      await writeReceipt(current);
    }
    expect(
      (await store.loadPrepared())?.report.adoption_generation_version
    ).toBe(10);
    expect(context.fixture.container.map((row) => row.id)).toEqual([
      ID,
      worker,
    ]);
    expect(network().id).toBe(NETWORK);
    expect(volume().createdAt).toBe(CREATED);
  } finally {
    await store.close();
  }
});

for (const owner of ["health", "bridge"] as const) {
  test(`${owner} saved owner refuses a version 10 receipt without gaining combined authority`, async () => {
    if (owner === "health") {
      await dependencyFixture();
    } else {
      await ownedBridge();
    }
    const { store, generation } = await prepared();
    try {
      expect(generation.report.adoption_generation_version).toBe(
        owner === "health" ? 5 : 6
      );
      const current = await readReceipt();
      await writeReceipt({ ...current, adoption_receipt_version: 10 });
      await refusal(store.loadPrepared());
      expect((await readReceipt()).adoption_receipt_version).toBe(10);
      expect(network().id).toBe(NETWORK);
      expect(volume().createdAt).toBe(CREATED);
      expect(await mutationCommands()).toEqual([]);
    } finally {
      await store.close();
    }
  });
}

boundedTest(
  "v10 foreign bridge member after first start retains pending before the dependent effect",
  async () => {
    const worker = await combinedBridgeHealthFixture();
    const { store, generation } = await prepared();
    const priorCompiler = process.env.HACK_CONFIG_COMPILER_BINARY;
    try {
      const binary = await compiler();
      process.env.HACK_CONFIG_COMPILER_BINARY = binary;
      await store.publish({ generation, binary });
      context.fixture.foreignAfterFirstStart = true;
      await save();
      await expect(
        tryLegacyComposeAdoptedCommand({
          cwd: context.projectRoot,
          operation: "up",
          detach: true,
        })
      ).rejects.toThrow("values omitted");
      expect(await mutationCommands()).toEqual([["container", "start", ID]]);
      expect((await readReceipt()).pendingOperation.operation).toBe("start");
      context.fixture = JSON.parse(
        await readFile(join(context.root, "fixture.json"), "utf8")
      );
      expect(network().id).toBe(NETWORK);
      expect(network().containers).toContain("e".repeat(64));
      expect(context.fixture.states).toEqual({ [ID]: true, [worker]: false });
      expect(context.fixture.container.map((row) => row.id)).toEqual([
        ID,
        worker,
      ]);
      expect(volume().createdAt).toBe(CREATED);
    } finally {
      restoreEnv("HACK_CONFIG_COMPILER_BINARY", priorCompiler);
      await store.close();
    }
  },
  retainedOperationCaseTimeout(1)
);

boundedTest(
  "v10 refuses a missing aggregate deadline before a retained effect",
  async () => {
    await combinedBridgeHealthFixture();
    const { store, generation } = await prepared();
    try {
      const binary = await compiler();
      await store.publish({ generation, binary });
      const before = await readFile(join(context.root, "commands"), "utf8");
      let called = false;
      await refusal(
        store.withMutation({
          generation,
          binary,
          operation: "start",
          services: [],
          run: async () => {
            called = true;
            return 0;
          },
        }),
        "E_LEGACY_ADOPTION_UNSUPPORTED"
      );
      expect(called).toBe(false);
      expect(await readFile(join(context.root, "commands"), "utf8")).toBe(
        before
      );
      expect((await readReceipt()).pendingOperation).toBeNull();
      expect(network().id).toBe(NETWORK);
      expect(volume().createdAt).toBe(CREATED);
    } finally {
      await store.close();
    }
  },
  ADOPTION_CASE_TIMEOUT_MS
);

test("rolled-back v10 can reprepare the same owned bridge without health under v6", async () => {
  const worker = await combinedBridgeHealthFixture();
  const binary = await compiler();
  const store = await openLegacyComposeAdoptedGenerationStore({
    projectRoot: context.projectRoot,
  });
  try {
    const combined = await store.prepare({ binary });
    expect(combined.report.adoption_generation_version).toBe(10);
    await store.publish({ generation: combined, binary });
    await store.rollback();
    const composePath = join(context.projectRoot, ".hack/docker-compose.yml");
    const authored = JSON.parse(await readFile(composePath, "utf8"));
    authored.services.web.depends_on = undefined;
    authored.services.db.healthcheck = undefined;
    await writeFile(composePath, JSON.stringify(authored));
    const bridge = await store.prepare({ binary });
    expect(bridge.report.adoption_generation_version).toBe(6);
    expect((await readReceipt()).adoption_receipt_version).toBe(6);
    expect(
      (await store.loadPrepared())?.report.adoption_generation_version
    ).toBe(6);
    expect(context.fixture.container.map((row) => row.id)).toEqual([
      ID,
      worker,
    ]);
    expect(network().id).toBe(NETWORK);
    expect(volume().createdAt).toBe(CREATED);
  } finally {
    await store.close();
  }
});

test("rolled-back v10 resets a later plain receipt to the checkout owner", async () => {
  const composePath = join(context.projectRoot, ".hack/docker-compose.yml");
  const worker = await combinedBridgeHealthFixture();
  const binary = await compiler();
  const store = await openLegacyComposeAdoptedGenerationStore({
    projectRoot: context.projectRoot,
  });
  try {
    const combined = await store.prepare({ binary });
    expect(combined.report.adoption_generation_version).toBe(10);
    await store.publish({ generation: combined, binary });
    await store.rollback();
    const authored = JSON.parse(await readFile(composePath, "utf8"));
    authored.services.web.depends_on = undefined;
    authored.services.db.healthcheck = undefined;
    authored.services.web.networks = undefined;
    authored.services.db.networks = undefined;
    authored.networks = undefined;
    await writeFile(composePath, JSON.stringify(authored));
    for (const row of context.fixture.container) {
      row.networks = [{ name: "fixture_default", id: NETWORK }];
    }
    context.fixture.network[0] = {
      ...network(),
      name: "fixture_default",
      logical: "default",
      internal: false,
    };
    context.fixture.aliases = undefined;
    await save();
    const plain = await store.prepare({ binary });
    expect(plain.report.adoption_generation_version).toBe(1);
    expect((await readReceipt()).adoption_receipt_version).toBe(1);
    expect(
      (await store.loadPrepared())?.report.adoption_generation_version
    ).toBe(1);
    expect(context.fixture.container.map((row) => row.id)).toEqual([
      ID,
      worker,
    ]);
    expect(network().id).toBe(NETWORK);
    expect(volume().createdAt).toBe(CREATED);
  } finally {
    await store.close();
  }
});

test("v6 saved bridge refuses a changed policy before another retained effect", async () => {
  await ownedBridge();
  const binary = await compiler();
  const store = await openLegacyComposeAdoptedGenerationStore({
    projectRoot: context.projectRoot,
  });
  try {
    const generation = await store.prepare({ binary });
    await store.publish({ generation, binary });
    context.fixture.network[0]!.internal = false;
    await save();
    let effects = 0;
    await refusal(
      store.withLease({
        generation,
        run: async () => {
          effects++;
        },
      }),
      "E_LEGACY_ADOPTION_STATE"
    );
    expect(effects).toBe(0);
    expect(context.fixture.container[0]?.id).toBe(ID);
    expect(context.fixture.volume[0]?.createdAt).toBe(CREATED);
  } finally {
    await store.close();
  }
});

test("v6 manifest and receipt must select the same saved topology owner", async () => {
  await ownedBridge();
  const { store, generation } = await prepared();
  try {
    expect(generation.report.adoption_generation_version).toBe(6);
    const current = await readReceipt();
    for (const foreignVersion of [4, 5, 7]) {
      await writeReceipt({
        ...current,
        adoption_receipt_version: foreignVersion,
      });
      await refusal(store.loadPrepared());
      expect(await readReceipt()).toEqual({
        ...current,
        adoption_receipt_version: foreignVersion,
      });
    }
    expect(context.fixture.container[0]?.id).toBe(ID);
    expect(context.fixture.network[0]?.id).toBe(NETWORK);
  } finally {
    await store.close();
  }
});

test("v5 retained health owner refuses a v6 topology receipt", async () => {
  await dependencyFixture();
  const { store, generation } = await prepared();
  try {
    expect(generation.report.adoption_generation_version).toBe(5);
    const current = await readReceipt();
    expect(current.adoption_receipt_version).toBe(5);
    await writeReceipt({ ...current, adoption_receipt_version: 6 });
    await refusal(store.loadPrepared());
    expect(await readReceipt()).toEqual({
      ...current,
      adoption_receipt_version: 6,
    });
    expect(context.fixture.container.map((row) => row.id)).toEqual([
      ID,
      "c".repeat(64),
    ]);
    expect(network().id).toBe(NETWORK);
  } finally {
    await store.close();
  }
});

boundedTest(
  "v7 retained completion owner refuses a v6 topology receipt",
  async () => {
    const { app, job } = await completedJobFixture();
    const { store, generation } = await prepared();
    try {
      expect(generation.report.adoption_generation_version).toBe(7);
      const current = await readReceipt();
      expect(current.adoption_receipt_version).toBe(7);
      await writeReceipt({ ...current, adoption_receipt_version: 6 });
      await refusal(store.loadPrepared());
      expect(await readReceipt()).toEqual({
        ...current,
        adoption_receipt_version: 6,
      });
      expect(await mutationCommands()).toEqual([]);
      expect(context.fixture.container.map((row) => row.id)).toEqual([
        ID,
        app,
        job,
      ]);
      expect(network().id).toBe(NETWORK);
      expect(volume().createdAt).toBe(CREATED);
    } finally {
      await store.close();
    }
  },
  ADOPTION_CASE_TIMEOUT_MS
);

test("v6 rollback permits a later plain owner without inheriting topology authority", async () => {
  const composePath = join(context.projectRoot, ".hack/docker-compose.yml");
  const plainCompose = await readFile(composePath, "utf8");
  await ownedBridge();
  const binary = await compiler();
  const store = await openLegacyComposeAdoptedGenerationStore({
    projectRoot: context.projectRoot,
  });
  try {
    const custom = await store.prepare({ binary });
    expect(custom.report.adoption_generation_version).toBe(6);
    await store.publish({ generation: custom, binary });
    await store.rollback();
    expect(network().id).toBe(NETWORK);
    expect(volume().createdAt).toBe(CREATED);

    const plainNetwork = "e".repeat(64);
    await writeFile(composePath, plainCompose);
    container().networks = [{ name: "fixture_default", id: plainNetwork }];
    context.fixture.network[0] = {
      ...network(),
      id: plainNetwork,
      name: "fixture_default",
      logical: "default",
      internal: false,
    };
    await save();
    const plain = await store.prepare({ binary });
    expect(plain.report.adoption_generation_version).toBe(1);
    expect((await readReceipt()).adoption_receipt_version).toBe(1);
    await store.publish({ generation: plain, binary });
    await store.close();
    const saved = await openLegacyComposeAdoptedGenerationStore({
      projectRoot: context.projectRoot,
      mode: "saved",
    });
    try {
      expect(
        (await saved.loadActive())?.report.adoption_generation_version
      ).toBe(1);
      expect(container().id).toBe(ID);
      expect(network().id).toBe(plainNetwork);
      expect(volume().createdAt).toBe(CREATED);
    } finally {
      await saved.close();
    }
  } finally {
    await store.close();
  }
});

test("v6 journals a running original stop before effect and retains the owned bridge on recovery", async () => {
  await ownedBridge();
  context.fixture.running = true;
  context.fixture.container[0]!.networks = [
    {
      name: "fixture_lab",
      id: NETWORK,
      aliases: ["fixture-db-1", "db", "db-alias"],
    },
  ];
  await save();
  const binary = await compiler();
  expect(
    (
      await previewLegacyComposeAdoption({
        projectRoot: context.projectRoot,
        binary,
      })
    ).complete
  ).toBe(false);
  expect(
    (
      await previewLegacyComposeAdoption({
        projectRoot: context.projectRoot,
        binary,
        stop: true,
      })
    ).complete
  ).toBe(true);
  const { store, generation } = await prepared();
  try {
    expect(
      await store.withPreparationStop({
        generation,
        binary,
        run: async (input) => {
          if (input.binding.binding_version !== 3) {
            throw new Error("Expected one owned bridge binding");
          }
          expect(input.binding.network.id).toBe(NETWORK);
          expect((await readReceipt()).adoption_receipt_version).toBe(6);
          expect((await readReceipt()).pendingOperation).toMatchObject({
            operation: "stop",
            services: ["db"],
          });
          context.fixture.running = false;
          context.fixture.container[0]!.networks = [
            { name: "fixture_lab", id: NETWORK, aliases: [] },
          ];
          await save();
          return 7;
        },
      })
    ).toBe(7);
    await refusal(store.loadPrepared(), "E_LEGACY_ADOPTION_BUSY");
    const recovered = await store.loadPrepared({ recoverOperation: true });
    if (!recovered) {
      throw new Error("Expected exact selected recovery");
    }
    await store.withPreparationStop({
      generation: recovered,
      binary,
      recover: true,
      run: async () => 0,
    });
    await store.publish({ generation: recovered, binary });
    await store.rollback();
    expect(context.fixture.container[0]?.id).toBe(ID);
    expect(context.fixture.network[0]?.id).toBe(NETWORK);
    expect(context.fixture.volume[0]?.createdAt).toBe(CREATED);
  } finally {
    await store.close();
  }
});
