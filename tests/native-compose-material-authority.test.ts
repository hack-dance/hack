import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  assertNativeComposeMaterialAuthority,
  type NativeComposeGenerationStore,
  type NativeComposeMaterialAuthority,
  type NativeComposeMutation,
  type NativeComposeReservation,
  openNativeComposeGenerationStore,
  runNativeComposeMaterialAction,
} from "../src/lib/native-compose-generation.ts";

const fixtures: string[] = [];
const stores: NativeComposeGenerationStore[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(
    fixtures.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
test("revocation precedes escaped work, while lock release awaits its settlement", async () => {
  const store = await fixture();
  const held = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  let escaped: Promise<void> | undefined;
  let released = false;
  const mutation = store
    .withMutation(async (mutation) => {
      const reservation = mutation.reserveGeneration();
      escaped = runNativeComposeMaterialAction({
        authority: mutation.materialAuthority,
        run: async () => {
          entered.resolve();
          await held.promise;
          await expect(
            assertNativeComposeMaterialAuthority({
              authority: mutation.materialAuthority,
              reservation,
              phase: "prepare",
            })
          ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_STATE" });
        },
      });
    })
    .finally(() => {
      released = true;
    });
  await entered.promise;
  await Bun.sleep(10);
  expect(released).toBe(false);
  expect(
    (
      await readFile(
        join(dirname(receiptPath(store)), "mutation.lock/owner"),
        "utf8"
      )
    ).length
  ).toBeGreaterThan(0);
  held.resolve();
  await mutation;
  await escaped;
  expect(released).toBe(true);
});
async function fixture() {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "native-material-authority-"))
  );
  fixtures.push(parent);
  const root = join(parent, "checkout");
  await mkdir(join(root, ".hack"), { recursive: true });
  await writeFile(
    join(root, ".hack/hack.project.json"),
    '{"schema_version":1,"name":"fixture"}'
  );
  const store = await openNativeComposeGenerationStore({
    projectRoot: root,
    instance: null,
  });
  stores.push(store);
  return store;
}
function document(reservation: NativeComposeReservation) {
  const labels = {
    "io.hack.native-config.version": "1",
    "io.hack.native-config.instance": reservation.identity.composeProject,
    "io.hack.native-config.owner": reservation.identity.ownerToken,
  };
  return JSON.stringify({
    name: reservation.identity.composeProject,
    services: {
      reader: {
        image: "fixture:1",
        labels: {
          ...labels,
          "io.hack.native-config.generation": reservation.generationId,
          "io.hack.native-config.workload": "service",
        },
      },
    },
    networks: { default: { labels } },
  });
}
async function publish(mutation: NativeComposeMutation) {
  const reservation = mutation.reserveGeneration();
  return await mutation.publish({
    reservation,
    composeJson: document(reservation),
    profiles: [],
    inputRevision: "a".repeat(64),
    assertFresh: async () => {},
  });
}
function receiptPath(store: NativeComposeGenerationStore) {
  return join(
    store.identity.checkoutRoot,
    ".hack/.internal/native-compose",
    store.identity.instanceId,
    "receipt.json"
  );
}

