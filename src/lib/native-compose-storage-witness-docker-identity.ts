import { createNativeComposeEngineIdentityAdmissions } from "./native-compose-engine-identity.ts";
import type { createNativeComposeProbe } from "./native-compose-ownership.ts";

type Probe = ReturnType<typeof createNativeComposeProbe>;
const IDENTITY = ["info", "--format", "{{json .ID}}"] as const;

/** One admission table per CLI process; a process runs exactly one native command. */
const commandAdmissions = createNativeComposeEngineIdentityAdmissions();

function identityQuery(args: readonly string[]): boolean {
  return (
    args.length === IDENTITY.length &&
    args.every((value, index) => value === IDENTITY[index])
  );
}

/**
 * Storage-witness probe whose exact engine-ID query keeps one fresh read per
 * fence but may use the command's admitted direct Unix transport
 * (`createNativeComposeEngineIdentityAdmissions`): an explicit Unix DOCKER_HOST
 * or a Docker context selection (DOCKER_CONTEXT, the client config's current
 * context, or the default context) that the CLI resolves to a Unix socket.
 * Every other query, every ineligible selection and every unadmitted binding
 * goes to the supplied CLI probe unchanged. The direct read shares this probe's
 * signal and deadline, and the same environment snapshot the CLI probe
 * captured. Recovery observation keeps its own CLI probes.
 */
export function nativeComposeStorageIdentityProbe(opts: {
  readonly probe: Probe;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
  readonly admissions?: ReturnType<
    typeof createNativeComposeEngineIdentityAdmissions
  >;
}): Probe {
  const { probe, signal } = opts;
  const admissions = opts.admissions ?? commandAdmissions;
  const deadline = Date.now() + opts.timeoutMs;
  const environment = Object.freeze({ ...process.env });
  return (args) => {
    const remaining = Math.min(60_000, deadline - Date.now());
    if (!identityQuery(args) || remaining < 1) {
      // An expired probe keeps the CLI probe's own timeout refusal.
      return probe(args);
    }
    return admissions({
      cli: () => probe(args),
      signal,
      timeoutMs: remaining,
      environment,
    }).catch((error: unknown) => {
      // Admitted failures never fall back. Cancellation and expiry keep the CLI
      // probe's closed classification: that probe refuses them before spawning.
      if (signal?.aborted || Date.now() >= deadline) {
        return probe(args);
      }
      throw error;
    });
  };
}
