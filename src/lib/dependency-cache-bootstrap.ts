import {
  composeRuntimeBackend,
  type RuntimeBaseOptions,
} from "../backends/runtime-backend.ts";
import { COMPOSE_STARTUP_TIMEOUT_ENV } from "./compose-startup-budget.ts";

const BOOTSTRAP_TIMEOUT_MS = 600_000;

/** Finish idempotent cache initialization before moving any selected consumer. */
export async function bootstrapDependencyCaches(
  opts: RuntimeBaseOptions & {
    readonly services: readonly string[];
    readonly timeoutMs?: number;
  }
): Promise<number> {
  for (const service of opts.services) {
    process.stderr.write(`Initializing dependency cache with ${service}\n`);
    const code = await composeRuntimeBackend.run({
      ...opts,
      service,
      noDeps: true,
      cmdArgs: [],
      timeoutMs: opts.timeoutMs ?? BOOTSTRAP_TIMEOUT_MS,
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

/** Keep dependency initialization failures distinct from the later Compose launch. */
export function dependencyCacheBootstrapFailure(opts: {
  readonly code: number;
  readonly timeoutMs?: number;
}): {
  readonly code: "E_STARTUP_TIMEOUT" | "E_DEPENDENCY_BOOTSTRAP_FAILED";
  readonly message: string;
} {
  return opts.code === 124
    ? {
        code: "E_STARTUP_TIMEOUT",
        message:
          opts.timeoutMs === undefined
            ? `Dependency cache initialization exceeded its startup budget of ${BOOTSTRAP_TIMEOUT_MS} ms (phase: dependency cache initialization; fixed for foreground and consumer runs); consumers were not changed`
            : `Dependency cache initialization exceeded its startup budget of ${opts.timeoutMs} ms (phase: dependency cache initialization, including any installer image pull; raise ${COMPOSE_STARTUP_TIMEOUT_ENV}=<ms> on the host invocation); consumers were not changed`,
      }
    : {
        code: "E_DEPENDENCY_BOOTSTRAP_FAILED",
        message:
          "Dependency cache initialization failed; consumers were not changed",
      };
}
