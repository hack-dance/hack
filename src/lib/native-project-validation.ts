import { isRecord } from "./guards.ts";
import {
  compileNativeConfig,
  NativeConfigCompilerError,
  type NativeConfigResolveResult,
  resolveNativeConfig,
} from "./native-config-compiler.ts";
import {
  acquireNativeLocalInputs,
  acquireNativeProjectInput,
} from "./native-project-inputs.ts";

/** Offline project selection; local policy is read only after Rust validates it. */
export async function validateNativeProject(opts: {
  readonly startDir: string;
  readonly profiles?: readonly string[];
  readonly explicitOverlay?: string | null;
  readonly signal?: AbortSignal;
}): Promise<NativeConfigResolveResult> {
  const project = await acquireNativeProjectInput({
    startDir: opts.startDir,
    signal: opts.signal,
  });
  const compiled = await compileNativeConfig({
    input: project.input,
    profiles: opts.profiles,
    signal: opts.signal,
    requireLocalResolution: true,
  });
  if (!compiled.ok) {
    return {
      ...compiled,
      diagnostics: compiled.diagnostics.map((diagnostic) => ({
        ...diagnostic,
        document: "project" as const,
      })),
    };
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
  return await resolveNativeConfig({
    input: project.input,
    ...locals,
    profiles: opts.profiles,
    explicitOverlay: opts.explicitOverlay,
    signal: opts.signal,
  });
}
