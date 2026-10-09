import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { NativeComposeHostHookError } from "../lib/native-compose-host-contract.ts";
import { NativeConfigCompilerError } from "../lib/native-config-compiler.ts";
import { acquireNativeExecutionInputs } from "../lib/native-execution-inputs.ts";
import {
  assertNativeFiniteHookBindings,
  type NativeFiniteHooks,
  type NativeHookPhase,
  type NativeHookResult,
  selectNativeFiniteHooks,
} from "../lib/native-host-hook-runner.ts";
import {
  assertNativeHostLifecycleBindings,
  type NativeHostLifecycle,
  selectNativeHostLifecycle,
} from "../lib/native-host-lifecycle-contract.ts";
import {
  type NativeAuthoredReceipt,
  type NativeAuthoredReview,
  parseNativeAuthoredReview,
  parseNativeAuthoredSnapshot,
} from "./native-authored-graph-protocol.ts";
import type { NativeAuthoredHookOwner } from "./native-authored-hook-journal.ts";
import {
  hookPhaseRunner,
  hookSelection,
  type NativeAuthoredStartupAttempt,
  type NativeHookDiagnostic,
  publishAuthoredReady,
  requireHookSuccess,
} from "./native-authored-hook-lifecycle.ts";
import type { serveNativeHookStop } from "./native-authored-hook-stop.ts";
import {
  createNativeAuthoredHostProcesses,
  type NativeAuthoredHostProcesses,
} from "./native-authored-host-processes.ts";
import {
  loadNativeAuthoredProjectRun,
  type NativeAuthoredProjectAdmission,
  type NativeAuthoredProjectRunScope,
  type NativeAuthoredProjectRunSelection,
  type NativeAuthoredProjectSource,
  withNativeAuthoredProjectAdmission,
} from "./native-authored-project-run.ts";
import {
  type NativeExitDiagnostic,
  serveNativeAuthoredProjectGraph,
} from "./native-project-process.ts";
import {
  invokeNativeRuntime,
  NativeRuntimeRequestError,
  type NativeRuntimeSelection,
} from "./native-runtime-client.ts";

const RUN = /^[a-f0-9]{32}$/;
const CODE = /^[a-z][a-z0-9_]{0,63}$/;
const PRIVATE_LIMIT = 256 * 1024;
type Inputs = Awaited<ReturnType<typeof acquireNativeExecutionInputs>>;
type Outcome = "not-started" | "removed" | "retained";
const STAGES = [
  "selection",
  "admission",
  "retained-state",
  "inputs",
  "source",
  "native-plan",
  "review",
  "source-freshness",
  "reservation",
  "runtime",
  "hook-up-before",
  "hook-up-after",
  "hook-down-before",
  "hook-down-after",
] as const;
type Stage = (typeof STAGES)[number];
const COMPILER_CODES = new Set([
  "E_COMPILER_BUDGET",
  "E_COMPILER_CANCELLED",
  "E_COMPILER_MISSING",
  "E_COMPILER_PATH",
  "E_COMPILER_RESPONSE",
  "E_COMPILER_TIMEOUT",
  "E_COMPILER_VERSION",
  "E_CONFIG_INPUT",
  "E_CONFIG_INVALID",
  "E_CONFIG_METADATA",
  "E_NATIVE_PROJECT_UNSUPPORTED",
]);

function compilerDiagnostic(error: unknown): string | undefined {
  return error instanceof NativeConfigCompilerError ? error.code : undefined;
}

/** Fixed diagnostics only; neither values nor arbitrary child/callback errors escape. */
export class NativeAuthoredProjectStartError extends Error {
  readonly outcome: Outcome;
  readonly canceled: boolean;
  readonly nativeCode?: string;
  readonly stage: Stage;
  readonly compilerCode?: string;

