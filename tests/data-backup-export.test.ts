import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  renderDataExportText,
  requireComposeBackendForData,
} from "../src/commands/data.ts";
import { HackCliError } from "../src/lib/cli-result.ts";
import type {
  DataBackupDocker,
  DataBackupProcessResult,
} from "../src/lib/data-backup-docker.ts";
import {
  type DataExportInput,
  exportProjectData,
} from "../src/lib/data-backup-export.ts";
import {
  DATA_BACKUP_DIGEST_SCRIPT,
  dataBackupHelperImage,
  dataBackupTimestamp,
} from "../src/lib/data-backup-format.ts";
import { planDeclaredVolumes } from "../src/lib/data-backup-volumes.ts";
import { FakeDockerEvents } from "./helpers/data-backup-events.ts";

const PROJECT = "shop";
const COMPOSE = ["docker", "compose", "-f", "/p/.hack/docker-compose.yml"];
const NOW = new Date("2026-11-23T14:05:01.250Z");
const PINNED =
  "oven/bun@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4";

type FakeVolume = {
  readonly driver?: string;
  readonly labels: Record<string, string> | null;
};

type FakeState = {
  model: unknown;
  volumes: Record<string, FakeVolume>;
  /** `docker ps --filter <filter>` → names, per call index of that filter. */
  running: Record<string, string[]>;
  /** Running names reported only from the Nth `ps` round on (0-based). */
  runningFromRound?: { round: number; filter: string; names: string[] };
  failTarFor?: string;
  /** The live event stream every `docker run` reports to. */
  events: FakeDockerEvents;
  /** Called on each `docker ps`, e.g. to inject a mount right after a check. */
  onPs?: () => void;
  calls: string[][];
  /** Helper runs seen, in order (markers included). */
  helpers?: { id: string; name: string; volume: string }[];
};

function helperRun(state: FakeState, argv: readonly string[]): string {
  state.helpers ??= [];
  const name = argv[argv.indexOf("--name") + 1] ?? "";
  const volume = argv.includes("--volume") ? mountedVolume(argv) : "";
  const id = state.events.run(argv);
  state.helpers.push({ id, name, volume });
  return volume;
}

function ok(stdout = ""): DataBackupProcessResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function owned(key: string, project = PROJECT): FakeVolume {
  return {
    labels: {
      "com.docker.compose.project": project,
      "com.docker.compose.volume": key,
    },
  };
}

function fakeDocker(state: FakeState): DataBackupDocker {
  let psCalls = 0;
  return {
    capture(argv) {
      state.calls.push([...argv]);
      const args = argv.slice(1);
      if (argv.slice(0, COMPOSE.length).join(" ") === COMPOSE.join(" ")) {
        return Promise.resolve(ok(JSON.stringify(state.model)));
      }
      if (args[0] === "volume" && args[1] === "inspect") {
        const name = argv.at(-1) ?? "";
        const volume = state.volumes[name];
        if (!volume) {
          return Promise.resolve({
            exitCode: 1,
            stdout: "",
            stderr: `Error response from daemon: get ${name}: no such volume`,
          });
        }
        return Promise.resolve(
          ok(
            JSON.stringify({
              name,
              driver: volume.driver ?? "local",
              labels: volume.labels,
            })
          )
        );
      }
      if (args[0] === "ps") {
        state.onPs?.();
        const filter = args[args.indexOf("--filter") + 1] ?? "";
        const late = state.runningFromRound;
        const round = Math.floor(psCalls / psFilterCount(state));
        psCalls += 1;
        const names = [
          ...(state.running[filter] ?? []),
          ...(late && late.filter === filter && round >= late.round
            ? late.names
            : []),
        ];
        return Promise.resolve(ok(names.map((n) => `${n}\n`).join("")));
      }
      if (args[0] === "run") {
        const volume = helperRun(state, argv);
        if (argv.includes("true")) {
          return Promise.resolve(ok());
        }
        return Promise.resolve(
          ok(
            `${JSON.stringify({
              algorithm: "hack.tree-digest.v1",
              entries: 3,
              excludedSockets: volume === "shop_db" ? 1 : 0,
              digest: createHash("sha256").update(volume).digest("hex"),
            })}\n`
          )
        );
      }
      return Promise.resolve({ exitCode: 99, stdout: "", stderr: "" });
    },
    async streamToFile({ argv, path }) {
      state.calls.push([...argv]);
      const volume = helperRun(state, argv);
      const bytes = Buffer.from(`tar of ${volume}`);
      await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
      if (state.failTarFor === volume) {
        return { exitCode: 2, stderr: "tar: boom", bytes: 1, sha256: "x" };
      }
      return {
        exitCode: 0,
        stderr: "",
        bytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    },
    streamFromFile: () => Promise.reject(new Error("export never extracts")),
    watch: (argv, onLine) => state.events.watch(argv, onLine),
  };
}

/** One ps round = the project filter plus one per owned volume. */
function psFilterCount(state: FakeState): number {
  return (
    1 +
    Object.entries(state.volumes).filter(
      ([, volume]) => volume.labels?.["com.docker.compose.project"] === PROJECT
    ).length
  );
}

function mountedVolume(argv: readonly string[]): string {
  const mount = argv[argv.indexOf("--volume") + 1] ?? "";
  return mount.slice(0, mount.indexOf(":"));
}

function model(volumes: Record<string, unknown>): unknown {
  return { name: PROJECT, services: {}, volumes };
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hack-data-backup-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function input(state: FakeState, extra: Partial<DataExportInput> = {}) {
  return {
    docker: fakeDocker(state),
    composeArgs: COMPOSE,
    project: PROJECT,
    branch: null,
    hackHome: join(root, "home"),
    hackVersion: "9.9.9",
    now: () => NOW,
    ...extra,
  } satisfies DataExportInput;
}

function baseState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    model: model({
      db: { name: "shop_db" },
      cache: { name: "custom-cache" },
      shared: { name: "team-shared", external: true },
      later: { name: "shop_later" },
      hijacked: { name: "other_thing" },
    }),
    volumes: {
      shop_db: owned("db"),
      "custom-cache": owned("cache"),
      other_thing: owned("thing", "other"),
      "team-shared": owned("shared", "team"),
    },
    running: {},
    calls: [],
    events: new FakeDockerEvents(),
    ...overrides,
  };
}

