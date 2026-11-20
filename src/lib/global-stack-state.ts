/**
 * Whether the global stack's containers are really running after
 * `docker compose up -d` (HACK-2381).
 *
 * `up -d` exits 0 once the containers are started. A container that then
 * fails at once, for example because it cannot read its bind-mounted config,
 * is not an error to Compose, so `hack global install` reported "Global infra
 * is up" with CoreDNS, Loki and Grafana exited. Every service of the global
 * stack is long-running (Caddy, CoreDNS, Loki, Alloy, Grafana; there is no
 * one-shot or optional service), so "running" means Compose reports the
 * container's state as `running`. Anything else (`exited`, `restarting`,
 * `created`, `dead`, `paused`) is not running.
 */
export type GlobalContainerState = {
  readonly name: string;
  readonly service: string;
  readonly state: string;
  readonly exitCode: number | null;
};

/**
 * Parses `docker compose ps --all --format json`: one JSON object per line,
 * or one JSON array (older Compose). Lines that are not a container record
 * are ignored; an output with no record yields an empty list, which callers
 * treat as "nothing known", never as a failure.
 */
export function parseComposePs(stdout: string): GlobalContainerState[] {
  const records: unknown[] = [];
  const trimmed = stdout.trim();
  if (trimmed === "") {
    return [];
  }
  try {
    const whole: unknown = JSON.parse(trimmed);
    records.push(...(Array.isArray(whole) ? whole : [whole]));
  } catch {
    for (const line of trimmed.split("\n")) {
      try {
        records.push(JSON.parse(line));
      } catch {
        // Not a record line.
      }
    }
  }
  const containers: GlobalContainerState[] = [];
  for (const record of records) {
    if (typeof record !== "object" || record === null) {
      continue;
    }
    const { Name, Service, State, ExitCode } = record as Record<
      string,
      unknown
    >;
    if (typeof Name !== "string" || typeof State !== "string") {
      continue;
    }
    containers.push({
      name: Name,
      service: typeof Service === "string" ? Service : Name,
      state: State,
      exitCode: typeof ExitCode === "number" ? ExitCode : null,
    });
  }
  return containers;
}

/** The containers Compose does not report as `running`. */
export function containersNotRunning(
  containers: readonly GlobalContainerState[]
): GlobalContainerState[] {
  return containers.filter((container) => container.state !== "running");
}

/**
 * The error for containers that are not running after a start: each one by
 * name with its state, and the command that shows why.
 */
export function describeContainersNotRunning(opts: {
  readonly stack: string;
  readonly containers: readonly GlobalContainerState[];
}): string {
  const names = opts.containers.map(
    (container) =>
      `${container.name} (${container.state}${container.state === "exited" && container.exitCode !== null ? `, exit code ${container.exitCode}` : ""})`
  );
  return [
    `${opts.stack} started, but ${names.length === 1 ? "this container is" : "these containers are"} not running: ${names.join(", ")}.`,
    ...opts.containers.map(
      (container) => `See why: docker logs --tail 50 ${container.name}`
    ),
  ].join("\n");
}

/**
 * Watches a just-started stack for `settleMs`: fails as soon as a container
 * is seen not running, and passes only when every look in the window found
 * all of them running. A config error ends a container within about a
 * second of its start, so a short window is enough to see it. Returns the
 * containers that are not running, or an empty list.
 *
 * `read` returning an empty list means nothing is known (no Docker answer,
 * or an output this parser does not understand): the watch then ends at once
 * without a finding, so it can never fail a healthy start.
 */
export async function watchStartedContainers(opts: {
  readonly read: () => Promise<readonly GlobalContainerState[]>;
  readonly settleMs?: number;
  readonly pollMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}): Promise<GlobalContainerState[]> {
  const settleMs = opts.settleMs ?? 2000;
  const pollMs = opts.pollMs ?? 500;
  const sleep =
    opts.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let waited = 0; ; waited += pollMs) {
    const containers = await opts.read();
    if (containers.length === 0) {
      return [];
    }
    const stopped = containersNotRunning(containers);
    if (stopped.length > 0 || waited >= settleMs) {
      return stopped;
    }
    await sleep(pollMs);
  }
}
