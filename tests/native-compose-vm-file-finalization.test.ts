import { afterEach, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { prepareNativeComposeCommandFiles } from "../src/lib/native-compose-file-command.ts";
import { openNativeComposeGenerationStore } from "../src/lib/native-compose-generation.ts";
import { acquireNativeComposeFilePlanningInputs } from "../src/lib/native-compose-inputs.ts";
import { renderNativeCompose } from "../src/lib/native-compose-renderer.ts";
import { assertNativeComposeVmFiles } from "../src/lib/native-compose-vm-file-owner.ts";
import { run } from "../src/lib/shell.ts";
import {
  cleanupVmFileFixtures,
  vmFileFixture,
} from "./helpers/native-compose-vm-files.ts";

afterEach(cleanupVmFileFixtures);

test.each([
  "ready",
  "foreign-consumer",
  "unearned",
] as const)("completed VM startup %s preserves the first final ownership fence", async (scenario) => {
  const fixture = await vmFileFixture(),
    signal = new AbortController().signal;
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
        throw new Error("Missing issued preparation.");
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
        const generation = await mutation.publish({
          reservation,
          composeJson: JSON.stringify(files.document(rendered.document)),
          profiles: [],
          inputRevision: files.inputs.inputRevision,
          assertFresh: files.inputs.assertFresh,
        });
        const selection = {
          composeProject: reservation.identity.composeProject,
          runtimeIdentity: reservation.identity.composeProject,
          ownerToken: reservation.identity.ownerToken,
          generationIds: [generation.generationId],
          expectedServices: ["reader"],
          expectedNetworks: [],
          expectedWorkloadNetworks: [
            {
              generationId: generation.generationId,
              service: "reader",
              networks: [],
            },
          ],
          signal,
        };
        await writeFile(
          join(fixture.root, "app-ownership.json"),
          JSON.stringify({
            project: selection.composeProject,
            instance: selection.runtimeIdentity,
            owner: selection.ownerToken,
            generation: generation.generationId,
          })
        );
        let ready = false,
          firstFinalFence = false,
          beforeComplete = false;
        const operation = mutation.runEffect({
          generation,
          operation: "up",
          assertFresh: files.inputs.assertFresh,
          assertOwned: async () => {
            if (ready && !beforeComplete) {
              firstFinalFence = true;
            }
            await files.assertBeforeEffects(generation);
          },
          beforeComplete: async () => {
            beforeComplete = true;
            await files.assertReady(selection, generation);
          },
          effect: async () => {
            await files.arm(generation);
            expect(
              await run(
                [
                  join(fixture.root, "docker"),
                  "synthetic-lifetime",
                  "complete",
                ],
                {
                  signal,
                  stdout: "ignore",
                  stderr: "ignore",
                  timeoutMs: 10_000,
                  ...files.childHooks(generation),
                }
              )
            ).toBe(0);
            expect(files.childReaped()).toBe(true);
            await fixture.mark("app-present");
            if (scenario !== "unearned") {
              await files.assertReady(selection, generation);
              ready = true;
            }
            // Earning the command-local phase never widens generic no-observation inspection.
            await expect(
              assertNativeComposeVmFiles({
                authority: mutation.materialAuthority,
                generation,
                document: await store.readGenerationDocument(generation),
                signal,
                deadline: Date.now() + 30_000,
              })
            ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_STATE" });
            if (scenario === "foreign-consumer") {
              await fixture.mark("foreign-consumer");
            }
            return { outcome: "complete", value: 0 };
          },
        });
        if (scenario !== "ready") {
          await expect(operation).rejects.toMatchObject({
            code: "E_NATIVE_COMPOSE_UNCERTAIN",
          });
          expect(beforeComplete).toBe(false);
          expect((await store.loadPending())?.generationId).toBe(
            generation.generationId
          );
          expect((await store.loadCurrent()).generation).toBeNull();
          return;
        }
        expect(await operation).toEqual({ outcome: "complete", value: 0 });
        expect(firstFinalFence).toBe(true);
        expect(beforeComplete).toBe(true);
        expect(await store.loadPending()).toBeNull();
        expect((await store.loadCurrent()).generation?.generationId).toBe(
          generation.generationId
        );
      } finally {
        await files.close();
      }
    });
  } finally {
    await store.close();
  }
}, 45_000);
