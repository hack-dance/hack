import { buildStaleNativeEnvWarning } from "../lib/compose-env-fingerprint.ts";
import {
  evaluateNativeServiceEnvFreshness,
  loadNativeEnvFingerprint,
  type NativeEnvSelection,
} from "../lib/native-env-fingerprint-state.ts";
import { acquireNativeExecutionInputs } from "../lib/native-execution-inputs.ts";
import {
  loadNativeAuthoredProjectRun,
  type NativeAuthoredProjectRunScope,
} from "./native-authored-project-run.ts";
import { selectNativeAuthoredManagedEnvironment } from "./native-authored-project-start.ts";
import { prepareNativeProjectInput } from "./native-project-input.ts";
import {
  loadNativeProjectRun,
  type NativeProjectRunScope,
} from "./native-project-run.ts";

/**
 * Advisory stale-env checks for native `hack exec` (HACK-1140).
 *
 * Each resolver compares the value-free record the foreground up/restart
 * wrote for the current run with the env selection resolved now, and returns
 * a closed warning naming the service, or null. Null covers unchanged env, no
 * record, a record from another run, and any failure: the check never refuses
 * exec and never reports a key or value. Resolution runs only when a record
 * for the current run exists.
 */

/**
 * Native image project: the selection is the Compose-file env resolved for
 * the run's recorded env name, before adaptation, AWS or runtime metadata,
 * exactly as startup digested it. Native exec delivers freshly resolved values
 * to the exec itself, so the warning is about the running service.
 */
export async function resolveNativeImageExecStaleEnvWarning(opts: {
  readonly scope: NativeProjectRunScope;
  readonly service: string;
  readonly composeFile: string;
  readonly loadRun?: typeof loadNativeProjectRun;
  readonly prepare?: typeof prepareNativeProjectInput;
}): Promise<string | null> {
  try {
    const entry = await loadNativeEnvFingerprint({
      projectDir: opts.scope.projectDir,
      owner: "image",
      branch: opts.scope.branch,
    });
    if (!entry) {
      return null;
    }
    const mapping = await (opts.loadRun ?? loadNativeProjectRun)(opts.scope);
    if (
      !mapping ||
      mapping.run !== entry.run ||
      mapping.effectiveEnvName === undefined
    ) {
      return null;
    }
    const input = await (opts.prepare ?? prepareNativeProjectInput)({
      projectRoot: opts.scope.projectRoot,
      projectDir: opts.scope.projectDir,
      composeFile: opts.composeFile,
      envName: mapping.effectiveEnvName,
    });
    if (input.effectiveEnvName !== mapping.effectiveEnvName) {
      return null;
    }
    const freshness = evaluateNativeServiceEnvFreshness({
      entry,
      run: mapping.run,
      service: opts.service,
      currentEnv: input.managedEnvironment[opts.service] ?? {},
    });
    return freshness === "changed"
      ? buildStaleNativeEnvWarning({ service: opts.service, exec: "fresh" })
      : null;
  } catch {
    return null;
  }
}

/** The run id of the authored scope's published ready run, or null. */
async function currentAuthoredRun(
  scope: NativeAuthoredProjectRunScope
): Promise<string | null> {
  const ready = await loadNativeAuthoredProjectRun(scope);
  return ready?.record.receipt.review.provenance.run ?? null;
}

/**
 * The managed selection an authored startup with `selection` would deliver
 * now: fresh input acquisition, then the same projection startup digests.
 */
async function resolveAuthoredEnvironment(opts: {
  readonly scope: NativeAuthoredProjectRunScope;
  readonly selection: NativeEnvSelection;
  readonly signal?: AbortSignal;
}): Promise<Readonly<Record<string, Readonly<Record<string, string>>>>> {
  const inputs = await acquireNativeExecutionInputs({
    projectRoot: opts.scope.projectRoot,
    ...(opts.selection.profiles === undefined
      ? {}
      : { profiles: opts.selection.profiles }),
    ...(opts.selection.overlay === undefined
      ? {}
      : { explicitOverlay: opts.selection.overlay }),
    compilerBranch: opts.scope.branch ?? undefined,
    signal: opts.signal,
  });
  return selectNativeAuthoredManagedEnvironment({
    environmentPlan: inputs.result.environment_plan,
    values: await inputs.resolveManagedValues(),
  });
}

/**
 * Authored native project: the selection is the compiler-selected managed
 * values delivered at startup, resolved again with the recorded env and
 * profile selectors. Authored exec runs through the live owner with the env
 * the service started with.
 */
export async function resolveNativeAuthoredExecStaleEnvWarning(opts: {
  readonly scope: NativeAuthoredProjectRunScope;
  readonly service: string;
  readonly signal?: AbortSignal;
  readonly currentRun?: typeof currentAuthoredRun;
  readonly resolveEnvironment?: typeof resolveAuthoredEnvironment;
}): Promise<string | null> {
  try {
    const entry = await loadNativeEnvFingerprint({
      projectDir: opts.scope.projectDir,
      owner: "authored",
      branch: opts.scope.branch,
    });
    if (!entry) {
      return null;
    }
    const run = await (opts.currentRun ?? currentAuthoredRun)(opts.scope);
    if (run === null || run !== entry.run) {
      return null;
    }
    const environment = await (
      opts.resolveEnvironment ?? resolveAuthoredEnvironment
    )({ scope: opts.scope, selection: entry.selection, signal: opts.signal });
    const freshness = evaluateNativeServiceEnvFreshness({
      entry,
      run,
      service: opts.service,
      currentEnv: environment[opts.service] ?? {},
    });
    return freshness === "changed"
      ? buildStaleNativeEnvWarning({ service: opts.service, exec: "started" })
      : null;
  } catch {
    return null;
  }
}
