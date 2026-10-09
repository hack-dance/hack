import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmod,
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
import { runNativeComposeOwnedFileChild } from "../src/lib/native-compose-file-command.ts";
import {
  createNativeComposeFileOwner,
  type NativeComposeFileProjection,
} from "../src/lib/native-compose-file-owner.ts";
import {
  acquireNativeComposeFileDeliveryInputs,
  acquireNativeComposeFileSources,
  assertNativeComposeFileSources,
  closeNativeComposeFileSources,
  type NativeComposeFileSources,
} from "../src/lib/native-compose-file-sources.ts";
import {
  NATIVE_COMPOSE_FILES_EXTENSION,
  parseNativeComposeFileManifest,
  parseNativeComposeFileReference,
} from "../src/lib/native-compose-file-state.ts";
import {
  type NativeComposeGenerationStore,
  type NativeComposeMaterialBinding,
  type NativeComposeMutation,
  openNativeComposeGenerationStore,
} from "../src/lib/native-compose-generation.ts";
import {
  assertNativeComposeSupported,
  renderNativeCompose,
} from "../src/lib/native-compose-renderer.ts";
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
type FileOwnerDiagnosticStage =
  | "authored-fixture"
  | "mutation"
  | "acquire"
  | "prepare"
  | "projection"
  | "publish"
  | "assert-fresh"
  | "effect"
  | "arm"
  | "reap"
  | "member-bytes"
  | "saved-ready";
type FileOwnerDiagnostic = (
  stage: FileOwnerDiagnosticStage,
  boundary: "begin" | "end"
) => void;