  constructor(opts: {
    readonly outcome: Outcome;
    readonly canceled: boolean;
    readonly nativeCode?: string;
    readonly stage?: Stage;
    readonly compilerCode?: string;
  }) {
    const nativeCode =
      opts.nativeCode && CODE.test(opts.nativeCode)
        ? opts.nativeCode
        : undefined;
    const stage = STAGES.includes(opts.stage ?? "selection")
      ? (opts.stage ?? "selection")
      : "selection";
    const compilerCode =
      opts.compilerCode && COMPILER_CODES.has(opts.compilerCode)
        ? opts.compilerCode
        : undefined;
    const detail = {
      "not-started": "no native consumer was started",
      removed: "exact native cleanup was confirmed",
      retained:
        "startup evidence is retained; inspect owned state before retrying",
    }[opts.outcome];
    super(
      `Native authored startup failed${nativeCode ? ` (${nativeCode})` : ""}; stage ${stage}${compilerCode ? ` (${compilerCode})` : ""}; ${detail}. Values omitted.`
    );
    this.outcome = opts.outcome;
    this.canceled = opts.canceled;
    this.nativeCode = nativeCode;
    this.stage = stage;
    this.compilerCode = compilerCode;
  }
}

type Options = {
  readonly runtime: NativeRuntimeSelection;
  readonly scope: NativeAuthoredProjectRunScope;
  readonly run: string;
  readonly profiles?: readonly string[];
  readonly overlay?: string | null;
  readonly startupTimeoutMs: number;
  readonly signal?: AbortSignal;
  readonly forceSignal?: AbortSignal;
  /** Observation after publication; the immutable selection grants no runtime authority. */
  readonly onReady?: (
    selection: NativeAuthoredProjectRunSelection
  ) => undefined;
  readonly onExitDiagnostic?: (diagnostic: NativeExitDiagnostic) => void;
  readonly onHookDiagnostic?: (event: NativeHookDiagnostic) => void;
};

function freeze(value: unknown): void {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) {
      freeze(child);
    }
    Object.freeze(value);
  }
}
function observedReady(
  opts: Options,
  ready: NativeAuthoredProjectRunSelection
): void {
  const observed: unknown = opts.onReady?.(ready);
  if (observed !== undefined) {
    void Promise.resolve(observed).catch(() => undefined);
    throw new Error(
      "Native ready observation must be synchronous; values omitted."
    );
  }
}

/** Match Candidate::plan_with_branch after storage has admitted the canonical scope. */
function projectNamespace(scope: NativeAuthoredProjectRunScope): string {
  const digest = createHash("sha256");
  if (scope.branch !== null) {
    digest.update("hack-native-branch-namespace-v1\0");
  }
  digest.update(scope.projectRoot);
  if (scope.branch !== null) {
    digest.update("\0").update(scope.branch);
  }
  return digest.digest("hex");
}

function matchingReview(
  value: unknown,
  inputs: Inputs,
  run: string,
  scope: NativeAuthoredProjectRunScope
) {
  const review = parseNativeAuthoredReview(value);
  if (
    review.provenance.run !== run ||
    review.provenance.namespace !== projectNamespace(scope) ||
    review.provenance.input.semantic_hash !== inputs.result.semantic_hash ||
    review.provenance.input.local_resolution_hash !==
      inputs.result.local_resolution.resolution_hash ||
    JSON.stringify(review.provenance.input.selected_profiles) !==
      JSON.stringify(inputs.result.plan.selected_profiles)
  ) {
    throw new Error("Native authored input identity changed; values omitted.");
  }
  return review;
}

/** Project only compiler-selected managed source keys. Rust owns destination remapping. */
async function privateDelivery(
  inputs: Inputs,
  review: NativeAuthoredReview,
  lifetimeMs: () => number
): Promise<Buffer | undefined> {
  const sources = Object.entries(inputs.result.environment_plan.workloads)
    .map(([name, bindings]) => ({
      name,
      keys: [
        ...new Set(
          Object.values(bindings).flatMap((binding) =>
            binding.kind === "managed" ? [binding.key] : []
          )
        ),
      ],
    }))
    .filter(({ keys }) => keys.length > 0);
  if (sources.length === 0) {
    return undefined;
  }
  const values = await inputs.resolveManagedValues();
  const services = Object.fromEntries(
    sources.map(({ name, keys }) => {
      const selected = values[name];
      return [
        name,
        Object.fromEntries(
          keys.map((key) => {
            if (
              !(selected && Object.hasOwn(selected, key)) ||
              typeof selected[key] !== "string"
            ) {
              throw new Error(
                "Native managed selection changed; values omitted."
              );
            }
            return [key, selected[key]];
          })
        ),
      ];
    })
  );
  const lifetime = Math.floor(lifetimeMs() / 1000);
  if (lifetime < 1 || lifetime > 300) {
    throw new Error("Native managed lifetime expired; values omitted.");
  }
  const payload = Buffer.from(
    JSON.stringify({
      version: 2,
      kind: "native-graph-environment",
      review: review.review_id,
      run: review.provenance.run,
      lifetime_seconds: lifetime,
      services,
    })
  );
  if (payload.byteLength > PRIVATE_LIMIT) {
    payload.fill(0);
    throw new Error(
      "Native managed delivery exceeds its budget; values omitted."
    );
  }
  return payload;
}

