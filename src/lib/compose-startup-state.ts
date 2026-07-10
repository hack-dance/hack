export type ComposeServiceState = {
  readonly service: string;
  readonly state: string;
  readonly exitCode: number | null;
};

export type ComposeStartupState = {
  readonly running: readonly string[];
  readonly completed: readonly string[];
  readonly failed: readonly string[];
};

/** Classify Compose services without treating successful one-shot containers as failures. */
export function classifyComposeStartupState(
  states: readonly ComposeServiceState[]
): ComposeStartupState {
  const running: string[] = [];
  const completed: string[] = [];
  const failed: string[] = [];

  for (const entry of states) {
    if (entry.state === "running") {
      running.push(entry.service);
      continue;
    }
    if (entry.state === "exited" && entry.exitCode === 0) {
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
