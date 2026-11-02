import { resolveNativeImageExecStaleEnvWarning } from "../backends/native-exec-stale-env.ts";
import { nativeProjectExec } from "../backends/native-project-exec.ts";
import type { NativeProjectRunScope } from "../backends/native-project-run.ts";
import type { NativeRuntimeSelection } from "../backends/native-runtime-client.ts";

/**
 * The native branch of `hack exec`: one bounded noninteractive command through the
 * selected runtime. Captured output is passed through as returned, with a fixed
 * truncation notice on stderr; the command's exit code is the result.
 *
 * An advisory value-free check (HACK-1140) warns on stderr, ahead of the
 * captured output, when the service's env selection changed since its run
 * started. The check never refuses or changes the exec.
 */
export async function runNativeProjectExec(input: {
  readonly runtime: NativeRuntimeSelection;
  readonly scope: NativeProjectRunScope;
  readonly service: string | undefined;
  readonly argv: readonly string[];
  readonly workdir: string | undefined;
  readonly composeFile: string;
  /** Seams for unit tests; the CLI always uses the real owners. */
  readonly exec?: typeof nativeProjectExec;
  readonly staleEnv?: typeof resolveNativeImageExecStaleEnvWarning;
}): Promise<number> {
  const service = input.service ?? "";
  const result = await (input.exec ?? nativeProjectExec)({
    runtime: input.runtime,
    scope: input.scope,
    service,
    argv: input.argv,
    workdir: input.workdir,
    composeFile: input.composeFile,
  });
  // Checked after the exec is admitted, so a refused request resolves no env.
  // Output is captured, so the warning still precedes it.
  const warning = await (
    input.staleEnv ?? resolveNativeImageExecStaleEnvWarning
  )({
    scope: input.scope,
    service,
    composeFile: input.composeFile,
  }).catch(() => null);
  if (warning) {
    process.stderr.write(`WARNING: ${warning}\n`);
  }
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.truncated) {
    process.stderr.write("Native exec output was truncated.\n");
  }
  return result.exitCode;
}
