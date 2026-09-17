import {
  composeRuntimeBackend,
  type RuntimeBaseOptions,
} from "../backends/runtime-backend.ts";

const BOOTSTRAP_TIMEOUT_MS = 600_000;

/** Finish idempotent cache initialization before moving any selected consumer. */
export async function bootstrapDependencyCaches(
  opts: RuntimeBaseOptions & {
    readonly services: readonly string[];
  }
): Promise<number> {
  for (const service of opts.services) {
    process.stderr.write(`Initializing dependency cache with ${service}\n`);
    const code = await composeRuntimeBackend.run({
      ...opts,
      service,
      noDeps: true,
      cmdArgs: [],
      timeoutMs: BOOTSTRAP_TIMEOUT_MS,
      forwardSignals: true,
      routeStdoutToStderr: true,
    });
    if (code !== 0) {
      process.stderr.write(
        `Dependency cache initialization failed for ${service} (exit ${code}); consumers were not changed\n`
      );
      return code;
    }
  }
  return 0;
}
