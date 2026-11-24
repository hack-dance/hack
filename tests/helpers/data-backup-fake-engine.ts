import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { posix } from "node:path";
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
 * unless a test makes them differ. Containers behave as Docker's do: each
 * `docker create` returns a new unique ID, a name is unique among existing
 * containers (a create under a taken name fails) and is free again once the
 * container is removed, and every command accepts the ID, a 12+ character
 * ID prefix, or the name. Starts report to the live event stream.
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
  name: string;
  labels: Record<string, string>;
  /** Null for an event-stream marker, which mounts nothing. */
  volume: string | null;
  /**
   * The volume the bind reached when the container was created. A bind
   * keeps that directory even after the volume is removed and another is
   * created under its name, as on Docker.
   */
  bound?: FakeVolume;
  readOnly: boolean;
  running: boolean;
  /** `{{json .Mounts}}` of a foreign container; helpers derive theirs. */
  mounts?: readonly unknown[];
  /** The named volume a `--mount type=volume` references. */
  references?: string;
  /** A backing-proof helper's output, printed by `start --attach`. */
  proof?: DataBackupProcessResult;
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
let containerIds = 0;

/**
 * The short ID `docker ps --format {{.ID}}` prints for a running container
 * a test names in {@link FakeEngine.running}.
 */
export function fakePsId(name: string): string {
  return createHash("sha256").update(`ps:${name}`).digest("hex").slice(0, 12);
}

/** A new unique 64-hex container ID. */
export function fakeContainerId(): string {
  containerIds += 1;
  return createHash("sha256")
    .update(`fake-container-${containerIds}`)
    .digest("hex");
}

export class FakeEngine {
  model: unknown = { name: "shop", services: {}, volumes: {} };
  volumes = new Map<string, FakeVolume>();
  /** Existing containers by full ID. */
  containers = new Map<string, FakeContainer>();
  /** Every container `docker create` made, in order (removed ones too). */
  created: { readonly name: string; readonly id: string }[] = [];
  events = new FakeDockerEvents();
  /**
   * Running containers, by name, per `docker ps --filter <filter>`; `ps`
   * prints them in the requested `--format` (names, or {@link fakePsId}).
   */
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
  /** `docker rm` leaves these containers (full IDs) in place. */
  rmFails = new Set<string>();
  /** Extra content appended by an extract (a restore that differs). */
  extractAppends = "";
  /** Archive digests answered instead of the content's, per volume. */
  archiveDigestOverride: Record<string, string> = {};

  /**
   * Create a volume. Like Docker, it emits a volume `create` event on an
   * open subscription. A test may pass `createdAt` to model Docker's
   * one-second CreatedAt resolution (a same-second replacement).
   */
  volume(name: string, volume: FakeVolume): this {
    births += 1;
    this.volumes.set(name, {
      createdAt: `2026-11-24T00:00:${String(births).padStart(2, "0")}Z`,
      driver: "local",
      options: null,
      sockets: 0,
      ...volume,
    });
    this.events.volume("create", name);
    return this;
  }

  /**
   * `docker volume rm` as Docker does it (checked on Docker 29.9.2). While
   * a container references the volume by name, created or running, the
   * removal is refused ("volume is in use", `--force` included) and this
   * returns false. A bind of the Mountpoint is no reference: the removal
   * succeeds, inspect then fails, and a bind holder keeps a mount whose tree
   * is now empty.
   */
  removeVolume(name: string): boolean {
    if (this.referencing(name).length > 0) {
      return false;
    }
    const volume = this.volumes.get(name);
    if (volume) {
      // The local driver deletes the data under any bind holder.
      volume.content = "";
      volume.sockets = 0;
      this.volumes.delete(name);
      this.events.volume("destroy", name);
    }
    return true;
  }

