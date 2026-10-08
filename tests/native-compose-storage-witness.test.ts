import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  lstat,
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
  type NativeComposeGeneration,
  type NativeComposeGenerationStore,
  type NativeComposeMutation,
  openNativeComposeGenerationStore,
} from "../src/lib/native-compose-generation.ts";
import { mergeNativeComposeRetainedVolumes } from "../src/lib/native-compose-retained-storage.ts";
import {
  enrollNativeComposeStorageWitness,
  type NativeComposeStorageWitnessEnrollment,
  type NativeComposeStorageWitnessReference,
  prepareNativeComposeStorageWitness,
  verifyNativeComposeStorageWitness,
} from "../src/lib/native-compose-storage-witness.ts";

const roots: string[] = [];
const stores: NativeComposeGenerationStore[] = [];
const engineId = "d".repeat(64);
const volume = {
  name: "owned_data",
  storage: "data",
  createdAt: "2026-10-08T12:00:00Z",
};
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

test("reused and copied enrollment capabilities cannot authorize a second seed", async () => {
  const store = await fixture();
  let seeds = 0;
  let archive: Uint8Array = new Uint8Array();
  await store.withMutation(async (mutation) => {
    const generation = await publish(mutation);
    await mutation.runEffect({
      generation,
      operation: "up",
      assertFresh: async () => {},
      assertOwned: async () => {},
      effect: async () => {
        const enrollment = await prepare(mutation, generation);
        const seed = async (bytes: Uint8Array) => {
          seeds++;
          archive = bytes;
        };
        const observe = async () => ({ volume, archive });
        await enrollNativeComposeStorageWitness({ enrollment, seed, observe });
        await expect(
          enrollNativeComposeStorageWitness({ enrollment, seed, observe })
        ).rejects.toThrow("values omitted");
        await expect(
          enrollNativeComposeStorageWitness({
            enrollment: { ...enrollment },
            seed,
            observe,
          })
        ).rejects.toThrow("values omitted");
        return { value: 0, outcome: "complete" };
      },
    });
  });
  expect(seeds).toBe(1);
});

