import { ClosedCliError } from "../lib/cli-result.ts";
import { isRecord } from "../lib/guards.ts";
import {
  type NativeProjectInput,
  requireNativeShellDeliveryFits,
  selectActiveNativeProjectInput,
} from "./native-project-input.ts";
import { withNativeProjectReview } from "./native-project-review.ts";
import {
  invokeNativeRuntime,
  NativeRuntimeRequestError,
  type NativeRuntimeSelection,
  nativeFailureNote,
} from "./native-runtime-client.ts";
import { readNativeStartRefusals } from "./native-start-refusals.ts";

/**
 * Judge the adapted Compose input before hooks, image acquisition or VM boot.
 * This review grants no runtime or retained-run authority. Startup repeats its
 * review after pinning images; neither review substitutes for effect-time checks.
 */
export async function requireNativeStaticStartReview(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly projectRoot: string;
  readonly composeFile: string;
  readonly input: NativeProjectInput;
  readonly profiles: readonly string[];
  readonly branch?: string | null;
  /** Retained branch identity is selected later under its existing restore proof. */
  readonly deferredRestore?: boolean;
  readonly buildServices: ReadonlySet<string>;
  readonly invoke?: typeof invokeNativeRuntime;
  readonly signal?: AbortSignal;
}): Promise<void> {
  const invoke = opts.invoke ?? invokeNativeRuntime;
  const compose: unknown = JSON.parse(opts.input.normalizedComposeJson);
  if (!(isRecord(compose) && isRecord(compose.services))) {
    throw new ClosedCliError("Native static start input is invalid.");
  }
  for (const service of opts.buildServices) {
    const spec = compose.services[service];
    if (isRecord(spec)) {
      // Pure build admission already passed. A sentinel lets file-local checks
      // review this service before its real image exists; it is never started.
      spec.image = `sha256:${"0".repeat(64)}`;
      Reflect.deleteProperty(spec, "build");
    }
  }
  await withNativeProjectReview({
    ...opts,
    branch: opts.deferredRestore ? undefined : opts.branch,
    input: { ...opts.input, normalizedComposeJson: JSON.stringify(compose) },
    invoke: (request) => invoke({ ...request, signal: opts.signal }),
    run: ({ report }) => {
      const plan = report.plan;
      if (!(isRecord(plan) && isRecord(plan.services))) {
        throw new ClosedCliError("Native static start review is invalid.");
      }
      requireNativeShellDeliveryFits(
        selectActiveNativeProjectInput({
          input: opts.input,
          reviewedPlan: plan,
        })
      );
      const services = Object.keys(plan.services);
      const refusals = readNativeStartRefusals(report.start_refusals, services);
      if (refusals === null) {
        throw new ClosedCliError(
          "Native static start review is unavailable; update the selected native runtime and run hack doctor --native-preflight. No VM was started."
        );
      }
      const first = refusals[0];
      if (first) {
        throw new NativeRuntimeRequestError({
          message: `Native static start review refused (${first.code}); no VM was started.${nativeFailureNote(first)} Run hack doctor --native-preflight to list every static blocker.`,
          nativeCode: first.code,
          nativeMessage: first.message,
          nativeService: first.service,
          nativeStartupPhase: "static-preflight",
        });
      }
      if (plan.enrollment_compatible !== true) {
        throw new ClosedCliError(
          "Native static start review does not admit this configuration; run hack doctor --native-preflight for its blockers. No VM was started."
        );
      }
      return Promise.resolve();
    },
  });
}
