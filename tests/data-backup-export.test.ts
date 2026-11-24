import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  renderDataExportText,
  requireComposeBackendForData,
} from "../src/commands/data.ts";
import { HackCliError } from "../src/lib/cli-result.ts";
import type { DataBackupDocker } from "../src/lib/data-backup-docker.ts";
import {
  type DataExportInput,
  exportProjectData,
} from "../src/lib/data-backup-export.ts";
import {
  DATA_BACKUP_ARCHIVE_DIGEST_SCRIPT,
  DATA_BACKUP_DIGEST_SCRIPT,
  dataBackupHelperImage,
  dataBackupTimestamp,
} from "../src/lib/data-backup-format.ts";
import { planDeclaredVolumes } from "../src/lib/data-backup-volumes.ts";
import {
  COMPOSE,
  FAKE_TIMEOUT_EXIT,
  FakeEngine,
  type FakeVolume,
} from "./helpers/data-backup-fake-engine.ts";

const PROJECT = "shop";
const NOW = new Date("2026-11-23T14:05:01.250Z");
const PINNED =
  "oven/bun@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4";
const DEADLINES = { commandMs: 1000, stepMs: 60_000 };
const sha = (text: string | Buffer): string =>
  createHash("sha256").update(text).digest("hex");

function owned(key: string, content: string, project = PROJECT): FakeVolume {
  return {
    labels: {
      "com.docker.compose.project": project,
      "com.docker.compose.volume": key,
    },
    content,
  };
}

function model(volumes: Record<string, unknown>): unknown {
  return { name: PROJECT, services: {}, volumes };
}