test("failed initial admission creates no expectation or seed capability", async () => {
  const store = await fixture();
  let admissions = 0;
  await store.withMutation(async (mutation) => {
    const generation = await publish(mutation);
    await expect(
      mutation.runEffect({
        generation,
        operation: "up",
        assertFresh: async () => {},
        assertOwned: async () => {},
        effect: async () => {
          await prepareNativeComposeStorageWitness({
            authority: mutation.materialAuthority,
            generation,
            engineId,
            volume: { name: volume.name, storage: volume.storage },
            admission: "initial-create",
            assertAdmission: async () => {
              admissions++;
              throw new Error("existing volume");
            },
          });
          return { value: 0, outcome: "complete" };
        },
      })
    ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_UNCERTAIN" });
  });
  expect(admissions).toBe(1);
  expect(await Bun.file(join(slot(store), "expectation.json")).exists()).toBe(
    false
  );
});

test.each([
  "selection",
  "journal",
] as const)("%s drift during the seed observation preserves incomplete enrollment", async (change) => {
  const store = await fixture();
  await store.withMutation(async (mutation) => {
    const generation = await publish(mutation);
    await expect(
      mutation.runEffect({
        generation,
        operation: "up",
        assertFresh: async () => {},
        assertOwned: async () => {},
        effect: async () => {
          const enrollment = await prepare(mutation, generation);
          let archive: Uint8Array = new Uint8Array();
          await enrollNativeComposeStorageWitness({
            enrollment,
            seed: async (bytes) => {
              archive = bytes;
            },
            observe: async () => {
              if (change === "journal") {
                await writeFile(
                  join(slot(store), "expectation.json"),
                  "private-invalid-canary",
                  { mode: 0o600 }
                );
              }
              return {
                volume:
                  change === "selection"
                    ? { ...volume, storage: "rebound" }
                    : volume,
                archive,
              };
            },
          });
          return { value: 0, outcome: "complete" };
        },
      })
    ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_UNCERTAIN" });
  });
  expect(await Bun.file(join(slot(store), "enrolled.json")).exists()).toBe(
    false
  );
  expect((await store.loadCurrent()).pending).not.toBeNull();
});

test.each([
  false,
  true,
])("explicit adoption requires its original exact birth (changed=%s)", async (changed) => {
  const store = await fixture();
  await store.withMutation(async (mutation) => {
    const generation = await publish(mutation);
    const result = mutation.runEffect({
      generation,
      operation: "up",
      assertFresh: async () => {},
      assertOwned: async () => {},
      effect: async () => {
        const enrollment = await prepareNativeComposeStorageWitness({
          authority: mutation.materialAuthority,
          generation,
          engineId,
          volume: { name: volume.name, storage: volume.storage },
          admission: "explicit-adoption",
          originalVolume: volume,
          assertAdmission: async () => {},
        });
        let archive: Uint8Array = new Uint8Array();
        const reference = await enrollNativeComposeStorageWitness({
          enrollment,
          seed: async (bytes) => {
            archive = bytes;
          },
          observe: async () => ({
            volume: changed
              ? { ...volume, createdAt: "2026-10-08T12:00:01Z" }
              : volume,
            archive,
          }),
        });
        await verifyNativeComposeStorageWitness({
          authority: mutation.materialAuthority,
          generation,
          engineId,
          reference,
          observe: async () => ({ volume, archive }),
        });
        return { value: 0, outcome: "complete" };
      },
    });
    if (changed) {
      await expect(result).rejects.toMatchObject({
        code: "E_NATIVE_COMPOSE_UNCERTAIN",
      });
    } else {
      expect(await result).toEqual({ value: 0, outcome: "complete" });
    }
  });
  expect(await Bun.file(join(slot(store), "enrolled.json")).exists()).toBe(
    !changed
  );
});
async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "native-storage-witness-"))
  );
  roots.push(root);
  await mkdir(join(root, ".hack"));
  await Bun.write(
    join(root, ".hack", "hack.project.json"),
    JSON.stringify({ schema_version: 1, name: "witness" })
  );
  const store = await openNativeComposeGenerationStore({
    projectRoot: root,
    instance: null,
  });
  stores.push(store);
  return store;
}
async function publish(mutation: NativeComposeMutation) {
  const reservation = mutation.reserveGeneration();
  return await mutation.publish({
    reservation,
    profiles: [],
    inputRevision: "a".repeat(64),
    assertFresh: async () => {},
    composeJson: JSON.stringify({
      name: reservation.identity.composeProject,
      services: {
        app: {
          image: "synthetic:1",
          labels: {
            "io.hack.native-config.version": "1",
            "io.hack.native-config.instance":
              reservation.identity.composeProject,
            "io.hack.native-config.owner": reservation.identity.ownerToken,
            "io.hack.native-config.generation": reservation.generationId,
            "io.hack.native-config.workload": "service",
          },
        },
      },
    }),
  });
}
function slot(store: NativeComposeGenerationStore) {
  return join(
    store.identity.checkoutRoot,
    ".hack",
    ".internal",
    "native-compose",
    store.identity.instanceId,
    "storage-witnesses",
    createHash("sha256").update(volume.name).digest("hex")
  );
}
async function prepare(
  mutation: NativeComposeMutation,
  generation: NativeComposeGeneration
) {
  return await prepareNativeComposeStorageWitness({
    authority: mutation.materialAuthority,
    generation,
    engineId,
    volume: { name: volume.name, storage: volume.storage },
    admission: "initial-create",
    assertAdmission: async () => {},
  });
}
async function active() {
  const store = await fixture();
  let archive: Uint8Array = new Uint8Array();
  const captured: { reference: NativeComposeStorageWitnessReference | null } = {
    reference: null,
  };
  const generation = await store.withMutation(async (mutation) => {
    const current = await publish(mutation);
    await mutation.runEffect({
      generation: current,
      operation: "up",
      assertOwned: async () => {},
      assertFresh: async () => {},
      effect: async () => {
        const enrollment = await prepare(mutation, current);
        expect(
          await Bun.file(join(slot(store), "enrolled.json")).exists()
        ).toBe(false);
        captured.reference = await enrollNativeComposeStorageWitness({
          enrollment,
          seed: async (bytes) => {
            expect(
              await Bun.file(join(slot(store), "expectation.json")).exists()
            ).toBe(true);
            expect(
              (await lstat(join(slot(store), "expectation.json"))).mode & 0o777
            ).toBe(0o600);
            archive = bytes;
          },
          observe: async () => ({ volume, archive }),
        });
        return { value: 0, outcome: "complete" };
      },
    });
    return current;
  });
  if (!captured.reference) {
    throw new Error("Expected enrolled fixture");
  }
  return { store, generation, archive, reference: captured.reference };
}

