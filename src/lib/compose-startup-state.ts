export type ComposeServiceState = {
  readonly containerId?: string;
  readonly service: string;
  readonly state: string;
  readonly exitCode: number | null;
};

/**
 * Settle fresh Docker observations within the start phase's remaining budget.
 * Never carry success across container replacement: corroborate the identity
 * listing, then classify only the latest states. A job can finish between reads
 * without ever being observed running. Created is not a successful exit zero.
 */
export async function waitForComposeStartupState(opts: {
  readonly read: (timeoutMs: number) => Promise<readonly ComposeServiceState[]>;
  readonly successfulCompletionServices: ReadonlySet<string>;
  readonly deadlineMs: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<unknown>;
}): Promise<{
  readonly states: readonly ComposeServiceState[];
  readonly startup: ComposeStartupState;
}> {
  const now = opts.now ?? (() => performance.now());
  const sleep = opts.sleep ?? ((ms) => Bun.sleep(ms));
  let previous: readonly ComposeServiceState[] = [];
  const seenServices = new Set<string>();
  for (;;) {
    const observed = await opts.read(Math.max(1, opts.deadlineMs - now()));
    for (const entry of observed) {
      seenServices.add(entry.service);
    }
    const presentServices = new Set(observed.map((entry) => entry.service));
    // A replacement may briefly disappear from ps. Retain its obligation, never
    // its old successful state, while the other services remain visible.
    const states: readonly ComposeServiceState[] = [
      ...observed,
      ...[...seenServices]
        .filter((service) => !presentServices.has(service))
        .map((service) => ({ service, state: "", exitCode: null })),
    ];
    const startup = classifyComposeStartupState(states, opts);
    const identity = (entries: readonly ComposeServiceState[]) =>
      entries
        .map((entry) => `${entry.service}:${entry.containerId ?? ""}`)
        .sort()
        .join("\n");
    const stable =
      observed.length > 0 &&
      observed.every((entry) => entry.containerId) &&
      identity(observed) === identity(previous);
    const pending = states.some(
      (entry) =>
        !entry.containerId ||
        ["created", "restarting", ""].includes(entry.state)
    );
    if (stable && !pending) {
      return { states, startup };
    }
    const remaining = opts.deadlineMs - now();
    if (remaining <= 0) {
      return {
        states,
        startup: stable
          ? startup
          : {
              running: [],
              completed: [],
              failed: states.map((s) => s.service),
            },
      };
    }
    previous = observed;
    // Corroborate a terminal/running listing immediately; wait only while
    // Docker still reports a transitional state or no containers.
    if (pending || states.length === 0) {
      await sleep(Math.min(100, remaining));
    }
  }
}

export type ComposeStartupState = {
  readonly running: readonly string[];
  readonly completed: readonly string[];
  readonly failed: readonly string[];
};

/** Classify Compose services without treating successful one-shot containers as failures. */
export function classifyComposeStartupState(
  states: readonly ComposeServiceState[],
  opts: {
    readonly successfulCompletionServices?: ReadonlySet<string>;
  } = {}
): ComposeStartupState {
  const running: string[] = [];
  const completed: string[] = [];
  const failed: string[] = [];

  for (const entry of states) {
    if (entry.state === "running") {
      running.push(entry.service);
      continue;
    }
    if (
      entry.state === "exited" &&
      entry.exitCode === 0 &&
      opts.successfulCompletionServices?.has(entry.service)
    ) {
      completed.push(entry.service);
      continue;
    }
    failed.push(entry.service);
  }

  return { running, completed, failed };
}

export function buildStartupIncompleteMessage(opts: {
  readonly composeProject: string;
  readonly failed: readonly string[];
}): string {
  if (opts.failed.length === 0) {
    return `Startup incomplete for ${opts.composeProject}: Compose reported no services after startup`;
  }
  return `Startup incomplete for ${opts.composeProject}: ${[...opts.failed].sort().join(", ")} did not reach running or successful completion`;
}
