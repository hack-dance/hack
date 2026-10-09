import { afterEach, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "../src/lib/guards.ts";
import {
  consumeNativeComposeFileRetirementProof,
  createNativeComposeFileOwner,
} from "../src/lib/native-compose-file-owner.ts";
import {
  acquireNativeComposeFileSources,
  assertNativeComposeFileSources,
  closeNativeComposeFileSources,
} from "../src/lib/native-compose-file-sources.ts";
import {
  type NativeComposeGenerationStore,
  type NativeComposeMutation,
  openNativeComposeGenerationStore,
} from "../src/lib/native-compose-generation.ts";
import { renderNativeCompose } from "../src/lib/native-compose-renderer.ts";
import { createNativeComposeVmFileClient } from "../src/lib/native-compose-vm-file-client.ts";
import {
  assertNativeComposeVmFiles,
  stageNativeComposeVmFiles,
} from "../src/lib/native-compose-vm-file-owner.ts";
import {
  parseVmFileJournal,
  vmFileJournalReady,
} from "../src/lib/native-compose-vm-file-protocol.ts";
import {
  cleanupVmFileFixtures,
  VM_BYTES,
  VM_ENGINE,
  vmFileFixture,
} from "./helpers/native-compose-vm-files.ts";

afterEach(cleanupVmFileFixtures);

async function staged(
  fixture: Awaited<ReturnType<typeof vmFileFixture>>,
  mutation: NativeComposeMutation
) {
  const reservation = mutation.reserveGeneration(),
    signal = new AbortController().signal;
  const sources = await acquireNativeComposeFileSources({
    authority: mutation.materialAuthority,
    reservation,
    signal,
  });
  const owner = createNativeComposeFileOwner({
    root: join(fixture.root, "home/compose-files"),
    authority: mutation.materialAuthority,
    signal,
  });
  try {
    const attempt = await owner.prepare({ reservation, sources });
    const host = await owner.projection(attempt);
    const projection = await stageNativeComposeVmFiles({
      authority: mutation.materialAuthority,
      reservation,
      sources,
      host,
      engineId: VM_ENGINE,
      signal,
      deadline: Date.now() + 30_000,
    });
    owner.selectVmProjection({ attempt, projection });
    return { reservation, sources, owner, attempt, host, projection, signal };
  } catch (error) {
    await owner.close();
    await closeNativeComposeFileSources(sources);
    throw error;
  }
}
async function withStore<T>(
  fixture: Awaited<ReturnType<typeof vmFileFixture>>,
  run: (
    mutation: NativeComposeMutation,
    store: NativeComposeGenerationStore
  ) => Promise<T>
) {
  const store = await openNativeComposeGenerationStore({
    projectRoot: fixture.checkout,
    instance: null,
  });
  try {
    return await store.withMutation(
      async (mutation) => await run(mutation, store)
    );
  } finally {
    await store.close();
  }
}
test("issued VM material uses pinned images/exact single files and earns only singleton nonforce rollback", async () => {
  const fixture = await vmFileFixture();
  await withStore(fixture, async (mutation) => {
    const selected = await staged(fixture, mutation);
    try {
      const options = {
        plan: selected.sources.result.plan,
        environmentPlan: selected.sources.result.environment_plan,
        filePlan: selected.sources.result.file_plan,
        declaredWorkloads: selected.sources.result.declared_workloads,
        projectRoot: fixture.checkout,
        runtimeIdentity: selected.reservation.identity.composeProject,
        ownerToken: selected.reservation.identity.ownerToken,
        generationIdentity: selected.reservation.generationId,
        managedValues: { reader: {} },
      };
      expect(() =>
        renderNativeCompose({ ...options, fileProjection: selected.host })
      ).toThrow();
      expect(() =>
        renderNativeCompose({
          ...options,
          fileProjection: { ...selected.projection },
        })
      ).toThrow();
      const rendered = renderNativeCompose({
        ...options,
        fileProjection: selected.projection,
      });
      expect(rendered.document.services.reader).toMatchObject({
        image: `sha256:${"b".repeat(64)}`,
        pull_policy: "never",
        volumes: selected.projection.workloads.reader,
      });
      expect(selected.projection.images).toEqual({
        reader: `sha256:${"b".repeat(64)}`,
      });
      expect(selected.projection.workloads.reader).toHaveLength(1);
      const grant = selected.projection.workloads.reader?.[0];
      expect(grant).toMatchObject({
        type: "bind",
        target: "/etc/settings",
        read_only: true,
        bind: { create_host_path: false },
      });
      expect(grant?.source).toStartWith("/var/lib/docker/volumes/hack-files-");
      expect(selected.projection.vm?.host).toEqual(selected.host.reference);
      const beforeRetirement = await fixture.state();
      expect(
        isRecord(beforeRetirement) &&
          isRecord(beforeRetirement.containers) &&
          beforeRetirement.containers["d".repeat(64)]
      ).toMatchObject({
        labels: { "org.opencontainers.image.title": "Bun synthetic" },
      });
      await selected.owner.rollback(selected.attempt);
      const state = await fixture.state();
      expect(isRecord(state) && state.volume).toBeNull();
      expect(isRecord(state) && state.containers).toEqual({});
      const commands = await fixture.commands();
      expect(
        commands.filter((args) => args[0] === "container" && args[1] === "rm")
      ).toEqual([
        ["container", "rm", "c".repeat(64)],
        ["container", "rm", "d".repeat(64)],
      ]);
      expect(
        commands.filter((args) => args[0] === "volume" && args[1] === "rm")
      ).toHaveLength(1);
      expect(
        commands.some(
          (args) =>
            args.includes("--force") ||
            args.includes("-f") ||
            args.includes("prune") ||
            args.includes("pull")
        )
      ).toBe(false);
      expect(await readFile(join(fixture.checkout, "settings"))).toEqual(
        VM_BYTES
      );
      expect(fixture.requests()).toBeGreaterThan(0);
    } finally {
      await selected.owner.close();
      await closeNativeComposeFileSources(selected.sources);
    }
  });
}, 45_000);

test.each([
  "writer-unknown",
  "wrong-mode",
  "foreign-consumer",
  "named-user",
  "image-label-collision",
] as const)("VM %s refuses before publication and never sweeps its partial resources", async (marker) => {
  const fixture = await vmFileFixture();
  await fixture.mark(marker);
  await withStore(fixture, async (mutation) => {
    await expect(staged(fixture, mutation)).rejects.toThrow();
    const commands = await fixture.commands();
    expect(
      commands.some((args) => args[1] === "rm" || args[1] === "stop")
    ).toBe(false);
    expect(commands.some((args) => args[0] === "compose")).toBe(false);
    if (marker === "foreign-consumer") {
      expect(commands.some((args) => args[1] === "start")).toBe(false);
    }
    if (marker === "named-user" || marker === "image-label-collision") {
      expect(commands.some((args) => args[1] === "create")).toBe(false);
    }
  });
}, 45_000);

test("an unknown verification durably stays armed and cannot earn later rollback", async () => {
  const fixture = await vmFileFixture();
  await withStore(fixture, async (mutation) => {
    const selected = await staged(fixture, mutation);
    try {
      await fixture.mark("verify-unknown");
      await expect(selected.owner.rollback(selected.attempt)).rejects.toThrow();
      const ref = selected.projection.reference;
      const text = await readFile(
          join(
            ref.root,
            `${ref.generationId}-${ref.snapshotToken}`,
            "vm-journal.jsonl"
          ),
          "utf8"
        ),
        header = text.slice(0, text.indexOf("\n") + 1);
      const phases = parseVmFileJournal({ text, header });
      expect(phases.at(-1)).toBe("observe-armed");
      expect(vmFileJournalReady(phases)).toBe(false);
      const before = await fixture.commands();
      await expect(selected.owner.rollback(selected.attempt)).rejects.toThrow();
      expect(await fixture.commands()).toEqual(before);
      const commands = await fixture.commands();
      expect(commands.filter((args) => args[1] === "rm")).toEqual([
        ["container", "rm", "c".repeat(64)],
      ]);
      expect(commands.some((args) => args[1] === "stop")).toBe(false);
    } finally {
      await selected.owner.close();
      await closeNativeComposeFileSources(selected.sources);
    }
  });
}, 45_000);

test("copies cannot issue the host retirement capability", async () => {
  const fixture = await vmFileFixture();
  await withStore(fixture, async (mutation) => {
    const selected = await staged(fixture, mutation);
    try {
      const before = await fixture.commands();
      expect(() =>
        consumeNativeComposeFileRetirementProof({
          proof: Object.freeze({}),
          authority: mutation.materialAuthority,
          reference: selected.projection.reference,
        })
      ).toThrow();
      expect(await fixture.commands()).toEqual(before);
      await selected.owner.rollback(selected.attempt);
    } finally {
      await selected.owner.close();
      await closeNativeComposeFileSources(selected.sources);
    }
  });
}, 45_000);
test.each([
  "birth-drift",
  "observer-drift",
  "label-drift",
  "foreign-consumer",
] as const)("retirement rechecks %s before stopping or removing the observer", async (marker) => {
  const fixture = await vmFileFixture();
  await withStore(fixture, async (mutation) => {
    const selected = await staged(fixture, mutation);
    try {
      await fixture.mark(marker);
      await expect(selected.owner.rollback(selected.attempt)).rejects.toThrow();
      const commands = await fixture.commands();
      expect(commands.filter((args) => args[1] === "rm")).toEqual([
        ["container", "rm", "c".repeat(64)],
      ]);
      expect(commands.some((args) => args[1] === "stop")).toBe(false);
    } finally {
      await selected.owner.close();
      await closeNativeComposeFileSources(selected.sources);
    }
  });
}, 45_000);

/** A real fake-client child must reap and release its exact group before the
 * original live host attempt may record completion. No engine handle exists. */
async function knownChild(fixture: Awaited<ReturnType<typeof vmFileFixture>>) {
  const client = createNativeComposeVmFileClient({
    engineId: VM_ENGINE,
    signal: new AbortController().signal,
    deadline: Date.now() + 5000,
    assertFresh: async () => {},
  });
  expect(await client.call(["synthetic-lifetime", "complete"])).toBe(
    "complete\n"
  );
  const row: unknown = JSON.parse(
    await readFile(join(fixture.root, "leader.json"), "utf8")
  );
  if (
    !isRecord(row) ||
    typeof row.pid !== "number" ||
    !Number.isSafeInteger(row.pid) ||
    row.pid <= 1
  ) {
    throw new Error("Invalid private child identity.");
  }
  const group = row.pid;
  return async () => {
    try {
      process.kill(-group, 0);
    } catch (error: unknown) {
      if (isRecord(error) && error.code === "ESRCH") {
        return;
      }
      throw error;
    }
    throw new Error("Original owned child group remains present.");
  };
}

test.each([
  "absent",
  "bound",
] as const)("published VM generation reopens under a saved lease and retires only with app %s", async (app) => {
  const fixture = await vmFileFixture();
  const published = await withStore(fixture, async (mutation) => {
    const selected = await staged(fixture, mutation);
    try {
      const rendered = renderNativeCompose({
        plan: selected.sources.result.plan,
        environmentPlan: selected.sources.result.environment_plan,
        filePlan: selected.sources.result.file_plan,
        declaredWorkloads: selected.sources.result.declared_workloads,
        projectRoot: fixture.checkout,
        runtimeIdentity: selected.reservation.identity.composeProject,
        ownerToken: selected.reservation.identity.ownerToken,
        generationIdentity: selected.reservation.generationId,
        managedValues: { reader: {} },
        fileProjection: selected.projection,
      });
      const assertFresh = async () => {
        await assertNativeComposeFileSources({
          authority: mutation.materialAuthority,
          reservation: selected.reservation,
          sources: selected.sources,
        });
      };
      const generation = await mutation.publish({
        reservation: selected.reservation,
        composeJson: JSON.stringify(rendered.document),
        profiles: [],
        inputRevision: await assertNativeComposeFileSources({
          authority: mutation.materialAuthority,
          reservation: selected.reservation,
          sources: selected.sources,
        }),
        assertFresh,
      });
      await mutation.runEffect({
        generation,
        operation: "up",
        assertFresh,
        assertOwned: async () => {},
        effect: async () => {
          await selected.owner.arm({ attempt: selected.attempt, generation });
          const assertReaped = await knownChild(fixture);
          await selected.owner.recordChildReaped({
            attempt: selected.attempt,
            generation,
            assertReaped,
          });
          await fixture.mark("app-present");
          return { outcome: "complete", value: 0 };
        },
      });
      return generation;
    } finally {
      await selected.owner.close();
      await closeNativeComposeFileSources(selected.sources);
    }
  });
  await withStore(fixture, async (mutation, store) => {
    const generation = (await store.loadCurrent()).generation;
    if (!generation) {
      throw new Error("Missing saved generation.");
    }
    expect(generation.generationId).toBe(published.generationId);
    const document = await store.readGenerationDocument(generation);
    const owner = createNativeComposeFileOwner({
      root: join(fixture.root, "home/compose-files"),
      authority: mutation.materialAuthority,
      signal: new AbortController().signal,
    });
    try {
      await owner.assertSavedReady(generation);
      await assertNativeComposeVmFiles({
        authority: mutation.materialAuthority,
        generation,
        document,
        signal: new AbortController().signal,
        deadline: Date.now() + 10_000,
        observed: {
          containers: [
            {
              id: "f".repeat(64),
              name: "vmfiles-reader-1",
              generationId: generation.generationId,
              service: "reader",
              state: "running",
              exitCode: 0,
              health: null,
              oneoff: false,
            },
          ],
          networks: [],
          volumes: [],
        },
      });
      const down = mutation.runEffect({
        generation,
        operation: "down",
        assertOwned: async () => {},
        effect: async () => {
          const attempt = await owner.armStop(generation);
          if (!attempt) {
            throw new Error("Missing original saved-stop attempt.");
          }
          const assertReaped = await knownChild(fixture);
          await owner.recordStopReaped({ attempt, assertReaped });
          if (app === "absent") {
            await fixture.unmark("app-present");
          }
          return { outcome: "complete", value: 0 };
        },
        beforeComplete: async () => {
          // This isolated consumer control lets the VM owner independently reject
          // a still-bound app, in addition to shipping's normal owned absence gate.
          await owner.retire({ generation, assertAbsent: async () => {} });
        },
      });
      if (app === "absent") {
        await expect(down).resolves.toEqual({ outcome: "complete", value: 0 });
        expect((await store.loadCurrent()).stopped).toBe(true);
        expect(await store.loadPending()).toBeNull();
        const state = await fixture.state();
        expect(isRecord(state) && state.volume).toBeNull();
        expect(isRecord(state) && state.containers).toEqual({});
      } else {
        await expect(down).rejects.toMatchObject({
          code: "E_NATIVE_COMPOSE_UNCERTAIN",
        });
        expect((await store.loadPending())?.generationId).toBe(
          generation.generationId
        );
        const commands = await fixture.commands();
        expect(commands.filter((args) => args[1] === "rm")).toEqual([
          ["container", "rm", "c".repeat(64)],
        ]);
        expect(commands.some((args) => args[1] === "stop")).toBe(false);
        const state = await fixture.state();
        expect(
          isRecord(state) &&
            isRecord(state.containers) &&
            state.containers["d".repeat(64)]
        ).toMatchObject({ running: true });
      }
      expect(await readFile(join(fixture.checkout, "settings"))).toEqual(
        VM_BYTES
      );
    } finally {
      await owner.close();
    }
  });
}, 45_000);
