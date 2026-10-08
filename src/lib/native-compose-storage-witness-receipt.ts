import type {
  NativeComposeEffectOptions,
  NativeComposeGeneration,
  NativeComposeMaterialAuthority,
  NativeComposeOperation,
  NativeComposeStorageWitnessPublication,
} from "./native-compose-generation.ts";
import { NativeComposeGenerationError } from "./native-compose-private-state.ts";
import {
  mergeNativeComposeRetainedVolumes,
  type NativeComposeRetainedVolume,
} from "./native-compose-retained-storage.ts";
import {
  type NativeComposeStorageWitnessIntent,
  type NativeComposeStorageWitnessState,
  nativeComposeStorageWitnessStatesValid,
} from "./native-compose-storage-witness-state.ts";

function refuse(): never {
  throw new NativeComposeGenerationError("E_NATIVE_COMPOSE_STATE");
}
type State = {
  readonly version: 1 | 2 | 3;
  readonly stopped: boolean;
  readonly storage?: readonly NativeComposeRetainedVolume[];
  readonly storageWitnesses?: readonly NativeComposeStorageWitnessState[];
};
/** Decision helper only: every read, write and live effect fence belongs to the existing generation mutation. */
export function createNativeComposeStorageWitnessReceiptProtocol<
  R extends State,
>(opts: {
  readonly authority: NativeComposeMaterialAuthority;
  readonly read: () => Promise<R>;
  readonly save: (state: R, beforePublish: () => void) => Promise<void>;
  readonly requireActive: () => void;
  readonly requireEffect: (
    generation: NativeComposeGeneration,
    intent?: NativeComposeStorageWitnessIntent
  ) => void;
  readonly verifyAuthority: (
    generation: NativeComposeGeneration
  ) => Promise<void>;
  readonly load: (state: R) => Promise<NativeComposeGeneration>;
}) {
  let publishing = false;
  const verifiers = new Map<string, () => Promise<void>>();
  const arm = async (
    generation: NativeComposeGeneration,
    intent: NativeComposeStorageWitnessIntent
  ) => {
    opts.requireEffect(generation, intent);
    const state = await opts.read();
    const prior = state.storageWitnesses ?? [];
    if (
      prior.some((entry) => entry.name === intent.name) ||
      prior.length >= 64
    ) {
      return refuse();
    }
    const observed = state.storage?.find((entry) => entry.name === intent.name);
    if (intent.admission === "explicit-adoption" && !state.stopped) {
      return refuse();
    }
    if (intent.admission === "initial-create" && observed) {
      return refuse();
    }
    if (
      observed &&
      JSON.stringify(observed) !== JSON.stringify(intent.originalVolume)
    ) {
      return refuse();
    }
    const storageWitnesses = [
      ...prior,
      { ...intent, state: "expected" as const },
    ].sort((a, b) => a.name.localeCompare(b.name));
    if (!nativeComposeStorageWitnessStatesValid(storageWitnesses)) {
      return refuse();
    }
    const storage = intent.originalVolume
      ? mergeNativeComposeRetainedVolumes({
          retained: state.storage ?? [],
          observed: [intent.originalVolume],
        })
      : (state.storage ?? []);
    await opts.save({ ...state, version: 3, storage, storageWitnesses }, () =>
      opts.requireEffect(generation, intent)
    );
  };
  const complete = async (
    generation: NativeComposeGeneration,
    input: Extract<
      NativeComposeStorageWitnessPublication,
      { state: "enrolled" }
    >
  ) => {
    const state = await opts.read();
    const prior = state.storageWitnesses ?? [];
    const selected = prior.find(
      (entry) => entry.name === input.reference.volume.name
    );
    if (
      !selected ||
      selected.state !== "expected" ||
      selected.storage !== input.reference.volume.storage
    ) {
      return refuse();
    }
    opts.requireEffect(generation, selected);
    await input.verify();
    const latest = await opts.read();
    if (JSON.stringify(latest.storageWitnesses) !== JSON.stringify(prior)) {
      return refuse();
    }
    const entry: NativeComposeStorageWitnessState = {
      ...selected,
      state: "enrolled",
      reference: input.reference,
    };
    const storageWitnesses = prior.map((item) =>
      item.name === selected.name ? entry : item
    );
    if (!nativeComposeStorageWitnessStatesValid(storageWitnesses)) {
      return refuse();
    }
    const storage = mergeNativeComposeRetainedVolumes({
      retained: latest.storage ?? [],
      observed: [input.reference.volume],
    });
    await opts.save({ ...latest, version: 3, storage, storageWitnesses }, () =>
      opts.requireEffect(generation, selected)
    );
    verifiers.set(selected.name, input.verify);
  };
  const verifyEntry = async (
    entry: NativeComposeStorageWitnessState,
    state: R,
    carrier: NativeComposeEffectOptions<unknown>["storageWitnesses"]
  ) => {
    if (entry.state !== "enrolled") {
      return refuse();
    }
    const local = verifiers.get(entry.name);
    if (local) {
      await local();
      return;
    }
    if (!carrier) {
      return refuse();
    }
    const generation = await opts.load(state);
    const { verifyNativeComposeStorageWitness } = await import(
      "./native-compose-storage-witness.ts"
    );
    if (entry.reference.version === 3) {
      if (carrier.kind !== "directory-xattr") {
        return refuse();
      }
      await verifyNativeComposeStorageWitness({
        authority: opts.authority,
        generation,
        engineId: carrier.engineId,
        reference: entry.reference,
        xattrCarrier: carrier.carrier,
      });
      return;
    }
    if (carrier.kind === "directory-xattr") {
      return refuse();
    }
    await verifyNativeComposeStorageWitness({
      authority: opts.authority,
      generation,
      engineId: carrier.engineId,
      reference: entry.reference,
      observe: async (markerName) =>
        await carrier.observe({
          name: entry.name,
          storage: entry.storage,
          markerName,
        }),
    });
  };
  return {
    async publish(
      generation: NativeComposeGeneration,
      input: NativeComposeStorageWitnessPublication
    ): Promise<void> {
      opts.requireEffect(generation);
      if (publishing) {
        return refuse();
      }
      publishing = true;
      try {
        await opts.verifyAuthority(generation);
        if (input.state === "expected") {
          await arm(generation, input.intent);
        } else {
          await complete(generation, input);
        }
      } finally {
        publishing = false;
      }
    },
    async assert(
      operation: NativeComposeOperation,
      carrier: NativeComposeEffectOptions<unknown>["storageWitnesses"]
    ): Promise<void> {
      if (operation === "down") {
        return;
      }
      const state = await opts.read();
      if (state.storageWitnesses?.some((entry) => entry.state === "expected")) {
        throw new NativeComposeGenerationError("E_NATIVE_COMPOSE_UNCERTAIN");
      }
      for (const entry of state.storageWitnesses ?? []) {
        await verifyEntry(entry, state, carrier);
      }
      const latest = await opts.read();
      if (
        JSON.stringify(latest.storageWitnesses) !==
        JSON.stringify(state.storageWitnesses)
      ) {
        return refuse();
      }
      opts.requireActive();
    },
  };
}
