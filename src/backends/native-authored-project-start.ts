import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { NativeConfigCompilerError } from "../lib/native-config-compiler.ts";
import { acquireNativeExecutionInputs } from "../lib/native-execution-inputs.ts";
import {
  type NativeAuthoredReceipt,
  type NativeAuthoredReview,
  parseNativeAuthoredReview,
  parseNativeAuthoredSnapshot,
} from "./native-authored-graph-protocol.ts";
import {
  loadNativeAuthoredProjectRun,
  type NativeAuthoredProjectAdmission,
  type NativeAuthoredProjectRunScope,
  type NativeAuthoredProjectRunSelection,
  type NativeAuthoredProjectSource,
  type NativeAuthoredProjectStartSelection,
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
  /** Observation after publication; the immutable selection grants no runtime authority. */
  readonly onReady?: (
    selection: NativeAuthoredProjectRunSelection
  ) => undefined;
  readonly onExitDiagnostic?: (diagnostic: NativeExitDiagnostic) => void;
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

type Attempt = {
  readonly source: NativeAuthoredProjectSource;
  readonly start: NativeAuthoredProjectStartSelection;
  /** First parsed runtime membership; observation alone grants no ready authority. */
  observed?: NativeAuthoredReceipt;
  ready?: NativeAuthoredProjectRunSelection;
};
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

async function retireAttempt(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly scope: NativeAuthoredProjectRunScope;
  readonly admission: NativeAuthoredProjectAdmission;
  readonly attempt: Attempt;
}): Promise<void> {
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
  await opts.admission.retire({
    expectedStart: attempt.start,
    expectedRun: attempt.ready,
    cleaned: snapshot.receipt,
  });
  await attempt.source.remove();
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
    opts.signal?.aborted
  ) {
    throw new NativeAuthoredProjectStartError({
      outcome: "not-started",
      canceled: opts.signal?.aborted === true,
    });
  }
  const controller = new AbortController();
  const deadline = performance.now() + opts.startupTimeoutMs;
  const remaining = () => {
    const time = Math.ceil(deadline - performance.now());
    if (controller.signal.aborted || time < 1) {
      throw new Error("Native startup expired or canceled; values omitted.");
    }
    return time;
  };
  const abort = () => controller.abort();
  opts.signal?.addEventListener("abort", abort, { once: true });
  if (opts.signal?.aborted) {
    abort();
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
        try {
          remaining();
          stage = "retained-state";
          if (
            (await admission.loadStart()) ||
            (await loadNativeAuthoredProjectRun(opts.scope))
          ) {
            outcome = "retained";
            throw new Error(
              "Native startup evidence is retained; values omitted."
            );
          }
          stage = "inputs";
          const inputs = await acquireNativeExecutionInputs({
            projectRoot: opts.scope.projectRoot,
            profiles: opts.profiles,
            explicitOverlay: opts.overlay,
            compilerBranch: opts.scope.branch ?? undefined,
            signal: controller.signal,
          });
          remaining();
          stage = "source";
          source = await admission.prepareSource({
            run: opts.run,
            metadata: inputs.metadata,
            profiles: opts.profiles,
            overlay: opts.overlay,
          });
          stage = "native-plan";
          const planned = await invokeNativeRuntime({
            runtime: opts.runtime,
            cwd: opts.scope.projectRoot,
            args: [
              "graph",
              "native",
              "plan",
              "--source-file",
              source.path,
              "--json",
            ],
            timeoutMs: remaining(),
            signal: controller.signal,
            boundNativeAuthoredReadDrain: true,
          });
          stage = "review";
          const review = matchingReview(planned, inputs, opts.run, opts.scope);
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
          const admitted = attempt;
          let failure: unknown;
          let code = 1;
          try {
            code = await serveNativeAuthoredProjectGraph({
              runtime: opts.runtime,
              projectRoot: opts.scope.projectRoot,
              run: opts.run,
              sourceFile: source.path,
              review,
              privateInput: payload,
              startupTimeoutMs: remaining(),
              signal: controller.signal,
              onExitDiagnostic: (diagnostic) => {
                nativeCode = diagnostic.nativeCode;
                const observed: unknown = opts.onExitDiagnostic?.(diagnostic);
                void Promise.resolve(observed).catch(() => undefined);
              },
              onReceipt: (receipt) => {
                freeze(receipt);
                admitted.observed = receipt;
                return undefined;
              },
              onReady: async (receipt, assertRunning) => {
                payload?.fill(0);
                if (!admitted.observed) {
                  throw new Error(
                    "Native runtime membership is unobserved; values omitted."
                  );
                }
                await inputs.assertFresh();
                await admitted.source.assertFresh();
                await admission.assertHeld();
                admitted.ready = await admission.publish({
                  expectedStart: admitted.start,
                  record: {
                    version: 2,
                    kind: "native-authored-project-run",
                    receipt,
                  },
                  assertReady: () => {
                    remaining();
                    assertRunning();
                    return undefined;
                  },
                });
                freeze(admitted.ready);
                clearTimeout(timer);
                observedReady(opts, admitted.ready);
              },
            });
          } catch (error) {
            failure = error;
          }
          await retireAttempt({
            runtime: opts.runtime,
            scope: opts.scope,
            admission,
            attempt: admitted,
          });
          outcome = "removed";
          if (failure) {
            throw failure;
          }
          return { ok: true as const, code };
        } catch (error) {
          // Capture only closed owning stages/codes before cleanup can fail.
          const failedStage = stage;
          const compilerCode = compilerDiagnostic(error);
          outcome = await removeUnstartedSource(source, attempt, outcome);
          if (error instanceof NativeRuntimeRequestError) {
            nativeCode = error.nativeCode;
          } else if (
            outcome === "not-started" &&
            source === undefined &&
            attempt === undefined &&
            error instanceof NativeConfigCompilerError &&
            error.code === "E_NATIVE_PROJECT_UNSUPPORTED"
          ) {
            // Preserve only the typed pre-attempt capability refusal, never its diagnostics.
            nativeCode = "native_graph_subset";
          }
          return {
            ok: false as const,
            error: new NativeAuthoredProjectStartError({
              outcome,
              canceled: opts.signal?.aborted === true,
              nativeCode,
              stage: failedStage,
              compilerCode,
            }),
          };
        } finally {
          payload?.fill(0);
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
  }
}
