import { createNativeComposeProbe } from "../../src/lib/native-compose-ownership.ts";

type Docker = (args: readonly string[]) => Promise<string>;
const REFUSAL = "Routed hook proof window expired; values omitted";

/**
 * One hook keeps one outer deadline. Each complete inventory or TLS observation
 * needs a fresh aggregate probe; a probe is not a lifecycle-wide Docker owner.
 * A late observation or hook completion is rejected against this deadline.
 */
export function createNativeRoutedDownProofWindow(opts: {
  readonly timeoutMs: number;
  readonly now?: () => number;
  readonly createProbe?: typeof createNativeComposeProbe;
}) {
  const now = opts.now ?? Date.now;
  const createProbe = opts.createProbe ?? createNativeComposeProbe;
  if (
    !Number.isInteger(opts.timeoutMs) ||
    opts.timeoutMs <= 0 ||
    opts.timeoutMs > 60_000
  ) {
    throw new Error(REFUSAL);
  }
  const deadline = now() + opts.timeoutMs;
  const remaining = (): number => {
    const value = Math.floor(deadline - now());
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(REFUSAL);
    }
    return value;
  };
  return {
    deadline,
    assertOpen: (): void => {
      remaining();
    },
    capture: async <T>(observe: (docker: Docker) => Promise<T>): Promise<T> => {
      const docker = createProbe({ timeoutMs: Math.min(10_000, remaining()) });
      const observed = await observe(docker);
      remaining();
      return observed;
    },
  };
}