  /**
   * Someone else removes every container that references `name` (Hack's
   * own reference included, by ID), then the volume.
   */
  forceRemoveVolume(name: string): void {
    for (const id of this.referencing(name)) {
      this.containers.delete(id);
    }
    this.removeVolume(name);
  }

  /** IDs of the containers that reference the volume `name` by name. */
  referencing(name: string): string[] {
    return [...this.containers]
      .filter(([, container]) => container.references === name)
      .map(([id]) => id);
  }

  /** `{{json .Mounts}}` of a container. */
  private mountsOf(held: FakeContainer): readonly unknown[] {
    if (held.mounts !== undefined) {
      return held.mounts;
    }
    return held.volume === null
      ? []
      : [
          {
            Type: "bind",
            Source: `/var/lib/docker/volumes/${held.volume}/_data`,
            Destination: "/v",
            RW: !held.readOnly,
          },
        ];
  }

  /**
   * A container that is already running when the run starts (no start
   * event), with `mounts` as `docker container inspect` reports them.
   */
  runningContainer(name: string, mounts: readonly unknown[]): string {
    const id = fakeContainerId();
    this.containers.set(id, {
      name,
      labels: {},
      volume: null,
      readOnly: true,
      running: true,
      mounts,
    });
    return id;
  }

  /**
   * The daemon's view of host paths, for the backing-proof helper: a path
   * that is a symlink resolves to its target (longest prefix first), a
   * `/proc/self/root` prefix names the daemon's own root, and a missing path
   * cannot be bound.
   */
  symlinks = new Map<string, string>();
  missingPaths = new Set<string>();
  /** The proof helper fails (exit 1) instead of answering. */
  proofFails = false;

  /** A host path as the daemon resolves it when it bind-mounts it. */
  daemonRealpath(path: string): string {
    let current = posix.normalize(path);
    for (let step = 0; step < 32; step += 1) {
      if (
        current === "/proc/self/root" ||
        current.startsWith("/proc/self/root/")
      ) {
        current = posix.normalize(
          current.slice("/proc/self/root".length) || "/"
        );
        continue;
      }
      const link = [...this.symlinks.keys()]
        .filter((from) => current === from || current.startsWith(`${from}/`))
        .sort((a, b) => b.length - a.length)[0];
      if (link === undefined) {
        break;
      }
      current = posix.normalize(
        `${this.symlinks.get(link) ?? ""}${current.slice(link.length)}`
      );
    }
    return current.length > 1 && current.endsWith("/")
      ? current.slice(0, -1)
      : current;
  }

  /** The answer of the proof helper for these bind mounts. */
  private proofOf(binds: readonly { src: string; dst: string }[]) {
    if (this.proofFails) {
      return fail("proof helper error", 1);
    }
    const within = (path: string, root: string) =>
      root === "/" || path === root || path.startsWith(`${root}/`);
    const owned = binds.filter((bind) => bind.dst.startsWith("/o/"));
    const results: Record<string, string[]> = {};
    for (const bind of binds.filter((one) => one.dst.startsWith("/c/"))) {
      const candidate = this.daemonRealpath(bind.src);
      results[bind.dst.slice(3)] = owned
        .filter((own) => {
          const real = this.daemonRealpath(own.src);
          return within(real, candidate) || within(candidate, real);
        })
        .map((own) => own.dst.slice(3));
    }
    return ok(`${JSON.stringify({ results })}\n`);
  }

  /** IDs of the containers that still exist. */
  leftovers(): string[] {
    return [...this.containers.keys()];
  }

  /** The full ID a reference (ID, 12+ character prefix or name) names. */
  resolve(ref: string): string | null {
    if (this.containers.has(ref)) {
      return ref;
    }
    for (const [id, container] of this.containers) {
      if (container.name === ref || (ref.length >= 12 && id.startsWith(ref))) {
        return id;
      }
    }
    return null;
  }

