import { HackCliError } from "./cli-result.ts";
import { resolveComposeStartupTimeoutMs } from "./compose-startup-budget.ts";
import {
  NativeComposeHostHookError,
  selectNativeComposeAfterHooks,
} from "./native-compose-host-contract.ts";
import {
  assertNativeComposeBeforeHookBindings,
  runNativeComposeBeforeHooks,
} from "./native-compose-host-hooks.ts";
import type { acquireNativeComposeInputs } from "./native-compose-inputs.ts";

type Inputs = Awaited<ReturnType<typeof acquireNativeComposeInputs>>;

/** Native approval/value acquisition precedes the journal; the returned finite runner owns no engine effects. */
export async function prepareNativeComposeAfterHooks(opts: {
  readonly inputs: Inputs;
  readonly projectRoot: string;
  readonly signal: AbortSignal;
  readonly json: boolean;
}) {
  await opts.inputs.assertFresh();
  const hooks = selectNativeComposeAfterHooks(opts.inputs.result.plan);
  const values = new Map<string, Readonly<Record<string, string>>>();
  for (const hook of hooks) {
    values.set(hook.name, await opts.inputs.resolveHostValues(hook.name));
  }
  assertNativeComposeBeforeHookBindings({
    hooks,
    environmentPlan: opts.inputs.result.environment_plan,
    managedValues: values,
  });
  return async () => {
    const result = await runNativeComposeBeforeHooks({
      hooks,
      projectRoot: opts.projectRoot,
      environmentPlan: opts.inputs.result.environment_plan,
      resolveHostValues: (name) => {
        const selected = values.get(name);
        if (!selected) {
          throw new NativeComposeHostHookError();
        }
        return Promise.resolve(selected);
      },
      signal: opts.signal,
      timeoutMs: resolveComposeStartupTimeoutMs(),
      json: opts.json,
    });
    return {
      ...result,
      ready: result.outcome === "complete" && result.value === 0,
    };
  };
}

/** After hooks cannot rebind a running generation. Reacquisition verifies the same source/local/routing selection; owner freshness fences managed env bytes. */
export async function assertNativeComposeAfterInputsUnchanged(opts: {
  readonly inputs: Inputs;
  readonly acquire: () => Promise<Inputs>;
}): Promise<void> {
  await opts.inputs.assertFresh();
  const fresh = await opts.acquire();
  if (fresh.inputRevision !== opts.inputs.inputRevision) {
    throw new HackCliError({
      code: "E_CONFIG_INVALID",
      message:
        "Native inputs changed during after hooks; startup remains incomplete. Values omitted.",
    });
  }
  await fresh.assertFresh();
  await opts.inputs.assertFresh();
}
