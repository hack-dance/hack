import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
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
import * as generationOwner from "../src/lib/native-compose-generation.ts";
import {
  armNativeComposeStorageWitnessIntent,
  assertNativeComposeMaterialAuthority,
  type NativeComposeGeneration,
  type NativeComposeGenerationStore,
  type NativeComposeMutation,
  openNativeComposeGenerationStore,
  publishNativeComposeStorageWitnessEnrollment,
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

test("enrollment captures original callbacks before admission can replace them", async () => {
  const store = await fixture();
  let originalSeeds = 0;
  let originalObservations = 0;
  let replacements = 0;
  let archive: Uint8Array = new Uint8Array();
  const mutable: {
    enrollment: NativeComposeStorageWitnessEnrollment;
    seed: (bytes: Uint8Array) => Promise<void>;
    observe: () => Promise<{ volume: typeof volume; archive: Uint8Array }>;
  } = {
    enrollment: {},
    seed: async (bytes) => {
      originalSeeds++;
      archive = bytes;
    },
    observe: async () => {
      originalObservations++;
      return { volume, archive };
    },
  };
  let replace = false;
  await store.withMutation(async (mutation) => {
    const generation = await publish(mutation);
    await mutation.runEffect({
      generation,
      operation: "up",
      assertFresh: async () => {},
      assertOwned: async () => {},
      effect: async () => {
        mutable.enrollment = await prepareNativeComposeStorageWitness({
          authority: mutation.materialAuthority,
          generation,
          engineId,
          volume: { name: volume.name, storage: volume.storage },
          admission: "initial-create",
          assertAdmission: async () => {
            if (replace) {
              mutable.seed = async (bytes) => {
                replacements++;
                archive = bytes;
              };
              mutable.observe = async () => {
                replacements++;
                return { volume, archive };
              };
            }
          },
        });
        replace = true;
        await enrollNativeComposeStorageWitness(mutable);
        return { value: 0, outcome: "complete" };
      },
    });
  });
  expect(originalSeeds).toBe(1);
  // Enrollment proof, fresh receipt publication proof, and final startup proof use the captured callback.
  expect(originalObservations).toBe(3);
  expect(replacements).toBe(0);
});

test.each([
  { change: "callback" },
  { change: "bindings" },
])("verification captures original inputs before its first await", async ({
  change,
}) => {
  const { store, generation, archive, reference } = await active();
  let original = 0;
  let substituted = 0;
  await store.withMutation(async (mutation) => {
    const mutable = {
      authority: mutation.materialAuthority,
      generation,
      engineId,
      reference,
      observe: async () => {
        original++;
        return { volume, archive };
      },
    };
    const verifying = verifyNativeComposeStorageWitness(mutable);
    mutable.observe = async () => {
      substituted++;
      return { volume, archive };
    };
    if (change === "bindings") {
      mutable.authority = {};
      mutable.engineId = "substituted";
    }
    await verifying;
  });
  expect(original).toBe(1);
  expect(substituted).toBe(0);
});

test.each([
  { boundary: "seed", read: 2 },
  { boundary: "completion", read: 3 },
])("revoked effect authority refuses at the final filesystem boundary", async ({
  boundary,
  read,
}) => {
  const store = await fixture();
  const waiting = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const work: { result: Promise<boolean> | null } = { result: null };
  let hit = false;
  let count = 0;
  let seeds = 0;
  let archive: Uint8Array = new Uint8Array();
  const originalOpen = fs.open;
  const opened = spyOn(fs, "open").mockImplementation(
    async (...args: Parameters<typeof fs.open>) => {
      const file = await originalOpen(...args);
      if (
        args[0] === join(slot(store), "expectation.json") &&
        typeof args[1] === "number" &&
        (args[1] & constants.O_CREAT) === 0
      ) {
        count++;
        if (count === read) {
          hit = true;
          waiting.resolve();
          await resume.promise;
        }
      }
      return file;
    }
  );
  const guard = setTimeout(() => {
    waiting.resolve();
    resume.resolve();
  }, 3000);
  try {
    await store.withMutation(async (mutation) => {
      const generation = await publish(mutation);
      await mutation.runEffect({
        generation,
        operation: "up",
        assertFresh: async () => {},
        assertOwned: async () => {},
        effect: async () => {
          const enrollment = await prepare(mutation, generation);
          work.result = enrollNativeComposeStorageWitness({
            enrollment,
            seed: async (bytes) => {
              seeds++;
              archive = bytes;
            },
            observe: async () => ({ volume, archive }),
          }).then(
            () => true,
            () => false
          );
          await waiting.promise;
          return { value: 1, outcome: "uncertain" };
        },
      });
      // Returning from runEffect revokes effectOperation/activePending. The
      // registered material action still owns its process/files until settled.
      resume.resolve();
      expect(await work.result).toBe(false);
    });
    expect(hit).toBe(true);
    expect(seeds).toBe(boundary === "seed" ? 0 : 1);
    expect(await Bun.file(join(slot(store), "enrolled.json")).exists()).toBe(
      false
    );
    expect((await store.loadCurrent()).pending).not.toBeNull();
  } finally {
    waiting.resolve();
    resume.resolve();
    clearTimeout(guard);
    await work.result;
    opened.mockRestore();
  }
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
  expect(typeof changed).toBe("boolean");
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
        storageWitnesses: {
          engineId,
          observe: async () => {
            probes++;
            return { volume: { ...volume }, archive: replaced };
          },
        },
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
    ).rejects.toThrow("values omitted");
  });
  expect(workloads).toBe(0);
  expect(probes).toBe(1);
  expect(await readFile(join(slot(store), "expectation.json"))).toEqual(before);
  expect((await store.loadCurrent()).pending).toBeNull();
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
  expect(typeof written).toBe("boolean");
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