test("durable expectation precedes seed, and completed read-only verification preserves both files", async () => {
  const { store, generation, archive, reference } = await active();
  const before = await Promise.all([
    readFile(join(slot(store), "expectation.json")),
    readFile(join(slot(store), "enrolled.json")),
  ]);
  await store.withMutation(async (mutation) => {
    await verifyNativeComposeStorageWitness({
      authority: mutation.materialAuthority,
      generation,
      engineId,
      reference,
      observe: async () => ({ volume, archive }),
    });
  });
  expect(
    await Promise.all([
      readFile(join(slot(store), "expectation.json")),
      readFile(join(slot(store), "enrolled.json")),
    ])
  ).toEqual(before);
  expect(Object.isFrozen(reference)).toBe(true);
  expect(Object.isFrozen(reference.volume)).toBe(true);
});

test.each([
  "missing",
  "wrong",
] as const)("same-label SAME-CreatedAt empty/replaced witness %s refuses before workload without reseeding", async (change) => {
  const { store, generation, archive, reference } = await active();
  await store.withMutation(async (mutation) => {
    await mutation.runEffect({
      generation,
      operation: "down",
      assertOwned: async () => {},
      assertFresh: async () => {},
      effect: async () => ({ value: 0, outcome: "complete" }),
    });
  });
  // PR200 metadata observes exactly the same facts; it cannot distinguish this replacement.
  expect(
    mergeNativeComposeRetainedVolumes({
      retained: [volume],
      observed: [{ ...volume }],
    })
  ).toEqual([volume]);
  const replaced =
    change === "missing" ? new Uint8Array(2048) : new Uint8Array(archive);
  if (change === "wrong") {
    replaced[550] = (replaced[550] ?? 0) ^ 1;
  }
  let workloads = 0;
  let probes = 0;
  const before = await readFile(join(slot(store), "expectation.json"));
  await store.withMutation(async (mutation) => {
    await expect(
      mutation.runEffect({
        generation,
        operation: "up",
        assertOwned: async () => {},
        assertFresh: async () => {},
        effect: async () => {
          await verifyNativeComposeStorageWitness({
            authority: mutation.materialAuthority,
            generation,
            engineId,
            reference,
            observe: async () => {
              probes++;
              return { volume: { ...volume }, archive: replaced };
            },
          });
          workloads++;
          return { value: 0, outcome: "complete" };
        },
      })
    ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_UNCERTAIN" });
  });
  expect(workloads).toBe(0);
  expect(probes).toBe(1);
  expect(await readFile(join(slot(store), "expectation.json"))).toEqual(before);
  expect((await store.loadCurrent()).pending?.generationId).toBe(
    generation.generationId
  );
});

test("a seed failure consumes capability and retains expectation with no completion", async () => {
  const store = await fixture();
  let seeds = 0;
  await store.withMutation(async (mutation) => {
    const generation = await publish(mutation);
    await expect(
      mutation.runEffect({
        generation,
        operation: "up",
        assertOwned: async () => {},
        assertFresh: async () => {},
        effect: async () => {
          const enrollment = await prepare(mutation, generation);
          const attempt = () =>
            enrollNativeComposeStorageWitness({
              enrollment,
              seed: async () => {
                seeds++;
                throw new Error("synthetic write interruption");
              },
              observe: async () => {
                throw new Error("Must not observe");
              },
            });
          await expect(attempt()).rejects.toThrow("values omitted");
          await expect(attempt()).rejects.toThrow("values omitted");
          return { value: 17, outcome: "uncertain" };
        },
      })
    ).resolves.toEqual({ value: 17, outcome: "uncertain" });
  });
  expect(seeds).toBe(1);
  expect(await Bun.file(join(slot(store), "expectation.json")).exists()).toBe(
    true
  );
  expect(await Bun.file(join(slot(store), "enrolled.json")).exists()).toBe(
    false
  );
  expect((await store.loadCurrent()).pending).not.toBeNull();
});

test.each([
  false,
  true,
])("interrupted expectation (marker written=%s) cannot be replayed after saved stop", async (written) => {
  const store = await fixture();
  let savedArchive: Uint8Array = new Uint8Array();
  let oldCapability: NativeComposeStorageWitnessEnrollment | null = null;
  let seeds = 0;
  const generation = await store.withMutation(async (mutation) => {
    const current = await publish(mutation);
    await mutation.runEffect({
      generation: current,
      operation: "up",
      assertOwned: async () => {},
      assertFresh: async () => {},
      effect: async () => {
        oldCapability = await prepare(mutation, current);
        if (written) {
          await expect(
            enrollNativeComposeStorageWitness({
              enrollment: oldCapability,
              seed: async (bytes) => {
                seeds++;
                savedArchive = bytes;
              },
              observe: async () => {
                throw new Error("Interrupted before completion");
              },
            })
          ).rejects.toThrow();
        }
        return { value: 1, outcome: "uncertain" };
      },
    });
    return current;
  });
  if (!oldCapability) {
    throw new Error("Expected retained capability");
  }
  await expect(
    enrollNativeComposeStorageWitness({
      enrollment: oldCapability,
      seed: async () => {
        seeds++;
      },
      observe: async () => ({ volume, archive: savedArchive }),
    })
  ).rejects.toThrow();
  const before = await readFile(join(slot(store), "expectation.json"));
  await store.withMutation(async (mutation) => {
    await mutation.runEffect({
      generation,
      operation: "down",
      recoverPending: true,
      assertOwned: async () => {},
      assertFresh: async () => {},
      effect: async () => ({ value: 0, outcome: "complete" }),
    });
    await expect(
      mutation.runEffect({
        generation,
        operation: "up",
        assertOwned: async () => {},
        assertFresh: async () => {},
        effect: async () => {
          await prepare(mutation, generation);
          seeds++;
          return { value: 0, outcome: "complete" };
        },
      })
    ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_UNCERTAIN" });
  });
  expect(seeds).toBe(written ? 1 : 0);
  expect(await readFile(join(slot(store), "expectation.json"))).toEqual(before);
  expect(await Bun.file(join(slot(store), "enrolled.json")).exists()).toBe(
    false
  );
});

test.each([
  "run",
  "down",
] as const)("%s cannot admit a seed or acquire private admission inputs", async (operation) => {
  const store = await fixture();
  let admissions = 0;
  await store.withMutation(async (mutation) => {
    const generation = await publish(mutation);
    await expect(
      mutation.runEffect({
        generation,
        operation,
        assertOwned: async () => {},
        assertFresh: async () => {},
        effect: async () => {
          await prepareNativeComposeStorageWitness({
            authority: mutation.materialAuthority,
            generation,
            engineId,
            volume,
            admission: "initial-create",
            assertAdmission: async () => {
              admissions++;
            },
          });
          return { value: 0, outcome: "complete" };
        },
      })
    ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_UNCERTAIN" });
  });
  expect(admissions).toBe(0);
});

test.each([
  "expectation",
  "completion",
  "directory",
  "engine",
] as const)("read-only witness verification refuses changed %s identity before observation", async (changed) => {
  const { store, generation, archive, reference } = await active();
  if (changed === "expectation") {
    const file = join(slot(store), "expectation.json");
    await rename(file, `${file}.old`);
    await symlink(`${file}.old`, file);
  } else if (changed === "completion") {
    await rename(
      join(slot(store), "enrolled.json"),
      join(slot(store), "enrolled.old")
    );
  } else if (changed === "directory") {
    await rename(slot(store), `${slot(store)}.old`);
    await mkdir(slot(store), { mode: 0o700 });
  }
  let probes = 0;
  await store.withMutation(async (mutation) => {
    await expect(
      verifyNativeComposeStorageWitness({
        authority: mutation.materialAuthority,
        generation,
        engineId: changed === "engine" ? "e".repeat(64) : engineId,
        reference,
        observe: async () => {
          probes++;
          return { volume, archive };
        },
      })
    ).rejects.toThrow();
  });
  expect(probes).toBe(0);
});