/** Opt-in same-budget timing exposes fixed lifecycle stages, never material. */
function literalDollarDiagnostic(): FileOwnerDiagnostic | undefined {
  const enabled = process.env.HACK_TEST_NATIVE_FILE_OWNER_DIAGNOSTICS === "1";
  if (!enabled) {
    return;
  }
  const startedAt = performance.now();
  const counts: Partial<Record<FileOwnerDiagnosticStage, number>> = {};
  return (stage, boundary) => {
    if (boundary === "begin") {
      counts[stage] = (counts[stage] ?? 0) + 1;
    }
    console.error(
      JSON.stringify({
        diagnostic: "native-file-owner-literal-dollar",
        stage,
        boundary,
        count: counts[stage] ?? 0,
        elapsedMs: Math.round(performance.now() - startedAt),
      })
    );
  };
}
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
    diagnostic?: FileOwnerDiagnostic;
  } = {}
) {
  const reservation = mutation.reserveGeneration();
  options.diagnostic?.("acquire", "begin");
  const acquired = await acquireNativeComposeFileSources({
    authority: mutation.materialAuthority,
    reservation,
  });
  options.diagnostic?.("acquire", "end");
  sources.push(acquired);
  const owner = ownerFor(mutation, options);
  options.diagnostic?.("prepare", "begin");
  const attempt = await owner.prepare({ reservation, sources: acquired });
  options.diagnostic?.("prepare", "end");
  options.diagnostic?.("projection", "begin");
  const projection = await owner.projection(attempt);
  options.diagnostic?.("projection", "end");
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
    options.diagnostic?.("assert-fresh", "begin");
    await assertNativeComposeFileSources({
      authority: mutation.materialAuthority,
      reservation,
      sources: acquired,
    });
    options.diagnostic?.("assert-fresh", "end");
  };
  options.diagnostic?.("publish", "begin");
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
  options.diagnostic?.("publish", "end");
  return { owner, attempt, generation, projection, assertFresh };
}
async function running(
  mutation: NativeComposeMutation,
  options: Parameters<typeof staged>[1] = {}
) {
  const selected = await staged(mutation, options);
  options.diagnostic?.("effect", "begin");
  await mutation.runEffect({
    generation: selected.generation,
    operation: "up",
    assertFresh: selected.assertFresh,
    assertOwned: async () => {},
    effect: async () => {
      options.diagnostic?.("arm", "begin");
      await selected.owner.arm({
        attempt: selected.attempt,
        generation: selected.generation,
      });
      options.diagnostic?.("arm", "end");
      options.diagnostic?.("reap", "begin");
      await selected.owner.recordChildReaped({
        attempt: selected.attempt,
        generation: selected.generation,
        assertReaped: async () => {},
      });
      options.diagnostic?.("reap", "end");
      return { outcome: "complete", value: 0 };
    },
  });
  options.diagnostic?.("effect", "end");
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
for (const operation of ["up", "down"] as const) {
  test(`cancellation during the last durable ${operation} arm never spawns a child and retains the exact pending material`, async () => {
    const initial =
      operation === "down" ? await store.withMutation(running) : null;
    await store.withMutation(async (mutation) => {
      const selected = initial ?? (await staged(mutation));
      const owner = initial ? ownerFor(mutation) : selected.owner;
      const controller = new AbortController();
      const marker = join(parent, "unexpected-child");
      await expect(
        mutation.runEffect({
          generation: selected.generation,
          operation,
          assertFresh: operation === "up" ? selected.assertFresh : undefined,
          assertOwned: async () => {},
          effect: async () => {
            const input = {
              command: [
                process.execPath,
                "-e",
                `await Bun.write(${JSON.stringify(marker)}, "effect")`,
              ],
              signal: controller.signal,
              deadline: Date.now() + 10_000,
              options: {
                stdin: "ignore" as const,
                stdout: "ignore" as const,
                stderr: "ignore" as const,
              },
              assertOwned: async () => {},
              arm: async () => {
                if (operation === "up") {
                  await owner.arm({
                    attempt: selected.attempt,
                    generation: selected.generation,
                  });
                } else {
                  expect(
                    await owner.armStop(selected.generation)
                  ).not.toBeNull();
                }
                controller.abort();
                Object.assign(input, {
                  signal: new AbortController().signal,
                  deadline: Date.now() + 60_000,
                });
              },
            };
            const code = await runNativeComposeOwnedFileChild(input);
            return { outcome: "complete", value: code };
          },
        })
      ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_UNCERTAIN" });
      expect(await Bun.file(marker).exists()).toBe(false);
      expect((await store.loadPending())?.generationId).toBe(
        selected.generation.generationId
      );
      expect(
        (await store.readGenerationDocument(selected.generation))[
          NATIVE_COMPOSE_FILES_EXTENSION
        ]
      ).toEqual(selected.projection.reference);
      const journal = await readFile(journalPath(selected.projection), "utf8");
      expect(journal).toContain(
        operation === "up" ? '"phase":"armed"' : '"phase":"stop-armed"'
      );
      expect(journal).not.toContain(
        operation === "up" ? '"phase":"reaped"' : '"phase":"stop-reaped"'
      );
      await expectPresent(memberPaths(selected.projection));
    });
  });
}
test("actual acquisition stages binary and empty 0444 files outside checkout", async () => {
  await store.withMutation(async (mutation) => {
    const selected = await staged(mutation);
    expect(JSON.stringify(selected.attempt)).toBe("{}");
    const paths = memberPaths(selected.projection);
    expect(selected.projection.reference.version).toBe(1);
    expect(paths.every((path) => !path.startsWith(root))).toBe(true);
    expect(await readFile(paths[0] ?? "")).toEqual(BYTES);
    expect(await readFile(paths[1] ?? "")).toEqual(Buffer.alloc(0));
    for (const path of paths) {
      expect((await lstat(path)).mode & 0o777).toBe(0o444);
    }
  });
});
test("exact bind/ref projection arms before simulated child and rejects a cloned capability", async () => {
  await store.withMutation(async (mutation) => {
    const selected = await staged(mutation);
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
  const diagnostic = literalDollarDiagnostic();
  diagnostic?.("authored-fixture", "begin");
  await dollarFixture();
  diagnostic?.("authored-fixture", "end");
  diagnostic?.("mutation", "begin");
  await store.withMutation(async (mutation) => {
    const selected = await running(mutation, { diagnostic });
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
    diagnostic?.("member-bytes", "begin");
    expect(
      await readFile(
        join(
          materialRoot,
          `${selected.projection.reference.generationId}-${selected.projection.reference.snapshotToken}`,
          basename(grant?.source ?? "")
        )
      )
    ).toEqual(BYTES);
    diagnostic?.("member-bytes", "end");
    diagnostic?.("saved-ready", "begin");
    await selected.owner.assertSavedReady(selected.generation);
    diagnostic?.("saved-ready", "end");
  });
  diagnostic?.("mutation", "end");
});
test("actual renderer requires the exact live owner projection and preserves literal bind encoding once", async () => {
  await dollarFixture();
  await store.withMutation(async (mutation) => {
    const reservation = mutation.reserveGeneration();
    const selected = await acquireNativeComposeFileSources({
      authority: mutation.materialAuthority,
      reservation,
    });
    sources.push(selected);
    const inputs = await acquireNativeComposeFileDeliveryInputs({
      sources: selected,
      authority: mutation.materialAuthority,
      reservation,
    });
    const owner = ownerFor(mutation);
    const attempt = await owner.prepare({ reservation, sources: selected });
    const projection = await owner.projection(attempt);
    const options = {
      plan: inputs.result.plan,
      environmentPlan: inputs.result.environment_plan,
      filePlan: inputs.result.file_plan,
      declaredWorkloads: inputs.result.declared_workloads,
      projectRoot: root,
      runtimeIdentity: store.identity.composeProject,
      generationIdentity: reservation.generationId,
      ownerToken: store.identity.ownerToken,
      managedValues: await inputs.resolveManagedValues(),
    };
    assertNativeComposeSupported(options);
    expect(() => renderNativeCompose(options)).toThrow();
    expect(() =>
      renderNativeCompose({ ...options, fileProjection: { ...projection } })
    ).toThrow();
    const rendered = renderNativeCompose({
      ...options,
      fileProjection: projection,
    });
    expect(rendered.document.services.reader?.volumes).toEqual([
      ...(projection.workloads.reader ?? []),
    ]);
    expect(rendered.json).toContain("/etc/$${TARGET}/$$settings");
    expect(rendered.json).not.toContain("/etc/$$$${TARGET}/$$$$settings");
    const generation = await mutation.publish({
      reservation,
      composeJson: rendered.json,
      profiles: rendered.profiles,
      inputRevision: inputs.inputRevision,
      assertFresh: inputs.assertFresh,
    });
    await mutation.runEffect({
      generation,
      operation: "up",
      assertFresh: inputs.assertFresh,
      assertOwned: async () => {},
      effect: async () => {
        await owner.arm({ attempt, generation });
        await owner.recordChildReaped({
          attempt,
          generation,
          assertReaped: async () => {},
        });
        return { outcome: "complete", value: 0 };
      },
    });
    await owner.assertSavedReady(generation);
    await owner.close();
    expect(() =>
      renderNativeCompose({ ...options, fileProjection: projection })
    ).toThrow();
  });
}, 30_000);
test("only the original live stop attempt may reap; copied and replacement-owner handles refuse", async () => {
  const selected = await store.withMutation(running);
  await store.withMutation(async (mutation) => {
    const owner = ownerFor(mutation);
    await mutation.runEffect({
      generation: selected.generation,
      operation: "down",
      assertOwned: async () => {},
      beforeComplete: async () => {
        await owner.retire({
          generation: selected.generation,
          assertAbsent: async () => {},
        });
      },
      effect: async () => {
        const attempt = await owner.armStop(selected.generation);
        if (!attempt) {
          throw new Error("Missing actual stop attempt");
        }
        const replacement = ownerFor(mutation);
        await expect(
          owner.recordStopReaped({
            attempt: { ...attempt },
            assertReaped: async () => {},
          })
        ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_STATE" });
        await expect(
          replacement.recordStopReaped({
            attempt,
            assertReaped: async () => {},
          })
        ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_STATE" });
        await owner.recordStopReaped({ attempt, assertReaped: async () => {} });
        await expect(
          owner.recordStopReaped({ attempt, assertReaped: async () => {} })
        ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_STATE" });
        return { outcome: "complete", value: 0 };
      },
    });
  });
  await expectAbsent(memberPaths(selected.projection));
}, 30_000);
test("stop authority exists only within the exact live down effect; an unknown stop survives mutation revocation and cannot be handed off", async () => {
  const selected = await store.withMutation(running);
  let original: Awaited<
    ReturnType<ReturnType<typeof createNativeComposeFileOwner>["armStop"]>
  >;
  let oldOwner: ReturnType<typeof createNativeComposeFileOwner> | undefined;
  await store.withMutation(async (mutation) => {
    const owner = ownerFor(mutation);
    oldOwner = owner;
    await expect(owner.armStop(selected.generation)).rejects.toMatchObject({
      code: "E_NATIVE_COMPOSE_STATE",
    });
    await mutation.runEffect({
      generation: selected.generation,
      operation: "down",
      assertOwned: async () => {},
      effect: async () => {
        original = await owner.armStop(selected.generation);
        return { outcome: "uncertain", value: 1 };
      },
    });
  });
  await store.withMutation(async (mutation) => {
    const owner = ownerFor(mutation);
    await expect(
      mutation.runEffect({
        generation: selected.generation,
        operation: "down",
        recoverPending: true,
        assertOwned: async () => {},
        beforeComplete: async () => {
          await owner.retire({
            generation: selected.generation,
            assertAbsent: async () => {
              throw new Error("Unknown stop must veto before absence callback");
            },
          });
        },
        effect: async () => {
          expect(await owner.armStop(selected.generation)).toBeNull();
          if (!(original && oldOwner)) {
            throw new Error("Missing actual abandoned attempt");
          }
          await expect(
            oldOwner.recordStopReaped({
              attempt: original,
              assertReaped: async () => {},
            })
          ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_STATE" });
          await expect(
            owner.recordStopReaped({
              attempt: original,
              assertReaped: async () => {},
            })
          ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_STATE" });
          return { outcome: "complete", value: 0 };
        },
      })
    ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_UNCERTAIN" });
  });
  expect((await store.loadPending())?.generationId).toBe(
    selected.generation.generationId
  );
  await expectPresent(memberPaths(selected.projection));
}, 30_000);
test("a known stop can re-arm after partial retirement intent and finish exact saved retry without recreating missing members", async () => {
  const selected = await store.withMutation(running);
  let unlinked = 0;
  await store.withMutation(async (mutation) => {
    const owner = ownerFor(mutation, {
      afterMemberUnlink: async () => {
        unlinked++;
        throw new Error("synthetic interruption before member directory sync");
      },
    });
    await expect(
      mutation.runEffect({
        generation: selected.generation,
        operation: "down",
        assertOwned: async () => {},
        beforeComplete: () =>
          owner.retire({
            generation: selected.generation,
            assertAbsent: async () => {},
          }),
        effect: async () => {
          const attempt = await owner.armStop(selected.generation);
          if (!attempt) {
            throw new Error("Missing stop attempt");
          }
          await owner.recordStopReaped({
            attempt,
            assertReaped: async () => {},
          });
          return { outcome: "complete", value: 0 };
        },
      })
    ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_UNCERTAIN" });
  });
  expect(unlinked).toBe(1);
  expect((await store.loadPending())?.generationId).toBe(
    selected.generation.generationId
  );
  await store.withMutation(async (mutation) => {
    const owner = ownerFor(mutation);
    await mutation.runEffect({
      generation: selected.generation,
      operation: "down",
      recoverPending: true,
      assertOwned: async () => {},
      beforeComplete: () =>
        owner.retire({
          generation: selected.generation,
          assertAbsent: async () => {},
        }),
      effect: async () => {
        const attempt = await owner.armStop(selected.generation);
        if (!attempt) {
          throw new Error("Missing replacement live stop attempt");
        }
        await owner.recordStopReaped({ attempt, assertReaped: async () => {} });
        return { outcome: "complete", value: 0 };
      },
    });
  });
  await expectAbsent(memberPaths(selected.projection));
  expect(await store.loadPending()).toBeNull();
}, 30_000);
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
}, 30_000);
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
}, 30_000);
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
}, 30_000);
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
}, 30_000);

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
}, 30_000);
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
}, 30_000);

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
}, 30_000);

