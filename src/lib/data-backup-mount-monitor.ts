import { HackCliError } from "./cli-result.ts";
import type { DataBackupDeadlines } from "./data-backup-deadlines.ts";
import type {
  DataBackupDocker,
  DataBackupProcessResult,
  DataBackupWatch,
} from "./data-backup-docker.ts";
import { dataBackupHelperImage } from "./data-backup-format.ts";
import {
  type DataHelperContainers,
  requireStep,
  withTrackedContainer,
} from "./data-backup-held-volume.ts";
import {
  type HelperPurpose,
  helperContainerName,
  parseJsonText,
} from "./data-backup-helper.ts";
import {
  containersReachingVolumes,
  type WatchedVolume,
} from "./data-backup-volumes.ts";
import { isRecord } from "./guards.ts";
import { holdSignalCleanup } from "./process-exit.ts";

/** Bound for a marker container's start event to arrive on the stream. */
const MARKER_TIMEOUT_MS = 30_000;

/**
 * Live `docker events` subscription. Combining filters ORs values of one key
 * and ANDs the keys, so this delivers volume `mount`, `create` and `destroy`
 * and container `start` events, plus container `create` and `destroy`, which
 * are ignored (checked on Docker 29.9.2; a volume event's Actor.ID is the
 * volume name). It has no `--since`/`--until`: replaying
 * history after the fact returns only the engine's last 256 events, so a busy
 * engine could evict a writer's mount before it is read.
 */
export const MOUNT_EVENTS_ARGV = [
  "docker",
  "events",
  "--filter",
  "type=volume",
  "--filter",
  "type=container",
  "--filter",
  "event=mount",
  "--filter",
  "event=start",
  "--filter",
  "event=create",
  "--filter",
  "event=destroy",
  "--format",
  "{{json .}}",
] as const;

/**
 * A mount of a watched volume. The container is named by its short (12
 * character) ID only: a container name can carry interpolated env values
 * (`container_name: db-${TOKEN}`), and it identifies nothing.
 */
export type ForeignMount = {
  readonly volume: string;
  readonly container: string;
};

export interface MountMonitor {
  /**
   * End coverage: run an end marker and wait for its start event (the
   * engine emits events in order, so every earlier event has then been
   * read), stop the subscription, and return every use of `volumes` seen in
   * the window:
   *
   * - each volume `mount` event of a watched volume. None is exempt: Hack's
   *   own helpers hold a volume with a bind of its Mountpoint, which emits
   *   no volume `mount` event (checked on Docker 29.9), and markers mount
   *   nothing;
   * - each container that started in the window and is not one this run
   *   created (by ID), inspected by ID: a volume mount of a watched volume,
   *   or a bind whose Source is a watched Mountpoint, inside one, or above
   *   one. A bind emits no volume event, so another container could use the
   *   same technique as Hack's helpers.
   *
   * Refuses, closed, when the stream ended before it was stopped, or when a
   * foreign container that started in the window cannot be inspected (it is
   * already gone, or the inspect failed): what it mounted is unknown.
   */
  finish(volumes: readonly WatchedVolume[]): Promise<readonly ForeignMount[]>;
  /**
   * After {@link finish}: the names in `names` that a volume `destroy` or
   * `create` event named during the window. A volume's CreatedAt has
   * one-second resolution, so a volume removed and recreated under the same
   * name and labels within a second passes an identity comparison; these
   * events catch it regardless. A `create` of a name in `ownCreates` (one
   * per successful `docker volume create` this run issued) is this run's
   * own and is not reported; every other create, and every destroy, is.
   */
  changedVolumes(opts: {
    readonly names: readonly string[];
    readonly ownCreates?: readonly string[];
  }): readonly string[];
  /** Stop the subscription on any other path. Idempotent. */
  stop(): Promise<void>;
}

function notPublished(command: HelperPurpose): string {
  return command === "export"
    ? "the backup was not published"
    : "the restore is not marked complete";
}

/**
 * A container started during the window and could not be inspected, so
 * what it mounted is unknown. On a busy engine it can be unrelated (any
 * short-lived container): retrying is the answer.
 */
function uncheckedStartError(
  command: HelperPurpose,
  containers: readonly string[]
): HackCliError {
  return new HackCliError({
    code: "E_PROJECT_RUNNING",
    message: `A container (${containers.join(", ")}) started during the ${command} and could not be checked (it was already gone or could not be inspected), so Hack cannot prove it did not use the project's volumes; ${notPublished(command)}. If nothing else should be using them, retry.`,
    detail: { unchecked: containers, reason: "unchecked_start" },
  });
}

