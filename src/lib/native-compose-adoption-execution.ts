import type { LegacyComposeVerifiedBinding } from "./native-compose-adoption-binding.ts";
import {
  type LegacyComposeJobAttempt,
  type LegacyComposeJobState,
  legacyComposeFreshJobResult,
  legacyComposeJobStates,
} from "./native-compose-adoption-jobs.ts";
import {
  type LegacyComposeReadinessState,
  type LegacyComposeRetainedPlan,
  type LegacyComposeRetainedService,
  legacyComposeRetainedReady,
} from "./native-compose-adoption-readiness.ts";
import type { AdoptionOperation } from "./native-compose-adoption-receipt.ts";
import {
  inspectLegacyComposeJobStates,
  inspectLegacyComposeReadiness,
} from "./native-compose-adoption-runtime.ts";
import { waitNativeComposeReady } from "./native-compose-wait-ready.ts";
import { run } from "./shell.ts";

function refuse(): never {
  throw new Error(
    "Legacy adoption ordered operation refused or did not become ready; pending ownership retained. Values omitted."
  );
}
const COMPLETION = Symbol("legacy-compose-job-completion");
export type LegacyComposeJobCompletion = { readonly [COMPLETION]: true };
export type LegacyComposeRetainedOutcome = number | LegacyComposeJobCompletion;
type CompletionWitness = {
  readonly plan: LegacyComposeRetainedPlan;
  readonly binding: LegacyComposeVerifiedBinding;
  readonly operation: AdoptionOperation;
  readonly deadline: number;
  readonly assertFresh: () => Promise<void>;
  readonly attempts: readonly LegacyComposeJobAttempt[];
};
const completions = new WeakMap<object, CompletionWitness>();
// An injected test scheduler cannot mint production authority from synthetic facts/effects.
const productionRuns = new WeakSet<object>();

function serviceEdges(
  required: LegacyComposeRetainedService["dependencies"]
): readonly {
  readonly service: string;
  readonly condition: "started" | "ready";
}[] {
  return required.map((edge) => {
    if (edge.condition === "completed") {
      refuse();
    }
    return { service: edge.service, condition: edge.condition };
  });
}

function captureJobAttempt(
  rows: readonly LegacyComposeJobState[],
  id: string | undefined
): LegacyComposeJobAttempt {
  const prior = rows.find((row) => row.id === id);
  if (
    !prior ||
    prior.running ||
    prior.paused ||
    !["created", "exited"].includes(prior.status) ||
    prior.health !== "" ||
    prior.restartPolicy !== "no" ||
    prior.maximumRetryCount !== 0
  ) {
    refuse();
  }
  return Object.freeze({ id: prior.id, priorStartedAt: prior.startedAt });
}

function completionEdges(
  plan: LegacyComposeRetainedPlan
): LegacyComposeRetainedService["dependencies"] {
  return plan.ordered.map((item) => {
    if (item.kind === "job") {
      return { service: item.service, condition: "completed" };
    }
    return {
      service: item.service,
      condition: item.healthy ? "ready" : "started",
    };
  });
}

function jobPlanIds(opts: {
  readonly plan: LegacyComposeRetainedPlan;
  readonly binding: LegacyComposeVerifiedBinding;
  readonly deadline: number;
}): ReadonlyMap<string, string> {
  const ids = new Map(
    opts.binding.containers.map((item) => [item.service, item.id])
  );
  if (
    !opts.plan.requiresV7 ||
    ids.size !== opts.binding.containers.length ||
    opts.plan.ordered.length !== ids.size ||
    !opts.plan.ordered.some((item) => item.kind === "job") ||
    opts.plan.ordered.some((item) => !ids.has(item.service)) ||
    !Number.isFinite(opts.deadline)
  ) {
    refuse();
  }
  return ids;
}

async function stopJobPlan(
  plan: LegacyComposeRetainedPlan,
  apply: (action: "start" | "stop", name: string) => Promise<number>
): Promise<number> {
  for (const item of [...plan.ordered].reverse()) {
    const code = await apply("stop", item.service);
    if (code !== 0) {
      return code;
    }
  }
  return 0;
}

