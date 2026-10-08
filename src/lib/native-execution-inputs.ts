import { createHash } from "node:crypto";
import { NativeConfigCompilerError } from "./native-config-compiler.ts";
import {
  type NativePreparedProject,
  type NativeProjectSelection,
  nativeEnvironmentMetadata,
  planPreparedNativeProject,
  prepareNativeProjectSelection,
} from "./native-project-validation.ts";
import {
  acquireProjectEnvForNativeExecution,
  type NativeProjectEnvSelectionOptions,
  selectProjectEnvValuesForNativeExecutionTarget,
} from "./project-env-config.ts";

function refused(): never {
  throw new NativeConfigCompilerError(
    "E_CONFIG_INVALID",
    "Native execution inputs are invalid or changed; prepare a fresh generation. Values omitted."
  );
}

function freezePlan(value: unknown): void {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) {
      freezePlan(child);
    }
    Object.freeze(value);
  }
}

/** Private receipt fingerprint. Managed env fingerprints remain inside their owner. */
function sourceRevision(prepared: NativePreparedProject): string {
  const digest = createHash("sha256");
  const add = (name: string, bytes: Uint8Array | undefined) => {
    digest.update(name);
    digest.update(bytes === undefined ? "absent" : `${bytes.byteLength}:`);
    if (bytes !== undefined) {
      digest.update(bytes);
    }
  };
  add("project", prepared.input);
  add("primary-local", prepared.locals.primaryLocal);
  add("checkout-local", prepared.locals.checkoutLocal);
  digest.update(
    JSON.stringify({
      projectRoot: prepared.projectRoot,
      profiles: [...(prepared.selection.profiles ?? [])].sort(),
      explicitOverlay: prepared.selection.explicitOverlay,
      explicitDomain: prepared.selection.explicitDomain,
      routing: prepared.routingInputs,
      result: prepared.result.ok
        ? {
            semantic: prepared.result.semantic_hash,
            local: prepared.result.local_resolution,
            routing: prepared.result.routing_resolution,
            hosts: prepared.result.host_binding_resolution,
          }
        : null,
    })
  );
  return digest.digest("hex");
}

/**
 * Private preparation shared by native consumers. The same bounded env acquisition
 * supplies metadata and values. Neither values nor source revision belong in a
 * CLI report or engine labels. Rechecking detects changes; it does not freeze
 * unrelated editors or provide an atomic snapshot across files.
 */
export async function acquireNativeExecutionInputs(opts: {
  readonly projectRoot: string;
  readonly profiles?: readonly string[];
  readonly explicitOverlay?: string | null;
  readonly explicitDomain?: string;
  readonly signal?: AbortSignal;
}) {
  const projectRoot = opts.projectRoot;
  const signal = opts.signal;
  const selection: NativeProjectSelection = {
    startDir: projectRoot,
    ...(opts.profiles === undefined ? {} : { profiles: [...opts.profiles] }),
    explicitOverlay: opts.explicitOverlay,
    explicitDomain: opts.explicitDomain,
    signal,
  };
  const prepare = () =>
    prepareNativeProjectSelection({ ...selection, requireEnvPlanning: true });
  const prepared = await prepare();
  if (prepared.projectRoot !== projectRoot || !prepared.result.ok) {
    return refused();
  }
  const resolved = prepared.result;
  const declared = resolved.declared_workloads;
  if (!declared) {
    return refused();
  }
  const envSelection: NativeProjectEnvSelectionOptions = {
    projectRoot: prepared.projectRoot,
    overlay: resolved.local_resolution.overlay,
    inheritLocal: resolved.local_resolution.inherit_local,
    declaredWorkloadNames: Object.keys(declared),
    ...(resolved.host_env_targets === undefined
      ? {}
      : {
          hostTargets: {
            includeDefault: resolved.host_env_targets.include_default,
            workloadNames: resolved.host_env_targets.workloads,
          },
        }),
    signal,
  };
  const env = await acquireProjectEnvForNativeExecution(envSelection);
  const metadata = nativeEnvironmentMetadata({
    metadata: env.metadata,
    declaredWorkloads: declared,
  });
  freezePlan(metadata);
  const planned = await planPreparedNativeProject({
    prepared,
    metadata: env.metadata,
    signal,
  });
  if (!(planned.ok && planned.environment_plan.complete)) {
    return refused();
  }
  const selectedWorkloads = Object.keys(planned.environment_plan.workloads);
  freezePlan(planned);
  const revision = sourceRevision(prepared);
  const assertFresh = async () => {
    const current = await prepare();
    if (
      current.projectRoot !== prepared.projectRoot ||
      !current.result.ok ||
      sourceRevision(current) !== revision
    ) {
      return refused();
    }
    await env.assertFresh(envSelection);
  };
  await assertFresh();
  const resolveManagedValues = async () => {
    const values = await env.resolveValues({ signal });
    await assertFresh();
    return Object.fromEntries(
      selectedWorkloads.map((name) => {
        const selected = values.workloadEnv[name];
        if (selected === undefined) {
          return refused();
        }
        return [name, selected];
      })
    );
  };
  const resolveHostValues = async (name: string) => {
    const reports = planned.environment_plan.host;
    if (!(reports && Object.hasOwn(reports, name))) {
      return refused();
    }
    const report = reports[name];
    if (!report) {
      return refused();
    }
    const values = await env.resolveValues({ signal });
    await assertFresh();
    return selectProjectEnvValuesForNativeExecutionTarget({
      resolved: values,
      target: "host",
      workloadName:
        report.env_target.kind === "workload" ? report.env_target.name : null,
    });
  };
  // Symbolic planning is serializable; private execution receipts and delivery
  // capabilities are deliberately absent from JSON/spread/public diagnostics.
  return Object.freeze(
    Object.defineProperties(
      { result: planned } as {
        readonly result: typeof planned;
        readonly metadata: typeof metadata;
        readonly inputRevision: string;
        readonly assertFresh: typeof assertFresh;
        readonly resolveManagedValues: typeof resolveManagedValues;
        readonly resolveHostValues: typeof resolveHostValues;
      },
      {
        metadata: { value: metadata },
        inputRevision: { value: revision },
        assertFresh: { value: assertFresh },
        resolveManagedValues: { value: resolveManagedValues },
        resolveHostValues: { value: resolveHostValues },
      }
    )
  );
}
