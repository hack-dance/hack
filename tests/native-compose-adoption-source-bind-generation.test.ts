import {
  afterEach,
  beforeEach,
  test as boundedTest,
  expect,
  spyOn,
} from "bun:test";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { previewLegacyComposeAdoption } from "../src/lib/native-compose-adoption-preview.ts";
import * as privateState from "../src/lib/native-compose-private-state.ts";
import {
  retainedSourceBindFixture,
  SOURCE_BIND_CANARY,
} from "./helpers/retained-source-bind-adoption.ts";

const test = (name: string, action: () => Promise<void>) =>
  boundedTest(name, action, 30_000);
let h: Awaited<ReturnType<typeof retainedSourceBindFixture>>;
beforeEach(async () => {
  h = await retainedSourceBindFixture();
});
afterEach(async () => {
  await h.cleanup();
});
async function red(pending: Promise<unknown>) {
  await expect(pending).rejects.toThrow("values omitted");
  try {
    await pending;
  } catch (error: unknown) {
    expect(String(error)).not.toContain(SOURCE_BIND_CANARY);
    expect(String(error)).not.toContain(h.root);
  }
}
async function prepared() {
  const store = await h.store();
  try {
    return { store, generation: await store.prepare({ binary: h.compiler }) };
  } catch (error: unknown) {
    await store.close();
    throw error;
  }
}
async function noAllocation() {
  const commands = await h.commands();
  expect(
    commands.some((args) =>
      args.some((arg) => ["build", "pull", "create", "up", "rm"].includes(arg))
    )
  ).toBe(false);
  expect(
    commands
      .filter(
        (args) =>
          args[0] === "container" && ["start", "stop"].includes(args[1] ?? "")
      )
      .every((args) => args.length === 3 && args[2] === "a".repeat(64))
  ).toBe(true);
  expect(await Bun.file(join(h.outer, "unexpected")).exists()).toBe(false);
}
test("version12 prepares, publishes, resumes originals, stops and rolls back without allocating mounts or data", async () => {
  const { store, generation } = await prepared();
  try {
    expect(generation.report.adoption_generation_version).toBe(12);
    expect((await h.receipt()).adoption_receipt_version).toBe(12);
    expect(JSON.stringify(generation)).not.toContain(SOURCE_BIND_CANARY);
    expect(JSON.stringify(generation)).not.toContain(h.root);
    await store.publish({ generation, binary: h.compiler });
    const active = await store.loadActive();
    if (!active) {
      throw new Error("Synthetic active generation missing");
    }
    await store.withLease({
      generation: active,
      run: async (input) => {
        expect(Object.keys(input)).toEqual([]);
        expect(JSON.stringify(input)).toBe("{}");
        expect(input.binding.binding_version).toBe(12);
      },
    });
    expect(await h.operation(store, active, "start")).toBe(0);
    await writeFile(
      join(h.root, "source/marker"),
      "legitimate runtime contents"
    );
    expect(await h.operation(store, active, "stop")).toBe(0);
    await store.rollback();
    expect(
      await readFile(join(h.root, ".hack/docker-compose.yml"), "utf8")
    ).toBe(h.compose);
    expect(await readFile(join(h.root, ".hack/hack.config.json"), "utf8")).toBe(
      h.config
    );
    expect(await readFile(join(h.root, "source/marker"), "utf8")).toBe(
      "legitimate runtime contents"
    );
    expect(await h.readModel()).toMatchObject({
      row: SOURCE_BIND_CANARY,
      volumeBirth: h.model.volumeBirth,
      running: false,
    });
    await noAllocation();
  } finally {
    await store.close();
  }
});
test("read-only adoption preview remains symbolic and does not create a receipt", async () => {
  const result = await previewLegacyComposeAdoption({
    projectRoot: h.root,
    binary: h.compiler,
  });
  expect(result.complete).toBe(true);
  expect(JSON.stringify(result)).not.toContain(SOURCE_BIND_CANARY);
  expect(JSON.stringify(result)).not.toContain(h.root);
  expect(
    await Bun.file(
      join(h.root, ".hack/.internal/legacy-compose-adoption-v1/receipt.json")
    ).exists()
  ).toBe(false);
  await noAllocation();
});