test.each([
  ["0400", 0o400],
  ["0600", 0o600],
] as const)("protected %s delivery preserves original permissions and binds exact private snapshot2 modes", async (mode, bits) => {
  const secretPath = join(root, "protected.bin");
  await writeFile(secretPath, BYTES, { mode: bits });
  const original = await lstat(secretPath);
  await writeFile(
    join(root, ".hack/hack.project.json"),
    JSON.stringify({
      ...SOURCE,
      secrets: { empty: { file: "protected.bin" } },
      services: {
        reader: {
          ...SOURCE.services.reader,
          mounts: [
            SOURCE.services.reader.mounts[0],
            {
              secret: "empty",
              target: "/run/empty",
              access: "read-only",
              mode,
            },
          ],
        },
      },
    })
  );
  const selected = await store.withMutation(running);
  expect(selected.projection.reference.version).toBe(2);
  const granted = selected.projection.workloads.reader;
  const secret = granted?.find((grant) => grant.target === "/run/empty");
  const config = granted?.find((grant) => grant.target === "/etc/settings");
  if (!(secret && config)) {
    throw new Error("Missing selected file grants");
  }
  expect(await readFile(secret.source)).toEqual(BYTES);
  expect((await lstat(secret.source)).mode & 0o777).toBe(bits);
  expect((await lstat(config.source)).mode & 0o777).toBe(0o444);
  const after = await lstat(secretPath);
  expect({
    dev: after.dev,
    ino: after.ino,
    mode: after.mode,
    uid: after.uid,
    gid: after.gid,
  }).toEqual({
    dev: original.dev,
    ino: original.ino,
    mode: original.mode,
    uid: original.uid,
    gid: original.gid,
  });
  const reference = selected.projection.reference;
  const text = await readFile(
    join(
      reference.root,
      `${reference.generationId}-${reference.snapshotToken}`,
      "manifest.json"
    ),
    "utf8"
  );
  const raw: unknown = JSON.parse(text);
  if (!(isRecord(raw) && isRecord(raw.creation))) {
    throw new Error("Missing owned material binding");
  }
  // This binding comes from the genuine owner-produced private manifest; parsing
  // below verifies it and no external effect authority is obtained from this fixture.
  const binding = raw.creation as NativeComposeMaterialBinding;
  const manifest = parseNativeComposeFileManifest({ text, reference, binding });
  expect(manifest.version).toBe(2);
  expect(
    manifest.members.find((member) => member.target === "/run/empty")?.file.mode
  ).toBe(bits);
  for (const changed of [0o000, 0o644, 0o777, "0400", null]) {
    const forged = structuredClone(manifest);
    const originalMembers = forged.members.map((member) => ({
      ...member,
      file: { ...member.file },
    }));
    const member = originalMembers.find(
      (entry) => entry.target === "/run/empty"
    );
    if (!member) {
      throw new Error("Missing owned secret member");
    }
    const altered = {
      ...forged,
      members: originalMembers.map((entry) =>
        entry === member
          ? { ...entry, file: { ...entry.file, mode: changed } }
          : entry
      ),
    };
    expect(() =>
      parseNativeComposeFileManifest({
        text: JSON.stringify(altered),
        reference,
        binding,
      })
    ).toThrow();
  }
  const legacy = {
    ...manifest,
    version: 1,
    reference: { ...manifest.reference, version: 1 },
  };
  expect(() =>
    parseNativeComposeFileManifest({
      text: JSON.stringify(legacy),
      reference: { ...reference, version: 1 },
      binding,
    })
  ).toThrow();
  const allPublic = {
    ...manifest,
    members: manifest.members.map((member) => ({
      ...member,
      file: { ...member.file, mode: 0o444 },
    })),
  };
  expect(() =>
    parseNativeComposeFileManifest({
      text: JSON.stringify(allPublic),
      reference,
      binding,
    })
  ).toThrow();
  expect(() =>
    parseNativeComposeFileReference({ ...reference, version: 3 })
  ).toThrow();
  const unknownVersion = {
    ...manifest,
    version: 3,
    reference: { ...manifest.reference, version: 3 },
  };
  expect(() =>
    Reflect.apply(parseNativeComposeFileManifest, undefined, [
      {
        text: JSON.stringify(unknownVersion),
        reference: { ...reference, version: 3 },
        binding,
      },
    ])
  ).toThrow();
  await store.withMutation(async (mutation) => {
    await ownerFor(mutation).assertSavedReady(selected.generation);
  });
  expect(JSON.stringify(selected.attempt)).toBe("{}");
});

