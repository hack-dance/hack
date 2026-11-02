import type { LegacyComposeVerifiedBinding } from "./native-compose-adoption-binding.ts";
import type { AdoptionOperation } from "./native-compose-adoption-receipt.ts";
import { run } from "./shell.ts";

const COMPLETE = Symbol("legacy-retained-routing-effect");
export type LegacyComposeRoutingCompletion = { readonly [COMPLETE]: true };
type Input = {
  readonly binding: LegacyComposeVerifiedBinding;
  readonly assertFresh: () => Promise<void>;
  readonly assertActive: () => void;
};
type Witness = {
  readonly input: Input;
  readonly operation: AdoptionOperation;
  readonly deadline: number;
  readonly code: number;
};
const completions = new WeakMap<object, Witness>();
function refuse(): never {
  throw new Error(
    "Retained routing child disposition is uncertain; values omitted."
  );
}
function check(signal: AbortSignal | undefined, deadline: number): void {
  if (signal?.aborted || !Number.isFinite(deadline) || deadline <= Date.now()) {
    refuse();
  }
}
function absent(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return false;
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ESRCH"
    ) {
      return true;
    }
    return refuse();
  }
}

/** One fixed original-ID child. Completion means known return and fresh group
 * absence; it does not infer container readiness or terminate an unknown peer. */
export async function runLegacyComposeRetainedRoutingOperation(opts: {
  readonly input: Input;
  readonly operation: AdoptionOperation;
  readonly deadline: number;
  readonly signal?: AbortSignal;
}): Promise<LegacyComposeRoutingCompletion> {
  const input = opts.input;
  const binding = input.binding;
  const projectRoot = binding.projectRoot;
  const assertFresh = input.assertFresh;
  const assertActive = input.assertActive;
  const operation = opts.operation;
  const deadline = opts.deadline;
  const signal = opts.signal;
  const ids = binding.containers.map((row) => row.id);
  if (
    binding.binding_version !== 14 ||
    typeof assertActive !== "function" ||
    !ids.length ||
    new Set(ids).size !== ids.length ||
    !["start", "restart", "stop"].includes(operation)
  ) {
    refuse();
  }
  check(signal, deadline);
  assertActive();
  await assertFresh();
  assertActive();
  check(signal, deadline);
  let group: number | undefined;
  let observationFailed = false;
  const code = await run(["docker", "container", operation, ...ids], {
    cwd: projectRoot,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    // This finite data-free child never needs a controlling-terminal handoff.
    signal,
    timeoutMs: Math.max(1, deadline - Date.now()),
    beforeSpawn: () => {
      assertActive();
      check(signal, deadline);
    },
    onSpawn: (event) => {
      if (
        !(event.ownsProcessGroup && Number.isSafeInteger(event.pid)) ||
        event.pid <= 1
      ) {
        observationFailed = true;
      } else {
        group = event.pid;
      }
      return Promise.resolve();
    },
  });
  if (
    observationFailed ||
    group === undefined ||
    !Number.isSafeInteger(code) ||
    code < 0 ||
    code > 255
  ) {
    refuse();
  }
  const drainDeadline = Math.min(deadline, Date.now() + 3000);
  while (!absent(group)) {
    if (Date.now() >= drainDeadline) {
      refuse();
    }
    await Bun.sleep(Math.min(25, drainDeadline - Date.now()));
  }
  const completion = Object.freeze({ [COMPLETE]: true as const });
  completions.set(completion, { input, operation, deadline, code });
  return completion;
}

/** Consumed by the same held generation callback; numeric/structural/replayed
 * results cannot clear its durable prospective child disposition. */
export function consumeLegacyComposeRoutingCompletion(opts: {
  readonly outcome: unknown;
  readonly input: Input;
  readonly operation: AdoptionOperation;
  readonly deadline: number;
}): number {
  if (typeof opts.outcome !== "object" || opts.outcome === null) {
    refuse();
  }
  const witness = completions.get(opts.outcome);
  if (
    !witness ||
    witness.input !== opts.input ||
    witness.operation !== opts.operation ||
    witness.deadline !== opts.deadline
  ) {
    refuse();
  }
  completions.delete(opts.outcome);
  return witness.code;
}
