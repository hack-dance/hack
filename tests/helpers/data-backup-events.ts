import type { DataBackupWatch } from "../../src/lib/data-backup-docker.ts";

/**
 * A fake live `docker events` stream for data export/import tests. Every
 * `docker run` a fake engine records through {@link FakeDockerEvents.run}
 * emits, on the open subscription, a mount event per `--volume` and then the
 * container's start event, in the order a real engine does. Tests can inject
 * extra events, end the stream as if the events child died, or suppress
 * start events so coverage is never established.
 */
export class FakeDockerEvents {
  private listener: ((line: string) => void) | null = null;
  private close: (() => void) | null = null;
  private next = 0;
  watches = 0;
  stopped = 0;
  /** False: start events are never delivered (the subscription is not live). */
  deliverStarts = true;
  /** False: volume create/destroy events are dropped (only rechecks see it). */
  deliverVolumeChanges = true;
  /** Called after each run's own events, e.g. to inject a foreign writer. */
  afterRun: ((argv: readonly string[]) => void) | null = null;

  get open(): boolean {
    return this.listener !== null;
  }

  watch(
    _argv: readonly string[],
    onLine: (line: string) => void
  ): DataBackupWatch {
    this.watches += 1;
    this.listener = onLine;
    const done = new Promise<{ exitCode: number }>((resolve) => {
      this.close = () => resolve({ exitCode: 0 });
    });
    return {
      done,
      stop: () => {
        if (this.listener) {
          this.stopped += 1;
        }
        this.end();
        return done.then(() => undefined);
      },
    };
  }

  /** The stream closes as if the events child exited on its own. */
  end(): void {
    this.listener = null;
    this.close?.();
    this.close = null;
  }

  emit(event: unknown): void {
    this.listener?.(JSON.stringify(event));
  }

  mount(volume: string, container: string): void {
    this.emit({
      Type: "volume",
      Action: "mount",
      Actor: { ID: volume, Attributes: { container, destination: "/v" } },
    });
  }

  /** A volume `create` or `destroy`; Docker names the volume in Actor.ID. */
  volume(action: "create" | "destroy", name: string): void {
    if (!this.deliverVolumeChanges) {
      return;
    }
    this.emit({
      Type: "volume",
      Action: action,
      Actor: { ID: name, Attributes: { driver: "local" } },
    });
  }

  start(container: string, name: string): void {
    if (this.deliverStarts) {
      this.emit({
        Type: "container",
        Action: "start",
        Actor: { ID: container, Attributes: { name } },
      });
    }
  }

  /** Record a `docker run`: its mounts, then its start, then `afterRun`. */
  run(argv: readonly string[]): string {
    this.next += 1;
    const id = `${String(this.next).padStart(4, "0")}${"a".repeat(60)}`;
    argv.forEach((value, index) => {
      if (value === "--volume") {
        const mount = argv[index + 1] ?? "";
        this.mount(mount.slice(0, mount.indexOf(":")), id);
      }
    });
    this.start(id, argv[argv.indexOf("--name") + 1] ?? "");
    this.afterRun?.(argv);
    return id;
  }
}