  /**
   * A short-lived container someone else creates and starts outside the
   * run: it emits its start event (like a bind, no mount event) and exits at
   * once, so no running check lists it, but it still exists and can be
   * inspected, with `mounts` as `docker container inspect` reports them.
   * Returns null, as Docker refuses, when the name is taken.
   */
  createForeign(name: string, mounts: readonly unknown[] = []): string | null {
    if (this.resolve(name) !== null) {
      return null;
    }
    const id = fakeContainerId();
    this.containers.set(id, {
      name,
      labels: {},
      volume: null,
      readOnly: true,
      running: false,
      mounts,
    });
    this.events.start(id, name);
    return id;
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
    const id = this.resolve(container);
    const held = id === null ? undefined : this.containers.get(id);
    const volume = held?.volume
      ? (held.bound ?? this.volumes.get(held.volume))
      : undefined;
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
      redactValues: [],
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
      // Several names: one line per volume Docker has; a missing one fails
      // the call after printing the others, as Docker does.
      const names = args.slice(args.indexOf("--format") + 2);
      if (names.length > 1) {
        const found = names.map((name) => this.inspectVolume(name));
        return {
          exitCode: found.some((one) => one.exitCode !== 0) ? 1 : 0,
          stdout: found
            .map((one) => one.stdout)
            .filter(Boolean)
            .join("\n"),
          stderr: found
            .map((one) => one.stderr)
            .filter(Boolean)
            .join("\n"),
        };
      }
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
    if (args[0] === "ps" && args.includes("--quiet")) {
      // Every running container, by full ID.
      return ok(
        [...this.containers]
          .filter(([, container]) => container.running)
          .map(([id]) => `${id}\n`)
          .join("")
      );
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
      const format = args[args.indexOf("--format") + 1] ?? "";
      const shown = format === "{{.ID}}" ? names.map(fakePsId) : names;
      return ok(shown.map((n) => `${n}\n`).join(""));
    }
    if (args[0] === "run") {
      return fail("data commands never use docker run", 99);
    }
    if (args[0] === "create") {
      const name = args[args.indexOf("--name") + 1] ?? "";
      if (this.resolve(name) !== null) {
        return fail(
          `Error response from daemon: Conflict. The container name "/${name}" is already in use.`
        );
      }
      const labels: Record<string, string> = {};
      args.forEach((value, index) => {
        if (value === "--label") {
          const [key, ...rest] = (args[index + 1] ?? "").split("=");
          labels[key ?? ""] = rest.join("=");
        }
      });
      const binds = args.flatMap((value, index) =>
        value === "--mount"
          ? [
              {
                src: /src=([^,]+)/.exec(args[index + 1] ?? "")?.[1] ?? "",
                dst: /dst=([^,]+)/.exec(args[index + 1] ?? "")?.[1] ?? "",
              },
            ]
          : []
      );
      if (binds.some((bind) => bind.dst.startsWith("/c/"))) {
        // The backing-proof helper: any existing path binds.
        const missing = binds.find((bind) =>
          this.missingPaths.has(posix.normalize(bind.src))
        );
        if (missing) {
          return fail(
            `Error response from daemon: invalid mount config for type "bind": bind source path does not exist: ${missing.src}`
          );
        }
        const id = fakeContainerId();
        this.created.push({ name, id });
        this.containers.set(id, {
          name,
          labels,
          volume: null,
          readOnly: true,
          running: false,
          proof: this.proofOf(binds),
        });
        return ok(`${id}\n`);
      }
      const mount = args.includes("--mount")
        ? (args[args.indexOf("--mount") + 1] ?? "")
        : null;
      let volume: string | null = null;
      let references: string | undefined;
      if (mount?.startsWith("type=volume,")) {
        // A reference by name. Docker creates a missing named volume, unless
        // the mount names driver options the local driver refuses to create
        // with (a `type` without `device`), as Hack's reference does.
        references = /src=([^,]+)/.exec(mount)?.[1] ?? "";
        if (!this.volumes.has(references)) {
          if (mount.includes("volume-opt=type=")) {
            return fail(
              `Error response from daemon: create ${references}: missing required option: "device"`
            );
          }
          this.volume(references, { labels: {}, content: "" });
        }
      } else if (mount !== null) {
        // A bind of a Mountpoint: a missing path fails, nothing is created.
        const src = /src=([^,]+)/.exec(mount)?.[1] ?? "";
        volume =
          [...this.volumes.keys()].find(
            (candidate) => `/var/lib/docker/volumes/${candidate}/_data` === src
          ) ?? null;
        if (volume === null) {
          return fail(
            `Error response from daemon: invalid mount config for type "bind": bind source path does not exist: ${src}`
          );
        }
      }
      const id = fakeContainerId();
      this.created.push({ name, id });
      this.containers.set(id, {
        name,
        labels,
        volume,
        bound: volume === null ? undefined : this.volumes.get(volume),
        readOnly: mount?.includes(",readonly") ?? true,
        running: false,
        references,
      });
      return ok(`${id}\n`);
    }
    if (args[0] === "start") {
      const ref = argv.at(-1) ?? "";
      const id = this.resolve(ref);
      const held = id === null ? undefined : this.containers.get(id);
      if (id === null || !held) {
        return fail(`Error response from daemon: No such container: ${ref}`);
      }
      const exit = this.startExit?.(held.name);
      if (exit !== undefined) {
        return fail("start did not finish", exit);
      }
      if (held.proof !== undefined) {
        // `start --attach`: runs to completion and prints its output.
        this.events.start(id, held.name);
        return held.proof;
      }
      held.running = true;
      // A bind mount emits no volume mount event, only the start.
      this.events.start(id, held.name);
      this.events.afterRun?.(["docker", "start", id]);
      return ok(`${ref}\n`);
    }
    if (
      args[0] === "container" &&
      args[1] === "inspect" &&
      args.includes("{{.Id}} {{json .Mounts}}")
    ) {
      // Batched: one line per container Docker knows; a missing one fails
      // the call after printing the others, as Docker does.
      const refs = args.slice(args.indexOf("--format") + 2);
      const lines: string[] = [];
      let missing = false;
      for (const ref of refs) {
        const id = this.resolve(ref);
        const held = id === null ? undefined : this.containers.get(id);
        if (id === null || !held) {
          missing = true;
          continue;
        }
        lines.push(`${id} ${JSON.stringify(this.mountsOf(held))}\n`);
      }
      return {
        exitCode: missing ? 1 : 0,
        stdout: lines.join(""),
        stderr: missing ? "Error: No such container" : "",
      };
    }
    if (args[0] === "container" && args[1] === "inspect") {
      const ref = argv.at(-1) ?? "";
      const id = this.resolve(ref);
      const held = id === null ? undefined : this.containers.get(id);
      if (id === null || !held) {
        return fail(`Error: No such container: ${ref}`);
      }
      if (argv.includes("{{json .Mounts}}")) {
        return ok(`${JSON.stringify(this.mountsOf(held))}\n`);
      }
      const format = argv[argv.indexOf("--format") + 1] ?? "";
      const nonce = /index \.Config\.Labels "([^"]+)"/.exec(format)?.[1];
      return ok(
        nonce === undefined
          ? `${id}\n`
          : `${id} ${held.labels[nonce] ?? "<no value>"}\n`
      );
    }
    if (args[0] === "rm") {
      const refs = args.slice(1).filter((arg) => !arg.startsWith("-"));
      let failed = false;
      for (const ref of refs) {
        const id = this.resolve(ref);
        if (id === null) {
          failed = true;
        } else if (this.rmFails.has(id)) {
          failed = true;
        } else {
          this.containers.delete(id);
        }
      }
      return failed ? fail("Error: cannot remove") : ok(refs.join("\n"));
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