test("public identities and copied tickets cannot mint material authority; closed mutation revokes it", async () => {
  const store = await fixture();
  let escaped: NativeComposeMaterialAuthority | undefined;
  await store.withMutation(async (mutation) => {
    const reservation = mutation.reserveGeneration();
    const select = { phase: "prepare" as const, reservation };
    const binding = await assertNativeComposeMaterialAuthority({
      authority: mutation.materialAuthority,
      ...select,
    });
    expect(binding.generationId).toBe(reservation.generationId);
    expect(binding.lease.token).toMatch(/^[a-f0-9]{32}$/);
    expect(Object.isFrozen(binding.checkout.projectDirectory)).toBe(true);
    expect(JSON.stringify(mutation)).toBe("{}");
    for (const authority of [
      {},
      { ...mutation.materialAuthority },
      store.identity,
    ]) {
      await expect(
        assertNativeComposeMaterialAuthority({ authority, ...select })
      ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_STATE" });
    }
    await expect(
      assertNativeComposeMaterialAuthority({
        authority: mutation.materialAuthority,
        phase: "prepare",
        reservation: { ...reservation },
      })
    ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_STATE" });
    escaped = mutation.materialAuthority;
  });
  if (!escaped) {
    throw new Error("missing test capability");
  }
  await store.withMutation(async (mutation) => {
    const reservation = mutation.reserveGeneration();
    await expect(
      assertNativeComposeMaterialAuthority({
        authority: escaped ?? {},
        phase: "prepare",
        reservation,
      })
    ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_STATE" });
  });
});

test("effect and retirement require the actual pending operation, not a published generation alone", async () => {
  const store = await fixture();
  await store.withMutation(async (mutation) => {
    const generation = await publish(mutation);
    const selection = { authority: mutation.materialAuthority, generation };
    await expect(
      assertNativeComposeMaterialAuthority({ ...selection, phase: "effect" })
    ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_STATE" });
    await mutation.runEffect({
      generation,
      operation: "up",
      assertFresh: async () => {},
      assertOwned: async () => {},
      effect: async () => {
        const binding = await assertNativeComposeMaterialAuthority({
          ...selection,
          phase: "effect",
        });
        expect(binding.pendingGenerationId).toBe(generation.generationId);
        expect(binding.pendingToken).not.toBeNull();
        expect(Object.isFrozen(binding.generation?.manifest)).toBe(true);
        await expect(
          assertNativeComposeMaterialAuthority({
            ...selection,
            phase: "retire",
          })
        ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_STATE" });
        return { outcome: "complete", value: 0 };
      },
    });
    await expect(
      assertNativeComposeMaterialAuthority({ ...selection, phase: "effect" })
    ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_STATE" });
    await expect(
      assertNativeComposeMaterialAuthority({
        ...selection,
        phase: "inspect",
        generation: { ...generation },
      })
    ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_STATE" });
    await mutation.runEffect({
      generation,
      operation: "down",
      assertOwned: async () => {},
      effect: async () => ({ outcome: "complete", value: 0 }),
      beforeComplete: async () => {
        const binding = await assertNativeComposeMaterialAuthority({
          ...selection,
          phase: "retire",
        });
        expect(binding.pendingToken).not.toBeNull();
        expect((await store.loadCurrent()).stopped).toBe(false);
      },
    });
    expect((await store.loadCurrent()).stopped).toBe(true);
  });
});

test.each([
  "receipt",
  "lock",
] as const)("same-byte %s substitution cannot acquire material authority", async (kind) => {
  const store = await fixture();
  await store.withMutation(async (mutation) => {
    const reservation = mutation.reserveGeneration();
    const path =
      kind === "receipt"
        ? receiptPath(store)
        : join(dirname(receiptPath(store)), "mutation.lock/owner");
    const text = await readFile(path, "utf8");
    const original = `${path}.original`;
    await rename(path, original);
    await writeFile(path, text, { mode: 0o600 });
    try {
      await expect(
        assertNativeComposeMaterialAuthority({
          authority: mutation.materialAuthority,
          phase: "prepare",
          reservation,
        })
      ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_STATE" });
    } finally {
      await unlink(path);
      await rename(original, path);
    }
    const binding = await assertNativeComposeMaterialAuthority({
      authority: mutation.materialAuthority,
      phase: "prepare",
      reservation,
    });
    expect(binding.generationId).toBe(reservation.generationId);
  });
});

test("saved mutation uses immutable generation despite missing authored source and cannot prepare", async () => {
  const initial = await fixture();
  await initial.withMutation(async (mutation) => {
    const generation = await publish(mutation);
    await mutation.runEffect({
      generation,
      operation: "up",
      assertFresh: async () => {},
      assertOwned: async () => {},
      effect: async () => ({ outcome: "complete", value: 0 }),
    });
  });
  await unlink(join(initial.identity.checkoutRoot, ".hack/hack.project.json"));
  const saved = await openNativeComposeGenerationStore({
    projectRoot: initial.identity.checkoutRoot,
    instance: null,
    mode: "saved",
  });
  stores.push(saved);
  const { generation } = await saved.loadCurrent();
  if (!generation) {
    throw new Error("missing saved generation");
  }
  await saved.withMutation(async (mutation) => {
    const binding = await assertNativeComposeMaterialAuthority({
      authority: mutation.materialAuthority,
      phase: "inspect",
      generation,
    });
    expect(binding.generationId).toBe(generation.generationId);
    expect(() => mutation.reserveGeneration()).toThrow();
  });
});