/** One callback's completion, consumed once by the held mutation owner. Structural/numeric/replayed success is not authority. */
export function consumeLegacyComposeJobCompletion(opts: {
  readonly outcome: unknown;
  readonly plan: LegacyComposeRetainedPlan;
  readonly binding: LegacyComposeVerifiedBinding;
  readonly operation: AdoptionOperation;
  readonly deadline: number;
  readonly assertFresh: () => Promise<void>;
}): readonly LegacyComposeJobAttempt[] {
  if (typeof opts.outcome !== "object" || opts.outcome === null) {
    refuse();
  }
  const witness = completions.get(opts.outcome);
  if (
    !witness ||
    witness.plan !== opts.plan ||
    witness.binding !== opts.binding ||
    witness.operation !== opts.operation ||
    witness.deadline !== opts.deadline ||
    witness.assertFresh !== opts.assertFresh ||
    Date.now() >= opts.deadline
  ) {
    refuse();
  }
  completions.delete(opts.outcome);
  return witness.attempts;
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
}): Promise<LegacyComposeRetainedOutcome> {
  if (opts.plan.requiresV7) {
    return await executeLegacyComposeRetainedJobs(opts);
  }
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
      await wait(serviceEdges(service.dependencies));
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

/** V7 uses the same retained IDs and aggregate deadline, with fresh admitted job attempts. */
async function executeLegacyComposeRetainedJobs(
  opts: Parameters<typeof executeLegacyComposeRetainedPlan>[0]
): Promise<LegacyComposeRetainedOutcome> {
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
  const ids = jobPlanIds({ plan, binding, deadline });
  const attempts = new Map<string, LegacyComposeJobAttempt>();
  function remaining() {
    const time = Math.floor(deadline - Date.now());
    if (signal?.aborted || time <= 0) {
      refuse();
    }
    return time;
  }
  async function fresh() {
    remaining();
    await assertFresh();
    remaining();
  }
  async function acquire() {
    const rows = legacyComposeJobStates({
      binding,
      observed: await observe(Math.min(60_000, remaining())),
    });
    await fresh();
    return rows;
  }
  async function apply(action: "start" | "stop", name: string) {
    await fresh();
    const id = ids.get(name);
    if (!id) {
      refuse();
    }
    return await effect(action, id, remaining());
  }
  function ready(
    rows: readonly LegacyComposeJobState[],
    required: LegacyComposeRetainedPlan["ordered"][number]["dependencies"]
  ) {
    return required.every((edge) => {
      const id = ids.get(edge.service),
        row = rows.find((item) => item.id === id);
      if (!row) {
        refuse();
      }
      if (edge.condition === "completed") {
        const attempt = attempts.get(edge.service);
        if (!attempt) {
          refuse();
        }
        const status = legacyComposeFreshJobResult({ attempt, observed: row });
        if (status === "failed" || status === "refused") {
          refuse();
        }
        return status === "ready";
      }
      return legacyComposeRetainedReady({
        plan,
        ids,
        observed: rows,
        required: [edge],
      });
    });
  }
  async function wait(
    required: LegacyComposeRetainedPlan["ordered"][number]["dependencies"]
  ) {
    const rows = await waitNativeComposeReady({
      deadline,
      signal,
      observe: acquire,
      ready: (values) => ready(values, required),
    });
    await fresh();
    if (!rows) {
      refuse();
    }
  }
  await fresh();
  if (operation === "stop" || operation === "restart") {
    const code = await stopJobPlan(plan, apply);
    if (code !== 0) {
      return code;
    }
    if (operation === "stop") {
      return 0;
    }
  }
  for (const item of plan.ordered) {
    if (item.dependencies.length) {
      await wait(item.dependencies);
    }
    let attempt: LegacyComposeJobAttempt | undefined;
    if (item.kind === "job") {
      attempt = captureJobAttempt(await acquire(), ids.get(item.service));
    }
    const code = await apply("start", item.service);
    if (code !== 0) {
      return code;
    }
    if (attempt) {
      attempts.set(item.service, attempt);
    }
    await wait([
      {
        service: item.service,
        condition: item.kind === "job" ? "completed" : "started",
      },
    ]);
  }
  const required = completionEdges(plan);
  await wait(required);
  const finalRows = await acquire();
  if (!ready(finalRows, required)) {
    refuse();
  }
  await fresh();
  if (!productionRuns.has(opts)) {
    return 0;
  }
  const completion: LegacyComposeJobCompletion = Object.freeze({
    [COMPLETION]: true,
  });
  completions.set(completion, {
    plan,
    binding,
    operation,
    deadline,
    assertFresh,
    attempts: Object.freeze([...attempts.values()]),
  });
  return completion;
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
}): Promise<LegacyComposeRetainedOutcome> {
  const { input, operation, deadline, signal } = opts;
  const admitted: Parameters<typeof executeLegacyComposeRetainedPlan>[0] =
    Object.freeze({
      plan: input.retainedPlan,
      binding: input.binding,
      operation,
      deadline,
      signal,
      assertFresh: input.assertFresh,
      observe: (remainingMs) =>
        (input.retainedPlan.requiresV7
          ? inspectLegacyComposeJobStates
          : inspectLegacyComposeReadiness)({
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
          signal,
          timeoutMs: remainingMs,
        }),
    });
  productionRuns.add(admitted);
  try {
    return await executeLegacyComposeRetainedPlan(admitted);
  } finally {
    productionRuns.delete(admitted);
  }
}
