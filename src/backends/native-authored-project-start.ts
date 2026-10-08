import { isAbsolute } from "node:path";
import { acquireNativeExecutionInputs } from "../lib/native-execution-inputs.ts";
import {
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

/** Fixed diagnostics only; neither values nor arbitrary child/callback errors escape. */
export class NativeAuthoredProjectStartError extends Error {
  readonly outcome: Outcome;
  readonly canceled: boolean;
  readonly nativeCode?: string;

  constructor(opts: {
    readonly outcome: Outcome;
    readonly canceled: boolean;
    readonly nativeCode?: string;
  }) {
    const nativeCode =
      opts.nativeCode && CODE.test(opts.nativeCode)
        ? opts.nativeCode
        : undefined;
    const detail = {
      "not-started": "no native consumer was started",
      removed: "exact native cleanup was confirmed",
      retained:
        "startup evidence is retained; inspect owned state before retrying",
    }[opts.outcome];
    super(
      `Native authored startup failed${nativeCode ? ` (${nativeCode})` : ""}; ${detail}. Values omitted.`
    );
    this.outcome = opts.outcome;
    this.canceled = opts.canceled;
    this.nativeCode = nativeCode;
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

function matchingReview(value: unknown, inputs: Inputs, run: string) {
  const review = parseNativeAuthoredReview(value);
  if (
    review.provenance.run !== run ||
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
    admitted: attempt.ready?.record.receipt,
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
 * Inactive native-source frontend owner. Hold shared input, exact startup intent
 * and authenticated foreground ownership through durable Removed retirement.
 * No Compose normalization, auto-recovery, backend switch or ordinary CLI activation.
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
          if (
            (await admission.loadStart()) ||
            (await loadNativeAuthoredProjectRun(opts.scope))
          ) {
            outcome = "retained";
            throw new Error(
              "Native startup evidence is retained; values omitted."
            );
          }
          const inputs = await acquireNativeExecutionInputs({
            projectRoot: opts.scope.projectRoot,
            profiles: opts.profiles,
            explicitOverlay: opts.overlay,
            compilerBranch: opts.scope.branch ?? undefined,
            signal: controller.signal,
          });
          remaining();
          source = await admission.prepareSource({
            run: opts.run,
            metadata: inputs.metadata,
            profiles: opts.profiles,
            overlay: opts.overlay,
          });
          const review = matchingReview(
            await invokeNativeRuntime({
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
            }),
            inputs,
            opts.run
          );
          await source.assertFresh();
          remaining();
          attempt = { source, start: await admission.reserve({ review }) };
          outcome = "retained";
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
              onReady: async (receipt, assertRunning) => {
                payload?.fill(0);
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
          outcome = await removeUnstartedSource(source, attempt, outcome);
          if (error instanceof NativeRuntimeRequestError) {
            nativeCode = error.nativeCode;
          }
          return {
            ok: false as const,
            error: new NativeAuthoredProjectStartError({
              outcome,
              canceled: opts.signal?.aborted === true,
              nativeCode,
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
    });
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", abort);
  }
}
