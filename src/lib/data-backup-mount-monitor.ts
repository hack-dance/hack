import { HackCliError } from "./cli-result.ts";
import type { DataBackupDeadlines } from "./data-backup-deadlines.ts";
import type {
  DataBackupDocker,
  DataBackupWatch,
} from "./data-backup-docker.ts";
import { dataBackupHelperImage } from "./data-backup-format.ts";
import {
  requireStep,
  withTrackedContainer,
} from "./data-backup-held-volume.ts";
import {
  type HelperPurpose,
  helperContainerName,
  parseJsonText,
} from "./data-backup-helper.ts";
import { isRecord } from "./guards.ts";
import { holdSignalCleanup } from "./process-exit.ts";

/** Bound for a marker container's start event to arrive on the stream. */
const MARKER_TIMEOUT_MS = 30_000;

/**
 * Live `docker events` subscription. Combining filters ORs values of one key
 * and ANDs the keys, so this delivers volume `mount` and container `start`
 * events (checked on a real engine). It has no `--since`/`--until`: replaying
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
  "--format",
  "{{json .}}",
] as const;

export type ForeignMount = {
  readonly volume: string;
  readonly container: string;
  /** The container's name from its start event, or null when none was seen. */
  readonly name: string | null;
};

export interface MountMonitor {
  /**
   * End coverage: run an end marker and wait for its start event (the
   * engine emits events in order, so every earlier event has then been
   * read), stop the subscription, and return mounts of `volumeNames` by any
   * container that is not one of `helperNames`. Refuses, closed, when the
   * stream ended before it was stopped.
   */
  finish(volumeNames: readonly string[]): Promise<readonly ForeignMount[]>;
  /** Stop the subscription on any other path. Idempotent. */
  stop(): Promise<void>;
}

function lostCoverage(command: HelperPurpose, why: string): HackCliError {
  return new HackCliError({
    code: "E_DOCKER_UNAVAILABLE",
    message: `Hack lost its watch on Docker's volume events (${why}), so it cannot prove that nothing else used the volumes during the ${command}; ${command === "export" ? "the backup was not published" : "the restore is not marked complete"}. Check \`docker info\`, then retry.`,
  });
}

/**
 * Subscribe to volume mount and container start events, and return once the
 * subscription is proven live: a no-op marker container's start event has
 * arrived on it. Only then may the caller start copying. Helpers started
 * afterwards are seen live too, so their names identify our own mounts.
 * SIGINT/SIGTERM while it runs stops the subscription and force-removes
 * this run's helper containers by name before the process ends.
 */
export async function startMountMonitor(opts: {
  readonly docker: DataBackupDocker;
  readonly purpose: HelperPurpose;
  /** Every container this run owns; markers are added and removed here. */
  readonly helperNames: Set<string>;
  readonly deadlines: DataBackupDeadlines;
  readonly markerTimeoutMs?: number;
}): Promise<MountMonitor> {
  const names = new Map<string, string>();
  const started = new Set<string>();
  const mounts: { volume: string; container: string }[] = [];
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
    if (
      event.Type === "container" &&
      event.Action === "start" &&
      typeof attributes.name === "string"
    ) {
      names.set(actor.ID, attributes.name);
      started.add(attributes.name);
      waiting.get(attributes.name)?.();
    } else if (
      event.Type === "volume" &&
      event.Action === "mount" &&
      typeof attributes.container === "string"
    ) {
      mounts.push({ volume: actor.ID, container: attributes.container });
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
      // `docker run` client leaves its container running, so this run's
      // helpers are removed by exact name too.
      const helpers = [...opts.helperNames];
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
    const name = `${helperContainerName(opts.purpose)}-${stage}`;
    const seen = new Promise<void>((resolve) => {
      waiting.set(name, resolve);
    });
    const { commandMs } = opts.deadlines;
    await withTrackedContainer(
      {
        docker: opts.docker,
        container: name,
        deadlines: opts.deadlines,
        helperNames: opts.helperNames,
      },
      async () => {
        for (const argv of [
          [
            "docker",
            "create",
            "--name",
            name,
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
          ["docker", "start", name],
        ]) {
          // Creating may pull the pinned image once.
          const result = await opts.docker.capture(argv, {
            timeoutMs: argv[1] === "create" ? opts.deadlines.stepMs : commandMs,
          });
          requireStep({
            result,
            label: `${stage} marker`,
            action: argv[1] === "create" ? "create" : "start",
            timeoutMs: commandMs,
            consequence: "nothing was changed.",
            redactValues: opts.docker.redactValues,
          });
        }
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
        waiting.delete(name);
      }
    );
    if (ended) {
      throw lostCoverage(opts.purpose, "the event stream ended");
    }
    if (!started.has(name)) {
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
    async finish(volumeNames) {
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
      const watched = new Set(volumeNames);
      return mounts
        .filter((mount) => watched.has(mount.volume))
        .map((mount) => ({
          ...mount,
          name: names.get(mount.container) ?? null,
        }))
        .filter((mount) => !(mount.name && opts.helperNames.has(mount.name)));
    },
    stop,
  };
}

/** The refusal for mounts of target volumes by anything but our helpers. */
export function foreignMountError(opts: {
  readonly mounts: readonly ForeignMount[];
  readonly command: HelperPurpose;
  /** What the refusal leaves behind, as a sentence. */
  readonly consequence: string;
  readonly stopCommand: string;
}): HackCliError {
  const containers = [
    ...new Set(opts.mounts.map((mount) => mount.container.slice(0, 12))),
  ];
  return new HackCliError({
    code: "E_PROJECT_RUNNING",
    message: `Another container (${containers.join(", ")}) mounted a volume during the ${opts.command}, so the result may be inconsistent: ${opts.consequence} Make sure nothing uses the project's volumes (\`${opts.stopCommand}\`), then retry.`,
    detail: { mounts: opts.mounts },
  });
}
