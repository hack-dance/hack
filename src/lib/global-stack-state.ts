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
  /**
   * Docker's health status (`starting`, `healthy`, `unhealthy`) for a
   * service with a healthcheck; `null` or absent when it has none.
   */
  readonly health?: string | null;
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
  return records.flatMap((record) => {
    const container = toContainerState(record);
    return container ? [container] : [];
  });
}

/** One `compose ps` record, or `null` when it is not a container record. */
function toContainerState(record: unknown): GlobalContainerState | null {
  if (typeof record !== "object" || record === null) {
    return null;
  }
  const { Name, Service, State, ExitCode, Health } = record as Record<
    string,
    unknown
  >;
  if (typeof Name !== "string" || typeof State !== "string") {
    return null;
  }
  return {
    name: Name,
    service: typeof Service === "string" ? Service : Name,
    state: State,
    exitCode: typeof ExitCode === "number" ? ExitCode : null,
    ...(typeof Health === "string" && Health !== "" ? { health: Health } : {}),
  };
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

/** Why a started stack is not ready; see {@link waitForStartedContainers}. */
export type StackNotReady = {
  /**
   * `stopped`: a container is not running; `unhealthy`: its healthcheck
   * failed; `timeout`: a healthcheck did not pass within the bound.
   */
  readonly reason: "stopped" | "unhealthy" | "timeout";
  readonly containers: readonly GlobalContainerState[];
};

/**
 * Waits until a just-started stack is ready: every container running, and
 * every one with a healthcheck `healthy`. Returns `null` when ready, at the
 * first look that shows it, so a healthy stack costs no fixed wait. Fails at
 * once when a container stops or turns unhealthy, and after `timeoutMs` when
 * a healthcheck still has not passed.
 *
 * A container without a healthcheck (CoreDNS, whose image has no shell)
 * counts as ready once running. A config error ends it within about a
 * second, which the looks made while the others become healthy see. A stack
 * with no healthcheck at all (its compose file predates them) has nothing to
 * wait for, so it is watched for `withoutHealthchecksMs` instead, the fixed
 * window Hack used before: still failing at the first stopped container.
 *
 * `read` returning an empty list means nothing is known (no Docker answer,
 * or an output this parser does not understand): the wait then ends at once
 * without a finding, so it can never fail a healthy start.
 */
export async function waitForStartedContainers(opts: {
  readonly read: () => Promise<readonly GlobalContainerState[]>;
  readonly timeoutMs: number;
  /** The watch for a stack none of whose containers has a healthcheck. */
  readonly withoutHealthchecksMs?: number;
  readonly pollMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}): Promise<StackNotReady | null> {
  const pollMs = opts.pollMs ?? 250;
  const now = opts.now ?? Date.now;
  const sleep =
    opts.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const started = now();
  const deadline = started + opts.timeoutMs;
  for (;;) {
    const containers = await opts.read();
    if (containers.length === 0) {
      return null;
    }
    const stopped = containersNotRunning(containers);
    if (stopped.length > 0) {
      return { reason: "stopped", containers: stopped };
    }
    const unhealthy = containers.filter((c) => c.health === "unhealthy");
    if (unhealthy.length > 0) {
      return { reason: "unhealthy", containers: unhealthy };
    }
    const pending = containers.filter(
      (c) => (c.health ?? null) !== null && c.health !== "healthy"
    );
    const noHealthchecks = containers.every((c) => (c.health ?? null) === null);
    if (noHealthchecks && now() - started < (opts.withoutHealthchecksMs ?? 0)) {
      await sleep(pollMs);
      continue;
    }
    if (pending.length === 0) {
      return null;
    }
    if (now() >= deadline) {
      return { reason: "timeout", containers: pending };
    }
    await sleep(pollMs);
  }
}

/**
 * The error for containers that did not pass their healthcheck: each by name,
 * and the commands that show why.
 */
export function describeContainersNotHealthy(opts: {
  readonly stack: string;
  readonly reason: "unhealthy" | "timeout";
  readonly timeoutMs: number;
  readonly containers: readonly GlobalContainerState[];
}): string {
  const names = opts.containers.map((c) => c.name).join(", ");
  const plural = opts.containers.length !== 1;
  return [
    opts.reason === "unhealthy"
      ? `${opts.stack} started, but ${plural ? "these containers are" : "this container is"} unhealthy: ${names}.`
      : `${opts.stack} started, but ${plural ? "these containers were" : "this container was"} not ready within ${Math.round(opts.timeoutMs / 1000)} s: ${names}.`,
    ...opts.containers.map(
      (c) =>
        `See why: docker inspect --format '{{json .State.Health}}' ${c.name}; docker logs --tail 50 ${c.name}`
    ),
  ].join("\n");
}
