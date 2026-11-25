import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  renderDataExportText,
  requireComposeBackendForDataExport,
} from "../src/commands/data.ts";
import { HackCliError } from "../src/lib/cli-result.ts";
import { cleanupRecordedRun } from "../src/lib/data-backup-cleanup.ts";
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
import { TIMED_OUT_CREATE_LOOKUPS } from "../src/lib/data-backup-held-volume.ts";
import { refuseRunning } from "../src/lib/data-backup-helper.ts";
import { planDeclaredVolumes } from "../src/lib/data-backup-volumes.ts";
import { readDataCleanupRecord } from "../src/lib/data-cleanup-record.ts";
import {
  COMPOSE,
  FAKE_TIMEOUT_EXIT,
  FakeEngine,
  type FakeVolume,
  fakePsId,
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

/** Every bind-hold helper `docker create` a run issued. */
const creates = (fake: FakeEngine): string[][] =>
  fake.calls.filter(
    (argv) =>
      argv[1] === "create" &&
      (argv[argv.indexOf("--mount") + 1] ?? "").startsWith("type=bind,")
  );

/** Every volume-reference `docker create` (never started) a run issued. */
const references = (fake: FakeEngine): string[][] =>
  fake.calls.filter(
    (argv) =>
      argv[1] === "create" &&
      (argv[argv.indexOf("--mount") + 1] ?? "").startsWith("type=volume,")
  );

/** Every event-stream marker `docker create`. */
const markers = (fake: FakeEngine): string[][] =>
  fake.calls.filter(
    (argv) => argv[1] === "create" && !argv.includes("--mount")
  );

/** The names the run's markers were created under, in order. */
const markerNames = (fake: FakeEngine): string[] =>
  markers(fake).map((argv) => argv[argv.indexOf("--name") + 1] ?? "");

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
    // A reference by name to each owned volume, never started.
    expect(
      references(fake).map((argv) => argv[argv.indexOf("--mount") + 1])
    ).toEqual([
      "type=volume,src=custom-cache,dst=/v,volume-nocopy,volume-driver=local,volume-opt=type=none",
      "type=volume,src=shop_db,dst=/v,volume-nocopy,volume-driver=local,volume-opt=type=none",
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
    const helperName = create?.[create.indexOf("--name") + 1] ?? "";
    expect(helperName).toMatch(/^hack-data-export-[a-f0-9]{24}$/);
    // Every later call names the helper by the ID its create returned.
    const name =
      fake.created.find((entry) => entry.name === helperName)?.id ?? "";
    expect(name).toMatch(/^[a-f0-9]{64}$/);
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
  test("a docker volume rm during the copy is refused by Hack's reference; the export completes", async () => {
    const fake = engine({ only: "db" });
    const removals: boolean[] = [];
    fake.onExec = (_container, args) => {
      if (args.includes("tar")) {
        // Docker: "volume is in use" while the reference container exists.
        removals.push(fake.removeVolume("shop_db"));
      }
    };
    const result = await exportProjectData(input(fake));
    expect(removals).toEqual([false]);
    const content = fake.volumes.get("shop_db")?.content ?? "";
    expect(content).not.toBe("");
    expect(result.manifest.volumes[0]?.contentDigest).toBe(sha(content));
    // The reference was created, never started, and removed by its ID.
    const [reference] = references(fake);
    expect(reference).toBeDefined();
    const id =
      fake.created.find(
        (entry) => entry.name === reference?.[reference.indexOf("--name") + 1]
      )?.id ?? "";
    expect(
      fake.calls.some((argv) => argv[1] === "start" && argv.includes(id))
    ).toBe(false);
    expect(fake.calls).toContainEqual(["docker", "rm", "--force", id]);
    expect(fake.leftovers()).toEqual([]);
    // Hack never removes a volume.
    expect(
      fake.calls.some((argv) => argv[1] === "volume" && argv[2] === "rm")
    ).toBe(false);
  });

  test("a reference whose removal Docker cannot confirm is reported, not claimed", async () => {
    const fake = engine({ only: "db" });
    fake.onExec = (_container, args) => {
      if (args.includes("tar")) {
        for (const id of fake.referencing("shop_db")) {
          fake.rmFails.add(id);
        }
      }
    };
    const error = await caught(exportProjectData(input(fake)));
    const [left] = fake.leftovers();
    expect(left).toMatch(/^[a-f0-9]{64}$/);
    expect(error.message).toContain(`docker rm -f ${left}`);
    expect(error.detail).toEqual({
      cleanup: { container: left, removed: false },
    });
    expect(await readdir(partialDir())).toEqual(["db.tar"]);
  });

  /**
   * Remove `shop_db` and create it again within the same second: same name,
   * labels, driver, Mountpoint and (CreatedAt has one-second resolution)
   * CreatedAt, so it passes every identity comparison.
   */
  function replaceWithinOneSecond(fake: FakeEngine): void {
    const old = fake.volumes.get("shop_db");
    // Hack's reference blocks a plain removal: someone removes it first.
    fake.forceRemoveVolume("shop_db");
    fake.volume("shop_db", {
      ...owned("db", "impostor"),
      createdAt: old?.createdAt,
    });
  }

  test("a same-second replacement before the hold is refused, though its identity matches", async () => {
    const fake = engine({ only: "db" });
    let replaced = false;
    fake.onPs = () => {
      if (!replaced) {
        replaced = true;
        replaceWithinOneSecond(fake);
      }
    };
    const error = await caught(exportProjectData(input(fake)));
    expect(error.code).toBe("E_PROJECT_RUNNING");
    expect(error.detail).toEqual({ key: "db", reason: "volume_changed" });
    expect(error.message).toContain("Docker reported it");
    expect(await readdir(partialDir())).toEqual(["db.tar"]);
  });

  test("a same-second replacement during the copy is refused, though its identity matches", async () => {
    // An empty volume: the emptied tree under the bind digests the same
    // before and after, and the identity recheck passes, so only Docker's
    // destroy/create events show the replacement.
    const fake = engine({ only: "db" });
    const volume = fake.volumes.get("shop_db");
    if (volume) {
      volume.content = "";
    }
    let replaced = false;
    fake.onExec = (_container, args) => {
      if (args.includes("tar") && !replaced) {
        replaced = true;
        replaceWithinOneSecond(fake);
      }
    };
    const error = await caught(exportProjectData(input(fake)));
    expect(error.code).toBe("E_PROJECT_RUNNING");
    expect(error.detail).toEqual({ key: "db", reason: "volume_changed" });
    expect(await readdir(partialDir())).toEqual(["db.tar"]);
  });

  test("a volume removed after the hold, before the first digest, is not published empty", async () => {
    // If Hack's reference container is removed first, Docker lets the
    // volume's removal succeed under the bind and leaves the helper an
    // empty tree, so all three digests agree on nothing.
    const fake = engine({ only: "db" });
    let removed = false;
    fake.onExec = () => {
      if (!removed) {
        removed = true;
        fake.forceRemoveVolume("shop_db");
      }
    };
    const error = await caught(exportProjectData(input(fake)));
    expect(error.code).toBe("E_PROJECT_RUNNING");
    expect(error.detail).toEqual({ key: "db", reason: "volume_changed" });
    expect(error.message).toContain("was removed while it was being copied");
    expect(await readdir(partialDir())).toEqual(["db.tar"]);
    // Export never creates a volume.
    expect(fake.volumes.has("shop_db")).toBeFalse();
    expect(fake.leftovers()).toEqual([]);
  });

  test("a volume removed during the copy refuses publication", async () => {
    const fake = engine({ only: "db" });
    fake.onExec = (_container, args) => {
      if (args.includes("tar")) {
        fake.forceRemoveVolume("shop_db");
      }
    };
    const error = await caught(exportProjectData(input(fake)));
    expect(error.code).toBe("E_PROJECT_RUNNING");
    expect(error.detail).toEqual({ key: "db", reason: "volume_changed" });
    expect(fake.volumes.has("shop_db")).toBeFalse();
  });

  test("a volume removed, or replaced under its name, between the copy and the publish is refused", async () => {
    // `reported`: Docker's destroy/create events arrive (the window refuses
    // first); otherwise only the identity recheck before the rename sees it.
    for (const [replace, reported] of [
      [false, true],
      [true, true],
      [false, false],
      [true, false],
    ] as const) {
      const fake = engine({ only: "db" });
      // The last running check runs after every copy, before the publish.
      fake.runningFromCall = null;
      let copied = false;
      fake.onExec = (_container, args) => {
        if (args.includes("--interactive") || args.includes("-e")) {
          copied = true;
        }
      };
      let psAfterCopy = false;
      fake.onPs = () => {
        if (copied && !psAfterCopy) {
          psAfterCopy = true;
          if (!reported) {
            fake.events.deliverVolumeChanges = false;
          }
          fake.forceRemoveVolume("shop_db");
          if (replace) {
            fake.volume("shop_db", owned("db", "rows-db"));
          }
        }
      };
      const out = join(root, `${replace}-${reported}`);
      const error = await caught(
        exportProjectData(input(fake, { outDir: out }))
      );
      expect({ replace, code: error.code, detail: error.detail }).toEqual({
        replace,
        code: "E_PROJECT_RUNNING",
        detail: { key: "db", reason: "volume_changed" },
      });
      expect(error.message).toContain(
        reported ? "Docker reported it" : "after it was copied"
      );
      // Not published: the manifest and tar stay in `.partial`.
      expect(await readdir(out)).toEqual(["20261123T140501Z.partial"]);
      expect(fake.volumes.has("shop_db")).toBe(replace);
    }
  });

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

  test("a volume removed after validation is refused at its reference and never recreated", async () => {
    // Removed before Hack's reference exists: the reference's driver options
    // make Docker refuse a missing name instead of creating it.
    const fake = engine({ only: "db" });
    let removed = false;
    fake.onPs = () => {
      if (!removed) {
        removed = true;
        fake.removeVolume("shop_db");
      }
    };
    const error = await caught(exportProjectData(input(fake)));
    expect(error.code).toBe("E_PROJECT_RUNNING");
    expect(error.detail).toEqual({ key: "db", reason: "volume_changed" });
    expect(error.message).toContain("nothing was created");
    // Nothing was read and no volume exists under the name: read-only.
    expect(creates(fake)).toEqual([]);
    expect(fake.volumes.has("shop_db")).toBeFalse();
    expect(
      fake.calls.some((argv) => argv[1] === "volume" && argv[2] !== "inspect")
    ).toBeFalse();
    expect(fake.leftovers()).toEqual([]);
  });

  test("a volume replaced under its name before its reference is referenced, refused and kept", async () => {
    // Not ours: a different volume now carries the name. Hack refuses and
    // never removes it.
    const fake = engine({ only: "db" });
    let replaced = false;
    fake.onPs = () => {
      if (!replaced) {
        replaced = true;
        fake.removeVolume("shop_db");
        fake.volume("shop_db", owned("db", "someone-elses"));
      }
    };
    const error = await caught(exportProjectData(input(fake)));
    expect(error.detail).toEqual({ key: "db", reason: "volume_changed" });
    expect(creates(fake)).toEqual([]);
    expect(fake.volumes.get("shop_db")?.content).toBe("someone-elses");
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

  test("an unclassified write error plus a failed cleanup keeps the helper ID and status", async () => {
    const fake = engine({ only: "db" });
    fake.tarThrows.shop_db = Object.assign(new Error("input/output error"), {
      code: "EIO",
    });
    fake.onExec = (container) => fake.rmFails.add(container);
    const error = await caught(exportProjectData(input(fake)));
    const [container] = fake.leftovers();
    expect(container).toMatch(/^[a-f0-9]{64}$/);
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
    expect(container).toMatch(/^[a-f0-9]{64}$/);
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
    // Short IDs, never names (which carry the resolved Compose project name).
    expect(error.detail).toEqual({ running: [fakePsId("shop-web-1")] });
    expect(creates(fake)).toEqual([]);
    expect(fake.events.open).toBeFalse();
    // No backup, and the run's cleanup record is gone: nothing is left.
    expect(await readdir(root)).toEqual(["home"]);
    expect(await readdir(join(root, "home"))).toEqual(["data-cleanup"]);
    expect(await readdir(join(root, "home", "data-cleanup"))).toEqual([]);
  });

  test("refuses while another container mounts an owned volume", async () => {
    const fake = engine();
    fake.running["volume=shop_db"] = ["adhoc-debug"];
    const error = await caught(exportProjectData(input(fake)));
    expect(error.code).toBe("E_PROJECT_RUNNING");
    expect(error.detail).toEqual({ running: [fakePsId("adhoc-debug")] });
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
      mounts: [{ volume: "db", container: "f".repeat(12) }],
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
      mounts: [{ volume: "db", container: "b".repeat(12) }],
    });
    // The subscription was live before that check: the start marker ran first.
    const marker = fake.calls.findIndex(
      (argv) => argv[1] === "create" && !argv.includes("--mount")
    );
    const ps = fake.calls.findIndex((argv) => argv[1] === "ps");
    expect(marker).toBeLessThan(ps);
  });

  test("a container reusing a removed marker's name and mounting a volume is refused", async () => {
    const fake = engine({ only: "db" });
    let reuser: string | null = null;
    fake.onExec = (_container, args) => {
      if (args.includes("tar") && reuser === null) {
        // The start marker was removed before the copy; its name is free.
        const reused = markerNames(fake)[0] ?? "";
        expect(reused).toMatch(/^hack-data-export-[a-f0-9]{24}-start$/);
        reuser = fake.createForeign(reused, [
          { Type: "volume", Name: "shop_db", Source: "/x", Destination: "/v" },
        ]);
        fake.events.mount("shop_db", reuser ?? "");
      }
    };
    const error = await caught(exportProjectData(input(fake)));
    expect(error.code).toBe("E_PROJECT_RUNNING");
    expect(reuser).toMatch(/^[a-f0-9]{64}$/);
    expect(error.detail).toEqual({
      mounts: [{ volume: "db", container: (reuser ?? "").slice(0, 12) }],
    });
    expect(await readdir(partialDir())).toEqual(["db.tar"]);
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
      mounts: [{ volume: "db", container: "d".repeat(12) }],
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
    const names = markerNames(fake);
    expect(names).toHaveLength(2);
    expect(names[0]).toMatch(/^hack-data-export-[a-f0-9]{24}-start$/);
    expect(names[1]).toMatch(/^hack-data-export-[a-f0-9]{24}-end$/);
    // Markers are removed and confirmed, like helpers: by ID, never by name.
    for (const name of names) {
      const id = fake.created.find((entry) => entry.name === name)?.id ?? "";
      expect(id).toMatch(/^[a-f0-9]{64}$/);
      expect(fake.calls).toContainEqual(["docker", "rm", "--force", id]);
    }
    for (const argv of fake.calls.filter((call) => call[1] === "rm")) {
      expect(argv.slice(3).every((ref) => /^[a-f0-9]{64}$/.test(ref))).toBe(
        true
      );
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
      redactValues: [],
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
  expect(() => requireComposeBackendForDataExport("native")).toThrow(
    expect.objectContaining({ code: "E_NATIVE_PROJECT_UNSUPPORTED" })
  );
  expect(() => requireComposeBackendForDataExport("compose")).not.toThrow();
  expect(() => requireComposeBackendForDataExport(undefined)).not.toThrow();
});

/**
 * Run `export` with `during` called from inside the tar exec, the run's
 * SIGINT handler at hand. A no-op listener stays registered so the handler
 * does not re-raise the signal on the test runner.
 */
async function exportInterruptedDuringCopy(
  fake: FakeEngine,
  during: (interrupt: () => void) => void
): Promise<void> {
  const keep = (): void => undefined;
  process.on("SIGINT", keep);
  const before = new Set(process.listeners("SIGINT"));
  let fired = false;
  fake.onExec = (_container, args) => {
    if (args.includes("tar") && !fired) {
      fired = true;
      const handler = process
        .listeners("SIGINT")
        .find((listener) => !before.has(listener));
      expect(handler).toBeDefined();
      during(() => (handler as () => void)());
    }
  };
  try {
    await exportProjectData(input(fake)).catch(() => undefined);
  } finally {
    process.off("SIGINT", keep);
  }
  expect(fired).toBeTrue();
}

describe("helper containers are tracked by ID, never by name", () => {
  test("an interrupt removes our live helper and reference by ID and spares a container that reused a removed marker's name", async () => {
    const fake = engine({ only: "db" });
    let reuser: string | null = null;
    let live: string[] = [];
    let firstCall = 0;
    await exportInterruptedDuringCopy(fake, (interrupt) => {
      reuser = fake.createForeign(markerNames(fake)[0] ?? "");
      // Live now: the volume reference, then the bind hold.
      live = fake.created
        .filter((entry) => !entry.name.endsWith("-start"))
        .map((entry) => entry.id);
      firstCall = fake.calls.length;
      interrupt();
    });
    expect(reuser).toMatch(/^[a-f0-9]{64}$/);
    expect(live).toHaveLength(2);
    // The signal cleanup's own removal: exactly the live containers, by ID.
    const signalRm = fake.calls
      .slice(firstCall)
      .find((argv) => argv[1] === "rm");
    expect(signalRm).toEqual(["docker", "rm", "--force", ...live]);
    // The replacement survives: nothing ever named it, by ID or by name.
    expect(fake.containers.has(reuser ?? "")).toBeTrue();
    const markerName = markerNames(fake)[0] ?? "";
    for (const argv of fake.calls.filter((call) => call[1] === "rm")) {
      expect(argv).not.toContain(reuser);
      expect(argv).not.toContain(markerName);
    }
    expect(fake.leftovers()).toEqual([reuser ?? ""]);
  });

  test("a create whose outcome is unknown adopts only a container with its nonce", async () => {
    // The create timed out after Docker made the container: it carries this
    // create's nonce label, so it is ours and is removed by ID.
    const fake = engine({ only: "db" });
    const real = fake.docker();
    let timedOut = false;
    const docker: DataBackupDocker = {
      ...real,
      capture: async (argv, opts) => {
        const result = await real.capture(argv, opts);
        if (!timedOut && argv[1] === "create" && argv.includes("--mount")) {
          timedOut = true;
          return { exitCode: FAKE_TIMEOUT_EXIT, stdout: "", stderr: "" };
        }
        return result;
      },
    };
    const error = await caught(exportProjectData({ ...input(fake), docker }));
    expect(error.code).toBe("E_DOCKER_UNAVAILABLE");
    expect(fake.leftovers()).toEqual([]);

    // A container that merely has the name (no nonce) is never touched.
    const other = engine({ only: "db" });
    const otherReal = other.docker();
    let foreign: string | null = null;
    const racing: DataBackupDocker = {
      ...otherReal,
      capture: async (argv, opts) => {
        if (
          foreign === null &&
          argv[1] === "create" &&
          argv.includes("--mount")
        ) {
          foreign = other.createForeign(argv[argv.indexOf("--name") + 1] ?? "");
          return { exitCode: FAKE_TIMEOUT_EXIT, stdout: "", stderr: "" };
        }
        return await otherReal.capture(argv, opts);
      },
    };
    const raced = await caught(
      exportProjectData({
        ...input(other, { outDir: join(root, "second") }),
        docker: racing,
      })
    );
    expect(raced.code).toBe("E_DOCKER_UNAVAILABLE");
    expect(foreign).toMatch(/^[a-f0-9]{64}$/);
    expect(other.leftovers()).toEqual([foreign ?? ""]);
  });
});

describe("container names never reach output", () => {
  // Not a credential: a recognizable stand-in for a managed value that a
  // service interpolates into `container_name: db-${TOKEN}`.
  const TOKEN = "managed-token-canary-7f3a";

  test("a running refusal lists short IDs, not names", async () => {
    const fake = engine();
    fake.running[`label=com.docker.compose.project=${PROJECT}`] = [
      `db-${TOKEN}`,
    ];
    fake.running["volume=shop_db"] = [`db-${TOKEN}`];
    const error = await caught(exportProjectData(input(fake)));
    expect(error.code).toBe("E_PROJECT_RUNNING");
    expect(error.detail).toEqual({ running: [fakePsId(`db-${TOKEN}`)] });
    expect(`${error.message}${JSON.stringify(error.detail)}`).not.toContain(
      TOKEN
    );
  });

  test("a mount refusal lists short IDs, not names", async () => {
    const fake = engine({ only: "db" });
    fake.onExec = (_container, args) => {
      if (args.includes("tar")) {
        const id = fake.createForeign(`db-${TOKEN}`, []) ?? "";
        fake.events.mount("shop_db", id);
      }
    };
    const error = await caught(exportProjectData(input(fake)));
    expect(error.code).toBe("E_PROJECT_RUNNING");
    expect(error.detail).toEqual({
      mounts: [
        { volume: "db", container: expect.stringMatching(/^[a-f0-9]{12}$/) },
      ],
    });
    expect(`${error.message}${JSON.stringify(error.detail)}`).not.toContain(
      TOKEN
    );
  });
});

describe("foreign container starts are inspected by ID", () => {
  const MOUNTPOINT = "/var/lib/docker/volumes/shop_db/_data";

  let runs = 0;
  async function exportWithForeignStart(
    mounts: readonly unknown[] | null,
    prepare: (fake: FakeEngine) => void = () => undefined
  ): Promise<{ fake: FakeEngine; id: string; error: HackCliError | null }> {
    runs += 1;
    const fake = engine({ only: "db" });
    prepare(fake);
    let id = "";
    fake.onExec = (_container, args) => {
      if (args.includes("tar") && id === "") {
        if (mounts === null) {
          // Started and already removed before Hack could inspect it.
          id = "7".repeat(64);
          fake.events.start(id, "short-lived");
        } else {
          id = fake.createForeign("binder", mounts) ?? "";
        }
      }
    };
    const error = await exportProjectData(
      input(fake, { outDir: join(root, `run-${runs}`) })
    ).then(
      () => null,
      (caughtError: unknown) => caughtError as HackCliError
    );
    return { fake, id, error };
  }

  test("a bind of an owned volume's Mountpoint refuses publication", async () => {
    const { id, error } = await exportWithForeignStart([
      { Type: "bind", Source: MOUNTPOINT, Destination: "/x" },
    ]);
    expect(error?.code).toBe("E_PROJECT_RUNNING");
    expect(error?.detail).toEqual({
      mounts: [{ volume: "db", container: id.slice(0, 12) }],
    });
  });

  test("a bind of a path inside, or above, an owned Mountpoint refuses publication", async () => {
    for (const source of [
      `${MOUNTPOINT}/sub/dir`,
      `${MOUNTPOINT}/`,
      "/var/lib/docker/volumes",
      "/var/lib/docker/volumes/shop_db/./_data/../_data",
    ]) {
      const { id, error } = await exportWithForeignStart([
        { Type: "bind", Source: source, Destination: "/x" },
      ]);
      expect({ source, detail: error?.detail }).toEqual({
        source,
        detail: { mounts: [{ volume: "db", container: id.slice(0, 12) }] },
      });
    }
  });

  test("a foreign start with unrelated mounts publishes", async () => {
    const { error, fake, id } = await exportWithForeignStart(
      [
        { Type: "bind", Source: "/srv/shop_db/_data", Destination: "/x" },
        {
          Type: "bind",
          Source: "/var/lib/docker/volumes/shop_db_other/_data",
          Destination: "/y",
        },
        {
          Type: "volume",
          Name: "other",
          Source: "/var/lib/docker/volumes/other/_data",
          Destination: "/z",
        },
      ],
      (fake) => fake.volume("other", owned("other", "x", "else"))
    );
    expect(error).toBeNull();
    // It was inspected, by ID.
    expect(
      fake.calls.some(
        (argv) =>
          argv[2] === "inspect" &&
          argv.includes("{{.Id}} {{json .Mounts}}") &&
          argv.includes(id)
      )
    ).toBeTrue();
  });

  test("a foreign start that is gone before it can be inspected refuses, closed", async () => {
    const { error } = await exportWithForeignStart(null);
    expect(error?.code).toBe("E_PROJECT_RUNNING");
    expect(error?.detail).toEqual({
      unchecked: ["7".repeat(12)],
      reason: "unchecked_start",
    });
    expect(error?.message).toContain("could not be checked");
    expect(error?.message).not.toContain("short-lived");
  });

  test("our own helpers' and markers' starts are never inspected", async () => {
    const fake = engine({ only: "db" });
    await exportProjectData(input(fake));
    const ours = new Set(fake.created.map((entry) => entry.id));
    // Start marker, volume reference, bind hold, end marker.
    expect(ours.size).toBe(4);
    // Only the hold's own mount proof inspects one of our containers.
    const inspected = fake.calls.filter(
      (argv) => argv[2] === "inspect" && argv.includes("{{json .Mounts}}")
    );
    expect(inspected).toHaveLength(1);
    expect(ours.has(inspected[0]?.at(-1) ?? "")).toBeTrue();
  });
});

describe("containers already running are inspected for binds", () => {
  const MOUNTPOINT = "/var/lib/docker/volumes/shop_db/_data";

  test("a container running before the export that binds an owned Mountpoint, a path inside or above it, refuses before any copy", async () => {
    for (const source of [
      MOUNTPOINT,
      `${MOUNTPOINT}/pgdata`,
      "/var/lib/docker/volumes",
    ]) {
      const fake = engine({ only: "db" });
      const id = fake.runningContainer("pre-existing", [
        { Type: "bind", Source: source, Destination: "/data" },
      ]);
      const error = await caught(
        exportProjectData(input(fake, { outDir: join(root, "pre") }))
      );
      expect({ source, code: error.code, detail: error.detail }).toEqual({
        source,
        code: "E_PROJECT_RUNNING",
        detail: { running: [id.slice(0, 12)] },
      });
      expect(creates(fake)).toEqual([]);
    }
  });

  test("a container that starts binding the Mountpoint and is still running at the last check refuses publication", async () => {
    const fake = engine({ only: "db" });
    let id = "";
    fake.onExec = (_container, args) => {
      if (args.includes("tar") && id === "") {
        // Already past the start event window: no start is emitted.
        id = fake.runningContainer("late", [
          { Type: "bind", Source: MOUNTPOINT, Destination: "/data" },
        ]);
      }
    };
    const error = await caught(exportProjectData(input(fake)));
    expect(error.code).toBe("E_PROJECT_RUNNING");
    expect(error.detail).toEqual({ running: [id.slice(0, 12)] });
    expect(await readdir(partialDir())).toEqual(["db.tar"]);
  });

  test("a running container with unrelated binds publishes", async () => {
    const fake = engine({ only: "db" });
    // A plain local volume: its Mountpoint is its own directory.
    fake.volume("other", owned("other", "x", "else"));
    fake.runningContainer("unrelated", [
      { Type: "bind", Source: "/srv/app", Destination: "/app" },
      {
        Type: "volume",
        Name: "other",
        Source: "/var/lib/docker/volumes/other/_data",
        Destination: "/x",
      },
    ]);
    const result = await exportProjectData(input(fake));
    expect(result.manifest.volumes.map((volume) => volume.key)).toEqual(["db"]);
  });

  test("a running container Docker does not answer for refuses closed", async () => {
    const fake = engine({ only: "db" });
    const gone = fake.runningContainer("vanishing", []);
    const real = fake.docker();
    const docker: DataBackupDocker = {
      ...real,
      capture: async (argv, opts) => {
        const result = await real.capture(argv, opts);
        // It exited and was removed between `ps` and the inspect.
        if (argv.includes("{{.Id}} {{json .Mounts}}")) {
          fake.containers.delete(gone);
          return await real.capture(argv, opts);
        }
        return result;
      },
    };
    const error = await caught(exportProjectData({ ...input(fake), docker }));
    expect(error.code).toBe("E_PROJECT_RUNNING");
    expect(error.detail).toEqual({
      unchecked: [gone.slice(0, 12)],
      reason: "unchecked_running",
    });
    expect(creates(fake)).toEqual([]);
  });

  test("this run's own containers are excluded by ID", async () => {
    const fake = engine({ only: "db" });
    const own = fake.runningContainer("hack-data-export-own", [
      { Type: "bind", Source: MOUNTPOINT, Destination: "/v" },
    ]);
    const watched = [{ name: "shop_db", mountpoint: MOUNTPOINT }];
    const check = (exclude: ReadonlySet<string>) =>
      refuseRunning({
        docker: fake.docker(),
        composeProject: PROJECT,
        volumes: watched,
        exclude,
        timeoutMs: 1000,
        stopCommand: "hack down",
        lead: "Running.",
        command: "export",
      });
    await check(new Set([own]));
    const error = await caught(check(new Set()));
    expect(error.detail).toEqual({ running: [own.slice(0, 12)] });
    // The exclusion is by the full ID only, never by name.
    const byName = await caught(check(new Set(["hack-data-export-own"])));
    expect(byName.detail).toEqual({ running: [own.slice(0, 12)] });
  });
});

describe("volume mounts are checked through their backing storage", () => {
  const MOUNTPOINT = "/var/lib/docker/volumes/shop_db/_data";
  /** A foreign `local` volume whose options bind `device`: an alias. */
  function alias(fake: FakeEngine, name: string, device: string): void {
    fake.volume(name, {
      labels: {},
      content: "",
      options: { type: "none", o: "bind", device },
    });
  }
  const mountOf = (name: string) => ({
    Type: "volume",
    Name: name,
    Source: `/var/lib/docker/volumes/${name}/_data`,
    Destination: "/data",
  });

  test("a running container writing through an alias of an owned Mountpoint, or a path inside it, refuses", async () => {
    for (const device of [
      MOUNTPOINT,
      `${MOUNTPOINT}/pgdata`,
      `${MOUNTPOINT}/`,
    ]) {
      const fake = engine({ only: "db" });
      alias(fake, "alias", device);
      const id = fake.runningContainer("alias-writer", [mountOf("alias")]);
      const error = await caught(
        exportProjectData(input(fake, { outDir: join(root, "alias") }))
      );
      expect({ device, code: error.code, detail: error.detail }).toEqual({
        device,
        code: "E_PROJECT_RUNNING",
        detail: { running: [id.slice(0, 12)] },
      });
      expect(`${error.message}${JSON.stringify(error.detail)}`).not.toContain(
        "alias"
      );
    }
  });

  test("an alias writer that starts during the window refuses publication", async () => {
    const fake = engine({ only: "db" });
    alias(fake, "alias", MOUNTPOINT);
    let id = "";
    fake.onExec = (_container, args) => {
      if (args.includes("tar") && id === "") {
        id = fake.createForeign("short-lived", [mountOf("alias")]) ?? "";
      }
    };
    const error = await caught(exportProjectData(input(fake)));
    expect(error.code).toBe("E_PROJECT_RUNNING");
    expect(error.detail).toEqual({
      mounts: [{ volume: "db", container: id.slice(0, 12) }],
    });
    expect(await readdir(partialDir())).toEqual(["db.tar"]);
  });

  test("a non-local driver, or local options Hack cannot classify, refuses closed", async () => {
    for (const [driver, options] of [
      ["rexray/ebs", null],
      ["local", { type: "nfs", o: "addr=10.0.0.2,rw", device: ":/export" }],
      ["local", { type: "ext4", device: "/dev/sdb1" }],
    ] as const) {
      const fake = engine({ only: "db" });
      fake.volume("opaque", { labels: {}, content: "", driver, options });
      const id = fake.runningContainer("opaque-writer", [mountOf("opaque")]);
      const error = await caught(
        exportProjectData(input(fake, { outDir: join(root, "opaque") }))
      );
      expect({
        driver,
        options,
        code: error.code,
        detail: error.detail,
      }).toEqual({
        driver,
        options,
        code: "E_PROJECT_RUNNING",
        detail: {
          unchecked: [id.slice(0, 12)],
          reason: "unchecked_volume_backing",
        },
      });
      expect(error.message).not.toContain("opaque");
    }
  });

  test("a volume Docker cannot inspect refuses closed", async () => {
    const fake = engine({ only: "db" });
    const id = fake.runningContainer("ghost-writer", [mountOf("ghost")]);
    const error = await caught(exportProjectData(input(fake)));
    expect(error.detail).toEqual({
      unchecked: [id.slice(0, 12)],
      reason: "unchecked_volume_backing",
    });
  });

  test("an alias of an unrelated directory and a tmpfs volume publish", async () => {
    const fake = engine({ only: "db" });
    alias(fake, "elsewhere", "/srv/data");
    fake.volume("scratch", {
      labels: {},
      content: "",
      options: { type: "tmpfs", device: "tmpfs", o: "size=64m" },
    });
    fake.runningContainer("app", [mountOf("elsewhere"), mountOf("scratch")]);
    const result = await exportProjectData(input(fake));
    expect(result.manifest.volumes.map((volume) => volume.key)).toEqual(["db"]);
  });
});

describe("bind sources and alias devices are proven on the daemon", () => {
  const MOUNTPOINT = "/var/lib/docker/volumes/shop_db/_data";
  const aliasMount = (name: string) => ({
    Type: "volume",
    Name: name,
    Source: `/var/lib/docker/volumes/${name}/_data`,
    Destination: "/data",
  });
  function alias(fake: FakeEngine, name: string, device: string): void {
    fake.volume(name, {
      labels: {},
      content: "",
      options: { type: "none", o: "bind", device },
    });
  }

  test("an alias device through /proc/self/root, or a symlink to the Mountpoint, refuses", async () => {
    for (const [device, link] of [
      [`/proc/self/root${MOUNTPOINT}`, null],
      ["/srv/link-to-db", MOUNTPOINT],
      ["/srv/link-to-volumes/shop_db/_data", "/var/lib/docker/volumes"],
    ] as const) {
      const fake = engine({ only: "db" });
      if (link !== null) {
        fake.symlinks.set(
          device.startsWith("/srv/link-to-volumes")
            ? "/srv/link-to-volumes"
            : device,
          link
        );
      }
      alias(fake, "alias", device);
      const id = fake.runningContainer("alias-writer", [aliasMount("alias")]);
      const error = await caught(
        exportProjectData(input(fake, { outDir: join(root, "proc") }))
      );
      expect({ device, code: error.code, detail: error.detail }).toEqual({
        device,
        code: "E_PROJECT_RUNNING",
        detail: { running: [id.slice(0, 12)] },
      });
    }
  });

  test("a bind source through /proc/self/root or a symlink refuses, running or started in the window", async () => {
    const fake = engine({ only: "db" });
    fake.symlinks.set("/srv/db", MOUNTPOINT);
    const id = fake.runningContainer("binder", [
      { Type: "bind", Source: "/srv/db", Destination: "/x" },
    ]);
    const error = await caught(exportProjectData(input(fake)));
    expect(error.detail).toEqual({ running: [id.slice(0, 12)] });

    const late = engine({ only: "db" });
    let started = "";
    late.onExec = (_container, args) => {
      if (args.includes("tar") && started === "") {
        started =
          late.createForeign("short-lived", [
            {
              Type: "bind",
              Source: "/proc/self/root/var/lib/docker/volumes/shop_db",
              Destination: "/x",
            },
          ]) ?? "";
      }
    };
    const raced = await caught(
      exportProjectData(input(late, { outDir: join(root, "late") }))
    );
    expect(raced.detail).toEqual({
      mounts: [{ volume: "db", container: started.slice(0, 12) }],
    });
  });

  test("a bind alias and a bind of truly separate directories publish after the proof", async () => {
    const fake = engine({ only: "db" });
    alias(fake, "elsewhere", "/srv/data");
    fake.runningContainer("app", [
      aliasMount("elsewhere"),
      { Type: "bind", Source: "/srv/app", Destination: "/app" },
    ]);
    const result = await exportProjectData(input(fake));
    expect(result.manifest.volumes.map((volume) => volume.key)).toEqual(["db"]);
    // The proof helper ran, tracked like every helper and removed.
    const proofCreate = fake.calls.find(
      (argv) =>
        argv[1] === "create" && argv.some((arg) => arg.includes("dst=/c/0"))
    );
    expect(proofCreate).toBeDefined();
    expect(proofCreate).toContain("none");
    expect(
      fake.leftovers().filter((id) => fake.containers.get(id)?.name !== "app")
    ).toEqual([]);
  });

  test("a proof that cannot be made refuses closed", async () => {
    for (const setup of [
      (fake: FakeEngine) => {
        fake.proofFails = true;
      },
      (fake: FakeEngine) => {
        fake.missingPaths.add("/srv/app");
      },
    ]) {
      const fake = engine({ only: "db" });
      setup(fake);
      const id = fake.runningContainer("app", [
        { Type: "bind", Source: "/srv/app", Destination: "/app" },
      ]);
      const error = await caught(
        exportProjectData(input(fake, { outDir: join(root, "unproven") }))
      );
      expect(error.detail).toEqual({
        unchecked: [id.slice(0, 12)],
        reason: "unchecked_volume_backing",
      });
    }
  });
});

describe("default backup names within one second", () => {
  const backups = (): string => join(root, "home", "data-backups", PROJECT);

  test("two default-path exports in the same second publish two distinct backups", async () => {
    const first = await exportProjectData(input(engine({ only: "db" })));
    const second = await exportProjectData(input(engine({ only: "db" })));
    expect(first.backup).toBe(join(backups(), "20261123T140501Z"));
    expect(second.backup).toBe(join(backups(), "20261123T140501Z-2"));
    expect((await readdir(backups())).sort()).toEqual([
      "20261123T140501Z",
      "20261123T140501Z-2",
    ]);
  });

  test("a refused export's .partial is never reused: a quick retry takes the next name", async () => {
    const failing = engine({ only: "db" });
    failing.tarExit.shop_db = 2;
    const refused = await caught(exportProjectData(input(failing)));
    expect(refused.code).toBe("E_UNEXPECTED");
    const retried = await exportProjectData(input(engine({ only: "db" })));
    expect(retried.backup).toBe(join(backups(), "20261123T140501Z-2"));
    // The refused copy stays where it was, untouched.
    expect((await readdir(backups())).sort()).toEqual([
      "20261123T140501Z-2",
      "20261123T140501Z.partial",
    ]);
    expect(await readdir(join(backups(), "20261123T140501Z.partial"))).toEqual([
      "db.tar",
    ]);
  });

  test("concurrent default-path exports in one second never share a name", async () => {
    const results = await Promise.all(
      [0, 1, 2].map(() => exportProjectData(input(engine({ only: "db" }))))
    );
    expect(new Set(results.map((result) => result.backup)).size).toBe(3);
  });

  test("an explicit --out collision still refuses", async () => {
    const out = join(root, "explicit");
    await exportProjectData(input(engine({ only: "db" }), { outDir: out }));
    const conflict = await caught(
      exportProjectData(input(engine({ only: "db" }), { outDir: out }))
    );
    expect(conflict.code).toBe("E_PATH_CONFLICT");
    expect(await readdir(out)).toEqual(["20261123T140501Z"]);
  });
});

describe("a create whose outcome cannot be reconciled is reported, not hidden", () => {
  /**
   * Docker accepts the matching create, but its response is lost (the
   * client times out) and the lookup by name and nonce fails too.
   */
  function lostCreate(
    fake: FakeEngine,
    matches: (argv: readonly string[]) => boolean,
    lookupFails: boolean
  ): DataBackupDocker {
    const real = fake.docker();
    let lost = false;
    // The engine also loses the create event: nothing can reconcile it.
    fake.events.deliverContainerCreates = !lookupFails;
    return {
      ...real,
      capture: async (argv, opts) => {
        if (!lost && argv[1] === "create" && matches(argv)) {
          lost = true;
          await real.capture(argv, opts);
          return { exitCode: FAKE_TIMEOUT_EXIT, stdout: "", stderr: "" };
        }
        if (
          lookupFails &&
          ((argv[2] === "inspect" &&
            argv.some((arg) => arg.includes(".Config.Labels"))) ||
            (argv[1] === "ps" && argv.includes("--all")))
        ) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: "error during connect: the engine stopped answering",
          };
        }
        return await real.capture(argv, opts);
      },
    };
  }

  const kinds = {
    hold: (argv: readonly string[]) =>
      argv.some((arg) => arg.startsWith("type=bind,")),
    reference: (argv: readonly string[]) =>
      argv.some((arg) => arg.startsWith("type=volume,")),
    marker: (argv: readonly string[]) => !argv.includes("--mount"),
  } as const;

  for (const [kind, matches] of Object.entries(kinds)) {
    test(`an unreconciled ${kind} create gives the unknown cleanup outcome and its command`, async () => {
      const fake = engine({ only: "db" });
      const error = await caught(
        exportProjectData({
          ...input(fake, { outDir: join(root, kind) }),
          docker: lostCreate(fake, matches, true),
        })
      );
      // The container Docker made is still there, untracked.
      const [left] = fake.leftovers();
      const nonce =
        fake.containers.get(left ?? "")?.labels["io.hack.data-backup.nonce"] ??
        "";
      expect(nonce).toMatch(/^[a-f0-9]{32}$/);
      const label = `io.hack.data-backup.nonce=${nonce}`;
      const hackCommand = `hack data cleanup --nonce=${nonce}`;
      expect((error.detail as { readonly cleanup?: unknown }).cleanup).toEqual({
        container: null,
        removed: false,
        outcome: "unknown",
        label,
        hackCommand,
      });
      expect(error.message).toContain(hackCommand);
      expect(error.message).toContain(label);
      // The only instruction: no raw docker command.
      expect(error.message).not.toContain("docker ps");
    });
  }

  test("a lost reference create that the lookup recovers is cleaned up normally", async () => {
    const fake = engine({ only: "db" });
    const error = await caught(
      exportProjectData({
        ...input(fake),
        docker: lostCreate(fake, kinds.reference, false),
      })
    );
    expect(error.code).toBe("E_DOCKER_UNAVAILABLE");
    expect(JSON.stringify(error.detail ?? {})).not.toContain("unknown");
    expect(fake.leftovers()).toEqual([]);
  });
});

describe("a create that timed out is settled only by finding and removing the container", () => {
  /**
   * The bind-hold create times out on the client. `land` says when the
   * daemon registers it: never, or during the Nth lookup by name and nonce
   * (the daemon still processing the request after the client gave up).
   */
  function timedOutCreate(
    fake: FakeEngine,
    opts: {
      readonly landAtLookup: number | null;
      readonly exitCode?: number;
      /** Land this long after the timeout instead (inside the window). */
      readonly landAfterMs?: number;
      /** Which create times out: a bind hold (default) or the start marker. */
      readonly which?: "hold" | "marker";
    }
  ): {
    docker: DataBackupDocker;
    lookups: () => number;
    /** The daemon registers the timed-out create now (after the run). */
    land: () => Promise<void>;
  } {
    const real = fake.docker();
    let pending: readonly string[] | null = null;
    let lookups = 0;
    return {
      lookups: () => lookups,
      land: async () => {
        if (pending !== null) {
          await real.capture(pending);
        }
      },
      docker: {
        ...real,
        capture: async (argv, captureOpts) => {
          const isTarget =
            opts.which === "marker"
              ? !argv.includes("--mount")
              : argv.some((arg) => arg.startsWith("type=bind,"));
          if (pending === null && argv[1] === "create" && isTarget) {
            pending = argv;
            const landing = argv;
            if (opts.landAfterMs !== undefined) {
              // The daemon registers it after the client gave up.
              setTimeout(() => {
                void real.capture(landing, captureOpts);
              }, opts.landAfterMs);
            }
            return {
              exitCode: opts.exitCode ?? FAKE_TIMEOUT_EXIT,
              stdout: "",
              stderr:
                opts.exitCode === undefined ? "" : "connection reset by peer",
            };
          }
          if (
            argv[2] === "inspect" &&
            argv.some((arg) => arg.includes(".Config.Labels"))
          ) {
            lookups += 1;
            if (pending !== null && lookups === opts.landAtLookup) {
              await real.capture(pending, captureOpts);
            }
          }
          return await real.capture(argv, captureOpts);
        },
      },
    };
  }

  const records = (): Promise<string[]> =>
    readdir(join(root, "home", "data-cleanup")).catch(() => []);

  test('a start marker\'s timeout plus "No such container" stays unknown; the record stays', async () => {
    const fake = engine({ only: "db" });
    const { docker, lookups } = timedOutCreate(fake, {
      landAtLookup: null,
      which: "marker",
    });
    const error = await caught(exportProjectData({ ...input(fake), docker }));
    expect(lookups()).toBe(TIMED_OUT_CREATE_LOOKUPS);
    const cleanup = (error.detail as { cleanup: Record<string, unknown> })
      .cleanup;
    expect(cleanup).toMatchObject({ outcome: "unknown" });
    const nonce = String(cleanup.label).split("=")[1];
    expect(await records()).toEqual([`${nonce}.json`]);
    const record = JSON.parse(
      await readFile(
        join(root, "home", "data-cleanup", `${nonce}.json`),
        "utf8"
      )
    );
    expect(record.unresolvedCreates).toHaveLength(1);
    expect(record.unresolvedCreates[0]).toMatch(/-start$/);
  });

  test("a container that lands inside the settle window is removed and the record deleted", async () => {
    const fake = engine({ only: "db" });
    // After the lookups (about 1.6 s), inside the 2 s window.
    const { docker } = timedOutCreate(fake, {
      landAtLookup: null,
      landAfterMs: 2400,
    });
    const error = await caught(exportProjectData({ ...input(fake), docker }));
    expect(error.code).toBe("E_DOCKER_UNAVAILABLE");
    expect(JSON.stringify(error.detail ?? {})).not.toContain("unknown");
    // The hold landed (it was created) and was removed with the rest.
    expect(
      fake.created.some((entry) =>
        /^hack-data-export-[a-f0-9]{24}$/.test(entry.name)
      )
    ).toBeTrue();
    expect(fake.leftovers()).toEqual([]);
    expect(await records()).toEqual([]);
  });

  test("a holder that appears after the window: the run keeps the record as unknown, and a later cleanup removes it", async () => {
    // "No such container" through every lookup, the whole window and the
    // final listing; the daemon registers the hold only after the run.
    const fake = engine({ only: "db" });
    const { docker, lookups, land } = timedOutCreate(fake, {
      landAtLookup: null,
    });
    const error = await caught(exportProjectData({ ...input(fake), docker }));
    expect(lookups()).toBe(TIMED_OUT_CREATE_LOOKUPS);
    // The final listing by label and name ran after the window.
    expect(
      fake.calls.some(
        (argv) =>
          argv[1] === "ps" &&
          argv.includes("--all") &&
          argv.some((arg) => arg.startsWith("name=^"))
      )
    ).toBeTrue();
    const cleanup = (error.detail as { cleanup: Record<string, unknown> })
      .cleanup;
    const nonce = String(cleanup.label).split("=")[1] ?? "";
    expect(cleanup).toEqual({
      container: null,
      removed: false,
      outcome: "unknown",
      label: `io.hack.data-backup.nonce=${nonce}`,
      hackCommand: `hack data cleanup --nonce=${nonce}`,
    });
    const hackHome = join(root, "home");
    const before = await readDataCleanupRecord({ hackHome, nonce });
    expect(before.unresolvedCreates).toHaveLength(1);
    const [hold] = before.unresolvedCreates ?? [];
    expect(hold).toMatch(/^hack-data-export-[a-f0-9]{24}$/);

    // A cleanup before it appears keeps the record and names the create.
    const early = await caught(
      cleanupRecordedRun({
        hackHome,
        record: before,
        docker: fake.docker(),
        deadlines: DEADLINES,
      })
    );
    expect(early.code).toBe("E_UNEXPECTED");
    expect(early.detail).toMatchObject({
      outcome: "unknown",
      unresolvedCreates: [hold],
    });
    expect(await records()).toEqual([`${nonce}.json`]);

    await land();
    expect(fake.leftovers()).toHaveLength(1);
    const result = await cleanupRecordedRun({
      hackHome,
      record: await readDataCleanupRecord({ hackHome, nonce }),
      docker: fake.docker(),
      deadlines: DEADLINES,
    });
    expect(result.removed).toHaveLength(1);
    expect(fake.leftovers()).toEqual([]);
    expect(await records()).toEqual([]);
  });

  test("a timeout where a later lookup finds the container removes it; not unknown", async () => {
    const fake = engine({ only: "db" });
    const { docker, lookups } = timedOutCreate(fake, { landAtLookup: 3 });
    const error = await caught(exportProjectData({ ...input(fake), docker }));
    expect(lookups()).toBe(3);
    expect(error.code).toBe("E_DOCKER_UNAVAILABLE");
    expect(JSON.stringify(error.detail ?? {})).not.toContain("unknown");
    // Found by its nonce, tracked by ID and removed with confirmation.
    expect(fake.leftovers()).toEqual([]);
  });

  test("a create that failed without a timeout and is absent stays absent", async () => {
    const fake = engine({ only: "db" });
    const { docker, lookups } = timedOutCreate(fake, {
      landAtLookup: null,
      exitCode: 1,
    });
    const error = await caught(exportProjectData({ ...input(fake), docker }));
    expect(lookups()).toBe(1);
    expect(JSON.stringify(error.detail ?? {})).not.toContain("unknown");
    expect(fake.leftovers()).toEqual([]);
  });
});

describe("the unknown cleanup instruction targets the export's engine", () => {
  /** A marker create Docker accepts while the response and lookup fail. */
  function unreconciled(
    fake: FakeEngine,
    extra: Pick<DataBackupDocker, "engine" | "hackCleanupCommand">
  ): DataBackupDocker {
    const real = fake.docker();
    let lost = false;
    fake.events.deliverContainerCreates = false;
    return {
      ...real,
      ...extra,
      capture: async (argv, opts) => {
        if (!lost && argv[1] === "create" && !argv.includes("--mount")) {
          lost = true;
          await real.capture(argv, opts);
          return { exitCode: FAKE_TIMEOUT_EXIT, stdout: "", stderr: "" };
        }
        if (
          (argv[2] === "inspect" &&
            argv.some((arg) => arg.includes(".Config.Labels"))) ||
          (argv[1] === "ps" && argv.includes("--all"))
        ) {
          return { exitCode: 1, stdout: "", stderr: "error during connect" };
        }
        return await real.capture(argv, opts);
      },
    };
  }

  test("the refusal names only hack data cleanup with the run's selection, and no endpoint", async () => {
    // Recognizable stand-ins: a credential-free endpoint and one with
    // userinfo. Neither may appear in any output, quoted or not.
    for (const host of [
      "tcp://10.0.0.5:2376",
      "ssh://deploy:canary-pass-31@build.example",
    ]) {
      const fake = engine({ only: "db" });
      const error = await caught(
        exportProjectData({
          ...input(fake, { outDir: join(root, host.slice(0, 3)) }),
          docker: {
            ...unreconciled(fake, {
              engine: { host, context: null },
              hackCleanupCommand: (nonce) =>
                `hack data cleanup --branch=feature-x --nonce=${nonce}`,
            }),
            redactValues: [host],
          },
        })
      );
      const cleanup = (error.detail as { cleanup: Record<string, unknown> })
        .cleanup;
      const nonce = String(cleanup.label).split("=")[1] ?? "";
      expect(cleanup).toEqual({
        container: null,
        removed: false,
        outcome: "unknown",
        label: `io.hack.data-backup.nonce=${nonce}`,
        hackCommand: `hack data cleanup --branch=feature-x --nonce=${nonce}`,
      });
      const rendered = `${error.message}${JSON.stringify(error.detail)}`;
      expect({ host, leaked: rendered.includes(host) }).toEqual({
        host,
        leaked: false,
      });
      for (const fragment of [
        "10.0.0.5",
        "canary-pass-31",
        "DOCKER_HOST",
        "docker ps",
      ]) {
        expect({ fragment, found: rendered.includes(fragment) }).toEqual({
          fragment,
          found: false,
        });
      }
    }
  });
});

describe("the run's cleanup record", () => {
  const recordsDir = (): string => join(root, "home", "data-cleanup");

  test("is written before the first create, holds no endpoint, and is removed once the run is settled", async () => {
    const fake = engine({ only: "db" });
    // Recognizable stand-in endpoint for a managed DOCKER_HOST.
    const host = "tcp://10.0.0.5:2376";
    const real = fake.docker();
    let atFirstCreate: string[] | null = null;
    let recordText = "";
    const docker: DataBackupDocker = {
      ...real,
      engine: { host, context: null },
      capture: async (argv, opts) => {
        if (atFirstCreate === null && argv[1] === "create") {
          atFirstCreate = await readdir(recordsDir()).catch(() => []);
          const [file] = atFirstCreate;
          recordText = await readFile(join(recordsDir(), file ?? ""), "utf8");
        }
        return await real.capture(argv, opts);
      },
    };
    await exportProjectData({
      ...input(fake),
      docker,
      envSelection: "staging",
    });
    expect(atFirstCreate).toHaveLength(1);
    const record = JSON.parse(recordText);
    expect(record).toMatchObject({
      version: 1,
      command: "export",
      project: PROJECT,
      branch: null,
      envName: "staging",
      envDefault: false,
      engine: { kind: "managed-host", overlay: "staging" },
    });
    expect(record.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(record.endpointSha256).toBe(sha(`host\n${host}`));
    expect(recordText).not.toContain("10.0.0.5");
    // Every container of the run went with it: the record is removed.
    expect(await readdir(recordsDir())).toEqual([]);
    // Every container the run made carries the run's nonce.
    for (const entry of fake.created) {
      expect(fake.calls).toContainEqual(
        expect.arrayContaining([`io.hack.data-backup.nonce=${record.nonce}`])
      );
      expect(entry.id).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  test("stays when a create could not be reconciled", async () => {
    const fake = engine({ only: "db" });
    fake.events.deliverContainerCreates = false;
    const real = fake.docker();
    let lost = false;
    const docker: DataBackupDocker = {
      ...real,
      capture: async (argv, opts) => {
        if (!lost && argv[1] === "create" && !argv.includes("--mount")) {
          lost = true;
          await real.capture(argv, opts);
          return { exitCode: FAKE_TIMEOUT_EXIT, stdout: "", stderr: "" };
        }
        if (
          (argv[2] === "inspect" &&
            argv.some((arg) => arg.includes(".Config.Labels"))) ||
          (argv[1] === "ps" && argv.includes("--all"))
        ) {
          return { exitCode: 1, stdout: "", stderr: "error during connect" };
        }
        return await real.capture(argv, opts);
      },
    };
    const error = await caught(exportProjectData({ ...input(fake), docker }));
    const nonce = String(
      (error.detail as { cleanup: { label: string } }).cleanup.label
    ).split("=")[1];
    expect(await readdir(recordsDir())).toEqual([`${nonce}.json`]);
  });
});

describe("the daemon's ID proves the engine", () => {
  const recordsDir = (): string => join(root, "home", "data-cleanup");

  test("is read before the first create and stored in the record", async () => {
    const fake = engine({ only: "db" });
    fake.daemonId = "WXYZ:ABCD:0042";
    const real = fake.docker();
    const order: string[] = [];
    const docker: DataBackupDocker = {
      ...real,
      capture: async (argv, opts) => {
        if (argv[1] === "info" || argv[1] === "create") {
          order.push(argv[1]);
        }
        if (
          argv[1] === "create" &&
          order.filter((step) => step === "create").length === 1
        ) {
          const [file] = await readdir(recordsDir());
          const record = JSON.parse(
            await readFile(join(recordsDir(), file ?? ""), "utf8")
          );
          expect(record.daemonId).toBe("WXYZ:ABCD:0042");
        }
        return await real.capture(argv, opts);
      },
    };
    await exportProjectData({ ...input(fake), docker });
    expect(order[0]).toBe("info");
    expect(order.indexOf("info")).toBeLessThan(order.indexOf("create"));
    expect(fake.calls.find((argv) => argv[1] === "info")).toEqual([
      "docker",
      "info",
      "--format",
      "{{.ID}}",
    ]);
  });

  test("an ID that cannot be read refuses the run before any create", async () => {
    for (const daemonId of [null, ""]) {
      const fake = engine({ only: "db" });
      fake.daemonId = daemonId;
      const error = await caught(
        exportProjectData(
          input(fake, { outDir: join(root, `none-${daemonId}`) })
        )
      );
      expect({ daemonId, code: error.code, detail: error.detail }).toEqual({
        daemonId,
        code: "E_DOCKER_UNAVAILABLE",
        detail: { reason: "daemon_id_unreadable" },
      });
      expect(fake.calls.some((argv) => argv[1] === "create")).toBeFalse();
      expect(await readdir(recordsDir()).catch(() => [])).toEqual([]);
    }
  });
});