function lostCoverage(command: HelperPurpose, why: string): HackCliError {
  return new HackCliError({
    code: "E_DOCKER_UNAVAILABLE",
    message: `Hack lost its watch on Docker's volume events (${why}), so it cannot prove that nothing else used the volumes during the ${command}; ${notPublished(command)}. Check \`docker info\`, then retry.`,
  });
}

/**
 * Subscribe to volume mount and container start events, and return once the
 * subscription is proven live: a no-op marker container's start event has
 * arrived on it. Only then may the caller start copying. Markers are matched
 * by the ID their own `docker create` returned, never by name.
 * SIGINT/SIGTERM while it runs stops the subscription and force-removes
 * exactly this run's live helper containers, by ID, before the process ends.
 */
export async function startMountMonitor(opts: {
  readonly docker: DataBackupDocker;
  readonly purpose: HelperPurpose;
  /** This run's containers (helpers and markers), by the IDs it created. */
  readonly helpers: DataHelperContainers;
  readonly deadlines: DataBackupDeadlines;
  readonly markerTimeoutMs?: number;
}): Promise<MountMonitor> {
  const started = new Set<string>();
  const mounts: { volume: string; container: string }[] = [];
  const volumeEvents: { action: "create" | "destroy"; volume: string }[] = [];
  const waiting = new Map<string, () => void>();
  let unreadable = false;
  let stopped = false;
  let ended = false;
  const onLine = (line: string): void => {
    if (line.trim() === "") {
      return;
    }
    const event = parseJsonText(line);
    const actor = isRecord(event) && isRecord(event.Actor) ? event.Actor : null;
    const attributes =
      actor && isRecord(actor.Attributes) ? actor.Attributes : null;
    if (
      !(isRecord(event) && actor && attributes && typeof actor.ID === "string")
    ) {
      unreadable = true;
      return;
    }
    if (event.Type === "container" && event.Action === "start") {
      started.add(actor.ID);
      waiting.get(actor.ID)?.();
    } else if (
      event.Type === "volume" &&
      event.Action === "mount" &&
      typeof attributes.container === "string"
    ) {
      mounts.push({ volume: actor.ID, container: attributes.container });
    } else if (
      event.Type === "volume" &&
      (event.Action === "create" || event.Action === "destroy")
    ) {
      volumeEvents.push({ action: event.Action, volume: actor.ID });
    }
  };
  const watch: DataBackupWatch = opts.docker.watch(MOUNT_EVENTS_ARGV, onLine);
  const closed = watch.done.then(
    () => undefined,
    () => undefined
  );
  void closed.then(() => {
    if (!stopped) {
      ended = true;
    }
    for (const wake of waiting.values()) {
      wake();
    }
  });

  const handlers = new Map<NodeJS.Signals, () => void>();
  const dispose = (): void => {
    for (const [signal, handler] of handlers) {
      process.off(signal, handler);
    }
    handlers.clear();
  };
  const stop = async (): Promise<void> => {
    stopped = true;
    dispose();
    await watch.stop();
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const handler = (): void => {
      const others = process
        .listeners(signal)
        .some((listener) => listener !== handler);
      // Held: the explicit exit must not orphan the events child. A killed
      // client leaves its container running, so this run's live helpers are
      // removed too: by the IDs their creates returned, never by name, so a
      // container that reused a removed helper's name is left alone.
      const helpers = [...opts.helpers.live];
      holdSignalCleanup({
        cleanup: Promise.all([
          stop(),
          helpers.length === 0
            ? undefined
            : opts.docker.capture(["docker", "rm", "--force", ...helpers]),
        ]),
        reraise: others ? null : () => process.kill(process.pid, signal),
      });
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }

  /**
   * Create and start a no-op marker container and wait for its start event.
   * The marker is tracked like a helper: its create and start are bounded
   * by the command deadline, and it is removed and its removal confirmed on
   * every path, a signal included.
   */
  const marker = async (stage: "start" | "end"): Promise<void> => {
    const { commandMs, stepMs } = opts.deadlines;
    const step = (
      result: DataBackupProcessResult,
      action: "create" | "start",
      timeoutMs: number
    ): void => {
      requireStep({
        result,
        label: `${stage} marker`,
        action,
        timeoutMs,
        consequence: "nothing was changed.",
        redactValues: opts.docker.redactValues,
      });
    };
    let markerId: string | null = null;
    await withTrackedContainer(
      {
        docker: opts.docker,
        name: `${helperContainerName(opts.purpose)}-${stage}`,
        createArgs: [
          "--network",
          "none",
          "--log-driver",
          "none",
          "--pull",
          "missing",
          "--read-only",
          "--security-opt",
          "no-new-privileges",
          "--label",
          `io.hack.data-backup=${opts.purpose}`,
          "--entrypoint",
          "true",
          dataBackupHelperImage(),
        ],
        // Creating may pull the pinned image once.
        createTimeoutMs: stepMs,
        checkCreate: (result) => step(result, "create", stepMs),
        deadlines: opts.deadlines,
        helpers: opts.helpers,
      },
      async (container) => {
        markerId = container;
        const seen = new Promise<void>((resolve) => {
          waiting.set(container, resolve);
        });
        step(
          await opts.docker.capture(["docker", "start", container], {
            timeoutMs: commandMs,
          }),
          "start",
          commandMs
        );
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          seen,
          closed,
          new Promise<void>((resolve) => {
            timer = setTimeout(
              resolve,
              opts.markerTimeoutMs ?? MARKER_TIMEOUT_MS
            );
          }),
        ]);
        clearTimeout(timer);
        waiting.delete(container);
      }
    );
    if (ended) {
      throw lostCoverage(opts.purpose, "the event stream ended");
    }
    if (markerId === null || !started.has(markerId)) {
      throw lostCoverage(
        opts.purpose,
        `the ${stage} marker's start event did not arrive`
      );
    }
  };

  try {
    await marker("start");
  } catch (error: unknown) {
    await stop();
    throw error;
  }
  return {
    async finish(volumes) {
      try {
        await marker("end");
      } finally {
        await stop();
      }
      if (ended) {
        throw lostCoverage(opts.purpose, "the event stream ended");
      }
      if (unreadable) {
        throw lostCoverage(opts.purpose, "an event line was unreadable");
      }
      const watched = new Set(volumes.map((volume) => volume.name));
      const found = mounts
        .filter((mount) => watched.has(mount.volume))
        .map((mount) => ({
          volume: mount.volume,
          container: mount.container.slice(0, 12),
        }));
      const reach = await containersReachingVolumes({
        docker: opts.docker,
        containers: [...started].filter(
          (container) => !opts.helpers.created.has(container)
        ),
        volumes,
        timeoutMs: opts.deadlines.commandMs,
      });
      found.push(...reach.mounts);
      const { unchecked } = reach;
      const unique = [
        ...new Map(
          found.map((mount) => [`${mount.volume}\0${mount.container}`, mount])
        ).values(),
      ];
      if (unique.length === 0 && unchecked.length > 0) {
        throw uncheckedStartError(opts.purpose, unchecked);
      }
      return unique;
    },
    changedVolumes({ names, ownCreates = [] }) {
      const watched = new Set(names);
      const ours = new Map<string, number>();
      for (const name of ownCreates) {
        ours.set(name, (ours.get(name) ?? 0) + 1);
      }
      const changed = new Set<string>();
      for (const { action, volume } of volumeEvents) {
        if (!watched.has(volume)) {
          continue;
        }
        const own = ours.get(volume) ?? 0;
        if (action === "create" && own > 0) {
          ours.set(volume, own - 1);
          continue;
        }
        changed.add(volume);
      }
      return [...changed].sort();
    },
    stop,
  };
}

/** The refusal for any mount of a target volume during the window. */
export function foreignMountError(opts: {
  readonly mounts: readonly ForeignMount[];
  readonly command: HelperPurpose;
  /** What the refusal leaves behind, as a sentence. */
  readonly consequence: string;
  readonly stopCommand: string;
}): HackCliError {
  const containers = [...new Set(opts.mounts.map((mount) => mount.container))];
  return new HackCliError({
    code: "E_PROJECT_RUNNING",
    message: `Another container (${containers.join(", ")}) mounted a volume during the ${opts.command}, so the result may be inconsistent: ${opts.consequence} Make sure nothing uses the project's volumes (\`${opts.stopCommand}\`), then retry.`,
    detail: { mounts: opts.mounts },
  });
}
