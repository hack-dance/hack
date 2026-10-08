import { afterEach, beforeEach, test as boundedTest, expect } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { previewLegacyComposeAdoption } from "../src/lib/native-compose-adoption-preview.ts";
import { parseLegacyComposeAdoptionReceipt } from "../src/lib/native-compose-adoption-receipt.ts";
import {
  BUILD_CANARY,
  retainedBuildFixture,
} from "./helpers/retained-build-adoption.ts";

const test = (name: string, run: () => Promise<void>) =>
  boundedTest(name, run, 30_000);
let h: Awaited<ReturnType<typeof retainedBuildFixture>>;
beforeEach(async () => {
  h = await retainedBuildFixture();
});
afterEach(async () => {
  await h.cleanup();
});
async function red(pending: Promise<unknown>) {
  try {
    await pending;
    throw new Error("unexpected retained build success");
  } catch (error) {
    expect(String(error)).toMatch(/values omitted/i);
    expect(String(error)).not.toContain(BUILD_CANARY);
    expect(String(error)).not.toContain(h.root);
  }
}
async function prepared() {
  const store = await h.store();
  try {
    const generation = await store.prepare({ binary: h.compiler });
    return { store, generation };
  } catch (error: unknown) {
    await store.close();
    throw error;
  }
}
async function assertNoAllocation() {
  const commands = await h.commands();
  expect(
    commands.some(
      (args) =>
        args.includes("build") ||
        args.includes("pull") ||
        args.includes("create") ||
        args.includes("up") ||
        args.includes("rm")
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
}
async function writeReceipt(value: unknown) {
  await writeFile(
    join(h.root, ".hack/.internal/legacy-compose-adoption-v1/receipt.json"),
    JSON.stringify(value)
  );
}

test("version9 prepares/switches/starts/stops/rolls back the original model identities and data", async () => {
  const { store, generation } = await prepared();
  try {
    expect(generation.report.adoption_generation_version).toBe(9);
    expect((await h.receipt()).adoption_receipt_version).toBe(9);
    expect(JSON.stringify(generation)).not.toContain(BUILD_CANARY);
    expect(JSON.stringify(generation)).not.toContain("sha256:");
    await store.publish({ generation, binary: h.compiler });
    const active = await store.loadActive();
    if (!active) {
      throw new Error("missing synthetic active generation");
    }
    expect(active.report.adoption_generation_version).toBe(9);
    expect(await h.operation(store, active, "start")).toBe(0);
    expect(await h.operation(store, active, "stop")).toBe(0);
    await store.rollback();
    expect(
      await readFile(join(h.root, ".hack/docker-compose.yml"), "utf8")
    ).toBe(h.compose);
    expect(await readFile(join(h.root, ".hack/hack.config.json"), "utf8")).toBe(
      h.config
    );
    expect(await h.readModel()).toMatchObject({
      row: BUILD_CANARY,
      image: h.model.image,
      imageBirth: h.model.imageBirth,
      volumeBirth: h.model.volumeBirth,
      containerBirth: h.model.containerBirth,
      running: false,
    });
    await assertNoAllocation();
  } finally {
    await store.close();
  }
});
test("dry-run reports only field provenance/counts and does not create a generation", async () => {
  const report = await previewLegacyComposeAdoption({
    projectRoot: h.root,
    binary: h.compiler,
  });
  expect(report.complete).toBe(true);
  expect(JSON.stringify(report)).not.toContain(BUILD_CANARY);
  expect(JSON.stringify(report)).not.toContain("sha256:");
  expect(
    await Bun.file(
      join(h.root, ".hack/.internal/legacy-compose-adoption-v1/receipt.json")
    ).exists()
  ).toBe(false);
  await assertNoAllocation();
});
boundedTest.each([
  "context",
  "tag",
  "missing image",
  "image birth",
  "container birth",
  "volume birth",
  "config hash",
])(
  "prepared %s drift cannot switch the authored format",
  async (kind) => {
    const { store, generation } = await prepared();
    try {
      if (kind === "context") {
        await writeFile(join(h.root, "src/marker"), "changed source");
      }
      if (kind === "tag") {
        h.model.tag = `sha256:${"e".repeat(64)}`;
      }
      if (kind === "missing image") {
        h.model.imageExists = false;
      }
      if (kind === "image birth") {
        h.model.imageBirth = "2026-02-02T01:02:03Z";
      }
      if (kind === "container birth") {
        h.model.containerBirth = "2026-02-02T01:02:03Z";
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
      await assertNoAllocation();
    } finally {
      await store.close();
    }
  },
  30_000
);
test("post-effect context drift retains pending ownership; exact same-inode byte repair permits explicit stop recovery", async () => {
  const { store, generation } = await prepared();
  try {
    await store.publish({ generation, binary: h.compiler });
    const active = await store.loadActive();
    if (!active) {
      throw new Error("missing synthetic active generation");
    }
    h.model.sourceRace = true;
    await h.persist();
    await red(h.operation(store, active, "start"));
    expect((await h.receipt()).pendingOperation?.operation).toBe("start");
    await red(store.loadActive());
    h.model.sourceRace = false;
    await h.persist();
    await writeFile(join(h.root, "src/marker"), BUILD_CANARY);
    const repair = await store.loadActive({ recoverOperation: true });
    if (!repair) {
      throw new Error("missing synthetic repair generation");
    }
    expect(await h.operation(store, repair, "stop", true)).toBe(0);
    expect((await h.receipt()).pendingOperation).toBeNull();
    await store.rollback();
    expect((await h.readModel()).row).toBe(BUILD_CANARY);
    await assertNoAllocation();
  } finally {
    await store.close();
  }
});
test("candidate build edits refuse before any retained effect or rollback overwrite", async () => {
  const { store, generation } = await prepared();
  try {
    await store.publish({ generation, binary: h.compiler });
    const path = join(h.root, ".hack/hack.project.json");
    const original = await readFile(path, "utf8");
    await writeFile(
      path,
      original.replace('"context":"."', '"context":"changed"')
    );
    await red(store.loadActive());
    await red(store.rollback());
    expect((await h.receipt()).publication?.phase).toBe("active");
    await assertNoAllocation();
  } finally {
    await store.close();
  }
});
test("older receipt versions cannot label a build manifest", async () => {
  const { store } = await prepared();
  try {
    const receipt = await h.receipt();
    expect(
      parseLegacyComposeAdoptionReceipt(receipt, receipt.checkout)
        .adoption_receipt_version
    ).toBe(9);
    for (const version of [1, 2, 3, 4, 5]) {
      await writeReceipt({ ...receipt, adoption_receipt_version: version });
      await red(store.loadPrepared());
    }
    await writeReceipt(receipt);
    expect(
      (await store.loadPrepared())?.report.adoption_generation_version
    ).toBe(9);
  } finally {
    await store.close();
  }
});
test("rolled-back version9 does not relabel a later image-only generation", async () => {
  const { store, generation } = await prepared();
  try {
    await store.publish({ generation, binary: h.compiler });
    await store.rollback();
    const plainCompose = JSON.stringify({
      name: "fixture",
      services: {
        db: { image: "postgres:16-alpine", volumes: ["data:/data"] },
      },
      volumes: { data: { name: "fixture_original_data" } },
    });
    await writeFile(join(h.root, ".hack/docker-compose.yml"), plainCompose);
    await h.acceptCompose(plainCompose);
    const plain = await store.prepare({ binary: h.compiler });
    expect(plain.report.adoption_generation_version).toBe(1);
    expect((await h.receipt()).adoption_receipt_version).toBe(1);
    expect(
      (await store.loadPrepared())?.report.adoption_generation_version
    ).toBe(1);
    const receipt = await h.receipt();
    await writeReceipt({ ...receipt, adoption_receipt_version: 9 });
    await red(store.loadPrepared());
    await writeReceipt(receipt);
    await assertNoAllocation();
  } finally {
    await store.close();
  }
});
test("remaining operation budget settles a held pre-effect ownership query without calling the mutation", async () => {
  const { store, generation } = await prepared();
  try {
    h.model.probeHold = true;
    await h.persist();
    const start = performance.now();
    let entered = false;
    await red(
      store.withPreparationStop({
        generation,
        binary: h.compiler,
        deadline: Date.now() + 1000,
        run: async () => {
          entered = true;
          return 0;
        },
      })
    );
    expect(await Bun.file(join(h.outer, "probe-started")).exists()).toBe(true);
    expect(performance.now() - start).toBeLessThan(5000);
    expect(entered).toBe(false);
    expect((await h.receipt()).pendingOperation).toBeNull();
    await assertNoAllocation();
  } finally {
    await store.close();
  }
});
test("version9 requires one deadline before any mutation callback and preserves pending evidence on failed stop", async () => {
  const { store, generation } = await prepared();
  try {
    let entered = false;
    await red(
      store.withPreparationStop({
        generation,
        run: async () => {
          entered = true;
          return 0;
        },
      })
    );
    expect(entered).toBe(false);
    expect((await h.receipt()).pendingOperation).toBeNull();
    h.model.running = true;
    h.model.partial = true;
    await h.persist();
    const deadline = Date.now() + 15_000;
    expect(
      await store.withPreparationStop({
        generation,
        deadline,
        binary: h.compiler,
        run: (input) =>
          import("../src/lib/native-compose-adoption-execution.ts").then(
            ({ runLegacyComposeRetainedOperation }) =>
              runLegacyComposeRetainedOperation({
                input,
                operation: "stop",
                deadline,
                signal: new AbortController().signal,
              })
          ),
      })
    ).toBe(7);
    expect((await h.receipt()).pendingOperation?.operation).toBe("stop");
    h.model.partial = false;
    await h.persist();
    const repair = await store.loadPrepared({ recoverOperation: true });
    if (!repair) {
      throw new Error("missing synthetic prepared repair");
    }
    const nextDeadline = Date.now() + 15_000;
    expect(
      await store.withPreparationStop({
        generation: repair,
        recover: true,
        deadline: nextDeadline,
        binary: h.compiler,
        run: (input) =>
          import("../src/lib/native-compose-adoption-execution.ts").then(
            ({ runLegacyComposeRetainedOperation }) =>
              runLegacyComposeRetainedOperation({
                input,
                operation: "stop",
                deadline: nextDeadline,
                signal: new AbortController().signal,
              })
          ),
      })
    ).toBe(0);
    await store.publish({ generation: repair, binary: h.compiler });
    await store.rollback();
    await assertNoAllocation();
  } finally {
    await store.close();
  }
});
