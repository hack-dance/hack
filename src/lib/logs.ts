export type LogBackendChoice = "compose" | "loki";

export function resolveShouldTryLoki(opts: {
  readonly forceCompose: boolean;
  readonly wantsLokiExplicit: boolean;
  readonly follow: boolean;
  readonly followBackend: LogBackendChoice;
  readonly snapshotBackend: LogBackendChoice;
}): boolean {
  if (opts.forceCompose) {
    return false;
  }
  if (opts.wantsLokiExplicit) {
    return true;
  }
  return opts.follow
    ? opts.followBackend === "loki"
    : opts.snapshotBackend === "loki";
}

export function resolveUseLoki(opts: {
  readonly forceCompose: boolean;
  readonly wantsLokiExplicit: boolean;
  readonly shouldTryLoki: boolean;
  readonly lokiReachable: boolean;
}): boolean {
  if (opts.wantsLokiExplicit) {
    return true;
  }
  if (opts.forceCompose) {
    return false;
  }
  return opts.shouldTryLoki && opts.lokiReachable;
}

export function buildLogSelector(opts: {
  readonly project: string | null;
  readonly services: readonly string[];
}): string {
  const parts: string[] = [];
  if (opts.project) {
    parts.push(`project=${quoteLogql(opts.project)}`);
  }
  if (opts.services.length === 1) {
    parts.push(`service=${quoteLogql(opts.services[0] ?? "")}`);
  } else if (opts.services.length > 1) {
    const pattern = `^(${opts.services.map(escapeRegex).join("|")})$`;
    parts.push(`service=~${quoteLogql(pattern)}`);
  }

  return `{${parts.join(",")}}`;
}

function quoteLogql(value: string): string {
  return `"${value.replaceAll("\\\\", "\\\\\\\\").replaceAll('"', '\\\\"')}"`;
}

function escapeRegex(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\\\$&");
}

/**
 * Lookback used for a Loki snapshot (`hack logs --no-follow`) when neither
 * `--since` nor `--until` bounds the start.
 *
 * Compose snapshots have no time bound: `docker compose logs --tail N` shows the
 * last N lines of every container, including containers that exited long ago.
 * A short Loki window made a quiet or already-exited service look empty, so the
 * default covers a working day while staying well inside the default 168h
 * retention. Older history needs an explicit `--since`.
 */
export const DEFAULT_LOKI_SNAPSHOT_LOOKBACK_MS = 24 * 60 * 60 * 1000;

export interface LokiQueryWindow {
  readonly start: Date;
  readonly end: Date;
}

/**
 * Resolve the `[start, end]` range for a Loki `query_range` snapshot.
 *
 * An explicit start or end always wins; a missing end is `now`, and a missing
 * start is {@link DEFAULT_LOKI_SNAPSHOT_LOOKBACK_MS} before the end.
 */
export function resolveLokiQueryWindow(opts: {
  readonly start?: Date;
  readonly end?: Date;
  readonly now: Date;
}): LokiQueryWindow {
  const end = opts.end ?? opts.now;
  const start =
    opts.start ?? new Date(end.getTime() - DEFAULT_LOKI_SNAPSHOT_LOOKBACK_MS);
  return { start, end };
}

/** Result of one Loki snapshot as reported to {@link runLokiSnapshotWithFallback}. */
export interface LokiSnapshotOutcome {
  readonly exitCode: number;
  /** Log entries Loki returned; zero for a failed query. */
  readonly entryCount: number;
  /**
   * True only when the snapshot was empty and the caller asked to defer empty
   * results: nothing was written to stdout, so another backend may answer.
   */
  readonly deferred: boolean;
}

/**
 * Run a Loki snapshot and handle an empty result.
 *
 * Alloy discovers containers by polling Docker, so a one-shot service that
 * exits (and is removed) between polls never reaches Loki even though
 * `docker compose logs` still shows its output. When Loki was chosen
 * implicitly (project default `logs.snapshotBackend`), an empty snapshot falls
 * back to the compose backend before any output is written, so stdout carries
 * exactly one backend's stream. When Loki was requested explicitly (`--loki`,
 * `--services`, `--query`, `--since`, `--until`), the Loki result stands and a
 * one-line hint on stderr points at `--compose`.
 */
export async function runLokiSnapshotWithFallback(opts: {
  readonly wantsLokiExplicit: boolean;
  readonly query: string;
  readonly service: string | undefined;
  readonly runLoki: (opts: {
    readonly deferEmpty: boolean;
  }) => Promise<LokiSnapshotOutcome>;
  readonly runCompose: () => Promise<number>;
  readonly writeNotice: (line: string) => void;
}): Promise<number> {
  if (opts.wantsLokiExplicit) {
    const outcome = await opts.runLoki({ deferEmpty: false });
    if (outcome.exitCode === 0 && outcome.entryCount === 0) {
      opts.writeNotice(
        renderEmptyLokiSnapshotNotice({
          action: "hint",
          query: opts.query,
          service: opts.service,
        })
      );
    }
    return outcome.exitCode;
  }

  const outcome = await opts.runLoki({ deferEmpty: true });
  if (!outcome.deferred) {
    return outcome.exitCode;
  }
  opts.writeNotice(
    renderEmptyLokiSnapshotNotice({
      action: "fallback",
      query: opts.query,
      service: opts.service,
    })
  );
  return await opts.runCompose();
}

/** One-line stderr notice for an empty Loki snapshot. */
export function renderEmptyLokiSnapshotNotice(opts: {
  readonly action: "fallback" | "hint";
  readonly query: string;
  readonly service: string | undefined;
}): string {
  const reason =
    "a short-lived container can exit before Alloy discovers it, and older logs sit outside the queried window";
  if (opts.action === "fallback") {
    return `Loki returned no log entries for ${opts.query}; showing docker compose logs instead (${reason}).`;
  }
  const service = (opts.service ?? "").trim();
  const composeCommand =
    service.length > 0
      ? `hack logs --compose ${service}`
      : "hack logs --compose";
  return `Loki returned no log entries for ${opts.query} (${reason}); try \`${composeCommand}\`.`;
}