type Attempt = NativeAuthoredStartupAttempt;
async function removeUnstartedSource(
  source: NativeAuthoredProjectSource | undefined,
  attempt: Attempt | undefined,
  outcome: Outcome
): Promise<Outcome> {
  if (attempt || !source) {
    return outcome;
  }
  try {
    await source.remove();
    return outcome;
  } catch {
    return "retained";
  }
}

async function confirmRemoved(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly scope: NativeAuthoredProjectRunScope;
  readonly admission: NativeAuthoredProjectAdmission;
  readonly attempt: Attempt;
}): Promise<NativeAuthoredReceipt> {
  const { attempt } = opts;
  // A canceled ingress must not prevent read-only authentication of completed
  // shutdown. This request has its own bounded drain; it never sends cleanup.
  const snapshot = parseNativeAuthoredSnapshot({
    value: await invokeNativeRuntime({
      runtime: opts.runtime,
      cwd: opts.scope.projectRoot,
      args: [
        "graph",
        "native",
        "inspect",
        "--run-id",
        attempt.start.record.review.provenance.run,
        "--json",
      ],
      timeoutMs: 45_000,
      boundNativeAuthoredReadDrain: true,
    }),
    expectedReview: attempt.start.record.review,
    admitted: attempt.observed,
  });
  if (
    snapshot.receipt.phase !== "removed" ||
    Object.values(snapshot.receipt.resources).some(
      (resource) => resource.phase !== "removed"
    ) ||
    Object.values(snapshot.observations).some(
      (observation) => observation !== null
    )
  ) {
    throw new Error("Native cleanup is unconfirmed; values omitted.");
  }
  return snapshot.receipt;
}

async function retireAttempt(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly scope: NativeAuthoredProjectRunScope;
  readonly admission: NativeAuthoredProjectAdmission;
  readonly attempt: Attempt;
}): Promise<void> {
  const cleaned = await confirmRemoved(opts);
  const { attempt } = opts;
  await opts.admission.retire({
    expectedStart: attempt.start,
    expectedRun: attempt.ready,
    cleaned,
  });
  await attempt.source.remove();
}

const HOOK_STAGES: Record<NativeHookPhase, Stage> = {
  "up.before": "hook-up-before",
  "up.after": "hook-up-after",
  "down.before": "hook-down-before",
  "down.after": "hook-down-after",
};
function observeHook(opts: Options, event: NativeHookDiagnostic): void {
  try {
    void Promise.resolve(opts.onHookDiagnostic?.(event)).catch(() => undefined);
  } catch {
    /* observation only */
  }
}