function engine(opts: { readonly only?: "db" } = {}): FakeEngine {
  const fake = new FakeEngine();
  if (opts.only === "db") {
    fake.model = model({ db: { name: "shop_db" } });
    fake.volume("shop_db", { ...owned("db", "rows"), sockets: 1 });
    return fake;
  }
  fake.model = model({
    db: { name: "shop_db" },
    cache: { name: "custom-cache" },
    shared: { name: "team-shared", external: true },
    later: { name: "shop_later" },
    hijacked: { name: "other_thing" },
  });
  fake.volume("shop_db", { ...owned("db", "rows"), sockets: 1 });
  fake.volume("custom-cache", owned("cache", "blobs"));
  fake.volume("other_thing", owned("thing", "theirs", "other"));
  fake.volume("team-shared", owned("shared", "team", "team"));
  return fake;
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hack-data-backup-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function input(fake: FakeEngine, extra: Partial<DataExportInput> = {}) {
  return {
    docker: fake.docker(),
    composeArgs: COMPOSE,
    project: PROJECT,
    branch: null,
    hackHome: join(root, "home"),
    hackVersion: "9.9.9",
    now: () => NOW,
    deadlines: DEADLINES,
    ...extra,
  } satisfies DataExportInput;
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

const partialDir = (): string =>
  join(root, "home", "data-backups", PROJECT, "20261123T140501Z.partial");

/** Every helper `docker create` a run issued (markers mount nothing). */
const creates = (fake: FakeEngine): string[][] =>
  fake.calls.filter((argv) => argv[1] === "create" && argv.includes("--mount"));

/** Every event-stream marker `docker create`. */
const markers = (fake: FakeEngine): string[][] =>
  fake.calls.filter(
    (argv) => argv[1] === "create" && !argv.includes("--mount")
  );

describe("planDeclaredVolumes", () => {
  test("maps keys to Docker names, sorts them and skips external volumes", () => {
    const plan = planDeclaredVolumes(
      model({
        web: {},
        db: { name: "custom" },
        nfs: { driver: "local", driver_opts: { type: "nfs" } },
        shared: { external: true, name: "shared-net-data" },
      })
    );
    expect(plan.composeProject).toBe(PROJECT);
    expect(plan.declared).toEqual([
      { key: "db", name: "custom", driver: "local", driverOpts: false },
      { key: "nfs", name: "shop_nfs", driver: "local", driverOpts: true },
      { key: "web", name: "shop_web", driver: "local", driverOpts: false },
    ]);
    expect(plan.external).toEqual([{ key: "shared", reason: "external" }]);
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
    const fake = engine();
    const result = await exportProjectData(input(fake));
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
    const manifest = JSON.parse(
      await readFile(join(backup, "manifest.json"), "utf8")
    );
    expect(manifest).toEqual(result.manifest);
    expect(manifest).toMatchObject({
      schema: "hack.data-backup.v1",
      project: PROJECT,
      branch: null,
      composeProjectSha256: sha(PROJECT),
      createdAt: "2026-11-23T14:05:01.250Z",
      hackVersion: "9.9.9",
      helperImage: PINNED,
      digestAlgorithm: "hack.tree-digest.v1",
    });
    const tar = await readFile(join(backup, "db.tar"));
    expect(manifest.volumes[1]).toEqual({
      key: "db",
      nameSha256: sha("shop_db"),
      driver: "local",
      labelsSha256: {
        "com.docker.compose.project": sha(PROJECT),
        "com.docker.compose.volume": sha("db"),
      },
      file: "db.tar",
      tarBytes: tar.byteLength,
      tarSha256: sha(tar),
      entries: 3,
      excludedSockets: 1,
      contentDigest: sha("rows"),
    });
    expect(manifest.skipped).toEqual([
      { key: "hijacked", reason: "foreign" },
      { key: "later", reason: "absent" },
      { key: "shared", reason: "external" },
    ]);
    // Only owned volumes are held; external is never even inspected.
    expect(
      creates(fake).map((argv) => argv[argv.indexOf("--mount") + 1])
    ).toEqual([
      "type=bind,src=/var/lib/docker/volumes/custom-cache/_data,dst=/v,readonly",
      "type=bind,src=/var/lib/docker/volumes/shop_db/_data,dst=/v,readonly",
    ]);
    // No volume is ever mounted by name.
    expect(fake.calls.some((argv) => argv.includes("--volume"))).toBeFalse();
    expect(fake.calls.some((argv) => argv.includes("team-shared"))).toBeFalse();
    expect(fake.leftovers()).toEqual([]);
    expect(renderDataExportText(result)).toBe(
      [
        "Backed up 2 volumes:",
        `  cache  ${"tar:blobs".length} B  3 entries`,
        `  db  ${"tar:rows".length} B  3 entries, 1 socket not copied`,
        "Skipped:",
        "  hijacked  labels name another project, not read",
        "  later  not created yet, nothing to back up",
        "  shared  external, not managed by this project",
        `Backup: ${backup}`,
        "",
      ].join("\n")
    );
  });

  test("each volume is held by one logless, network-less, read-only helper and read through exec", async () => {
    const fake = engine({ only: "db" });
    await exportProjectData(input(fake));
    const [create] = creates(fake);
    expect(create?.slice(0, 2)).toEqual(["docker", "create"]);
    const name = create?.[create.indexOf("--name") + 1] ?? "";
    expect(name).toMatch(/^hack-data-export-[a-f0-9]{24}$/);
    expect(create?.[create.indexOf("--network") + 1]).toBe("none");
    expect(create?.[create.indexOf("--log-driver") + 1]).toBe("none");
    expect(create).toContain("--read-only");
    expect(create).toContain("no-new-privileges");
    expect(create?.[create.indexOf("--mount") + 1]).toBe(
      "type=bind,src=/var/lib/docker/volumes/shop_db/_data,dst=/v,readonly"
    );
    expect(create?.slice(-2)).toEqual([PINNED, "infinity"]);
    expect(dataBackupHelperImage()).toBe(PINNED);
    const execs = fake.calls.filter((argv) => argv[1] === "exec");
    expect(execs.map((argv) => argv.slice(2, 5))).toEqual([
      [name, "bun", "-e"],
      [name, "tar", "--numeric-owner"],
      [name, "bun", "-e"],
      ["--interactive", name, "bun"],
    ]);
    // The last reads the archive from stdin with the archive digest script.
    expect(execs[3]?.at(-1)).toBe(DATA_BACKUP_ARCHIVE_DIGEST_SCRIPT);
    expect(execs[0]?.at(-1)).toBe(DATA_BACKUP_DIGEST_SCRIPT);
    expect(execs[1]?.slice(3)).toEqual([
      "tar",
      "--numeric-owner",
      "-cpf",
      "-",
      "-C",
      "/v",
      ".",
    ]);
    // Removed and confirmed gone.
    expect(fake.calls).toContainEqual(["docker", "rm", "--force", name]);
    expect(fake.leftovers()).toEqual([]);
    // Markers log nothing either.
    for (const argv of markers(fake)) {
      expect(argv[argv.indexOf("--log-driver") + 1]).toBe("none");
    }
  });

  test("resolved Docker names never reach the manifest, JSON or text output", async () => {
    const secret = "s3cr3t-tok3n-9f8e7d";
    const fake = new FakeEngine();
    fake.model = model({
      db: { name: `shop_db-${secret}` },
      shared: { name: `team-${secret}`, external: true },
      gone: { name: `shop_gone-${secret}` },
      other: { name: `other-${secret}` },
    });
    fake.volume(`shop_db-${secret}`, owned("db", "rows"));
    fake.volume(`other-${secret}`, owned("thing", "x", "elsewhere"));
    const result = await exportProjectData(input(fake));
    const manifest = await readFile(
      join(result.backup, "manifest.json"),
      "utf8"
    );
    for (const text of [
      manifest,
      JSON.stringify(result),
      renderDataExportText(result),
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(result.manifest.volumes[0]?.nameSha256).toBe(
      sha(`shop_db-${secret}`)
    );
    expect(result.manifest.skipped).toEqual([
      { key: "gone", reason: "absent" },
      { key: "other", reason: "foreign" },
      { key: "shared", reason: "external" },
    ]);

    // Nor does a failure message.
    const failing = new FakeEngine();
    failing.model = model({ db: { name: `shop_db-${secret}` } });
    failing.volume(`shop_db-${secret}`, owned("db", "rows"));
    failing.tarExit[`shop_db-${secret}`] = 2;
    const error = await caught(
      exportProjectData(input(failing, { outDir: join(root, "fail") }))
    );
    expect(
      `${error.message}${JSON.stringify(error.detail ?? null)}`
    ).not.toContain(secret);
  });

  test("an interpolated Compose project name reaches no path, manifest, label copy, text or JSON", async () => {
    const secret = "s3cr3t-tok3n-9f8e7d";
    // As `name: ${STORAGE_TOKEN}` resolves: the Compose project is the value.
    const fake = new FakeEngine();
    fake.model = { name: secret, services: {}, volumes: { db: {} } };
    fake.volume(`${secret}_db`, owned("db", "rows", secret));
    const result = await exportProjectData(input(fake));
    expect(result.backup).toBe(
      join(root, "home", "data-backups", PROJECT, "20261123T140501Z")
    );
    const manifest = await readFile(
      join(result.backup, "manifest.json"),
      "utf8"
    );
    for (const text of [
      result.backup,
      manifest,
      JSON.stringify(result),
      renderDataExportText(result),
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(result.manifest.composeProjectSha256).toBe(sha(secret));
    expect(
      result.manifest.volumes[0]?.labelsSha256["com.docker.compose.project"]
    ).toBe(sha(secret));

    // A refusal naming running containers redacts it too.
    const running = new FakeEngine();
    running.model = fake.model;
    running.volume(`${secret}_db`, owned("db", "rows", secret));
    running.running[`label=com.docker.compose.project=${secret}`] = [
      `${secret}-web-1`,
    ];
    const error = await caught(exportProjectData(input(running)));
    expect(`${error.message}${JSON.stringify(error.detail)}`).not.toContain(
      secret
    );
  });

  test("a volume labeled for this project but another key is foreign", async () => {
    const fake = new FakeEngine();
    fake.model = model({ db: { name: "shop_db" } });
    fake.volume("shop_db", owned("cache", "x"));
    const result = await exportProjectData(input(fake));
    expect(result.manifest.volumes).toEqual([]);
    expect(result.manifest.skipped).toEqual([{ key: "db", reason: "foreign" }]);
    expect(creates(fake)).toEqual([]);
  });
});

describe("binding to the validated volume", () => {
  test("a volume replaced after validation is refused and the helper removed", async () => {
    const fake = engine({ only: "db" });
    // Between the ownership check and the hold, the volume is removed and
    // another one created under the same name with the same labels.
    let swapped = false;
    fake.onPs = () => {
      if (!swapped) {
        swapped = true;
        fake.volumes.delete("shop_db");
        fake.volume("shop_db", owned("db", "impostor"));
      }
    };
    const error = await caught(exportProjectData(input(fake)));
    expect(error.code).toBe("E_PROJECT_RUNNING");
    expect(error.detail).toMatchObject({ key: "db", reason: "volume_changed" });
    expect(fake.calls.some((argv) => argv[1] === "exec")).toBeFalse();
    expect(fake.leftovers()).toEqual([]);
  });

  test("a volume removed after validation is refused, not copied empty", async () => {
    const fake = engine({ only: "db" });
    let removed = false;
    fake.onPs = () => {
      if (!removed) {
        removed = true;
        fake.volumes.delete("shop_db");
      }
    };
    const error = await caught(exportProjectData(input(fake)));
    expect(error.detail).toMatchObject({ reason: "volume_changed" });
    expect(error.message).toContain("nothing was created");
    // The bind of the vanished Mountpoint failed: no volume was created.
    expect(fake.volumes.has("shop_db")).toBeFalse();
    expect(fake.leftovers()).toEqual([]);
  });

  test("a volume with another driver or driver options is refused before any hold", async () => {
    const fake = engine({ only: "db" });
    const volume = fake.volumes.get("shop_db");
    if (volume) {
      volume.options = { type: "nfs", device: ":/export" };
    }
    const error = await caught(exportProjectData(input(fake)));
    expect(error.code).toBe("E_CONFIG_INVALID");
    expect(error.detail).toEqual({
      keys: ["db"],
      reason: "unsupported_driver",
    });
    expect(creates(fake)).toEqual([]);
  });

  test("a tree that changes between the digests before and after the copy is not published", async () => {
    const fake = engine({ only: "db" });
    fake.onExec = (_container, args) => {
      if (args.includes("tar")) {
        const volume = fake.volumes.get("shop_db");
        if (volume) {
          volume.content = "rows-changed";
        }
      }
    };
    const error = await caught(exportProjectData(input(fake)));
    expect(error.code).toBe("E_PROJECT_RUNNING");
    expect(error.detail).toEqual({ key: "db", reason: "source_changed" });
    expect(await readdir(partialDir())).toEqual(["db.tar"]);
    expect(fake.leftovers()).toEqual([]);
  });
});

describe("the archive must match the source", () => {
  test("an archive whose digest differs from the source is not published", async () => {
    const fake = engine({ only: "db" });
    fake.archiveDigestOverride.shop_db = "0".repeat(64);
    const error = await caught(exportProjectData(input(fake)));
    expect(error.code).toBe("E_UNEXPECTED");
    expect(error.detail).toEqual({ key: "db", reason: "archive_mismatch" });
    expect(error.message).toContain("archive digest differs");
    expect(await readdir(partialDir())).toEqual(["db.tar"]);
    expect(fake.leftovers()).toEqual([]);
  });

  test("an archive the helper cannot parse is not published", async () => {
    const fake = engine({ only: "db" });
    const docker = fake.docker();
    const failing = {
      ...docker,
      streamFromFile: () =>
        Promise.resolve({ exitCode: 3, stdout: "", stderr: "bad header" }),
    };
    const error = await caught(
      exportProjectData({ ...input(fake), docker: failing })
    );
    expect(error.message).toContain("verify the archive of volume db");
    expect(fake.leftovers()).toEqual([]);
  });
});

describe("deadlines and cleanup", () => {
  test("a stalled tar times out and the helper container is removed", async () => {
    const fake = engine({ only: "db" });
    fake.tarExit.shop_db = FAKE_TIMEOUT_EXIT;
    const error = await caught(exportProjectData(input(fake)));
    expect(error.code).toBe("E_DOCKER_UNAVAILABLE");
    expect(error.detail).toEqual({ reason: "step_timeout", timeoutMs: 60_000 });
    expect(error.message).toContain("HACK_DATA_STEP_TIMEOUT_MS");
    expect(fake.calls.some((argv) => argv[1] === "rm")).toBeTrue();
    expect(fake.leftovers()).toEqual([]);
  });

  test("an interrupted step is E_CANCELLED and the helper is removed", async () => {
    const fake = engine({ only: "db" });
    fake.tarExit.shop_db = 130;
    const error = await caught(exportProjectData(input(fake)));
    expect(error.code).toBe("E_CANCELLED");
    expect(error.message).toContain("Interrupted");
    expect(fake.leftovers()).toEqual([]);
  });

  test("a marker whose start times out is removed and the export refused", async () => {
    const fake = engine({ only: "db" });
    fake.startExit = (name) =>
      name.endsWith("-start") ? FAKE_TIMEOUT_EXIT : undefined;
    const error = await caught(exportProjectData(input(fake)));
    expect(error.code).toBe("E_DOCKER_UNAVAILABLE");
    expect(error.message).toContain("start marker");
    expect(creates(fake)).toEqual([]);
    expect(fake.leftovers()).toEqual([]);
    expect(fake.events.open).toBeFalse();
  });

  test("an interrupted end marker is removed and the export cancelled", async () => {
    const fake = engine({ only: "db" });
    fake.startExit = (name) => (name.endsWith("-end") ? 130 : undefined);
    const error = await caught(exportProjectData(input(fake)));
    expect(error.code).toBe("E_CANCELLED");
    expect(fake.leftovers()).toEqual([]);
    expect(await readdir(partialDir())).toEqual(["db.tar"]);
  });

  test("an unclassified write error plus a failed cleanup keeps the helper name and status", async () => {
    const fake = engine({ only: "db" });
    fake.tarThrows.shop_db = Object.assign(new Error("input/output error"), {
      code: "EIO",
    });
    fake.onExec = (container) => fake.rmFails.add(container);
    const error = await caught(exportProjectData(input(fake)));
    const [container] = fake.leftovers();
    expect(container).toMatch(/^hack-data-export-[a-f0-9]{24}$/);
    expect(error.message).toContain("input/output error");
    expect(error.message).toContain(`docker rm -f ${container}`);
    expect(error.detail).toEqual({ cleanup: { container, removed: false } });
  });

  test("a full disk while writing the tar removes the helper container", async () => {
    const fake = engine({ only: "db" });
    fake.tarThrows.shop_db = Object.assign(new Error("no space"), {
      code: "ENOSPC",
    });
    const error = await caught(exportProjectData(input(fake)));
    expect(error.code).toBe("E_NO_SPACE");
    expect(fake.leftovers()).toEqual([]);
  });

  test("a removal Docker cannot confirm is reported, not claimed", async () => {
    const fake = engine({ only: "db" });
    fake.onExec = (container) => {
      fake.rmFails.add(container);
    };
    const error = await caught(exportProjectData(input(fake)));
    const [container] = fake.leftovers();
    expect(container).toMatch(/^hack-data-export-/);
    expect(error.message).toContain(`docker rm -f ${container}`);
    expect(error.detail).toEqual({ cleanup: { container, removed: false } });
    // Nothing was published.
    expect(await readdir(join(root, "home", "data-backups", PROJECT))).toEqual([
      "20261123T140501Z.partial",
    ]);

    // On a failure path the refusal keeps its code and gains the cleanup note.
    const failing = engine({ only: "db" });
    failing.tarExit.shop_db = FAKE_TIMEOUT_EXIT;
    failing.onExec = (name) => failing.rmFails.add(name);
    const timeout = await caught(
      exportProjectData(input(failing, { outDir: join(root, "t") }))
    );
    expect(timeout.code).toBe("E_DOCKER_UNAVAILABLE");
    expect(timeout.detail).toMatchObject({
      reason: "step_timeout",
      cleanup: { removed: false },
    });
  });
});

describe("running containers and the live event fence", () => {
  test("refuses while a project container runs and writes nothing", async () => {
    const fake = engine();
    fake.running[`label=com.docker.compose.project=${PROJECT}`] = [
      "shop-web-1",
    ];
    const error = await caught(
      exportProjectData(input(fake, { downCommand: "hack down --branch=x" }))
    );
    expect(error.code).toBe("E_PROJECT_RUNNING");
    expect(error.message).toContain("`hack down --branch=x`");
    // Container names carry the resolved Compose project name: redacted.
    expect(error.detail).toEqual({ running: ["<compose project>-web-1"] });
    expect(creates(fake)).toEqual([]);
    expect(fake.events.open).toBeFalse();
    expect(await readdir(root)).toEqual([]);
  });

  test("refuses while another container mounts an owned volume", async () => {
    const fake = engine();
    fake.running["volume=shop_db"] = ["adhoc-debug"];
    const error = await caught(exportProjectData(input(fake)));
    expect(error.code).toBe("E_PROJECT_RUNNING");
    expect(error.detail).toEqual({ running: ["adhoc-debug"] });
  });

  test("a container that starts during the copy keeps the backup unpublished", async () => {
    const fake = engine({ only: "db" });
    // Calls 0-1: the first check (project + volume); from call 2: the last.
    fake.runningFromCall = {
      call: 2,
      filter: `label=com.docker.compose.project=${PROJECT}`,
      names: ["shop-web-1"],
    };
    const error = await caught(exportProjectData(input(fake)));
    expect(error.code).toBe("E_PROJECT_RUNNING");
    expect(error.message).toContain("20261123T140501Z.partial");
    expect(await readdir(partialDir())).toEqual(["db.tar"]);
  });

  test("a short-lived writer that mounts during the copy keeps the backup unpublished", async () => {
    const fake = engine({ only: "db" });
    fake.onExec = (_container, args) => {
      if (args.includes("tar")) {
        fake.events.mount("shop_db", "f".repeat(64));
        fake.events.start("f".repeat(64), "adhoc-writer");
        // A mount of an unrelated volume is ignored.
        fake.events.mount("other", "e".repeat(64));
      }
    };
    const error = await caught(exportProjectData(input(fake)));
    expect(error.code).toBe("E_PROJECT_RUNNING");
    expect(error.message).toContain("ffffffffffff");
    expect(error.detail).toEqual({
      mounts: [
        { volume: "db", container: "f".repeat(64), name: "adhoc-writer" },
      ],
    });
    expect(await readdir(partialDir())).toEqual(["db.tar"]);
    expect(fake.events.open).toBeFalse();
  });

  test("a mount between the first running check and the first copy is seen", async () => {
    const fake = engine({ only: "db" });
    let injected = false;
    fake.onPs = () => {
      if (!injected) {
        injected = true;
        queueMicrotask(() => {
          fake.events.mount("shop_db", "b".repeat(64));
          fake.events.start("b".repeat(64), "early-writer");
        });
      }
    };
    const error = await caught(exportProjectData(input(fake)));
    expect(error.detail).toEqual({
      mounts: [
        { volume: "db", container: "b".repeat(64), name: "early-writer" },
      ],
    });
    // The subscription was live before that check: the start marker ran first.
    const marker = fake.calls.findIndex(
      (argv) => argv[1] === "create" && !argv.includes("--mount")
    );
    const ps = fake.calls.findIndex((argv) => argv[1] === "ps");
    expect(marker).toBeLessThan(ps);
  });

  test("a mount by a container whose start was never seen is foreign", async () => {
    const fake = engine({ only: "db" });
    fake.onExec = (_container, args) => {
      if (args.includes("tar")) {
        fake.events.mount("shop_db", "d".repeat(64));
      }
    };
    const error = await caught(exportProjectData(input(fake)));
    expect(error.detail).toEqual({
      mounts: [{ volume: "db", container: "d".repeat(64), name: null }],
    });
  });

  test("an event stream that ends before it is stopped refuses publication", async () => {
    const fake = engine({ only: "db" });
    fake.onExec = (_container, args) => {
      if (args.includes("tar")) {
        fake.events.end();
      }
    };
    const error = await caught(exportProjectData(input(fake)));
    expect(error.code).toBe("E_DOCKER_UNAVAILABLE");
    expect(error.message).toContain("lost its watch");
    expect(await readdir(partialDir())).toEqual(["db.tar"]);
  });

  test("copying starts only after the start marker proves the stream live", async () => {
    const fake = engine({ only: "db" });
    fake.events.deliverStarts = false;
    const error = await caught(
      exportProjectData(input(fake, { markerTimeoutMs: 20 }))
    );
    expect(error.code).toBe("E_DOCKER_UNAVAILABLE");
    expect(error.message).toContain("start marker");
    expect(creates(fake)).toEqual([]);
    expect(fake.events.open).toBeFalse();
  });

  test("our own held helper's mount publishes; markers bracket the copy", async () => {
    const fake = engine({ only: "db" });
    await exportProjectData(input(fake));
    const names = markers(fake).map((argv) => argv[argv.indexOf("--name") + 1]);
    expect(names).toHaveLength(2);
    expect(names[0]).toMatch(/^hack-data-export-[a-f0-9]{24}-start$/);
    expect(names[1]).toMatch(/^hack-data-export-[a-f0-9]{24}-end$/);
    // Markers are removed and confirmed, like helpers.
    for (const name of names) {
      expect(fake.calls).toContainEqual([
        "docker",
        "rm",
        "--force",
        name ?? "",
      ]);
    }
    expect(fake.leftovers()).toEqual([]);
    expect(fake.events.watches).toBe(1);
    expect(fake.events.open).toBeFalse();
    expect(fake.calls.some((argv) => argv[1] === "events")).toBeFalse();
  });
});

describe("publication", () => {
  test("a failure mid-way leaves only the partial directory; a rerun never reuses it", async () => {
    const out = join(root, "out");
    const fake = engine();
    fake.tarExit.shop_db = 2;
    const error = await caught(exportProjectData(input(fake, { outDir: out })));
    expect(error.code).toBe("E_UNEXPECTED");
    expect(error.message).toContain("volume db");
    expect(error.message).not.toContain("shop_db");
    expect(await readdir(out)).toEqual(["20261123T140501Z.partial"]);
    // cache (sorted first) was copied; the failed db tar is left; no manifest.
    expect(
      (await readdir(join(out, "20261123T140501Z.partial"))).sort()
    ).toEqual(["cache.tar", "db.tar"]);
    expect(fake.leftovers()).toEqual([]);

    // Same second: the partial directory is refused, not reused.
    const retry = engine();
    const conflict = await caught(
      exportProjectData(input(retry, { outDir: out }))
    );
    expect(conflict.code).toBe("E_PATH_CONFLICT");
    expect(creates(retry)).toEqual([]);

    // A later run takes a new timestamp and publishes beside the leftover.
    const later = new Date(NOW.getTime() + 1000);
    const result = await exportProjectData(
      input(engine(), { outDir: out, now: () => later })
    );
    expect(result.backup).toBe(join(out, "20261123T140502Z"));
    expect((await readdir(out)).sort()).toEqual([
      "20261123T140501Z.partial",
      "20261123T140502Z",
    ]);
  });

  test("a parent fsync failure after the rename is reported as published but not durable", async () => {
    const out = join(root, "out");
    const backup = join(out, "20261123T140501Z");
    const synced: string[] = [];
    const error = await caught(
      exportProjectData(
        input(engine(), {
          outDir: out,
          syncDirectory: (path) => {
            synced.push(path);
            return path === out
              ? Promise.reject(Object.assign(new Error("io"), { code: "EIO" }))
              : Promise.resolve();
          },
        })
      )
    );
    expect(error.message).toBe(
      `The backup at ${backup} is complete but its durability could not be confirmed: the rename that published it could not be flushed to disk. Check the file system, then use the backup or export again.`
    );
    expect(error.detail).toEqual({ backup, published: true, durable: false });
    // .partial was synced before the rename, the parent after it.
    expect(synced).toEqual([`${backup}.partial`, out]);
    expect(await readdir(out)).toEqual(["20261123T140501Z"]);
  });

  test("directories export creates for --out are flushed in their parents, deepest first", async () => {
    const out = join(root, "a", "b", "c");
    const backup = join(out, "20261123T140501Z");
    const synced: string[] = [];
    await exportProjectData(
      input(engine(), {
        outDir: out,
        syncDirectory: (path) => {
          synced.push(path);
          return Promise.resolve();
        },
      })
    );
    expect(synced).toEqual([
      `${backup}.partial`,
      out,
      join(root, "a", "b"),
      join(root, "a"),
      root,
    ]);

    // A failure on one of them is the durability-unconfirmed outcome.
    const again = join(root, "x", "y");
    const error = await caught(
      exportProjectData(
        input(engine(), {
          outDir: again,
          syncDirectory: (path) =>
            path === join(root, "x")
              ? Promise.reject(Object.assign(new Error("io"), { code: "EIO" }))
              : Promise.resolve(),
        })
      )
    );
    expect(error.detail).toEqual({
      backup: join(again, "20261123T140501Z"),
      published: true,
      durable: false,
    });
  });

  test("refuses an existing target directory", async () => {
    const out = join(root, "out");
    await exportProjectData(input(engine(), { outDir: out }));
    const error = await caught(
      exportProjectData(input(engine(), { outDir: out }))
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
      exportProjectData({ ...input(engine()), docker })
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