test("expired mutation clock retains pending proof but permits a fresh bounded saved recovery", async () => {
  const { store, generation } = await prepared();
  try {
    await store.publish({ generation, binary: h.compiler });
    const active = await store.loadActive();
    if (!active) {
      throw new Error("Synthetic active generation missing");
    }
    const deadline = Date.now() + 10_000;
    let callbackReached = false;
    await red(
      store.withMutation({
        generation: active,
        operation: "start",
        services: [],
        binary: h.compiler,
        deadline,
        run: async (input) => {
          await input.assertFresh();
          callbackReached = true;
          await Bun.sleep(Math.max(1, deadline - Date.now() + 25));
          return 0;
        },
      })
    );
    expect(callbackReached).toBe(true);
    expect((await h.receipt()).pendingOperation).not.toBeNull();
    const recovery = await store.loadActive({ recoverOperation: true });
    expect(recovery).not.toBeNull();
    if (!recovery) {
      throw new Error("Synthetic recovery generation missing");
    }
    expect(await h.operation(store, recovery, "stop", true)).toBe(0);
    expect((await h.receipt()).pendingOperation).toBeNull();
    await store.rollback();
    await noAllocation();
  } finally {
    await store.close();
  }
});

test("replacement during the final preparation receipt read refuses before publishing a prepared anchor", async () => {
  const store = await h.store();
  const prior = await h.receipt();
  const read = privateState.readPrivate;
  let staged = false;
  let replaced = false;
  const capture = spyOn(privateState, "readPrivate").mockImplementation(
    async (...args) => {
      const result = await read(...args);
      if (String(args[0]).endsWith(".receipt")) {
        staged = true;
      }
      if (
        staged &&
        !replaced &&
        args[0] ===
          join(
            h.root,
            ".hack/.internal/legacy-compose-adoption-v1/receipt.json"
          )
      ) {
        replaced = true;
        await rename(join(h.root, "source"), join(h.root, "original"));
        await mkdir(join(h.root, "source"));
      }
      return result;
    }
  );
  try {
    await red(store.prepare({ binary: h.compiler }));
    expect(staged).toBe(true);
    expect(replaced).toBe(true);
    expect(await h.receipt()).toEqual(prior);
    await noAllocation();
  } finally {
    capture.mockRestore();
    await store.close();
  }
});

