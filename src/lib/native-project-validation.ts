import { isRecord } from "./guards.ts";
import {
  compileNativeConfig,
  NativeConfigCompilerError,
  type NativeConfigPlanResult,
  type NativeConfigResolveResult,
  planNativeConfig,
  resolveNativeConfig,
} from "./native-config-compiler.ts";
import { nativeEndpointPlanningRequired } from "./native-endpoint-plan-protocol.ts";
import type {
  NativeDeclaredWorkloads,
  NativeEnvMetadata,
} from "./native-env-plan-protocol.ts";
import {
  acquireNativeLocalInputs,
  acquireNativeProjectInput,
} from "./native-project-inputs.ts";
import { acquireNativeGlobalDomain } from "./native-routing-inputs.ts";
import {
  type NativeProjectEnvMetadata,
  resolveProjectEnvMetadataForNativeSelection,
} from "./project-env-config.ts";
import { resolveVerifiedNativeBranch } from "./worktree-local-config.ts";

export type NativeProjectSelection = {
  readonly startDir: string;
  readonly profiles?: readonly string[];
  readonly explicitOverlay?: string | null;
  readonly explicitDomain?: string;
  readonly signal?: AbortSignal;
};

/** Offline project selection; local policy is read only after Rust validates it. */
export async function validateNativeProject(
  opts: NativeProjectSelection
): Promise<NativeConfigResolveResult> {
  return (await prepareNativeProjectSelection(opts)).result;
}

/** Explicit metadata inspection; this is binding completeness, not runtime admission. */
export async function planNativeProject(
  opts: NativeProjectSelection
): Promise<NativeConfigPlanResult> {
  const prepared = await prepareNativeProjectSelection({
    ...opts,
    requireEnvPlanning: true,
  });
  const resolved = prepared.result;
  if (!resolved.ok) {
    return resolved;
  }
  const declared = resolved.declared_workloads;
  if (!declared) {
    throw new NativeConfigCompilerError(
      "E_COMPILER_RESPONSE",
      "Native compiler omitted the declared workload namespace."
    );
  }
  let metadata: Awaited<
    ReturnType<typeof resolveProjectEnvMetadataForNativeSelection>
  >;
  try {
    metadata = await resolveProjectEnvMetadataForNativeSelection({
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
      signal: opts.signal,
    });
  } catch (error: unknown) {
    if (error instanceof NativeConfigCompilerError) {
      throw error;
    }
    throw new NativeConfigCompilerError(
      "E_CONFIG_METADATA",
      "Cannot inspect selected managed environment metadata; values omitted."
    );
  }
  return await planPreparedNativeProject({
    prepared,
    metadata,
    signal: opts.signal,
  });
}

/** Private execution preparation may plan metadata from its same owned value acquisition. */
export async function planPreparedNativeProject(opts: {
  readonly prepared: NativePreparedProject;
  readonly metadata: NativeProjectEnvMetadata;
  readonly signal?: AbortSignal;
}): Promise<NativeConfigPlanResult> {
  const { prepared, metadata } = opts;
  const resolved = prepared.result;
  if (!resolved.ok) {
    return resolved;
  }
  const declared = resolved.declared_workloads;
  if (!declared) {
    throw new NativeConfigCompilerError(
      "E_COMPILER_RESPONSE",
      "Native compiler omitted the declared workload namespace."
    );
  }
  const result = await planNativeConfig({
    ...prepared.selection,
    signal: opts.signal,
    input: prepared.input,
    ...prepared.locals,
    ...prepared.routingInputs,
    envMetadata: nativeEnvironmentMetadata({
      metadata,
      declaredWorkloads: declared,
    }),
  });
  if (
    result.ok &&
    (result.semantic_hash !== resolved.semantic_hash ||
      result.local_resolution.resolution_hash !==
        resolved.local_resolution.resolution_hash ||
      JSON.stringify(result.routing_resolution) !==
        JSON.stringify(resolved.routing_resolution) ||
      JSON.stringify(result.host_binding_resolution) !==
        JSON.stringify(resolved.host_binding_resolution))
  ) {
    throw new NativeConfigCompilerError(
      "E_COMPILER_RESPONSE",
      "Native metadata planning changed the authored or local resolution identity."
    );
  }
  return result;
}

