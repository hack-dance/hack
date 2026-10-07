import { isRecord } from "./guards.ts";
import {
  compileNativeConfig,
  NativeConfigCompilerError,
  type NativeConfigPlanResult,
  type NativeConfigResolveResult,
  planNativeConfig,
  resolveNativeConfig,
} from "./native-config-compiler.ts";
import {
  acquireNativeLocalInputs,
  acquireNativeProjectInput,
} from "./native-project-inputs.ts";
import { resolveProjectEnvMetadataForNativeSelection } from "./project-env-config.ts";

type NativeProjectSelection = {
  readonly startDir: string;
  readonly profiles?: readonly string[];
  readonly explicitOverlay?: string | null;
  readonly signal?: AbortSignal;
};

/** Offline project selection; local policy is read only after Rust validates it. */
export async function validateNativeProject(
  opts: NativeProjectSelection
): Promise<NativeConfigResolveResult> {
  return (await prepareNativeProject(opts)).result;
}

/** Explicit metadata inspection; this is binding completeness, not runtime admission. */
export async function planNativeProject(
  opts: NativeProjectSelection
): Promise<NativeConfigPlanResult> {
  const prepared = await prepareNativeProject({
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
  const result = await planNativeConfig({
    ...opts,
    input: prepared.input,
    ...prepared.locals,
    envMetadata: {
      metadata_version: 1,
      overlay: metadata.overlay,
      overlay_exists: metadata.overlayExists,
      workloads: Object.fromEntries(
        Object.keys(declared).map((name) => [
          name,
          metadata.effectiveMetadata[name] ?? {},
        ])
      ),
      inactive_scopes: metadata.unknownScopes,
      ...(metadata.hostMetadata === undefined
        ? {}
        : { host: metadata.hostMetadata }),
    },
  });
  if (
    result.ok &&
    (result.semantic_hash !== resolved.semantic_hash ||
      result.local_resolution.resolution_hash !==
        resolved.local_resolution.resolution_hash)
  ) {
    throw new NativeConfigCompilerError(
      "E_COMPILER_RESPONSE",
      "Native metadata planning changed the authored or local resolution identity."
    );
  }
  return result;
}

async function prepareNativeProject(
  opts: NativeProjectSelection & {
    readonly requireEnvPlanning?: boolean;
  }
) {
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
  });
  if (!compiled.ok) {
    const result: NativeConfigResolveResult = {
      ...compiled,
      diagnostics: compiled.diagnostics.map((diagnostic) => ({
        ...diagnostic,
        document: "project" as const,
      })),
    };
    return { ...project, result, locals: {} };
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
  const result = await resolveNativeConfig({
    input: project.input,
    ...locals,
    profiles: opts.profiles,
    explicitOverlay: opts.explicitOverlay,
    signal: opts.signal,
    requireEnvPlanning: opts.requireEnvPlanning,
    requireHostPlanning:
      opts.requireEnvPlanning && compiled.host_env_targets !== undefined,
  });
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
  return { ...project, result, locals };
}
