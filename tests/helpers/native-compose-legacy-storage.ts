import { join } from "node:path";
import { openNativeComposeGenerationStore } from "../../src/lib/native-compose-generation.ts";
import { nativeComposeStorageVolumeName } from "../../src/lib/native-compose-renderer.ts";
import { fixture } from "./native-compose-command.ts";

/** Older metadata-only state is issued through the public store API. Engine facts
 * are synthetic; no managed receipt, witness, journal or material is hand-edited. */
export async function legacyStorageFixture(): Promise<string> {
  const root = await fixture("", false, {
    noHooks: true,
    storage: { data: { kind: "persistent", scope: "worktree" } },
  });
  const store = await openNativeComposeGenerationStore({
    projectRoot: root,
    instance: null,
    mode: "prepare",
  });
  try {
    await store.withMutation(async (mutation) => {
      const reservation = mutation.reserveGeneration();
      const labels = {
        "io.hack.native-config.version": "1",
        "io.hack.native-config.instance": store.identity.composeProject,
        "io.hack.native-config.owner": store.identity.ownerToken,
      };
      const name = nativeComposeStorageVolumeName({
        runtimeIdentity: store.identity.composeProject,
        storage: "data",
      });
      const volume = {
        name,
        storage: "data",
        createdAt: "2026-10-08T12:00:00Z",
      };
      const generation = await mutation.publish({
        reservation,
        profiles: [],
        inputRevision: "a".repeat(64),
        assertFresh: async () => {},
        composeJson: JSON.stringify({
          name: store.identity.composeProject,
          services: {
            web: {
              image: "fixture/web:1",
              labels: {
                ...labels,
                "io.hack.native-config.generation": reservation.generationId,
                "io.hack.native-config.workload": "service",
              },
            },
          },
          volumes: {
            data: {
              name,
              labels: { ...labels, "io.hack.native-config.storage": "data" },
            },
          },
          networks: { default: { name: `${store.identity.composeProject}_default`, labels } },
        }),
      });
      await mutation.runEffect({
        generation,
        operation: "up",
        assertFresh: async () => {},
        assertOwned: async () => {},
        captureStorage: () => [volume],
        effect: async () => {
          await Bun.write(join(root, "volumes"), JSON.stringify([{
            ...volume,
            id: name,
            project: store.identity.composeProject,
            version: "1",
            instance: store.identity.composeProject,
            owner: store.identity.ownerToken,
          }]));
          return { value: 0, outcome: "complete" };
        },
      });
      await mutation.runEffect({
        generation,
        operation: "down",
        assertOwned: async () => {},
        effect: async () => ({ value: 0, outcome: "complete" }),
      });
    });
    for (const name of ["order", "requests", "compiler-requests"]) {
      await Bun.write(join(root, name), "");
    }
    return root;
  } finally {
    await store.close();
  }
}