/** Public metadata projection shared by compiler planning and native source transport; never values. */
export function nativeEnvironmentMetadata(opts: {
  readonly metadata: NativeProjectEnvMetadata;
  readonly declaredWorkloads: NativeDeclaredWorkloads;
}): NativeEnvMetadata {
  const { metadata, declaredWorkloads } = opts;
  return {
    metadata_version: 1,
    overlay: metadata.overlay,
    overlay_exists: metadata.overlayExists,
    workloads: Object.fromEntries(
      Object.keys(declaredWorkloads).map((name) => [
        name,
        metadata.effectiveMetadata[name] ?? {},
      ])
    ),
    inactive_scopes: metadata.unknownScopes,
    ...(metadata.hostMetadata === undefined
      ? {}
      : { host: metadata.hostMetadata }),
  };
}

export type NativePreparedProject = Awaited<
  ReturnType<typeof prepareNativeProjectSelection>
>;

/** Raw selected inputs remain private; this is not a runtime admission or public report. */
export async function prepareNativeProjectSelection(
  inputOpts: NativeProjectSelection & {
    readonly requireEnvPlanning?: boolean;
  }
) {
  const selection = {
    ...inputOpts,
    ...(inputOpts.profiles === undefined
      ? {}
      : { profiles: [...inputOpts.profiles] }),
  };
  const opts = selection;
  const project = await acquireNativeProjectInput({
    startDir: opts.startDir,
    signal: opts.signal,
  });
  const compiled = await compileNativeConfig({
    input: project.input,
    profiles: opts.profiles,
    signal: opts.signal,
    requireLocalResolution: true,
    requireEnvPlanning: opts.requireEnvPlanning,
    requireRoutingPlanning: opts.explicitDomain !== undefined,
  });
  if (!compiled.ok) {
    const result: NativeConfigResolveResult = {
      ...compiled,
      diagnostics: compiled.diagnostics.map((diagnostic) => ({
        ...diagnostic,
        document: "project" as const,
      })),
    };
    return { ...project, selection, result, locals: {}, routingInputs: {} };
  }
  const worktree = compiled.plan.worktree;
  if (!isRecord(worktree) || typeof worktree.inherit_local !== "boolean") {
    throw new NativeConfigCompilerError(
      "E_COMPILER_RESPONSE",
      "Native configuration compiler returned invalid worktree policy."
    );
  }
  const locals = await acquireNativeLocalInputs({
    projectRoot: project.projectRoot,
    inheritLocal: worktree.inherit_local,
    signal: opts.signal,
  });
  const resolveInputs = {
    input: project.input,
    ...locals,
    profiles: opts.profiles,
    explicitOverlay: opts.explicitOverlay,
    explicitDomain: opts.explicitDomain,
    signal: opts.signal,
    requireEnvPlanning: opts.requireEnvPlanning,
    requireHostPlanning:
      opts.requireEnvPlanning && compiled.host_env_targets !== undefined,
    requireRoutingPlanning:
      opts.explicitDomain !== undefined ||
      Object.hasOwn(compiled.plan, "routes") ||
      Object.hasOwn(compiled.plan, "open"),
    requireEndpointPlanning: nativeEndpointPlanningRequired(compiled.plan),
  };
  const checkResolvedIdentity = (result: NativeConfigResolveResult) => {
    if (
      result.ok &&
      (result.semantic_hash !== compiled.semantic_hash ||
        JSON.stringify(result.host_env_targets) !==
          JSON.stringify(compiled.host_env_targets))
    ) {
      throw new NativeConfigCompilerError(
        "E_COMPILER_RESPONSE",
        "Native local resolution changed the authored identity or host targets."
      );
    }
  };
  let result = await resolveNativeConfig({
    ...resolveInputs,
    probeRoutingInputs: true,
  });
  checkResolvedIdentity(result);
  let routingInputs: {
    readonly globalDomain?: string;
    readonly branch?: string;
  } = {};
  if (result.ok && result.routing_inputs_required === true) {
    routingInputs = {
      globalDomain: await acquireNativeGlobalDomain({ signal: opts.signal }),
      branch: await resolveVerifiedNativeBranch({
        projectRoot: project.projectRoot,
        autoBranch: result.local_resolution.auto_branch,
        signal: opts.signal,
      }),
    };
    result = await resolveNativeConfig({
      ...resolveInputs,
      ...routingInputs,
      requireRoutingPlanning: true,
    });
  }
  checkResolvedIdentity(result);
  return { ...project, selection, result, locals, routingInputs };
}
