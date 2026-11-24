import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import type {
  DataBackupDocker,
  DataBackupProcessResult,
} from "../../src/lib/data-backup-docker.ts";
import { DATA_BACKUP_TIMEOUT_EXIT } from "../../src/lib/data-backup-docker.ts";
import { FakeDockerEvents } from "./data-backup-events.ts";

/**
 * A synthetic Docker engine for `hack data` unit tests. Volumes hold one
 * string of content; a tar of a volume is the file `tar:<content>`, and every
 * digest (live tree or archive) is the sha256 of the content, so they agree
 * unless a test makes them differ. Helper containers are created, started,
 * exec'd into and removed by name, as the real flow does, and `docker run`
 * markers report to the live event stream.
 */
export type FakeVolume = {
  labels: Record<string, string>;
  content: string;
  createdAt?: string;
  driver?: string;
  options?: Record<string, string> | null;
  /** Unix sockets in the tree: excluded from digests, counted. */
  sockets?: number;
};

type FakeContainer = {
  /** Null for an event-stream marker, which mounts nothing. */
  volume: string | null;
  readOnly: boolean;
  running: boolean;
};

export const COMPOSE = [
  "docker",
  "compose",
  "-f",
  "/p/.hack/docker-compose.yml",
];

const sha = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

function ok(stdout = ""): DataBackupProcessResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function fail(stderr: string, exitCode = 1): DataBackupProcessResult {
  return { exitCode, stdout: "", stderr };
}

let births = 0;

export class FakeEngine {
  model: unknown = { name: "shop", services: {}, volumes: {} };
  volumes = new Map<string, FakeVolume>();
  containers = new Map<string, FakeContainer>();
  events = new FakeDockerEvents();
  /** `docker ps --filter <filter>` answers. */
  running: Record<string, string[]> = {};
  calls: string[][] = [];
  psCalls = 0;
  /** Hooks a test sets to inject a race or a failure. */
  onPs: (() => void) | null = null;
  onExec: ((container: string, args: readonly string[]) => void) | null = null;
  beforeVolumeCreate: ((name: string) => void) | null = null;
  /** Running names reported from the Nth `ps` call on (0-based). */
  runningFromCall: { call: number; filter: string; names: string[] } | null =
    null;
  /** Exit code of the tar stream: 124 is a timeout. */
  tarExit: Record<string, number> = {};
  /** The tar stream throws (a full disk) for these volumes. */
  tarThrows: Record<string, Error> = {};
  /** A `docker start` answer instead of success (124 timeout, 130 interrupt). */
  startExit: ((name: string) => number | undefined) | null = null;
  /** `docker rm` leaves these containers in place. */
  rmFails = new Set<string>();
  /** Extra content appended by an extract (a restore that differs). */
  extractAppends = "";
  /** Archive digests answered instead of the content's, per volume. */
  archiveDigestOverride: Record<string, string> = {};

  volume(name: string, volume: FakeVolume): this {
    births += 1;
    this.volumes.set(name, {
      createdAt: `2026-11-24T00:00:${String(births).padStart(2, "0")}Z`,
      driver: "local",
      options: null,
      sockets: 0,
      ...volume,
    });
    return this;
  }

  /** Containers this run created that still exist. */
  leftovers(): string[] {
    return [...this.containers.keys()];
  }

  private inspectVolume(name: string): DataBackupProcessResult {
    const volume = this.volumes.get(name);
    if (!volume) {
      return fail(`Error response from daemon: get ${name}: no such volume`);
    }
    return ok(
      JSON.stringify({
        name,
        createdAt: volume.createdAt,
        driver: volume.driver,
        mountpoint: `/var/lib/docker/volumes/${name}/_data`,
        options: volume.options,
        labels: volume.labels,
      })
    );
  }

  private exec(container: string, args: readonly string[]) {
    const held = this.containers.get(container);
    const volume = held?.volume ? this.volumes.get(held.volume) : undefined;
    this.onExec?.(container, args);
    return { held, volume };
  }

  private digest(volume: FakeVolume): DataBackupProcessResult {
    return ok(
      `${JSON.stringify({
        algorithm: "hack.tree-digest.v1",
        entries: 3,
        excludedSockets: volume.sockets ?? 0,
        digest: sha(volume.content),
      })}\n`
    );
  }

  docker(): DataBackupDocker {
    return {
      capture: (argv) => Promise.resolve(this.capture(argv)),
      streamToFile: async ({ argv, path }) => {
        this.calls.push([...argv]);
        const container = argv[argv.indexOf("exec") + 1] ?? "";
        const { held, volume } = this.exec(container, argv.slice(3));
        if (!(held?.running && volume)) {
          return { exitCode: 1, stderr: "no container", bytes: 0, sha256: "" };
        }
        const thrown = this.tarThrows[held.volume ?? ""];
        const bytes = Buffer.from(`tar:${volume.content}`);
        await writeFile(path, thrown ? bytes.subarray(0, 2) : bytes, {
          flag: "wx",
          mode: 0o600,
        });
        if (thrown) {
          throw thrown;
        }
        return {
          exitCode: this.tarExit[held.volume ?? ""] ?? 0,
          stderr: "",
          bytes: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        };
      },
      streamFromFile: async ({ argv, path }) => {
        this.calls.push([...argv]);
        const container = argv[argv.indexOf("exec") + 2] ?? "";
        const { held, volume } = this.exec(container, argv.slice(4));
        if (!(held?.running && volume)) {
          return fail("no container");
        }
        const text = await readFile(path, "utf8");
        const content = text.startsWith("tar:") ? text.slice(4) : `!${text}`;
        if (argv.includes("-xpf")) {
          volume.content += `${content}${this.extractAppends}`;
          return ok();
        }
        // The archive digest: parse the "tar" and digest what it holds.
        return ok(
          `${JSON.stringify({
            algorithm: "hack.tree-digest.v1",
            entries: 3,
            excludedSockets: 0,
            digest:
              this.archiveDigestOverride[held.volume ?? ""] ?? sha(content),
          })}\n`
        );
      },
      watch: (argv, onLine) => this.events.watch(argv, onLine),
    };
  }