function receiptFile(store: NativeComposeGenerationStore) {
  return join(
    store.identity.checkoutRoot,
    ".hack",
    ".internal",
    "native-compose",
    store.identity.instanceId,
    "receipt.json"
  );
}

test("v3 Expected is durable before the slot and survives failed publication and explicit saved stop", async () => {
  const store = await fixture();
  const originalMkdir = fs.mkdir;
  let journalBeforeSlot = false;
  const mocked = spyOn(fs, "mkdir").mockImplementation((async (
    path,
    options
  ) => {
    if (String(path) === slot(store)) {
      const value = JSON.parse(await readFile(receiptFile(store), "utf8"));
      journalBeforeSlot =
        value.version === 3 && value.storageWitnesses[0]?.state === "expected";
      throw new Error("synthetic slot creation interruption");
    }
    return await originalMkdir(path, options);
  }) as typeof fs.mkdir);
  let generation: NativeComposeGeneration;
  try {
    generation = await store.withMutation(async (mutation) => {
      const current = await publish(mutation);
      await expect(
        mutation.runEffect({
          generation: current,
          operation: "up",
          assertFresh: async () => {},
          assertOwned: async () => {},
          effect: async () => {
            await prepare(mutation, current);
            return { value: 0, outcome: "complete" };
          },
        })
      ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_UNCERTAIN" });
      return current;
    });
  } finally {
    mocked.mockRestore();
  }
  expect(journalBeforeSlot).toBe(true);
  await expect(lstat(slot(store))).rejects.toMatchObject({ code: "ENOENT" });
  const expected = (await store.loadCurrent()).storageWitnesses;
  expect(expected?.[0]?.state).toBe("expected");
  await store.close();
  const saved = await openNativeComposeGenerationStore({
    projectRoot: store.identity.checkoutRoot,
    instance: null,
    mode: "saved",
  });
  stores.push(saved);
  const pending = await saved.loadPending();
  expect(pending?.generationId).toBe(generation.generationId);
  if (!pending) {
    throw new Error("Expected recovery anchor");
  }
  let probes = 0;
  let effects = 0;
  let retirements = 0;
  await saved.withMutation(async (mutation) => {
    await expect(
      mutation.runEffect({
        generation: pending,
        operation: "down",
        assertOwned: async () => {
          probes++;
        },
        effect: async () => {
          effects++;
          return { value: 0, outcome: "complete" };
        },
      })
    ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_UNCERTAIN" });
    expect(probes).toBe(0);
    expect(effects).toBe(0);
    const result = await mutation.runEffect({
      generation: pending,
      operation: "down",
      recoverPending: true,
      assertOwned: async () => {
        probes++;
      },
      beforeComplete: async () => {
        retirements++;
      },
      effect: async () => {
        effects++;
        return { value: 0, outcome: "complete" };
      },
    });
    expect(result).toEqual({ value: 0, outcome: "uncertain" });
  });
  expect(effects).toBe(1);
  expect(retirements).toBe(0);
  const current = await saved.loadCurrent();
  expect(current.storageWitnesses).toEqual(expected);
  expect(current.storageWitnessesPending).toBe(true);
  expect(current.pending?.generationId).toBe(generation.generationId);
  // No successful startup existed: its original stopped bit remains, alongside the required pending anchor.
  expect(current.stopped).toBe(true);
  expect(JSON.stringify(current)).not.toContain("storageWitness");
});

test("enrolled v3 references survive metadata capture, reopen and saved down, and resume requires a carrier", async () => {
  const { store, generation, reference } = await active();
  const before = (await store.loadCurrent()).storageWitnesses;
  expect(before?.[0]?.state).toBe("enrolled");
  expect(before?.[0]?.state === "enrolled" && before[0].reference).toEqual(
    reference
  );
  expect((await store.loadCurrent()).retainedStorage).toEqual([volume]);
  expect(JSON.stringify(await store.loadCurrent())).not.toContain(volume.name);
  await store.withMutation(async (mutation) => {
    await mutation.runEffect({
      generation,
      operation: "down",
      assertOwned: async () => {},
      captureStorage: () => [volume],
      effect: async () => ({ value: 0, outcome: "complete" }),
    });
  });
  expect(JSON.parse(await readFile(receiptFile(store), "utf8")).version).toBe(
    3
  );
  await store.close();
  const reopened = await openNativeComposeGenerationStore({
    projectRoot: store.identity.checkoutRoot,
    instance: null,
    mode: "prepare",
  });
  stores.push(reopened);
  const current = await reopened.loadCurrent();
  expect(current.storageWitnesses).toEqual(before);
  expect(current.storageWitnessesPending).toBe(false);
  expect(current.stopped).toBe(true);
  if (!current.generation) {
    throw new Error("Expected saved generation");
  }
  let probes = 0;
  let effects = 0;
  await reopened.withMutation(async (mutation) => {
    await expect(
      mutation.runEffect({
        generation: current.generation!,
        operation: "up",
        assertFresh: async () => {},
        assertOwned: async () => {
          probes++;
        },
        effect: async () => {
          effects++;
          return { value: 0, outcome: "complete" };
        },
      })
    ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_STATE" });
  });
  expect(probes).toBe(0);
  expect(effects).toBe(0);
  expect((await reopened.loadCurrent()).pending).toBeNull();
});

test("store fences an unchanged resume before and after workload without enrollment replay", async () => {
  const { store, generation, archive } = await active();
  const events: string[] = [];
  await store.withMutation(async (mutation) => {
    await mutation.runEffect({
      generation,
      operation: "up",
      assertFresh: async () => {},
      assertOwned: async () => {
        events.push("owned");
      },
      storageWitnesses: {
        engineId,
        observe: async ({ name, storage, markerName }) => {
          expect(name).toBe(volume.name);
          expect(storage).toBe(volume.storage);
          expect(markerName).toMatch(/^\.hack-storage-[a-f0-9]{64}\.witness$/);
          events.push("marker");
          return { volume, archive };
        },
      },
      effect: async () => {
        events.push("workload");
        return { value: 0, outcome: "complete" };
      },
    });
  });
  expect(events.indexOf("marker")).toBeLessThan(events.indexOf("owned"));
  expect(events.lastIndexOf("marker")).toBeGreaterThan(
    events.indexOf("workload")
  );
  expect(events.filter((event) => event === "workload")).toHaveLength(1);
  expect((await store.loadCurrent()).pending).toBeNull();
});

test("finalizer marker drift preserves exact v3 recovery state and cannot publish ready", async () => {
  const { store, generation, archive } = await active();
  let currentArchive = archive;
  const before = (await store.loadCurrent()).storageWitnesses;
  let finalizers = 0;
  await store.withMutation(async (mutation) => {
    await expect(
      mutation.runEffect({
        generation,
        operation: "restart",
        assertFresh: async () => {},
        assertOwned: async () => {},
        storageWitnesses: {
          engineId,
          observe: async () => ({ volume, archive: currentArchive }),
        },
        beforeComplete: async () => {
          finalizers++;
          currentArchive = new Uint8Array(2048);
        },
        effect: async () => ({ value: 0, outcome: "complete" }),
      })
    ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_UNCERTAIN" });
  });
  expect(finalizers).toBe(1);
  const current = await store.loadCurrent();
  expect(current.pending?.generationId).toBe(generation.generationId);
  expect(current.storageWitnesses).toEqual(before);
});

test.each([
  "downgrade",
  "missing",
  "duplicate",
  "birth",
  "unknown",
] as const)("required v3 witness receipt refuses %s without rewriting", async (change) => {
  const { store } = await active();
  const file = receiptFile(store);
  const value = JSON.parse(await readFile(file, "utf8"));
  if (change === "downgrade") {
    value.version = 2;
  }
  if (change === "missing") {
    Reflect.deleteProperty(value, "storageWitnesses");
  }
  if (change === "duplicate") {
    value.storageWitnesses.push(value.storageWitnesses[0]);
  }
  if (change === "birth") {
    value.storage[0].createdAt = "2026-10-08T12:00:01Z";
  }
  if (change === "unknown") {
    value.storageWitnesses[0].state = "synthetic-private-canary";
  }
  const changed = JSON.stringify(value);
  await writeFile(file, changed, { mode: 0o600 });
  await expect(store.loadCurrent()).rejects.toMatchObject({
    code: "E_NATIVE_COMPOSE_STATE",
  });
  expect(await readFile(file, "utf8")).toBe(changed);
});

test("material effect revocation during its own final receipt read cannot return authority", async () => {
  const store = await fixture();
  const waiting = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const held: { work: Promise<boolean> | null } = { work: null };
  const originalOpen = fs.open;
  let armed = false;
  let count = 0;
  let hit = false;
  const mocked = spyOn(fs, "open").mockImplementation(
    async (path, flags, mode) => {
      if (
        armed &&
        String(path) === receiptFile(store) &&
        Number(flags) ===
          (constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      ) {
        count++;
        if (count === 2) {
          hit = true;
          waiting.resolve();
          await resume.promise;
        }
      }
      return await originalOpen(path, flags, mode);
    }
  );
  const guard = setTimeout(() => waiting.resolve(), 3000);
  try {
    await store.withMutation(async (mutation) => {
      const generation = await publish(mutation);
      await mutation.runEffect({
        generation,
        operation: "up",
        assertFresh: async () => {},
        assertOwned: async () => {},
        effect: async () => {
          armed = true;
          held.work = assertNativeComposeMaterialAuthority({
            authority: mutation.materialAuthority,
            generation,
            phase: "effect",
          }).then(
            () => true,
            () => false
          );
          await waiting.promise;
          return { value: 0, outcome: "uncertain" };
        },
      });
      armed = false;
      resume.resolve();
      expect(await held.work).toBe(false);
    });
    expect(hit).toBe(true);
    expect((await store.loadCurrent()).pending).not.toBeNull();
  } finally {
    waiting.resolve();
    resume.resolve();
    clearTimeout(guard);
    await held.work;
    mocked.mockRestore();
  }
});

test("revocation during the staged Enrolled receipt read preserves Expected and never promotes", async () => {
  const store = await fixture();
  const waiting = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const held: { work: Promise<boolean> | null } = { work: null };
  let seeds = 0;
  let hit = false;
  let archive: Uint8Array = new Uint8Array();
  const originalOpen = fs.open;
  const mocked = spyOn(fs, "open").mockImplementation(
    async (path, flags, mode) => {
      if (
        !hit &&
        String(path).endsWith(".receipt.tmp") &&
        Number(flags) ===
          (constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      ) {
        const staged = await Bun.file(String(path)).json();
        if (staged.storageWitnesses?.[0]?.state === "enrolled") {
          hit = true;
          waiting.resolve();
          await resume.promise;
        }
      }
      return await originalOpen(path, flags, mode);
    }
  );
  const guard = setTimeout(() => waiting.resolve(), 3000);
  try {
    await store.withMutation(async (mutation) => {
      const generation = await publish(mutation);
      await mutation.runEffect({
        generation,
        operation: "up",
        assertFresh: async () => {},
        assertOwned: async () => {},
        effect: async () => {
          const enrollment = await prepare(mutation, generation);
          held.work = enrollNativeComposeStorageWitness({
            enrollment,
            seed: async (bytes) => {
              seeds++;
              archive = bytes;
            },
            observe: async () => ({ volume, archive }),
          }).then(
            () => true,
            () => false
          );
          await waiting.promise;
          return { value: 0, outcome: "uncertain" };
        },
      });
      resume.resolve();
      expect(await held.work).toBe(false);
    });
    expect(hit).toBe(true);
    expect(seeds).toBe(1);
    // The completed extension alone cannot authorize promotion after this invocation ends.
    expect(await Bun.file(join(slot(store), "enrolled.json")).exists()).toBe(
      true
    );
    const current = await store.loadCurrent();
    expect(current.storageWitnessesPending).toBe(true);
    expect(current.storageWitnesses?.[0]?.state).toBe("expected");
    expect(current.generation).toBeNull();
    expect(current.pending).not.toBeNull();
  } finally {
    waiting.resolve();
    resume.resolve();
    clearTimeout(guard);
    await held.work;
    mocked.mockRestore();
  }
});

test("witness-bearing before hooks refuse before private acquisition or spawn while the carrier is inactive", async () => {
  const { store } = await active();
  let acquisitions = 0;
  let effects = 0;
  await store.withMutation(async (mutation) => {
    await expect(
      mutation.runBeforeHooks({
        assertFresh: async () => {
          acquisitions++;
        },
        effect: async () => {
          effects++;
          return { value: 0, outcome: "complete" };
        },
      })
    ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_UNCERTAIN" });
  });
  expect(acquisitions).toBe(0);
  expect(effects).toBe(0);
  expect((await store.loadCurrent()).beforeHooksPending).toBe(false);
});

test("a shape-valid fabricated reference and no-op verifier cannot promote Expected", async () => {
  const store = await fixture();
  let suppliedVerifiers = 0;
  await store.withMutation(async (mutation) => {
    const generation = await publish(mutation);
    await mutation.runEffect({
      generation,
      operation: "up",
      assertFresh: async () => {},
      assertOwned: async () => {},
      effect: async () => {
        const binding = await assertNativeComposeMaterialAuthority({
          authority: mutation.materialAuthority,
          generation,
          phase: "effect",
        });
        if (!binding.pendingToken) {
          throw new Error("Expected active pending token");
        }
        await armNativeComposeStorageWitnessIntent({
          authority: mutation.materialAuthority,
          generation,
          intent: {
            name: volume.name,
            storage: volume.storage,
            engineId,
            generationId: generation.generationId,
            pendingToken: binding.pendingToken,
            admission: "initial-create",
            originalVolume: null,
          },
        });
        const forged = {
          authority: mutation.materialAuthority,
          generation,
          proof: {},
          reference: {
            version: 1 as const,
            volume,
            root: { dev: 1, ino: 1 },
            directory: { dev: 1, ino: 2 },
            expectation: { dev: 1, ino: 3, hash: "a".repeat(64) },
            completion: { dev: 1, ino: 4, hash: "b".repeat(64) },
          },
          verify: async () => {
            suppliedVerifiers++;
          },
        };
        await expect(
          publishNativeComposeStorageWitnessEnrollment(forged)
        ).rejects.toThrow("values omitted");
        return { value: 0, outcome: "uncertain" };
      },
    });
  });
  expect(suppliedVerifiers).toBe(0);
  const current = await store.loadCurrent();
  expect(current.storageWitnessesPending).toBe(true);
  expect(current.storageWitnesses?.[0]?.state).toBe("expected");
  expect(current.generation).toBeNull();
  await expect(lstat(slot(store))).rejects.toMatchObject({ code: "ENOENT" });
});

test("issued completion proof rejects copies, changed authority/generation and reuse without consuming the original", async () => {
  const originalPublish =
    generationOwner.publishNativeComposeStorageWitnessEnrollment;
  let publications = 0;
  const mocked = spyOn(
    generationOwner,
    "publishNativeComposeStorageWitnessEnrollment"
  ).mockImplementation(async (opts) => {
    publications++;
    await expect(
      originalPublish({ ...opts, proof: { ...opts.proof } })
    ).rejects.toThrow("values omitted");
    await expect(originalPublish({ ...opts, authority: {} })).rejects.toThrow(
      "values omitted"
    );
    await expect(
      originalPublish({ ...opts, generation: { ...opts.generation } })
    ).rejects.toThrow("values omitted");
    await originalPublish(opts);
    await expect(originalPublish(opts)).rejects.toThrow("values omitted");
  });
  try {
    const { store } = await active();
    expect(publications).toBe(1);
    const current = await store.loadCurrent();
    expect(current.storageWitnessesPending).toBe(false);
    expect(current.storageWitnesses?.[0]?.state).toBe("enrolled");
    expect(current.pending).toBeNull();
  } finally {
    mocked.mockRestore();
  }
});
