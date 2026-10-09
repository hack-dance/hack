import { afterEach, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { prepareNativeComposeCommandFiles } from "../src/lib/native-compose-file-command.ts";
import { openNativeComposeGenerationStore } from "../src/lib/native-compose-generation.ts";
import { acquireNativeComposeFilePlanningInputs } from "../src/lib/native-compose-inputs.ts";
import { renderNativeCompose } from "../src/lib/native-compose-renderer.ts";
import {
  assertNativeComposeVmFiles,
  assertPreparedNativeComposeVmFiles,
} from "../src/lib/native-compose-vm-file-owner.ts";
import {
  cleanupVmFileFixtures,
  vmFileFixture,
} from "./helpers/native-compose-vm-files.ts";

afterEach(cleanupVmFileFixtures);

test.each([
  "pending",
  "current",
  "source-drift",
] as const)("issued VM preparation %s preserves the original reservation and generation boundaries", async (scenario) => {
  const fixture = await vmFileFixture();
  const signal = new AbortController().signal;
  const inputs = await acquireNativeComposeFilePlanningInputs({
    projectRoot: fixture.checkout,
    signal,
  });
  const store = await openNativeComposeGenerationStore({
    projectRoot: fixture.checkout,
    instance: null,
  });
  try {
    await store.withMutation(async (mutation) => {
      const reservation = mutation.reserveGeneration();
      const files = await prepareNativeComposeCommandFiles({
        mutation,
        store,
        reservation,
        inputs,
        signal,
      });
      if (!files) {
        throw new Error("Missing issued VM preparation.");
      }
      try {
        const rendered = renderNativeCompose({
          plan: files.inputs.result.plan,
          environmentPlan: files.inputs.result.environment_plan,
          filePlan: files.inputs.result.file_plan,
          declaredWorkloads: files.inputs.result.declared_workloads,
          projectRoot: fixture.checkout,
          runtimeIdentity: reservation.identity.composeProject,
          ownerToken: reservation.identity.ownerToken,
          generationIdentity: reservation.generationId,
          managedValues: { reader: {} },
          fileProjection: files.projection,
        });
        const document = files.document(rendered.document);
        const generation = await mutation.publish({
          reservation,
          composeJson: JSON.stringify(document),
          profiles: [],
          inputRevision: files.inputs.inputRevision,
          assertFresh: files.inputs.assertFresh,
        });
        expect((await store.loadCurrent()).generation).toBeNull();
        expect(await store.loadPending()).toBeNull();
        const before = await fixture.commands();
        await expect(
          assertNativeComposeVmFiles({
            authority: mutation.materialAuthority,
            generation,
            document,
            signal,
            deadline: Date.now() + 30_000,
          })
        ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_STATE" });
        expect(await fixture.commands()).toEqual(before);
        const prepared = {
          authority: mutation.materialAuthority,
          reservation,
          projection: files.projection,
          document,
          signal,
          deadline: Date.now() + 30_000,
        };
        for (const selected of [
          { ...prepared, projection: { ...files.projection } },
          { ...prepared, reservation: { ...reservation } },
          { ...prepared, reservation: mutation.reserveGeneration() },
          { ...prepared, authority: Object.freeze({}) },
          { ...prepared, document: {} },
        ]) {
          await expect(
            assertPreparedNativeComposeVmFiles(selected)
          ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_STATE" });
          expect(await fixture.commands()).toEqual(before);
        }
        if (scenario === "source-drift") {
          await writeFile(join(fixture.checkout, "settings"), "changed");
          await expect(
            assertPreparedNativeComposeVmFiles(prepared)
          ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_STATE" });
          expect(await fixture.commands()).toEqual(before);
          expect(await store.loadPending()).toBeNull();
          return;
        }
        const boundaries: string[] = [];
        const result = await mutation.runEffect({
          generation,
          operation: "up",
          assertFresh: files.inputs.assertFresh,
          assertOwned: async () => {
            boundaries.push(
              (await store.loadPending()) ? "pending" : "prepared"
            );
            await files.assertBeforeEffects(generation);
          },
          effect: async () => {
            expect((await store.loadPending())?.generationId).toBe(
              generation.generationId
            );
            const pendingCommands = await fixture.commands();
            await expect(
              assertPreparedNativeComposeVmFiles(prepared)
            ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_STATE" });
            expect(await fixture.commands()).toEqual(pendingCommands);
            boundaries.push("effect");
            // No app is started. Only the current variant synthesizes a complete
            // store postcondition to test capability refusal after intent clearance.
            return {
              outcome: scenario === "current" ? "complete" : "uncertain",
              value: 0,
            };
          },
        });
        if (scenario === "current") {
          expect(result).toEqual({ outcome: "complete", value: 0 });
          expect(boundaries[0]).toBe("prepared");
          expect(boundaries.filter((phase) => phase === "effect")).toEqual([
            "effect",
          ]);
          expect(
            boundaries
              .slice(1)
              .every((phase) => phase === "pending" || phase === "effect")
          ).toBe(true);
          expect(await store.loadPending()).toBeNull();
          expect((await store.loadCurrent()).generation?.generationId).toBe(
            generation.generationId
          );
          const completedCommands = await fixture.commands();
          await expect(
            assertPreparedNativeComposeVmFiles(prepared)
          ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_STATE" });
          expect(await fixture.commands()).toEqual(completedCommands);
          await assertNativeComposeVmFiles({
            authority: mutation.materialAuthority,
            generation,
            document,
            signal,
            deadline: Date.now() + 30_000,
          });
        } else {
          expect(result).toEqual({ outcome: "uncertain", value: 0 });
          expect(boundaries).toEqual(["prepared", "pending", "effect"]);
          expect((await store.loadPending())?.generationId).toBe(
            generation.generationId
          );
          expect((await store.loadCurrent()).generation).toBeNull();
        }
      } finally {
        await files.close();
      }
    });
  } finally {
    await store.close();
  }
}, 45_000);