type HostSelection = {
  readonly hooks?: NativeFiniteHooks;
  readonly lifecycle?: NativeHostLifecycle;
  readonly persistent: boolean;
  readonly owner?: NativeAuthoredHookOwner;
  readonly processes?: NativeAuthoredHostProcesses;
};
function assertHostBindings(selected: HostSelection, inputs: Inputs): void {
  if (selected.persistent && selected.lifecycle) {
    assertNativeHostLifecycleBindings(
      selected.lifecycle,
      inputs.result.environment_plan
    );
  } else if (selected.hooks) {
    assertNativeFiniteHookBindings({
      hooks: selected.hooks,
      report: inputs.result.environment_plan,
    });
  }
}
async function prepareHostSelection(opts: {
  readonly inputs: () => Inputs;
  readonly options: Options;
  readonly admission: NativeAuthoredProjectAdmission;
  readonly identity: string;
  readonly signal: AbortSignal;
  readonly remaining: () => number;
}): Promise<HostSelection> {
  const inputs = opts.inputs();
  if (inputs.result.plan.host === undefined) {
    return { persistent: false };
  }
  const lifecycle = selectNativeHostLifecycle(inputs.result.plan);
  const persistent =
    lifecycle.processes.length !== 0 ||
    inputs.result.plan.host_bindings !== undefined;
  const hooks = persistent
    ? lifecycle.hooks
    : selectNativeFiniteHooks(inputs.result.plan);
  assertHostBindings({ hooks, lifecycle, persistent }, inputs);
  const owner = await opts.admission.createHooks({
    run: opts.options.run,
    selectionHash: createHash("sha256").update(opts.identity).digest("hex"),
  });
  if (!persistent) {
    return { hooks, lifecycle, persistent, owner };
  }
  const name = inputs.result.plan.name;
  if (typeof name !== "string") {
    throw new NativeComposeHostHookError();
  }
  const processes = await createNativeAuthoredHostProcesses({
    scope: opts.options.scope,
    run: opts.options.run,
    semanticHash: inputs.result.semantic_hash,
    projectName: name,
    lifecycle,
    report: () => opts.inputs().result.environment_plan,
    resolveValues: (name) => opts.inputs().resolveHostValues(name),
    signal: opts.signal,
    remaining: opts.remaining,
    assertFresh: async () => {
      await opts.inputs().assertFresh();
      await opts.admission.assertHeld();
      await owner.assertFresh();
    },
  });
  return { hooks, lifecycle, persistent, owner, processes };
}

async function runPreparedLifecycle(ctx: {
  readonly options: Options;
  readonly admitted: Attempt;
  readonly review: NativeAuthoredReview;
  readonly payload: Buffer | undefined;
  readonly inputs: () => Inputs;
  readonly hookOwner: NativeAuthoredHookOwner | undefined;
  readonly hostProcesses: NativeAuthoredHostProcesses | undefined;
  readonly hostRetired: () => void;
  readonly phase: (name: NativeHookPhase) => Promise<NativeHookResult>;
  readonly graph: AbortController;
  readonly hard: AbortController;
  readonly remaining: () => number;
  readonly admission: NativeAuthoredProjectAdmission;
  readonly stopped: Promise<boolean>;
  readonly completeStop: (removed: boolean) => void;
  readonly endpoint: (
    value: Awaited<ReturnType<typeof serveNativeHookStop>>
  ) => void;
  readonly published: () => void;
  readonly removed: () => void;
  readonly hookRetired: () => void;
  readonly nativeCode: (code: string | undefined) => void;
}): Promise<number> {
  const review = ctx.review;
  let downBefore = false;
  let failure: unknown;
  let code = 1;
  try {
    code = await serveNativeAuthoredProjectGraph({
      runtime: ctx.options.runtime,
      projectRoot: ctx.options.scope.projectRoot,
      run: ctx.options.run,
      sourceFile: ctx.admitted.source.path,
      review,
      privateInput: ctx.payload,
      startupTimeoutMs: ctx.remaining(),
      signal: ctx.graph.signal,
      forceSignal: ctx.hard.signal,
      frontendHooks: ctx.hookOwner !== undefined,
      onGroup: ctx.hookOwner?.graphChild,
      beforeStop: ctx.hookOwner
        ? async () => {
            const result = await ctx.phase("down.before");
            downBefore =
              result.outcome === "complete" &&
              result.exitCode === 0 &&
              !result.timedOut &&
              !result.canceled;
            if (!downBefore) {
              ctx.completeStop(false);
            }
            return downBefore;
          }
        : undefined,
      onStopFailure: () => {
        observeHook(ctx.options, {
          phase: "down.before",
          boundary: "stop-operation",
        });
        ctx.completeStop(false);
      },
      onExitDiagnostic: (diagnostic) => {
        ctx.nativeCode(diagnostic.nativeCode);
        const observed: unknown = ctx.options.onExitDiagnostic?.(diagnostic);
        void Promise.resolve(observed).catch(() => undefined);
      },
      onReceipt: (receipt) => {
        freeze(receipt);
        ctx.admitted.observed = receipt;
        return undefined;
      },
      onReady: (receipt, assertRunning, refreshRunning, publishReady) =>
        publishAuthoredReady(
          {
            run: ctx.options.run,
            observe: (event) => observeHook(ctx.options, event),
            onReady: (value) => observedReady(ctx.options, value),
            payload: () => ctx.payload,
            admitted: ctx.admitted,
            hookOwner: ctx.hookOwner,
            assertHostReady: ctx.hostProcesses?.assertReady,
            phase: ctx.phase,
            inputs: ctx.inputs,
            admission: ctx.admission,
            remaining: ctx.remaining,
            published: ctx.published,
            stop: () => ctx.graph.abort(),
            stopped: ctx.stopped,
            endpoint: ctx.endpoint,
          },
          receipt,
          assertRunning,
          refreshRunning,
          publishReady
        ),
    });
  } catch (error) {
    failure = error;
  }
  ctx.hookOwner?.graphSettled();
  const retirement = {
    runtime: ctx.options.runtime,
    scope: ctx.options.scope,
    admission: ctx.admission,
    attempt: ctx.admitted,
  };
  if (ctx.hookOwner) {
    // Keep frontend bindings recoverable until every hook has known completion.
    await confirmRemoved(retirement);
    if (ctx.hostProcesses) {
      await ctx.hostProcesses.stop();
      await ctx.hostProcesses.close();
      ctx.hostRetired();
    }
    await ctx.hookOwner.graphRemoved();
    if (downBefore) {
      const result = await ctx.phase("down.after");
      try {
        requireHookSuccess(result);
      } catch (error) {
        failure ??= error;
      }
    }
    await ctx.hookOwner.retire();
    ctx.hookRetired();
  }
  await retireAttempt(retirement);
  ctx.removed();
  ctx.completeStop(failure === undefined);
  if (failure) {
    throw failure;
  }
  return code;
}

