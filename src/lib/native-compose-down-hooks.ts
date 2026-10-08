import { HackCliError } from "./cli-result.ts";
import { isRecord } from "./guards.ts";
import { prepareNativeComposeFiniteHooks } from "./native-compose-after-hooks.ts";
import type { NativeComposeGeneration } from "./native-compose-generation.ts";
import { selectNativeComposeDownHooks } from "./native-compose-host-contract.ts";
import { acquireNativeComposeFilePlanningInputs } from "./native-compose-inputs.ts";

const EXTENSION = "x-hack-native-down-hooks";
type Inputs = Awaited<
  ReturnType<typeof acquireNativeComposeFilePlanningInputs>
>;
type Binding = {
  readonly version: 1;
  readonly inputRevision: string;
  readonly profiles: readonly string[];
  readonly overlay: string | null;
  readonly explicitOverlay?: string | null;
};
function refuse(): never {
  throw new HackCliError({
    code: "E_CONFIG_INVALID",
    message:
      "Native down-hook inputs differ from the saved generation; stop remains incomplete. Use explicit down --recover to stop saved resources without replaying hooks. Values omitted.",
  });
}

/** Saved-only generations without this private binding never acquire newly authored hooks. */
export function bindNativeComposeDownHooks(opts: {
  readonly inputs: Inputs;
  readonly profiles: readonly string[];
  readonly explicitOverlay?: string | null;
  readonly document: Readonly<Record<string, unknown>>;
}): Readonly<Record<string, unknown>> {
  const hooks = selectNativeComposeDownHooks(opts.inputs.result.plan);
  if (hooks.before.length + hooks.after.length === 0) {
    return opts.document;
  }
  const binding: Binding = {
    version: 1,
    inputRevision: opts.inputs.inputRevision,
    profiles: [...opts.profiles],
    overlay: opts.inputs.result.local_resolution.overlay,
    ...(opts.explicitOverlay === undefined
      ? {}
      : { explicitOverlay: opts.explicitOverlay }),
  };
  return { ...opts.document, [EXTENSION]: binding };
}

/** Must be called on an owner-verified immutable document. Cross-check the extension with the manifest. */
export function readNativeComposeDownHookBinding(opts: {
  readonly generation: NativeComposeGeneration;
  readonly document: Readonly<Record<string, unknown>>;
}): Binding | null {
  if (!Object.hasOwn(opts.document, EXTENSION)) {
    return null;
  }
  const value = opts.document[EXTENSION];
  if (
    !(
      isRecord(value) &&
      ["version", "inputRevision", "profiles", "overlay"].every((key) =>
        Object.hasOwn(value, key)
      ) &&
      Object.keys(value).every((key) =>
        [
          "version",
          "inputRevision",
          "profiles",
          "overlay",
          "explicitOverlay",
        ].includes(key)
      ) &&
      value.version === 1 &&
      value.inputRevision === opts.generation.inputRevision &&
      Array.isArray(value.profiles) &&
      JSON.stringify(value.profiles) ===
        JSON.stringify(opts.generation.profiles) &&
      Object.hasOwn(value, "overlay") &&
      (value.overlay === null || typeof value.overlay === "string") &&
      (!Object.hasOwn(value, "explicitOverlay") ||
        value.explicitOverlay === null ||
        typeof value.explicitOverlay === "string")
    )
  ) {
    return refuse();
  }
  return Object.freeze({
    version: 1,
    inputRevision: opts.generation.inputRevision,
    profiles: opts.generation.profiles,
    overlay: value.overlay,
    ...(Object.hasOwn(value, "explicitOverlay")
      ? {
          explicitOverlay:
            typeof value.explicitOverlay === "string"
              ? value.explicitOverlay
              : null,
        }
      : {}),
  });
}

/** Call under the mutation lock only after rejecting pre-existing pending/host intent. */
export async function prepareNativeComposeDownHooks(opts: {
  readonly binding: Binding;
  readonly projectRoot: string;
  readonly signal: AbortSignal;
  readonly json: boolean;
  readonly assertAbsent: () => Promise<void>;
}) {
  const acquire = () =>
    acquireNativeComposeFilePlanningInputs({
      projectRoot: opts.projectRoot,
      profiles: opts.binding.profiles,
      explicitOverlay: opts.binding.explicitOverlay,
      signal: opts.signal,
    });
  const inputs = await acquire();
  const sameSelection = (selected: Inputs) => {
    if (
      selected.inputRevision !== opts.binding.inputRevision ||
      selected.result.local_resolution.overlay !== opts.binding.overlay
    ) {
      refuse();
    }
  };
  sameSelection(inputs);
  const hooks = selectNativeComposeDownHooks(inputs.result.plan);
  if (hooks.before.length + hooks.after.length === 0) {
    refuse();
  }
  // Both native approvals/value captures happen before journaling any host effects.
  const before = hooks.before.length
    ? await prepareNativeComposeFiniteHooks({
        ...opts,
        inputs,
        hooks: hooks.before,
      })
    : undefined;
  const after = hooks.after.length
    ? await prepareNativeComposeFiniteHooks({
        ...opts,
        inputs,
        hooks: hooks.after,
      })
    : undefined;
  let code: number | undefined;
  const assertSelectionUnchanged = async () => {
    await inputs.assertFresh();
    const fresh = await acquire();
    sameSelection(fresh);
    await fresh.assertFresh();
    await inputs.assertFresh();
  };
  const phase = (
    execute: NonNullable<typeof before>,
    afterEngine: boolean
  ) => ({
    prepare: async () => {
      await assertSelectionUnchanged();
      if (afterEngine) {
        await opts.assertAbsent();
      }
      return async () => {
        const result = await execute();
        code = result.value;
        return result;
      };
    },
  });
  return {
    // The store fences exact source and env-owner bytes around every slow
    // ownership probe. Reacquire the whole selection at phase/final boundaries.
    assertFresh: inputs.assertFresh,
    assertSelectionUnchanged,
    downHooks: {
      ...(before ? { before: phase(before, false) } : {}),
      ...(after ? { after: phase(after, true) } : {}),
    },
    code: () => code,
  };
}
