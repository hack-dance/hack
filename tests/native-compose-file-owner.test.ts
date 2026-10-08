import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  lstat,
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
import { basename, join, resolve } from "node:path";
import { isRecord } from "../src/lib/guards.ts";
import {
  createNativeComposeFileOwner,
  type NativeComposeFileProjection,
} from "../src/lib/native-compose-file-owner.ts";
import {
  acquireNativeComposeFileSources,
  assertNativeComposeFileSources,
  closeNativeComposeFileSources,
  type NativeComposeFileSources,
} from "../src/lib/native-compose-file-sources.ts";
import { NATIVE_COMPOSE_FILES_EXTENSION } from "../src/lib/native-compose-file-state.ts";
import {
  type NativeComposeGenerationStore,
  type NativeComposeMutation,
  openNativeComposeGenerationStore,
} from "../src/lib/native-compose-generation.ts";
import { restoreEnv } from "./helpers/env.ts";

const KEYS = [
  "HACK_HOME",
  "HACK_GLOBAL_CONFIG_PATH",
  "HACK_CONFIG_COMPILER_BINARY",
  "HACK_ENV_SECRET_KEY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
] as const;
const SOURCE = {
  schema_version: 1,
  name: "fixture",
  worktree: { auto_branch: false },
  configs: { settings: { file: "settings.bin" } },
  secrets: { empty: { env_ref: "EMPTY" } },
  services: {
    reader: {
      image: "fixture:1",
      mounts: [
        { config: "settings", target: "/etc/settings", access: "read-only" },
        { secret: "empty", target: "/run/empty", access: "read-only" },
      ],
    },
  },
};
const BYTES = Buffer.from([0, 255, 10]);
const compiler = resolve(
  process.env.HACK_CONFIG_COMPILER_BINARY ?? "dist/hack-config-compiler"
);
let parent = "";
let root = "";
let materialRoot = "";
let store: NativeComposeGenerationStore;
let saved: Record<string, string | undefined> = {};
const sources: NativeComposeFileSources[] = [];
const owners: ReturnType<typeof createNativeComposeFileOwner>[] = [];
const stores: NativeComposeGenerationStore[] = [];
beforeEach(async () => {
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  for (const key of KEYS) {
    Reflect.deleteProperty(process.env, key);
  }
  parent = await realpath(await mkdtemp(join(tmpdir(), "native-file-owner-")));
  root = join(parent, "checkout");
  materialRoot = join(parent, "material");
  await mkdir(join(root, ".hack"), { recursive: true });
  await writeFile(
    join(root, ".hack/hack.project.json"),
    JSON.stringify(SOURCE)
  );
  await writeFile(
    join(root, ".hack/hack.env.default.yaml"),
    JSON.stringify({
      version: 1,
      environment: "default",
      secretsprovider: "project_key",
      values: { global: { EMPTY: "" } },
    })
  );
  await writeFile(join(root, "settings.bin"), BYTES);
  process.env.HACK_HOME = join(parent, "home");
  process.env.HACK_CONFIG_COMPILER_BINARY = compiler;
  store = await openNativeComposeGenerationStore({
    projectRoot: root,
    instance: null,
  });
  stores.push(store);
});
afterEach(async () => {
  await Promise.all(owners.splice(0).map((owner) => owner.close()));
  await Promise.all(sources.splice(0).map(closeNativeComposeFileSources));
  await Promise.all(stores.splice(0).map((store) => store.close()));
  for (const key of KEYS) {
    restoreEnv(key, saved[key]);
  }
  await rm(parent, { recursive: true, force: true });
});
function ownerFor(
  mutation: NativeComposeMutation,
  opts: { root?: string; afterMemberUnlink?: () => Promise<void> } = {}
) {
  const owner = createNativeComposeFileOwner({
    root: opts.root ?? materialRoot,
    authority: mutation.materialAuthority,
    afterMemberUnlink: opts.afterMemberUnlink,
  });
  owners.push(owner);
  return owner;
}
function memberPaths(projection: NativeComposeFileProjection): string[] {
  return Object.values(projection.workloads).flatMap((grants) =>
    grants.map((grant) => grant.source)
  );
}
function journalPath(projection: NativeComposeFileProjection): string {
  return join(
    projection.reference.root,
    `${projection.reference.generationId}-${projection.reference.snapshotToken}`,
    "journal.jsonl"
  );
}
async function staged(
  mutation: NativeComposeMutation,
  options: {
    afterMemberUnlink?: () => Promise<void>;
    mutateDocument?: (document: Record<string, unknown>) => void;
  } = {}
) {
  const reservation = mutation.reserveGeneration();
  const acquired = await acquireNativeComposeFileSources({
    authority: mutation.materialAuthority,
    reservation,
  });
  sources.push(acquired);
  const owner = ownerFor(mutation, options);
  const attempt = await owner.prepare({ reservation, sources: acquired });
  const projection = await owner.projection(attempt);
  const labels = {
    "io.hack.native-config.version": "1",
    "io.hack.native-config.instance": reservation.identity.composeProject,
    "io.hack.native-config.owner": reservation.identity.ownerToken,
  };
  const document: Record<string, unknown> = {
    name: reservation.identity.composeProject,
    services: {
      reader: {
        image: "fixture:1",
        labels: {
          ...labels,
          "io.hack.native-config.generation": reservation.generationId,
          "io.hack.native-config.workload": "service",
        },
        volumes: projection.workloads.reader,
      },
    },
    networks: { default: { labels } },
    [NATIVE_COMPOSE_FILES_EXTENSION]: projection.reference,
  };
  options.mutateDocument?.(document);
  const assertFresh = async () => {
    await assertNativeComposeFileSources({
      authority: mutation.materialAuthority,
      reservation,
      sources: acquired,
    });
  };
  const generation = await mutation.publish({
    reservation,
    composeJson: JSON.stringify(document),
    profiles: [],
    inputRevision: await assertNativeComposeFileSources({
      authority: mutation.materialAuthority,
      reservation,
      sources: acquired,
    }),
    assertFresh,
  });
  return { owner, attempt, generation, projection, assertFresh };
}
async function running(
  mutation: NativeComposeMutation,
  options: Parameters<typeof staged>[1] = {}
) {
  const selected = await staged(mutation, options);
  await mutation.runEffect({
    generation: selected.generation,
    operation: "up",
    assertFresh: selected.assertFresh,
    assertOwned: async () => {},
    effect: async () => {
      await selected.owner.arm({
        attempt: selected.attempt,
        generation: selected.generation,
      });
      await selected.owner.recordChildReaped({
        attempt: selected.attempt,
        generation: selected.generation,
        assertReaped: async () => {},
      });
      return { outcome: "complete", value: 0 };
    },
  });
  return selected;
}
async function expectPresent(paths: readonly string[]) {
  for (const path of paths) {
    expect((await lstat(path)).isFile()).toBe(true);
  }
}
async function expectAbsent(paths: readonly string[]) {
  for (const path of paths) {
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
  }
}
test("actual acquisition stages binary/empty 0444 files outside checkout; exact bind/ref projection arms before simulated child", async () => {
  await store.withMutation(async (mutation) => {
    const selected = await staged(mutation);
    expect(JSON.stringify(selected.attempt)).toBe("{}");
    const paths = memberPaths(selected.projection);
    expect(paths.every((path) => !path.startsWith(root))).toBe(true);
    expect(await readFile(paths[0] ?? "")).toEqual(BYTES);
    expect(await readFile(paths[1] ?? "")).toEqual(Buffer.alloc(0));
    for (const path of paths) {
      expect((await lstat(path)).mode & 0o777).toBe(0o444);
    }
    let simulatedChildren = 0;
    await mutation.runEffect({
      generation: selected.generation,
      operation: "up",
      assertFresh: selected.assertFresh,
      assertOwned: async () => {},
      effect: async () => {
        await selected.owner.arm({
          attempt: selected.attempt,
          generation: selected.generation,
        });
        simulatedChildren += 1;
        await selected.owner.recordChildReaped({
          attempt: selected.attempt,
          generation: selected.generation,
          assertReaped: async () => {},
        });
        expect(
          await readFile(journalPath(selected.projection), "utf8")
        ).toContain('"phase":"armed"');
        return { outcome: "complete", value: 0 };
      },
    });
    expect(simulatedChildren).toBe(1);
    await selected.owner.assertSavedReady(selected.generation);
    await expect(
      selected.owner.arm({
        attempt: { ...selected.attempt },
        generation: selected.generation,
      })
    ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_STATE" });
  });
});
async function dollarFixture(): Promise<void> {
  materialRoot = join(parent, "material-${ROOT}-$cash");
  const authored = structuredClone(SOURCE);
  const grant = authored.services.reader.mounts[0];
  if (!grant) {
    throw new Error("missing authored fixture grant");
  }
  grant.target = "/etc/${TARGET}/$settings";
  await writeFile(
    join(root, ".hack/hack.project.json"),
    JSON.stringify(authored)
  );
}
test("literal dollar roots and targets are encoded once in binds while saved filesystem anchors stay raw", async () => {
  await dollarFixture();
  await store.withMutation(async (mutation) => {
    const selected = await running(mutation);
    const grant = selected.projection.workloads.reader?.[0];
    expect(grant?.target).toBe("/etc/$${TARGET}/$$settings");
    expect(grant?.source).toBe(
      join(
        parent,
        "material-$${ROOT}-$$cash",
        `${selected.projection.reference.generationId}-${selected.projection.reference.snapshotToken}`,
        basename(grant?.source ?? "")
      )
    );
    expect(selected.projection.reference.root).toBe(materialRoot);
    expect(
      await readFile(
        join(
          materialRoot,
          `${selected.projection.reference.generationId}-${selected.projection.reference.snapshotToken}`,
          basename(grant?.source ?? "")
        )
      )
    ).toEqual(BYTES);
    await selected.owner.assertSavedReady(selected.generation);
  });
});
test.each([
  "extra-private-bind",
  "interpolated-bind",
] as const)("%s refuses before simulated child for a dollar-containing material root", async (kind) => {
  await dollarFixture();
  await store.withMutation(async (mutation) => {
    const selected = await staged(mutation, {
      mutateDocument: (document) => {
        if (
          !(
            isRecord(document.services) &&
            isRecord(document.services.reader) &&
            Array.isArray(document.services.reader.volumes)
          )
        ) {
          throw new Error("invalid generated fixture services");
        }
        document.services.reader.volumes = [
          ...document.services.reader.volumes,
          {
            type: "bind",
            source:
              kind === "extra-private-bind"
                ? `${materialRoot.replaceAll("$", () => "$$")}/extra`
                : "/tmp/${UNQUALIFIED}",
            target: "/unexpected",
            read_only: true,
            bind: { create_host_path: false },
          },
        ];
      },
    });
    let children = 0;
    await expect(
      mutation.runEffect({
        generation: selected.generation,
        operation: "up",
        assertFresh: selected.assertFresh,
        assertOwned: async () => {},
        effect: async () => {
          await selected.owner.arm({
            attempt: selected.attempt,
            generation: selected.generation,
          });
          children += 1;
          return { outcome: "complete", value: 0 };
        },
      })
    ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_UNCERTAIN" });
    expect(children).toBe(0);
    expect((await store.loadPending())?.generationId).toBe(
      selected.generation.generationId
    );
    expect(
      await readFile(journalPath(selected.projection), "utf8")
    ).not.toContain('"phase":"armed"');
  });
});
test.each([
  "checkout-root",
  "unreceipted-root",
] as const)("%s refuses staging without adopting material", async (kind) => {
  if (kind === "unreceipted-root") {
    await mkdir(materialRoot, { mode: 0o700 });
  }
  await store.withMutation(async (mutation) => {
    const reservation = mutation.reserveGeneration();
    const acquired = await acquireNativeComposeFileSources({
      authority: mutation.materialAuthority,
      reservation,
    });
    sources.push(acquired);
    const owner = ownerFor(mutation, {
      root: kind === "checkout-root" ? join(root, "private") : materialRoot,
    });
    await expect(
      owner.prepare({ reservation, sources: acquired })
    ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_STATE" });
  });
});
test("changed exact bind projection prevents the simulated engine child and retains pending reference", async () => {
  await store.withMutation(async (mutation) => {
    const selected = await staged(mutation, {
      mutateDocument: (document) => {
        document.services = {
          reader: {
            image: "fixture:1",
            labels: {
              "io.hack.native-config.version": "1",
              "io.hack.native-config.instance": store.identity.composeProject,
              "io.hack.native-config.owner": store.identity.ownerToken,
              "io.hack.native-config.generation": (
                document[
                  NATIVE_COMPOSE_FILES_EXTENSION
                ] as NativeComposeFileProjection["reference"]
              ).generationId,
              "io.hack.native-config.workload": "service",
            },
            volumes: [],
          },
        };
      },
    });
    let effects = 0;
    await expect(
      mutation.runEffect({
        generation: selected.generation,
        operation: "up",
        assertFresh: selected.assertFresh,
        assertOwned: async () => {},
        effect: async () => {
          await selected.owner.arm({
            attempt: selected.attempt,
            generation: selected.generation,
          });
          await selected.owner.recordChildReaped({
            attempt: selected.attempt,
            generation: selected.generation,
            assertReaped: async () => {},
          });
          effects += 1;
          return { outcome: "complete", value: 0 };
        },
      })
    ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_UNCERTAIN" });
    expect(effects).toBe(0);
    expect((await store.loadPending())?.generationId).toBe(
      selected.generation.generationId
    );
    await expectPresent(memberPaths(selected.projection));
  });
});
test("source-unavailable saved down retires only exact material before completed receipt; retired reference is idempotent", async () => {
  const selected = await store.withMutation(running);
  await unlink(join(root, "settings.bin"));
  await unlink(join(root, ".hack/hack.project.json"));
  await unlink(join(root, ".hack/hack.env.default.yaml"));
  const saved = await openNativeComposeGenerationStore({
    projectRoot: root,
    instance: null,
    mode: "saved",
  });
  stores.push(saved);
  const { generation } = await saved.loadCurrent();
  if (!generation) {
    throw new Error("missing fixture generation");
  }
  await saved.withMutation(async (mutation) => {
    const owner = ownerFor(mutation);
    await owner.assertSavedReady(generation);
    await mutation.runEffect({
      generation,
      operation: "down",
      assertOwned: async () => {},
      effect: async () => ({ outcome: "complete", value: 0 }),
      beforeComplete: async () => {
        expect((await saved.loadCurrent()).stopped).toBe(false);
        await owner.retire({ generation, assertAbsent: async () => {} });
        expect((await saved.loadPending())?.generationId).toBe(
          generation.generationId
        );
      },
    });
    expect((await saved.loadCurrent()).stopped).toBe(true);
    await expectAbsent(memberPaths(selected.projection));
    await expect(owner.assertSavedReady(generation)).rejects.toMatchObject({
      code: "E_NATIVE_COMPOSE_STATE",
    });
  });
});
test.each([
  "absent-proof",
  "missing-before-intent",
  "replacement",
  "journal-substitution",
] as const)("%s retirement refusal preserves pending generation and remaining material", async (kind) => {
  const selected = await store.withMutation(running);
  const paths = memberPaths(selected.projection);
  const first = paths[0];
  if (!first) {
    throw new Error("missing fixture member");
  }
  if (kind === "missing-before-intent") {
    await unlink(first);
  } else if (kind === "replacement") {
    await rename(first, `${first}.original`);
    await writeFile(first, BYTES, { mode: 0o444 });
  } else if (kind === "journal-substitution") {
    const journal = journalPath(selected.projection);
    const bytes = await readFile(journal);
    await rename(journal, `${journal}.original`);
    await writeFile(journal, bytes, { mode: 0o600 });
  }
  await store.withMutation(async (mutation) => {
    const owner = ownerFor(mutation);
    await expect(
      mutation.runEffect({
        generation: selected.generation,
        operation: "down",
        assertOwned: async () => {},
        effect: async () => ({ outcome: "complete", value: 0 }),
        beforeComplete: async () => {
          await owner.retire({
            generation: selected.generation,
            assertAbsent: async () => {
              if (kind === "absent-proof") {
                throw new Error("synthetic owned container still exists");
              }
            },
          });
        },
      })
    ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_UNCERTAIN" });
    expect((await store.loadPending())?.generationId).toBe(
      selected.generation.generationId
    );
    const document = await store.readGenerationDocument(selected.generation);
    expect(document[NATIVE_COMPOSE_FILES_EXTENSION]).toEqual(
      selected.projection.reference
    );
    expect((await store.loadCurrent()).stopped).toBe(false);
    await expectPresent(paths.slice(1));
  });
});
test("partial unlink interruption retains durable intent and exact pending reference; fresh saved mutation resumes without source", async () => {
  const selected = await store.withMutation(running);
  let unlinked = 0;
  await store.withMutation(async (mutation) => {
    const owner = ownerFor(mutation, {
      afterMemberUnlink: async () => {
        unlinked += 1;
        throw new Error("synthetic interruption before directory sync");
      },
    });
    await expect(
      mutation.runEffect({
        generation: selected.generation,
        operation: "down",
        assertOwned: async () => {},
        effect: async () => ({ outcome: "complete", value: 0 }),
        beforeComplete: async () => {
          await owner.retire({
            generation: selected.generation,
            assertAbsent: async () => {},
          });
        },
      })
    ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_UNCERTAIN" });
    expect(unlinked).toBe(1);
    const journal = await readFile(journalPath(selected.projection), "utf8");
    expect(journal).toContain('"phase":"retiring"');
    expect(journal).not.toContain('"phase":"retired"');
    expect((await store.loadPending())?.generationId).toBe(
      selected.generation.generationId
    );
    expect(
      (await store.readGenerationDocument(selected.generation))[
        NATIVE_COMPOSE_FILES_EXTENSION
      ]
    ).toEqual(selected.projection.reference);
  });
  await unlink(join(root, ".hack/hack.project.json"));
  await store.withMutation(async (mutation) => {
    const owner = ownerFor(mutation);
    await mutation.runEffect({
      generation: selected.generation,
      operation: "down",
      recoverPending: true,
      assertOwned: async () => {},
      effect: async () => ({ outcome: "complete", value: 0 }),
      beforeComplete: async () => {
        await owner.retire({
          generation: selected.generation,
          assertAbsent: async () => {},
        });
      },
    });
    await expectAbsent(memberPaths(selected.projection));
    expect((await store.loadCurrent()).pending).toBeNull();
    expect((await store.loadCurrent()).stopped).toBe(true);
  });
});
test("failure after retired marker but before receipt commit keeps exact recovery generation and retries marker idempotently", async () => {
  const selected = await store.withMutation(running);
  await store.withMutation(async (mutation) => {
    const owner = ownerFor(mutation);
    await expect(
      mutation.runEffect({
        generation: selected.generation,
        operation: "down",
        assertOwned: async () => {},
        effect: async () => ({ outcome: "complete", value: 0 }),
        beforeComplete: async () => {
          await owner.retire({
            generation: selected.generation,
            assertAbsent: async () => {},
          });
          throw new Error("synthetic crash at composite boundary");
        },
      })
    ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_UNCERTAIN" });
    expect((await store.loadPending())?.generationId).toBe(
      selected.generation.generationId
    );
    expect(
      (await store.readGenerationDocument(selected.generation))[
        NATIVE_COMPOSE_FILES_EXTENSION
      ]
    ).toEqual(selected.projection.reference);
    expect(await readFile(journalPath(selected.projection), "utf8")).toContain(
      '"phase":"retired"'
    );
  });
  await store.withMutation(async (mutation) => {
    const owner = ownerFor(mutation);
    await mutation.runEffect({
      generation: selected.generation,
      operation: "down",
      recoverPending: true,
      assertOwned: async () => {},
      effect: async () => ({ outcome: "complete", value: 0 }),
      beforeComplete: async () => {
        await owner.retire({
          generation: selected.generation,
          assertAbsent: async () => {},
        });
      },
    });
    expect((await store.loadCurrent()).stopped).toBe(true);
    await expectAbsent(memberPaths(selected.projection));
  });
}, 30_000);
test("uncertain after hook permits owned stop but retains material and blocks completion", async () => {
  let hooks = 0;
  const selected = await store.withMutation(async (mutation) => {
    const selected = await staged(mutation);
    await expect(
      mutation.runEffect({
        generation: selected.generation,
        operation: "up",
        assertFresh: selected.assertFresh,
        assertOwned: async () => {},
        effect: async () => {
          await selected.owner.arm({
            attempt: selected.attempt,
            generation: selected.generation,
          });
          await selected.owner.recordChildReaped({
            attempt: selected.attempt,
            generation: selected.generation,
            assertReaped: async () => {},
          });
          return { outcome: "complete", value: 0 };
        },
        afterHooks: {
          prepare: async () => async () => {
            hooks += 1;
            return { outcome: "uncertain", value: 1, ready: false };
          },
        },
      })
    ).resolves.toEqual({ outcome: "uncertain", value: 1 });
    return selected;
  });
  expect(hooks).toBe(1);
  await store.withMutation(async (mutation) => {
    const owner = ownerFor(mutation);
    let children = 0;
    let finalizers = 0;
    let proofs = 0;
    await expect(
      mutation.runEffect({
        generation: selected.generation,
        operation: "down",
        recoverPending: true,
        assertOwned: async () => {},
        effect: async () => {
          children += 1;
          return { outcome: "complete", value: 0 };
        },
        beforeComplete: async () => {
          finalizers += 1;
          await owner.retire({
            generation: selected.generation,
            assertAbsent: async () => {
              proofs += 1;
            },
          });
        },
      })
    ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_UNCERTAIN" });
    expect(children).toBe(1);
    expect(finalizers).toBe(1);
    expect(proofs).toBe(0);
    expect((await store.loadPending())?.generationId).toBe(
      selected.generation.generationId
    );
    await expectPresent(memberPaths(selected.projection));
    expect(
      await readFile(journalPath(selected.projection), "utf8")
    ).not.toContain('"phase":"retiring"');
  });
});

test("live unarmed rollback retires exact new files despite source change; armed or copied attempts cannot authorize it", async () => {
  await store.withMutation(async (mutation) => {
    const selected = await staged(mutation);
    await unlink(join(root, "settings.bin"));
    await expect(
      selected.owner.rollback({ ...selected.attempt })
    ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_STATE" });
    await expectPresent(memberPaths(selected.projection));
    await selected.owner.rollback(selected.attempt);
    await expectAbsent(memberPaths(selected.projection));
    expect(await readFile(journalPath(selected.projection), "utf8")).toContain(
      '"phase":"rollback"'
    );
    expect((await store.loadCurrent()).pending).toBeNull();
  });
});
test("ownership drift after material retirement blocks completed receipt and keeps generation plus retired anchor", async () => {
  const selected = await store.withMutation(running);
  await store.withMutation(async (mutation) => {
    const owner = ownerFor(mutation);
    let owned = true;
    await expect(
      mutation.runEffect({
        generation: selected.generation,
        operation: "down",
        assertOwned: async () => {
          if (!owned) {
            throw new Error("synthetic foreign ownership after finalizer");
          }
        },
        effect: async () => ({ outcome: "complete", value: 0 }),
        beforeComplete: async () => {
          await owner.retire({
            generation: selected.generation,
            assertAbsent: async () => {},
          });
          owned = false;
        },
      })
    ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_UNCERTAIN" });
    expect((await store.loadCurrent()).stopped).toBe(false);
    expect((await store.loadPending())?.generationId).toBe(
      selected.generation.generationId
    );
    expect(
      (await store.readGenerationDocument(selected.generation))[
        NATIVE_COMPOSE_FILES_EXTENSION
      ]
    ).toEqual(selected.projection.reference);
    expect(await readFile(journalPath(selected.projection), "utf8")).toContain(
      '"phase":"retired"'
    );
  });
});
test("absence proof drift during retirement preserves other members and pending recovery state", async () => {
  const selected = await store.withMutation(running);
  await store.withMutation(async (mutation) => {
    let absent = true;
    const owner = ownerFor(mutation, {
      afterMemberUnlink: async () => {
        absent = false;
      },
    });
    await expect(
      mutation.runEffect({
        generation: selected.generation,
        operation: "down",
        assertOwned: async () => {},
        effect: async () => ({ outcome: "complete", value: 0 }),
        beforeComplete: async () => {
          await owner.retire({
            generation: selected.generation,
            assertAbsent: async () => {
              if (!absent) {
                throw new Error("synthetic concurrent owning container");
              }
            },
          });
        },
      })
    ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_UNCERTAIN" });
    await expectAbsent(memberPaths(selected.projection).slice(0, 1));
    await expectPresent(memberPaths(selected.projection).slice(1));
    expect((await store.loadPending())?.generationId).toBe(
      selected.generation.generationId
    );
    expect(
      await readFile(journalPath(selected.projection), "utf8")
    ).not.toContain('"phase":"retired"');
  });
});

test("replacement retires obsolete current snapshot before receipt handoff while new pending material remains", async () => {
  await store.withMutation(async (mutation) => {
    const old = await running(mutation);
    await writeFile(join(root, "settings.bin"), Buffer.from([5, 6, 7]));
    const current = await staged(mutation);
    await mutation.runEffect({
      generation: current.generation,
      operation: "up",
      assertFresh: current.assertFresh,
      assertOwned: async () => {},
      effect: async () => {
        await current.owner.arm({
          attempt: current.attempt,
          generation: current.generation,
        });
        await current.owner.recordChildReaped({
          attempt: current.attempt,
          generation: current.generation,
          assertReaped: async () => {},
        });
        return { outcome: "complete", value: 0 };
      },
      beforeComplete: async () => {
        await expect(
          current.owner.retire({
            generation: current.generation,
            assertAbsent: async () => {},
          })
        ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_STATE" });
        await old.owner.retire({
          generation: old.generation,
          assertAbsent: async () => {},
        });
        await expectAbsent(memberPaths(old.projection));
        await expectPresent(memberPaths(current.projection));
        expect((await store.loadPending())?.generationId).toBe(
          current.generation.generationId
        );
      },
    });
    expect((await store.loadCurrent()).generation?.generationId).toBe(
      current.generation.generationId
    );
    await current.owner.assertSavedReady(current.generation);
  });
}, 30_000);
test("a replacement member after partial retirement is never deleted on retry", async () => {
  const selected = await store.withMutation(running);
  const paths = memberPaths(selected.projection);
  const remaining = paths[1];
  if (!remaining) {
    throw new Error("missing fixture member");
  }
  await store.withMutation(async (mutation) => {
    const owner = ownerFor(mutation, {
      afterMemberUnlink: async () => {
        throw new Error("synthetic interruption");
      },
    });
    await expect(
      mutation.runEffect({
        generation: selected.generation,
        operation: "down",
        assertOwned: async () => {},
        effect: async () => ({ outcome: "complete", value: 0 }),
        beforeComplete: async () => {
          await owner.retire({
            generation: selected.generation,
            assertAbsent: async () => {},
          });
        },
      })
    ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_UNCERTAIN" });
  });
  await rename(remaining, `${remaining}.original`);
  await writeFile(remaining, Buffer.alloc(0), { mode: 0o444 });
  const replacement = await lstat(remaining);
  await store.withMutation(async (mutation) => {
    const owner = ownerFor(mutation);
    await expect(
      mutation.runEffect({
        generation: selected.generation,
        operation: "down",
        recoverPending: true,
        assertOwned: async () => {},
        effect: async () => ({ outcome: "complete", value: 0 }),
        beforeComplete: async () => {
          await owner.retire({
            generation: selected.generation,
            assertAbsent: async () => {},
          });
        },
      })
    ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_UNCERTAIN" });
    expect((await lstat(remaining)).ino).toBe(replacement.ino);
    expect((await store.loadPending())?.generationId).toBe(
      selected.generation.generationId
    );
    expect(
      await readFile(journalPath(selected.projection), "utf8")
    ).not.toContain('"phase":"retired"');
  });
}, 30_000);

test("armed startup without durable reaped evidence cannot retire from container absence or a fresh public ticket", async () => {
  const selected = await store.withMutation(async (mutation) => {
    const selected = await staged(mutation);
    let childFinished = false;
    await expect(
      mutation.runEffect({
        generation: selected.generation,
        operation: "up",
        assertFresh: selected.assertFresh,
        assertOwned: async () => {},
        effect: async () => {
          await selected.owner.arm({
            attempt: selected.attempt,
            generation: selected.generation,
          });
          await expect(
            selected.owner.recordChildReaped({
              attempt: selected.attempt,
              generation: selected.generation,
              assertReaped: async () => {
                if (!childFinished) {
                  throw new Error("synthetic child remains unresolved");
                }
              },
            })
          ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_STATE" });
          return { outcome: "uncertain", value: 1 };
        },
      })
    ).resolves.toEqual({ outcome: "uncertain", value: 1 });
    childFinished = true;
    return selected;
  });
  expect(
    await readFile(journalPath(selected.projection), "utf8")
  ).not.toContain('"phase":"reaped"');
  await store.withMutation(async (mutation) => {
    const owner = ownerFor(mutation);
    let proofs = 0;
    await expect(
      mutation.runEffect({
        generation: selected.generation,
        operation: "down",
        recoverPending: true,
        assertOwned: async () => {},
        effect: async () => ({ outcome: "complete", value: 0 }),
        beforeComplete: async () => {
          await expect(
            owner.recordChildReaped({
              attempt: selected.attempt,
              generation: selected.generation,
              assertReaped: async () => {},
            })
          ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_STATE" });
          await owner.retire({
            generation: selected.generation,
            assertAbsent: async () => {
              proofs += 1;
            },
          });
        },
      })
    ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_UNCERTAIN" });
    expect(proofs).toBe(0);
    expect((await store.loadPending())?.generationId).toBe(
      selected.generation.generationId
    );
    await expectPresent(memberPaths(selected.projection));
  });
});
test("known reaped readiness failure retains pending material until a separate verified stop retires it", async () => {
  const selected = await store.withMutation(async (mutation) => {
    const selected = await staged(mutation);
    await expect(
      mutation.runEffect({
        generation: selected.generation,
        operation: "up",
        assertFresh: selected.assertFresh,
        assertOwned: async () => {},
        effect: async () => {
          await selected.owner.arm({
            attempt: selected.attempt,
            generation: selected.generation,
          });
          await selected.owner.recordChildReaped({
            attempt: selected.attempt,
            generation: selected.generation,
            assertReaped: async () => {},
          });
          return { outcome: "uncertain", value: 1 };
        },
      })
    ).resolves.toEqual({ outcome: "uncertain", value: 1 });
    await expect(
      selected.owner.rollback(selected.attempt)
    ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_STATE" });
    await expectPresent(memberPaths(selected.projection));
    return selected;
  });
  await store.withMutation(async (mutation) => {
    const owner = ownerFor(mutation);
    await mutation.runEffect({
      generation: selected.generation,
      operation: "down",
      recoverPending: true,
      assertOwned: async () => {},
      effect: async () => ({ outcome: "complete", value: 0 }),
      beforeComplete: async () => {
        await owner.retire({
          generation: selected.generation,
          assertAbsent: async () => {},
        });
      },
    });
    expect((await store.loadCurrent()).stopped).toBe(true);
    await expectAbsent(memberPaths(selected.projection));
  });
});