async function failedAdmission(opts: {
  readonly error: unknown;
  readonly options: Options;
  readonly stage: Stage;
  readonly outcome: Outcome;
  readonly source: NativeAuthoredProjectSource | undefined;
  readonly attempt: Attempt | undefined;
  readonly hookOwner: NativeAuthoredHookOwner | undefined;
  readonly nativeCode: string | undefined;
}): Promise<NativeAuthoredProjectStartError> {
  const { error, source, attempt, hookOwner } = opts;
  let outcome = await removeUnstartedSource(source, attempt, opts.outcome);
  let nativeCode = opts.nativeCode;
  if (hookOwner && !attempt) {
    try {
      await hookOwner.retire();
    } catch {
      outcome = "retained";
    }
  } else if (hookOwner) {
    outcome = "retained";
  }
  if (error instanceof NativeRuntimeRequestError) {
    nativeCode = error.nativeCode;
  } else if (
    outcome === "not-started" &&
    source === undefined &&
    attempt === undefined &&
    ((error instanceof NativeConfigCompilerError &&
      error.code === "E_NATIVE_PROJECT_UNSUPPORTED") ||
      error instanceof NativeComposeHostHookError)
  ) {
    nativeCode = "native_graph_subset";
  }
  return new NativeAuthoredProjectStartError({
    outcome,
    canceled: opts.options.signal?.aborted === true,
    nativeCode,
    stage: opts.stage,
    compilerCode: compilerDiagnostic(error),
  });
}

async function stopUnstartedHostProcesses(opts: {
  readonly processes: NativeAuthoredHostProcesses | undefined;
  readonly attempt: Attempt | undefined;
  readonly outcome: Outcome;
}): Promise<{
  readonly processes: NativeAuthoredHostProcesses | undefined;
  readonly outcome: Outcome;
}> {
  if (!opts.processes || opts.attempt) {
    return opts;
  }
  try {
    await opts.processes.stop();
    await opts.processes.close();
    return { processes: undefined, outcome: opts.outcome };
  } catch {
    return { processes: opts.processes, outcome: "retained" };
  }
}

/**
 * Native-source frontend owner. Hold shared input, exact startup intent
 * and authenticated foreground ownership through durable Removed retirement.
 * No Compose normalization, auto-recovery or implicit backend switch.
 */