test("protected snapshot mode drift refuses saved readiness while preserving owned stop recovery", async () => {
  await writeFile(join(root, "protected.bin"), BYTES, { mode: 0o600 });
  await writeFile(
    join(root, ".hack/hack.project.json"),
    JSON.stringify({
      ...SOURCE,
      secrets: { empty: { file: "protected.bin" } },
      services: {
        reader: {
          ...SOURCE.services.reader,
          mounts: [
            SOURCE.services.reader.mounts[0],
            {
              secret: "empty",
              target: "/run/empty",
              access: "read-only",
              mode: "0400",
            },
          ],
        },
      },
    })
  );
  const selected = await store.withMutation(running);
  const secret = selected.projection.workloads.reader?.find(
    (grant) => grant.target === "/run/empty"
  );
  if (!secret) {
    throw new Error("Missing selected secret grant");
  }
  await chmod(secret.source, 0o600);
  let children = 0;
  let readinessChecks = 0;
  await expect(
    store.withMutation(async (mutation) => {
      const owner = ownerFor(mutation);
      await mutation.runEffect({
        generation: selected.generation,
        operation: "up",
        // This control isolates the saved-material guard, not source admission;
        // input freshness is synthetic and no expired first-mutation authority is reused.
        assertFresh: async () => {},
        assertOwned: async () => {},
        effect: async () => {
          readinessChecks++;
          await owner.assertSavedReady(selected.generation);
          children++;
          return { outcome: "complete", value: 0 };
        },
      });
    })
  ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_UNCERTAIN" });
  expect(readinessChecks).toBe(1);
  expect(children).toBe(0);
  expect((await store.loadPending())?.generationId).toBe(
    selected.generation.generationId
  );
  await expect(
    store.withMutation(async (mutation) => {
      const owner = ownerFor(mutation);
      await mutation.runEffect({
        generation: selected.generation,
        operation: "down",
        recoverPending: true,
        assertOwned: async () => {},
        effect: async () => {
          const attempt = await owner.armStop(selected.generation);
          if (!attempt) {
            throw new Error("Missing known owned stop attempt");
          }
          children++;
          await owner.recordStopReaped({
            attempt,
            assertReaped: async () => {},
          });
          return { outcome: "complete", value: 0 };
        },
        beforeComplete: async () => {
          await owner.retire({
            generation: selected.generation,
            assertAbsent: async () => {},
          });
        },
      });
    })
  ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_UNCERTAIN" });
  expect(children).toBe(1);
  expect((await store.loadPending())?.generationId).toBe(
    selected.generation.generationId
  );
  expect((await lstat(secret.source)).mode & 0o777).toBe(0o600);
  expect((await lstat(join(root, "protected.bin"))).mode & 0o777).toBe(0o600);
});
