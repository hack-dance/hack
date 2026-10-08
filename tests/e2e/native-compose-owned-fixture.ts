import { isRecord } from "../../src/lib/guards.ts";
import { openNativeComposeGenerationStore } from "../../src/lib/native-compose-generation.ts";
import {
  assertNativeComposeOwned,
  type NativeComposeOwnershipObservation,
  type NativeComposeOwnershipOptions,
} from "../../src/lib/native-compose-ownership.ts";

/** Read immutable saved artifacts and use the production whole-owner probe. Never return delivered values. */
export async function observeNativeComposeFixture(root: string) {
  const store = await openNativeComposeGenerationStore({
    projectRoot: root,
    instance: null,
    mode: "saved",
  });
  try {
    const state = await store.loadCurrent();
    const pending = await store.loadPending();
    const generation = pending ?? state.generation;
    if (!generation) {
      throw new Error(
        "Owned fixture generation is missing; retain fixture for inspection"
      );
    }
    const generations = [state.generation, pending].filter(
      (value) => value !== null
    );
    const services = new Set<string>();
    const volumes = new Map<string, string>();
    let network: string | undefined;
    for (const selected of generations) {
      await store.withLease({
        generation: selected,
        run: async () => {
          const document = await store.readGenerationDocument(selected);
          if (
            !(
              isRecord(document.services) &&
              isRecord(document.volumes) &&
              isRecord(document.networks) &&
              isRecord(document.networks.default) &&
              typeof document.networks.default.name === "string"
            )
          ) {
            throw new Error(
              "Owned fixture document is invalid; values omitted"
            );
          }
          for (const name of Object.keys(document.services)) {
            services.add(name);
          }
          for (const [storage, volume] of Object.entries(document.volumes)) {
            if (!(isRecord(volume) && typeof volume.name === "string")) {
              throw new Error("Owned fixture volume name is missing");
            }
            volumes.set(volume.name, storage);
          }
          if (
            network !== undefined &&
            network !== document.networks.default.name
          ) {
            throw new Error("Owned fixture default network changed");
          }
          network = document.networks.default.name;
        },
      });
    }
    const selection: NativeComposeOwnershipOptions = {
      composeProject: store.identity.composeProject,
      runtimeIdentity: store.identity.composeProject,
      ownerToken: store.identity.ownerToken,
      generationIds: [
        ...new Set(generations.map((value) => value.generationId)),
      ],
      expectedServices: [...services],
      expectedVolumes: [...volumes].map(([name, storage]) => ({
        name,
        storage,
      })),
      expectedNetwork: network,
    };
    return {
      selection,
      observed: await assertNativeComposeOwned(selection),
      stopped: state.stopped,
      pending: state.pending,
      hostHookPhase: state.hostHookPhase,
      beforeHooksPending: state.beforeHooksPending,
    };
  } finally {
    await store.close();
  }
}

export type NativeComposeFixtureVolumePin = {
  readonly name: string;
  readonly storage: string;
  readonly createdAt: string;
  readonly composeProject: string;
  readonly runtimeIdentity: string;
  readonly ownerToken: string;
};

/** Volumes have no immutable engine ID. Pin creation time and the exact saved storage/owner before cleanup. */
export async function pinNativeComposeFixtureVolume(opts: {
  readonly selection: NativeComposeOwnershipOptions;
  readonly observed: NativeComposeOwnershipObservation;
  readonly probe: (args: readonly string[]) => Promise<string>;
}): Promise<NativeComposeFixtureVolumePin> {
  const volume = opts.observed.volumes[0];
  const saved = opts.selection.expectedVolumes?.[0];
  if (
    !(
      volume &&
      saved &&
      opts.observed.volumes.length === 1 &&
      opts.selection.expectedVolumes?.length === 1 &&
      volume.name === saved.name &&
      volume.storage === saved.storage
    )
  ) {
    throw new Error("Expected original singleton owned fixture volume");
  }
  const value: unknown = JSON.parse(
    await opts.probe([
      "volume",
      "inspect",
      volume.name,
      "--format",
      '{"name":{{json .Name}},"createdAt":{{json .CreatedAt}},"storage":{{json (index .Labels "io.hack.native-config.storage")}},"ownerToken":{{json (index .Labels "io.hack.native-config.owner")}},"runtimeIdentity":{{json (index .Labels "io.hack.native-config.instance")}},"composeProject":{{json (index .Labels "com.docker.compose.project")}},"version":{{json (index .Labels "io.hack.native-config.version")}}}',
    ])
  );
  if (
    !(
      isRecord(value) &&
      Object.keys(value).sort().join() ===
        "composeProject,createdAt,name,ownerToken,runtimeIdentity,storage,version" &&
      typeof value.createdAt === "string" &&
      value.createdAt.length > 0 &&
      value.name === saved.name &&
      value.storage === saved.storage &&
      value.ownerToken === opts.selection.ownerToken &&
      value.runtimeIdentity === opts.selection.runtimeIdentity &&
      value.composeProject === opts.selection.composeProject &&
      value.version === "1"
    )
  ) {
    throw new Error("Fixture volume identity changed; values omitted");
  }
  return Object.freeze({
    name: saved.name,
    storage: saved.storage,
    createdAt: value.createdAt,
    ownerToken: opts.selection.ownerToken,
    runtimeIdentity: opts.selection.runtimeIdentity,
    composeProject: opts.selection.composeProject,
  });
}

/** Cleanup failure fails successful acceptance; an earlier failure keeps its original evidence. */
export async function runWithOwnedCleanup(opts: {
  readonly run: () => Promise<void>;
  readonly cleanup: () => Promise<void>;
  readonly secondaryFailure: () => void;
}): Promise<void> {
  let failed = false;
  let failure: unknown;
  try {
    await opts.run();
  } catch (error: unknown) {
    failed = true;
    failure = error;
  }
  try {
    await opts.cleanup();
  } catch (error: unknown) {
    if (!failed) {
      throw error;
    }
    opts.secondaryFailure();
  }
  if (failed) {
    throw failure;
  }
}