export async function serveNativeAuthoredProject(
  input: Options
): Promise<number> {
  const opts: Options = {
    ...input,
    runtime: { binary: input.runtime.binary, home: input.runtime.home },
    scope: {
      projectRoot: input.scope.projectRoot,
      projectDir: input.scope.projectDir,
      nativeHome: input.scope.nativeHome,
      branch: input.scope.branch,
    },
    profiles: input.profiles === undefined ? undefined : [...input.profiles],
  };
  if (
    process.platform !== "darwin" ||
    !isAbsolute(opts.runtime.binary) ||
    opts.runtime.home !== opts.scope.nativeHome ||
    !RUN.test(opts.run) ||
    !Number.isSafeInteger(opts.startupTimeoutMs) ||
    opts.startupTimeoutMs < 1 ||
    opts.startupTimeoutMs > 300_000 ||
    opts.signal?.aborted ||
    opts.forceSignal?.aborted
  ) {
    throw new NativeAuthoredProjectStartError({
      outcome: "not-started",
      canceled: opts.signal?.aborted === true,
    });
  }
  const controller = new AbortController();
  const graphSignal = new AbortController();
  const hardSignal = new AbortController();
  let published = false;
  const deadline = performance.now() + opts.startupTimeoutMs;
  const remaining = () => {
    const time = Math.ceil(deadline - performance.now());
    if (controller.signal.aborted || time < 1) {
      throw new Error("Native startup expired or canceled; values omitted.");
    }
    return time;
  };
  const abort = () => {
    if (!published) {
      controller.abort();
    }
    graphSignal.abort();
  };
  const force = () => {
    hardSignal.abort();
    controller.abort();
    graphSignal.abort();
  };
  opts.forceSignal?.addEventListener("abort", force, { once: true });
  opts.signal?.addEventListener("abort", abort, { once: true });
  if (opts.signal?.aborted) {
    abort();
  }
  if (opts.forceSignal?.aborted) {
    force();
  }
  const timer = setTimeout(abort, remaining());
  let stage: Stage = "admission";
  try {
    const result = await withNativeAuthoredProjectAdmission(
      opts.scope,
      async (admission) => {
        let source: NativeAuthoredProjectSource | undefined;
        let attempt: Attempt | undefined;
        let payload: Buffer | undefined;
        let outcome: Outcome = "not-started";
        let nativeCode: string | undefined;
        let hookOwner: NativeAuthoredHookOwner | undefined;
        let hostProcesses: NativeAuthoredHostProcesses | undefined;
        let hookStop:
          | Awaited<ReturnType<typeof serveNativeHookStop>>
          | undefined;
        let stopCompleted: ((removed: boolean) => void) | undefined;
        const stopped = new Promise<boolean>((resolve) => {
          stopCompleted = resolve;
        });
        try {
          remaining();
          stage = "retained-state";
          if (
            (await admission.loadStart()) ||
            (await admission.hooksRetained()) ||
            (await loadNativeAuthoredProjectRun(opts.scope))
          ) {
            outcome = "retained";
            throw new Error(
              "Native startup evidence is retained; values omitted."
            );
          }
          stage = "inputs";
          const acquire = (signal: AbortSignal) =>
            acquireNativeExecutionInputs({
              projectRoot: opts.scope.projectRoot,
              profiles: opts.profiles,
              explicitOverlay: opts.overlay,
              compilerBranch: opts.scope.branch ?? undefined,
              signal,
            });
          let inputs = await acquire(controller.signal);
          const identity = hookSelection(inputs);
          const selectedHost = await prepareHostSelection({
            inputs: () => inputs,
            options: opts,
            admission,
            identity,
            signal: controller.signal,
            remaining,
          });
          const { hooks, persistent } = selectedHost;
          hookOwner = selectedHost.owner;
          hostProcesses = selectedHost.processes;
          const phase = hookPhaseRunner({
            owner: hookOwner,
            hooks,
            readInputs: () => inputs,
            setInputs: (value) => {
              inputs = value;
            },
            identity,
            acquire,
            admission,
            startup: controller.signal,
            hard: hardSignal.signal,
            remaining,
            projectRoot: opts.scope.projectRoot,
            hostProcesses: persistent,
            stage: (value) => {
              stage = HOOK_STAGES[value];
            },
            diagnostic: (error) => {
              const code = compilerDiagnostic(error);
              return code && COMPILER_CODES.has(code) ? code : undefined;
            },
            observe: (event) => observeHook(opts, event),
          });
          remaining();
          stage = "source";
          source = await admission.prepareSource({
            run: opts.run,
            metadata: inputs.metadata,
            profiles: opts.profiles,
            overlay: opts.overlay,
            hookPermit: await hookOwner?.permit({
              role: "preflight",
              semanticHash: inputs.result.semantic_hash,
              processes: await hostProcesses?.proof(false),
            }),
          });
          stage = "native-plan";
          const planned = await invokeNativeRuntime({
            runtime: opts.runtime,
            cwd: opts.scope.projectRoot,
            args: [
              "graph",
              "native",
              hookOwner ? "frontend-plan" : "plan",
              "--source-file",
              source.path,
              "--json",
            ],
            timeoutMs: remaining(),
            signal: controller.signal,
            boundNativeAuthoredReadDrain: true,
          });
          stage = "review";
          let review = matchingReview(planned, inputs, opts.run, opts.scope);
          if (hookOwner && hooks) {
            requireHookSuccess(await phase("up.before"));
            await source.remove();
            source = undefined;
            const semanticBefore = inputs.result.semantic_hash;
            inputs = await acquire(controller.signal);
            if (
              hookSelection(inputs) !== identity ||
              inputs.result.semantic_hash !== semanticBefore
            ) {
              throw new Error("Native hook source changed; values omitted.");
            }
            assertHostBindings(selectedHost, inputs);
            await hostProcesses?.start();
            source = await admission.prepareSource({
              run: opts.run,
              metadata: inputs.metadata,
              profiles: opts.profiles,
              overlay: opts.overlay,
              hookPermit: await hookOwner.permit({
                role: "execution",
                semanticHash: inputs.result.semantic_hash,
                processes: await hostProcesses?.proof(true),
              }),
            });
            review = matchingReview(
              await invokeNativeRuntime({
                runtime: opts.runtime,
                cwd: opts.scope.projectRoot,
                args: [
                  "graph",
                  "native",
                  "frontend-plan",
                  "--source-file",
                  source.path,
                  "--json",
                ],
                timeoutMs: remaining(),
                signal: controller.signal,
                boundNativeAuthoredReadDrain: true,
              }),
              inputs,
              opts.run,
              opts.scope
            );
          }
          stage = "source-freshness";
          await source.assertFresh();
          remaining();
          stage = "reservation";
          attempt = { source, start: await admission.reserve({ review }) };
          outcome = "retained";
          stage = "runtime";
          payload = await privateDelivery(inputs, review, remaining);
          await inputs.assertFresh();
          await source.assertFresh();
          await admission.assertHeld();
          await hostProcesses?.assertReady();
          const admitted = attempt;
          await hookOwner?.graphEntered();
          const code = await runPreparedLifecycle({
            options: opts,
            admitted,
            review,
            payload,
            inputs: () => inputs,
            hookOwner,
            hostProcesses,
            hostRetired: () => {
              hostProcesses = undefined;
            },
            phase,
            graph: graphSignal,
            hard: hardSignal,
            remaining,
            admission,
            stopped,
            completeStop: (value) => stopCompleted?.(value),
            endpoint: (value) => {
              hookStop = value;
            },
            published: () => {
              published = true;
              stage = "runtime";
              clearTimeout(timer);
            },
            removed: () => {
              outcome = "removed";
            },
            hookRetired: () => {
              hookOwner = undefined;
            },
            nativeCode: (value) => {
              nativeCode = value;
            },
          });
          return { ok: true as const, code };
        } catch (error) {
          const failedStage = stage;
          const host = await stopUnstartedHostProcesses({
            processes: hostProcesses,
            attempt,
            outcome,
          });
          hostProcesses = host.processes;
          outcome = host.outcome;
          stopCompleted?.(false);
          const failure = await failedAdmission({
            error,
            options: opts,
            stage: failedStage,
            source,
            attempt,
            outcome,
            nativeCode,
            hookOwner,
          });
          outcome = failure.outcome;
          return { ok: false as const, error: failure };
        } finally {
          payload?.fill(0);
          await hookStop?.close(outcome !== "removed");
          try {
            await hostProcesses?.close();
          } catch {
            /* retained durable owner, no replay */
          }
        }
      }
    );
    if (!result.ok) {
      throw result.error;
    }
    return result.code;
  } catch (error) {
    if (error instanceof NativeAuthoredProjectStartError) {
      throw error;
    }
    throw new NativeAuthoredProjectStartError({
      outcome: "retained",
      canceled: opts.signal?.aborted === true,
      stage,
    });
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", abort);
    opts.forceSignal?.removeEventListener("abort", force);
  }
}
