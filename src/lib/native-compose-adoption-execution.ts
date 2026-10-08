import type { LegacyComposeVerifiedBinding } from "./native-compose-adoption-binding.ts";
import {
  type LegacyComposeReadinessState,
  type LegacyComposeRetainedPlan,
  legacyComposeRetainedReady,
} from "./native-compose-adoption-readiness.ts";
import type { AdoptionOperation } from "./native-compose-adoption-receipt.ts";
import { inspectLegacyComposeReadiness } from "./native-compose-adoption-runtime.ts";
import { waitNativeComposeReady } from "./native-compose-wait-ready.ts";
import { run } from "./shell.ts";

function refuse(): never {
  throw new Error(
    "Legacy adoption ordered operation refused or did not become ready; pending ownership retained. Values omitted."
  );
}
/**
 * Consume a journaled v5 plan through exact original IDs. Every effect rechecks
 * the store's held source/resource/receipt authority. Restart stops in reverse
 * dependency order, then starts in order; no Compose recreation or new IDs occur.
 * All effects and fresh polling acquisitions share one declared deadline.
 */
export async function executeLegacyComposeRetainedPlan(opts: {
  readonly plan: LegacyComposeRetainedPlan;
  readonly binding: LegacyComposeVerifiedBinding;
  readonly operation: AdoptionOperation;
  readonly deadline: number;
  readonly signal?: AbortSignal;
  readonly assertFresh: () => Promise<void>;
  readonly observe: (
    remainingMs: number
  ) => Promise<readonly LegacyComposeReadinessState[]>;
  readonly effect: (
    operation: "start" | "stop",
    id: string,
    remainingMs: number
  ) => Promise<number>;
}): Promise<number> {
  const {
    plan,
    binding,
    operation,
    deadline,
    signal,
    assertFresh,
    observe,
    effect,
  } = opts;
  const ids = new Map(
    binding.containers.map((container) => [container.service, container.id])
  );
  if (
    !plan.requiresV5 ||
    ids.size !== binding.containers.length ||
    plan.ordered.length !== ids.size ||
    plan.ordered.some((service) => !ids.has(service.service)) ||
    !Number.isFinite(deadline)
  ) {
    refuse();
  }
  function remaining() {
    const time = Math.floor(deadline - Date.now());
    if (signal?.aborted || time <= 0) {
      refuse();
    }
    return time;
  }
  async function apply(action: "start" | "stop", service: string) {
    remaining();
    await assertFresh();
    const id = ids.get(service);
    if (!id) {
      refuse();
    }
    return await effect(action, id, remaining());
  }
  async function wait(
    required: readonly {
      readonly service: string;
      readonly condition: "started" | "ready";
    }[]
  ) {
    remaining();
    const ready = await waitNativeComposeReady({
      deadline,
      signal,
      observe: () => observe(Math.min(60_000, remaining())),
      ready: (observed) =>
        legacyComposeRetainedReady({ plan, ids, observed, required }),
    });
    remaining();
    if (!ready) {
      refuse();
    }
  }
  remaining();
  if (operation === "stop" || operation === "restart") {
    for (const service of [...plan.ordered].reverse()) {
      const code = await apply("stop", service.service);
      if (code !== 0) {
        return code;
      }
    }
    if (operation === "stop") {
      return 0;
    }
  }
  for (const service of plan.ordered) {
    if (service.dependencies.length) {
      await wait(service.dependencies);
    }
    const code = await apply("start", service.service);
    if (code !== 0) {
      return code;
    }
    await wait([{ service: service.service, condition: "started" }]);
  }
  await wait(
    plan.ordered.map((service) => ({
      service: service.service,
      condition: service.healthy ? "ready" : "started",
    }))
  );
  return 0;
}

/** Production adapter uses the shared bounded probe and process-group runner. */
export async function runLegacyComposeRetainedOperation(opts: {
  readonly input: {
    readonly binding: LegacyComposeVerifiedBinding;
    readonly retainedPlan: LegacyComposeRetainedPlan;
    readonly assertFresh: () => Promise<void>;
  };
  readonly operation: AdoptionOperation;
  readonly deadline: number;
  readonly signal: AbortSignal;
}): Promise<number> {
  const { input, operation, deadline, signal } = opts;
  return await executeLegacyComposeRetainedPlan({
    plan: input.retainedPlan,
    binding: input.binding,
    operation,
    deadline,
    signal,
    assertFresh: input.assertFresh,
    observe: (remainingMs) =>
      inspectLegacyComposeReadiness({
        binding: input.binding,
        signal,
        timeoutMs: remainingMs,
      }),
    effect: (action, id, remainingMs) =>
      run(["docker", "container", action, id], {
        cwd: input.binding.projectRoot,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        forwardSignals: true,
        timeoutMs: remainingMs,
      }),
  });
}