async function caught(promise: Promise<unknown>): Promise<HackCliError> {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof HackCliError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected a HackCliError");
}

describe("planDeclaredVolumes", () => {
  test("maps keys to Docker names, sorts them and skips external volumes", () => {
    const plan = planDeclaredVolumes(
      model({
        web: {},
        db: { name: "custom" },
        shared: { external: true, name: "shared-net-data" },
      })
    );
    expect(plan.composeProject).toBe(PROJECT);
    expect(plan.declared).toEqual([
      { key: "db", name: "custom" },
      { key: "web", name: "shop_web" },
    ]);
    expect(plan.external).toEqual([
      { key: "shared", name: "shared-net-data", reason: "external" },
    ]);
  });

  test("a model without volumes declares none", () => {
    expect(
      planDeclaredVolumes({ name: PROJECT, services: {} }).declared
    ).toEqual([]);
  });

  test("refuses a model whose names are not plain file names", () => {
    for (const bad of [
      { name: "../x", volumes: {} },
      { name: PROJECT, volumes: { "../etc": {} } },
      { name: PROJECT, volumes: { db: { name: "a/b" } } },
      null,
    ]) {
      expect(() => planDeclaredVolumes(bad)).toThrow(HackCliError);
    }
  });
});

describe("exportProjectData", () => {
  test("backs up only owned volumes and reports external, foreign and absent ones", async () => {
    const state = baseState();
    const result = await exportProjectData(input(state));
    const backup = join(
      root,
      "home",
      "data-backups",
      PROJECT,
      "20261123T140501Z"
    );
    expect(result.backup).toBe(backup);
    expect((await readdir(backup)).sort()).toEqual([
      "cache.tar",
      "db.tar",
      "manifest.json",
    ]);
    expect(await readdir(join(root, "home", "data-backups", PROJECT))).toEqual([
      "20261123T140501Z",
    ]);
    const manifest = JSON.parse(
      await readFile(join(backup, "manifest.json"), "utf8")
    );
    expect(manifest).toEqual(result.manifest);
    expect(manifest).toMatchObject({
      schema: "hack.data-backup.v1",
      project: PROJECT,
      branch: null,
      composeProject: PROJECT,
      createdAt: "2026-11-23T14:05:01.250Z",
      hackVersion: "9.9.9",
      helperImage: PINNED,
      digestAlgorithm: "hack.tree-digest.v1",
    });
    expect(manifest.volumes.map((v: { key: string }) => v.key)).toEqual([
      "cache",
      "db",
    ]);
    const db = manifest.volumes[1];
    const tar = await readFile(join(backup, "db.tar"));
    expect(db).toEqual({
      key: "db",
      name: "shop_db",
      driver: "local",
      labels: {
        "com.docker.compose.project": PROJECT,
        "com.docker.compose.volume": "db",
      },
      file: "db.tar",
      tarBytes: tar.byteLength,
      tarSha256: createHash("sha256").update(tar).digest("hex"),
      entries: 3,
      excludedSockets: 1,
      contentDigest: createHash("sha256").update("shop_db").digest("hex"),
    });
    expect(manifest.skipped).toEqual([
      { key: "hijacked", name: "other_thing", reason: "foreign" },
      { key: "later", name: "shop_later", reason: "absent" },
      { key: "shared", name: "team-shared", reason: "external" },
    ]);
    // Foreign and external volumes are never mounted; external is never inspected.
    const mounted = state.calls
      .filter((argv) => argv[1] === "run" && argv.includes("--volume"))
      .map(mountedVolume);
    expect(new Set(mounted)).toEqual(new Set(["shop_db", "custom-cache"]));
    expect(
      state.calls.some((argv) => argv.includes("team-shared"))
    ).toBeFalse();
    expect(renderDataExportText(result)).toBe(
      [
        "Backed up 2 volumes:",
        `  cache  ${"tar of custom-cache".length} B  3 entries`,
        `  db  ${"tar of shop_db".length} B  3 entries, 1 socket not copied`,
        "Skipped:",
        "  hijacked  labels name another project, not read",
        "  later  not created yet, nothing to back up",
        "  shared  external, not managed by this project",
        `Backup: ${backup}`,
        "",
      ].join("\n")
    );
  });

  test("a volume labeled for this project but another key is foreign", async () => {
    const state = baseState({
      model: model({ db: { name: "shop_db" } }),
      volumes: { shop_db: owned("cache") },
    });
    const result = await exportProjectData(input(state));
    expect(result.manifest.volumes).toEqual([]);
    expect(result.manifest.skipped).toEqual([
      { key: "db", name: "shop_db", reason: "foreign" },
    ]);
  });

  test("every helper is network-less, read-only and uses the pinned image", async () => {
    const state = baseState({
      model: model({ db: { name: "shop_db" } }),
      volumes: { shop_db: owned("db") },
    });
    await exportProjectData(input(state));
    const runs = state.calls.filter(
      (argv) => argv[1] === "run" && argv.includes("--volume")
    );
    expect(runs).toHaveLength(2);
    for (const argv of runs) {
      expect(argv.slice(0, 3)).toEqual(["docker", "run", "--rm"]);
      expect(argv[argv.indexOf("--name") + 1]).toMatch(
        /^hack-data-export-[a-f0-9]{24}$/
      );
      expect(argv[argv.indexOf("--network") + 1]).toBe("none");
      expect(argv).toContain("--read-only");
      expect(argv[argv.indexOf("--volume") + 1]).toBe("shop_db:/v:ro");
      expect(argv).toContain(PINNED);
    }
    expect(dataBackupHelperImage()).toBe(PINNED);
    const [tar, digest] = runs;
    expect(tar?.slice(tar.indexOf(PINNED) + 1)).toEqual([
      "--numeric-owner",
      "-cpf",
      "-",
      "-C",
      "/v",
      ".",
    ]);
    expect(digest?.at(-1)).toBe(DATA_BACKUP_DIGEST_SCRIPT);
  });

  test("refuses while a project container runs and writes nothing", async () => {
    const state = baseState({
      running: {
        [`label=com.docker.compose.project=${PROJECT}`]: ["shop-web-1"],
      },
    });
    const error = await caught(
      exportProjectData(input(state, { downCommand: "hack down --branch=x" }))
    );
    expect(error.code).toBe("E_PROJECT_RUNNING");
    expect(error.message).toContain("`hack down --branch=x`");
    expect(error.detail).toEqual({ running: ["shop-web-1"] });
    expect(
      state.calls.some((argv) => argv[1] === "run" && argv.includes("--volume"))
    ).toBeFalse();
    expect(state.events.open).toBeFalse();
    expect(await readdir(root)).toEqual([]);
  });

  test("refuses while another container mounts an owned volume", async () => {
    const state = baseState({
      running: { "volume=shop_db": ["adhoc-debug"] },
    });
    const error = await caught(exportProjectData(input(state)));
    expect(error.code).toBe("E_PROJECT_RUNNING");
    expect(error.detail).toEqual({ running: ["adhoc-debug"] });
  });

  test("a container that starts during the copy keeps the backup unpublished", async () => {
    const state = baseState({
      model: model({ db: { name: "shop_db" } }),
      volumes: { shop_db: owned("db") },
      runningFromRound: {
        round: 1,
        filter: `label=com.docker.compose.project=${PROJECT}`,
        names: ["shop-web-1"],
      },
    });
    const error = await caught(exportProjectData(input(state)));
    expect(error.code).toBe("E_PROJECT_RUNNING");
    expect(error.message).toContain("20261123T140501Z.partial");
    const parent = join(root, "home", "data-backups", PROJECT);
    expect(await readdir(parent)).toEqual(["20261123T140501Z.partial"]);
    expect(await readdir(join(parent, "20261123T140501Z.partial"))).toEqual([
      "db.tar",
    ]);
  });

  test("a short-lived writer that mounts during the copy keeps the backup unpublished", async () => {
    const events = new FakeDockerEvents();
    // While the tar helper runs, another container mounts the volume and is
    // gone again before any ps check (a --rm writer).
    events.afterRun = (argv) => {
      if (argv.includes("tar")) {
        events.mount("shop_db", "f".repeat(64));
        events.start("f".repeat(64), "adhoc-writer");
        // A mount of an unrelated volume is ignored.
        events.mount("other", "e".repeat(64));
      }
    };
    const state = baseState({
      model: model({ db: { name: "shop_db" } }),
      volumes: { shop_db: owned("db") },
      events,
    });
    const error = await caught(exportProjectData(input(state)));
    expect(error.code).toBe("E_PROJECT_RUNNING");
    expect(error.message).toContain("ffffffffffff");
    expect(error.detail).toEqual({
      mounts: [
        { volume: "shop_db", container: "f".repeat(64), name: "adhoc-writer" },
      ],
    });
    const parent = join(root, "home", "data-backups", PROJECT);
    expect(await readdir(parent)).toEqual(["20261123T140501Z.partial"]);
    expect(events.open).toBeFalse();
  });

  test("a mount between the first running check and the first copy is seen", async () => {
    const events = new FakeDockerEvents();
    const state = baseState({
      model: model({ db: { name: "shop_db" } }),
      volumes: { shop_db: owned("db") },
      events,
    });
    let injected = false;
    state.onPs = () => {
      if (!injected) {
        injected = true;
        // Arrives after this check reads nothing running, before any copy.
        queueMicrotask(() => {
          events.mount("shop_db", "b".repeat(64));
          events.start("b".repeat(64), "early-writer");
        });
      }
    };
    const error = await caught(exportProjectData(input(state)));
    expect(error.code).toBe("E_PROJECT_RUNNING");
    expect(error.detail).toEqual({
      mounts: [
        { volume: "shop_db", container: "b".repeat(64), name: "early-writer" },
      ],
    });
    // The subscription was live before that check: the start marker ran first.
    const first = state.calls.findIndex((argv) => argv[1] === "run");
    const ps = state.calls.findIndex((argv) => argv[1] === "ps");
    expect(first).toBeLessThan(ps);
  });

  test("a mount by a container whose start was never seen is foreign", async () => {
    const events = new FakeDockerEvents();
    events.afterRun = (argv) => {
      if (argv.includes("tar")) {
        events.mount("shop_db", "d".repeat(64));
      }
    };
    const state = baseState({
      model: model({ db: { name: "shop_db" } }),
      volumes: { shop_db: owned("db") },
      events,
    });
    const error = await caught(exportProjectData(input(state)));
    expect(error.code).toBe("E_PROJECT_RUNNING");
    expect(error.detail).toEqual({
      mounts: [{ volume: "shop_db", container: "d".repeat(64), name: null }],
    });
  });

  test("an event stream that ends before it is stopped refuses publication", async () => {
    const events = new FakeDockerEvents();
    events.afterRun = (argv) => {
      if (argv.includes("tar")) {
        events.end();
      }
    };
    const state = baseState({
      model: model({ db: { name: "shop_db" } }),
      volumes: { shop_db: owned("db") },
      events,
    });
    const error = await caught(exportProjectData(input(state)));
    expect(error.code).toBe("E_DOCKER_UNAVAILABLE");
    expect(error.message).toContain("lost its watch");
    const parent = join(root, "home", "data-backups", PROJECT);
    expect(await readdir(parent)).toEqual(["20261123T140501Z.partial"]);
  });

  test("copying starts only after the start marker proves the stream live", async () => {
    const events = new FakeDockerEvents();
    events.deliverStarts = false;
    const state = baseState({
      model: model({ db: { name: "shop_db" } }),
      volumes: { shop_db: owned("db") },
      events,
    });
    const error = await caught(
      exportProjectData(input(state, { markerTimeoutMs: 20 }))
    );
    expect(error.code).toBe("E_DOCKER_UNAVAILABLE");
    expect(error.message).toContain("start marker");
    // Only the marker ran; no helper read the volume.
    expect(
      state.calls.filter(
        (argv) => argv[1] === "run" && argv.includes("--volume")
      )
    ).toEqual([]);
    expect(events.open).toBeFalse();
  });

  test("mounts by this run's own helpers publish; markers bracket the copy", async () => {
    const state = baseState({
      model: model({ db: { name: "shop_db" } }),
      volumes: { shop_db: owned("db") },
    });
    await exportProjectData(input(state));
    const names = (state.helpers ?? []).map((helper) => helper.name);
    expect(names).toHaveLength(4);
    expect(new Set(names).size).toBe(4);
    expect(names[0]).toMatch(/^hack-data-export-[a-f0-9]{24}-start$/);
    expect(names[3]).toMatch(/^hack-data-export-[a-f0-9]{24}-end$/);
    expect(state.events.watches).toBe(1);
    expect(state.events.open).toBeFalse();
    expect(state.calls.some((argv) => argv[1] === "events")).toBeFalse();
  });

  test("a failure mid-way leaves only the partial directory; a rerun never reuses it", async () => {
    const out = join(root, "out");
    const state = baseState({ failTarFor: "shop_db" });
    const error = await caught(
      exportProjectData(input(state, { outDir: out }))
    );
    expect(error.code).toBe("E_UNEXPECTED");
    expect(error.message).toContain("shop_db");
    expect(await readdir(out)).toEqual(["20261123T140501Z.partial"]);
    // cache (sorted first) was copied; the failed db tar is left; no manifest.
    expect(
      (await readdir(join(out, "20261123T140501Z.partial"))).sort()
    ).toEqual(["cache.tar", "db.tar"]);

    // Same second: the partial directory is refused, not reused.
    const retry = baseState();
    const conflict = await caught(
      exportProjectData(input(retry, { outDir: out }))
    );
    expect(conflict.code).toBe("E_PATH_CONFLICT");
    // No helper read a volume; only the event-stream marker ran.
    expect(
      retry.calls.some((argv) => argv[1] === "run" && argv.includes("--volume"))
    ).toBeFalse();

    // A later run takes a new timestamp and publishes beside the leftover.
    const later = new Date(NOW.getTime() + 1000);
    const result = await exportProjectData(
      input(baseState(), { outDir: out, now: () => later })
    );
    expect(result.backup).toBe(join(out, "20261123T140502Z"));
    expect((await readdir(out)).sort()).toEqual([
      "20261123T140501Z.partial",
      "20261123T140502Z",
    ]);
  });

  test("refuses an existing target directory", async () => {
    const out = join(root, "out");
    await exportProjectData(input(baseState(), { outDir: out }));
    const error = await caught(
      exportProjectData(input(baseState(), { outDir: out }))
    );
    expect(error.code).toBe("E_PATH_CONFLICT");
    expect(await readdir(out)).toEqual(["20261123T140501Z"]);
  });

  test("an unreachable engine is E_DOCKER_UNAVAILABLE", async () => {
    const docker: DataBackupDocker = {
      capture: () =>
        Promise.resolve({
          exitCode: 1,
          stdout: "",
          stderr:
            "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
        }),
      streamToFile: () => Promise.reject(new Error("not reached")),
      streamFromFile: () => Promise.reject(new Error("not reached")),
      watch: () => {
        throw new Error("not reached");
      },
    };
    const error = await caught(
      exportProjectData({ ...input(baseState()), docker })
    );
    expect(error.code).toBe("E_DOCKER_UNAVAILABLE");
  });
});

test("backup timestamps are UTC, second resolution and file-name safe", () => {
  expect(dataBackupTimestamp(NOW)).toBe("20261123T140501Z");
});

test("the native backend is refused; compose and unset are accepted", () => {
  for (const command of ["export", "import"] as const) {
    expect(() =>
      requireComposeBackendForData({ command, backend: "native" })
    ).toThrow(
      expect.objectContaining({ code: "E_NATIVE_PROJECT_UNSUPPORTED" })
    );
    expect(() =>
      requireComposeBackendForData({ command, backend: "compose" })
    ).not.toThrow();
    expect(() =>
      requireComposeBackendForData({ command, backend: undefined })
    ).not.toThrow();
  }
});