boundedTest.each(["mutation freshness", "lease return"])(
  "replacement during the last %s receipt await refuses at the outer boundary",
  async (kind) => {
    const { store, generation } = await prepared();
    await store.publish({ generation, binary: h.compiler });
    const active = await store.loadActive();
    if (!active) {
      throw new Error("Synthetic active generation missing");
    }
    const read = privateState.readPrivate;
    let armed = false;
    let replaced = false;
    let effects = 0;
    const capture = spyOn(privateState, "readPrivate").mockImplementation(
      async (...args) => {
        const result = await read(...args);
        if (
          armed &&
          !replaced &&
          args[0] ===
            join(
              h.root,
              ".hack/.internal/legacy-compose-adoption-v1/receipt.json"
            )
        ) {
          replaced = true;
          await rename(join(h.root, "source"), join(h.root, "original"));
          await mkdir(join(h.root, "source"));
        }
        return result;
      }
    );
    try {
      if (kind === "mutation freshness") {
        await red(
          store.withMutation({
            generation: active,
            operation: "start",
            services: [],
            binary: h.compiler,
            deadline: Date.now() + 15_000,
            run: async (input) => {
              armed = true;
              await input.assertFresh();
              effects++;
              return 0;
            },
          })
        );
        expect((await h.receipt()).pendingOperation).not.toBeNull();
      } else {
        await red(
          store.withLease({
            generation: active,
            run: async () => {
              armed = true;
            },
          })
        );
        expect((await h.receipt()).pendingOperation).toBeNull();
      }
      expect(armed).toBe(true);
      expect(replaced).toBe(true);
      expect(effects).toBe(0);
      await noAllocation();
    } finally {
      capture.mockRestore();
      await store.close();
    }
  },
  30_000
);
boundedTest.each([
  "directory",
  "engine source",
  "access",
  "volume birth",
  "config hash",
])(
  "prepared %s drift refuses publication without effects",
  async (kind) => {
    const { store, generation } = await prepared();
    try {
      if (kind === "directory") {
        await rename(join(h.root, "source"), join(h.root, "original"));
        await mkdir(join(h.root, "source"));
      }
      if (kind === "engine source") {
        h.model.source = join(h.outer, "foreign");
      }
      if (kind === "access") {
        h.model.readOnly = true;
      }
      if (kind === "volume birth") {
        h.model.volumeBirth = "2026-02-02T01:02:03Z";
      }
      if (kind === "config hash") {
        h.model.hash = "e".repeat(64);
      }
      await h.persist();
      await red(store.publish({ generation, binary: h.compiler }));
      expect((await h.receipt()).publication).toBeNull();
      expect(
        await readFile(join(h.root, ".hack/docker-compose.yml"), "utf8")
      ).toBe(h.compose);
      expect(
        (await h.commands()).filter((args) =>
          ["start", "stop"].includes(args[1] ?? "")
        )
      ).toHaveLength(0);
      await noAllocation();
    } finally {
      await store.close();
    }
  },
  30_000
);
test("directory replacement retains a partial-start journal; same original directory repair permits explicit recovery stop", async () => {
  const { store, generation } = await prepared();
  try {
    await store.publish({ generation, binary: h.compiler });
    const active = await store.loadActive();
    if (!active) {
      throw new Error("Synthetic active generation missing");
    }
    h.model.partial = true;
    await h.persist();
    expect(await h.operation(store, active, "start")).toBe(7);
    const pending = await readFile(
      join(h.root, ".hack/.internal/legacy-compose-adoption-v1/receipt.json"),
      "utf8"
    );
    await rename(join(h.root, "source"), join(h.root, "original"));
    await mkdir(join(h.root, "source"));
    await red(h.operation(store, active, "stop", true));
    expect(
      await readFile(
        join(h.root, ".hack/.internal/legacy-compose-adoption-v1/receipt.json"),
        "utf8"
      )
    ).toBe(pending);
    await rename(join(h.root, "source"), join(h.root, "replacement"));
    await rename(join(h.root, "original"), join(h.root, "source"));
    const current = await h.readModel();
    h.model.running = current.running === true;
    h.model.partial = false;
    await h.persist();
    expect(await h.operation(store, active, "stop", true)).toBe(0);
    expect((await h.receipt()).pendingOperation).toBeNull();
    await store.rollback();
    await noAllocation();
  } finally {
    await store.close();
  }
});
test("new proof owner requires a finite operation deadline before publishing pending effects", async () => {
  const { store, generation } = await prepared();
  try {
    await store.publish({ generation, binary: h.compiler });
    let called = false;
    await red(
      store.withMutation({
        generation,
        operation: "start",
        services: [],
        binary: h.compiler,
        run: async () => {
          called = true;
          return 0;
        },
      })
    );
    expect(called).toBe(false);
    expect((await h.receipt()).pendingOperation).toBeNull();
  } finally {
    await store.close();
  }
});
boundedTest.each([1, 9, 10, 11, 13])(
  "receipt version%s cannot consume a saved version12 proof",
  async (version) => {
    const { store, generation } = await prepared();
    try {
      await store.publish({ generation, binary: h.compiler });
      const state = await h.receipt();
      await writeFile(
        join(h.root, ".hack/.internal/legacy-compose-adoption-v1/receipt.json"),
        JSON.stringify({ ...state, adoption_receipt_version: version })
      );
      await red(store.loadActive());
      expect(
        (await h.commands()).filter((args) =>
          ["start", "stop"].includes(args[1] ?? "")
        )
      ).toHaveLength(0);
    } finally {
      await store.close();
    }
  },
  30_000
);
