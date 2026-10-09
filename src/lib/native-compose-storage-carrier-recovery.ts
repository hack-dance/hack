import type {
  NativeComposeGeneration,
  NativeComposeGenerationStore,
  NativeComposeMaterialAuthority,
} from "./native-compose-generation.ts";
import { observeNativeComposeStorageWitnessCarrier } from "./native-compose-storage-witness.ts";
import { observeNativeComposeStorageDockerCarrierRecovery } from "./native-compose-storage-witness-docker.ts";
import type { NativeComposeStorageWitnessReference } from "./native-compose-storage-witness-state.ts";

/** Internal saved down-recovery observation. Exact readonly verification work is
 * retained even on success: the old host command has no durable settlement
 * receipt. This API cannot clear pending, replay a helper, or retire resources. */
export async function observeNativeComposeStorageCarrierRecovery(opts: {
  readonly store: NativeComposeGenerationStore;
  readonly authority: NativeComposeMaterialAuthority;
  readonly generation: NativeComposeGeneration;
  readonly engineId: string;
  readonly reference: NativeComposeStorageWitnessReference;
  readonly signal: AbortSignal;
  readonly deadline: number;
}) {
  const { store, authority, generation, engineId, signal, deadline } = opts;
  return await observeNativeComposeStorageWitnessCarrier({
    authority,
    generation,
    engineId,
    reference: opts.reference,
    observe: async ({ intent, request, assertUnchanged }) =>
      await observeNativeComposeStorageDockerCarrierRecovery({
        context: { store, authority, engineId, signal, deadline },
        intent,
        request,
        assertUnchanged,
      }),
  });
}
