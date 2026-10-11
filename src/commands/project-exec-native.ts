import { nativeProjectExec } from "../backends/native-project-exec.ts";
import type { NativeProjectRunScope } from "../backends/native-project-run.ts";
import type { NativeRuntimeSelection } from "../backends/native-runtime-client.ts";

/**
 * The native branch of `hack exec`: one bounded noninteractive command through the
 * selected runtime. Captured output is passed through as returned, with a fixed
 * truncation notice on stderr; the command's exit code is the result.
 */
export async function runNativeProjectExec(input: {
  readonly runtime: NativeRuntimeSelection;
  readonly scope: NativeProjectRunScope;
  readonly service: string | undefined;
  readonly argv: readonly string[];
  readonly workdir: string | undefined;
  readonly composeFile: string;
}): Promise<number> {
  const result = await nativeProjectExec({
    runtime: input.runtime,
    scope: input.scope,
    service: input.service ?? "",
    argv: input.argv,
    workdir: input.workdir,
    composeFile: input.composeFile,
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.truncated) {
    process.stderr.write("Native exec output was truncated.\n");
  }
  return result.exitCode;
}
