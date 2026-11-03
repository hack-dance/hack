import { expect } from "bun:test";
import type {
  LegacyComposeAdoptedGeneration,
  LegacyComposeAdoptedGenerationStore,
} from "../../src/lib/native-compose-adoption-generation.ts";

/** Invalid caller budgets must refuse before probing, journaling or invoking effects. */
export async function assertInvalidRetainedMutationDeadlines(opts: {
  readonly store: LegacyComposeAdoptedGenerationStore;
  readonly generation: LegacyComposeAdoptedGeneration;
  readonly binary: string;
  readonly snapshot: () => Promise<unknown>;
}): Promise<void> {
  const before = await opts.snapshot();
  let calls = 0;
  const run = async () => {
    calls += 1;
    return 0;
  };
  for (const deadline of [
    undefined,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ]) {
    const common = {
      generation: opts.generation,
      binary: opts.binary,
      deadline,
      run,
    };
    await expect(opts.store.withPreparationStop(common)).rejects.toMatchObject({
      code: "E_LEGACY_ADOPTION_UNSUPPORTED",
    });
    await expect(
      opts.store.withMutation({ ...common, operation: "stop", services: [] })
    ).rejects.toMatchObject({
      code: "E_LEGACY_ADOPTION_UNSUPPORTED",
    });
  }
  expect(calls).toBe(0);
  expect(await opts.snapshot()).toEqual(before);
}