  capture(argv: readonly string[]): DataBackupProcessResult {
    this.calls.push([...argv]);
    const args = argv.slice(1);
    if (argv.slice(0, COMPOSE.length).join(" ") === COMPOSE.join(" ")) {
      return ok(JSON.stringify(this.model));
    }
    if (args.join(" ") === "compose version --short") {
      return ok("2.29.7\n");
    }
    if (args[0] === "volume" && args[1] === "inspect") {
      return this.inspectVolume(argv.at(-1) ?? "");
    }
    if (args[0] === "volume" && args[1] === "create") {
      const name = argv.at(-1) ?? "";
      this.beforeVolumeCreate?.(name);
      if (!this.volumes.has(name)) {
        const labels: Record<string, string> = {};
        args.forEach((value, index) => {
          if (value === "--label") {
            const [key, ...rest] = (args[index + 1] ?? "").split("=");
            labels[key ?? ""] = rest.join("=");
          }
        });
        this.volume(name, { labels, content: "" });
      }
      return ok(`${name}\n`);
    }
    if (args[0] === "ps") {
      this.onPs?.();
      const filter = args[args.indexOf("--filter") + 1] ?? "";
      const late = this.runningFromCall;
      const call = this.psCalls;
      this.psCalls += 1;
      const names = [
        ...(this.running[filter] ?? []),
        ...(late && late.filter === filter && call >= late.call
          ? late.names
          : []),
      ];
      return ok(names.map((n) => `${n}\n`).join(""));
    }
    if (args[0] === "run") {
      return fail("data commands never use docker run", 99);
    }
    if (args[0] === "create") {
      const name = args[args.indexOf("--name") + 1] ?? "";
      const mount = args.includes("--volume")
        ? (args[args.indexOf("--volume") + 1] ?? "")
        : null;
      const volume = mount === null ? null : mount.slice(0, mount.indexOf(":"));
      if (volume !== null && !this.volumes.has(volume)) {
        // Like Docker: mounting a missing name creates an empty volume.
        this.volume(volume, { labels: {}, content: "" });
      }
      this.containers.set(name, {
        volume,
        readOnly: mount?.endsWith(":ro") ?? true,
        running: false,
      });
      return ok(`${"c".repeat(64)}\n`);
    }
    if (args[0] === "start") {
      const name = argv.at(-1) ?? "";
      const held = this.containers.get(name);
      if (!held) {
        return fail(`Error response from daemon: No such container: ${name}`);
      }
      const exit = this.startExit?.(name);
      if (exit !== undefined) {
        return fail("start did not finish", exit);
      }
      held.running = true;
      this.events.run([
        "docker",
        "run",
        "--name",
        name,
        ...(held.volume ? ["--volume", `${held.volume}:/v`] : []),
      ]);
      return ok(`${name}\n`);
    }
    if (args[0] === "container" && args[1] === "inspect") {
      const name = argv.at(-1) ?? "";
      const held = this.containers.get(name);
      if (!held) {
        return fail(`Error: No such container: ${name}`);
      }
      if (argv.includes("{{json .Mounts}}")) {
        return ok(
          `${JSON.stringify([
            {
              Type: "volume",
              Name: held.volume,
              Source: `/var/lib/docker/volumes/${held.volume}/_data`,
              Destination: "/v",
              RW: !held.readOnly,
            },
          ])}\n`
        );
      }
      return ok(`${"c".repeat(64)}\n`);
    }
    if (args[0] === "rm") {
      const name = argv.at(-1) ?? "";
      if (!this.rmFails.has(name)) {
        this.containers.delete(name);
      }
      return this.rmFails.has(name) ? fail("Error: cannot remove") : ok(name);
    }
    if (args[0] === "exec") {
      const container = args[1] ?? "";
      const { held, volume } = this.exec(container, args.slice(2));
      if (!(held?.running && volume)) {
        return fail(`Error: No such container: ${container}`);
      }
      if (argv.includes("-e")) {
        return this.digest(volume);
      }
      if (argv.includes("-quit")) {
        return ok(volume.content ? "/v/x\n" : "");
      }
      if (argv.includes("-delete")) {
        volume.content = "";
        return ok();
      }
      return fail("unknown exec", 99);
    }
    return fail("unknown", 99);
  }
}

export const FAKE_TIMEOUT_EXIT = DATA_BACKUP_TIMEOUT_EXIT;
