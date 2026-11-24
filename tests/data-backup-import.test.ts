import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderDataImportText } from "../src/commands/data.ts";
import { HackCliError } from "../src/lib/cli-result.ts";
import {
  DATA_IMPORT_SOURCE_LABEL,
  type DataImportInput,
  importProjectData,
} from "../src/lib/data-backup-import.ts";
import {
  dataImportJournalPath,
  readDataImportJournal,
  withDataImportLock,
  writeDataImportJournal,
} from "../src/lib/data-import-journal.ts";
import {
  COMPOSE,
  FAKE_TIMEOUT_EXIT,
  FakeEngine,
  fakePsId,
} from "./helpers/data-backup-fake-engine.ts";

const PROJECT = "shop";
const NOW = new Date("2026-11-24T10:00:00.000Z");
const DEADLINES = { commandMs: 1000, stepMs: 60_000 };
const sha = (text: string | Buffer): string =>
  createHash("sha256").update(text).digest("hex");
const OWNED = (key: string, project = PROJECT) => ({
  "com.docker.compose.project": project,
  "com.docker.compose.volume": key,
});

function model(volumes: Record<string, unknown>, name = PROJECT): unknown {
  return { name, services: {}, volumes };
}

function engine(): FakeEngine {
  const fake = new FakeEngine();
  fake.model = model({
    db: { name: "shop_db" },
    cache: { name: "shop_cache" },
  });
  return fake;
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hack-data-import-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A backup as export writes it; each tar holds `rows-<key>`. */
async function writeBackup(opts: {
  readonly keys: readonly string[];
  readonly composeProject?: string;
  readonly name?: string;
  /** Tree contents per key; default `rows-<key>`. */
  readonly contents?: Readonly<Record<string, string>>;
}): Promise<string> {
  const composeProject = opts.composeProject ?? PROJECT;
  const dir = join(root, "backups", opts.name ?? "20261124T090000Z");
  await mkdir(dir, { recursive: true });
  const volumes: unknown[] = [];
  for (const key of opts.keys) {
    const content = opts.contents?.[key] ?? `rows-${key}`;
    const bytes = `tar:${content}`;
    await writeFile(join(dir, `${key}.tar`), bytes);
    volumes.push({
      key,
      nameSha256: sha(`${composeProject}_${key}`),
      driver: "local",
      labelsSha256: {
        "com.docker.compose.project": sha(composeProject),
        "com.docker.compose.volume": sha(key),
      },
      file: `${key}.tar`,
      tarBytes: bytes.length,
      tarSha256: sha(bytes),
      entries: 3,
      excludedSockets: 0,
      contentDigest: sha(content),
    });
  }
  await writeFile(
    join(dir, "manifest.json"),
    `${JSON.stringify(
      {
        schema: "hack.data-backup.v1",
        project: composeProject,
        branch: null,
        composeProjectSha256: sha(composeProject),
        createdAt: "2026-11-24T09:00:00.000Z",
        hackVersion: "9.9.9",
        helperImage: "oven/bun@sha256:x",
        digestAlgorithm: "hack.tree-digest.v1",
        volumes,
        skipped: [],
      },
      null,
      2
    )}\n`
  );
  return dir;
}

async function backupId(dir: string): Promise<string> {
  return sha(await readFile(join(dir, "manifest.json")));
}

function input(
  fake: FakeEngine,
  backupPath: string,
  extra: Partial<DataImportInput> = {}
) {
  return {
    docker: fake.docker(),
    composeArgs: COMPOSE,
    backupPath,
    project: PROJECT,
    branch: null,
    hackHome: join(root, "home"),
    now: () => NOW,
    deadlines: DEADLINES,
    ...extra,
  } satisfies DataImportInput;
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

/** Calls that could write a volume: create, extract, clear. */
function writes(fake: FakeEngine): string[][] {
  return fake.calls.filter(
    (argv) =>
      (argv[1] === "volume" && argv[2] === "create") ||
      argv.includes("-xpf") ||
      argv.includes("-delete")
  );
}

function journal(key: string, project = PROJECT) {
  return readDataImportJournal(
    dataImportJournalPath({
      hackHome: join(root, "home"),
      composeProject: project,
      key,
    })
  );
}

describe("backup verification runs before any effect", () => {
  test("an interrupted .partial export is refused", async () => {
    const dir = await writeBackup({
      keys: ["db"],
      name: "20261124T090000Z.partial",
    });
    const fake = engine();
    const error = await caught(importProjectData(input(fake, dir)));
    expect(error.code).toBe("E_BACKUP_INVALID");
    expect(error.message).toContain(".partial");
    expect(fake.calls).toEqual([]);
  });

  test("a directory without manifest.json is refused", async () => {
    const dir = join(root, "empty");
    await mkdir(dir);
    const error = await caught(importProjectData(input(engine(), dir)));
    expect(error.code).toBe("E_BACKUP_INVALID");
    expect(error.message).toContain("manifest.json");
  });

  test("a missing tar, a size or sha256 mismatch and a foreign schema are refused", async () => {
    const missing = await writeBackup({ keys: ["db"], name: "a" });
    await rm(join(missing, "db.tar"));
    const resized = await writeBackup({ keys: ["db"], name: "b" });
    await writeFile(join(resized, "db.tar"), "tar:rows-db+");
    const altered = await writeBackup({ keys: ["db"], name: "c" });
    await writeFile(join(altered, "db.tar"), "tar:rows-dX");
    const schema = await writeBackup({ keys: ["db"], name: "d" });
    const manifest = JSON.parse(
      await readFile(join(schema, "manifest.json"), "utf8")
    );
    await writeFile(
      join(schema, "manifest.json"),
      JSON.stringify({ ...manifest, schema: "hack.data-backup.v0" })
    );
    for (const [dir, words] of [
      [missing, "db.tar is missing"],
      [resized, "has 12 bytes"],
      [altered, "sha256"],
      [schema, "hack.data-backup.v1"],
    ] as const) {
      const fake = engine();
      const error = await caught(importProjectData(input(fake, dir)));
      expect(error.code).toBe("E_BACKUP_INVALID");
      expect(error.message).toContain(words);
      expect(fake.calls).toEqual([]);
    }
  });

  test("a backup of another Compose project needs a matching --from-project", async () => {
    const dir = await writeBackup({ keys: ["db"], composeProject: "shop-old" });
    const plain = await caught(importProjectData(input(engine(), dir)));
    expect(plain.code).toBe("E_USAGE");
    expect(plain.message).toContain("--from-project shop-old");
    const wrong = await caught(
      importProjectData(input(engine(), dir, { fromProject: "nope" }))
    );
    expect(wrong.code).toBe("E_USAGE");

    const fake = engine();
    const result = await importProjectData(
      input(fake, dir, { fromProject: "shop-old" })
    );
    expect(result.sourceProject).toBe("shop-old");
    expect(result.project).toBe(PROJECT);
    expect(result.volumes.map((volume) => volume.key)).toEqual(["db"]);
    expect(fake.volumes.get("shop_db")?.content).toBe("rows-db");
  });

  test("within one project a changed Docker name needs --from-project", async () => {
    const dir = await writeBackup({ keys: ["db"] });
    const fake = engine();
    fake.model = model({ db: { name: "shop_db-renamed" } });
    const error = await caught(importProjectData(input(fake, dir)));
    expect(error.code).toBe("E_USAGE");
    expect(error.detail).toEqual({ keys: ["db"] });
    expect(error.message).not.toContain("shop_db-renamed");
    const result = await importProjectData(
      input(fake, dir, { fromProject: PROJECT })
    );
    expect(result.volumes[0]?.target).toBe("created");
  });
});

describe("targets", () => {
  test("an absent target is created with Compose's labels and the backup id, then verified", async () => {
    const dir = await writeBackup({ keys: ["db", "gone", "shared"] });
    const fake = engine();
    fake.model = model({
      db: { name: "shop_db" },
      shared: { name: "team-shared", external: true },
    });
    const result = await importProjectData(input(fake, dir));
    const id = await backupId(dir);
    expect(result).toEqual({
      backup: dir,
      backupId: id,
      sourceProject: PROJECT,
      sourceBranch: null,
      project: PROJECT,
      branch: null,
      volumes: [
        {
          key: "db",
          target: "created",
          outcome: "restored",
          entries: 3,
          excludedSockets: 0,
          contentDigest: sha("rows-db"),
        },
      ],
      skipped: [
        { key: "gone", reason: "undeclared" },
        { key: "shared", reason: "external" },
      ],
    });
    expect(fake.volumes.get("shop_db")?.labels).toEqual({
      ...OWNED("db"),
      "com.docker.compose.version": "2.29.7",
      [DATA_IMPORT_SOURCE_LABEL]: id,
    });
    expect(fake.volumes.get("shop_db")?.content).toBe("rows-db");
    // External and undeclared keys are never created, mounted or inspected.
    expect(fake.calls.some((argv) => argv.includes("team-shared"))).toBeFalse();
    expect((await journal("db"))?.state).toBe("complete");
    // The extract runs in one held, logless, network-less helper, read-write.
    const create =
      fake.calls.find(
        (argv) =>
          argv[1] === "create" &&
          (argv[argv.indexOf("--mount") + 1] ?? "").startsWith("type=bind,")
      ) ?? [];
    // A Docker reference to the created target, never started.
    expect(
      fake.calls.some(
        (argv) =>
          argv[1] === "create" &&
          argv.includes(
            "type=volume,src=shop_db,dst=/v,volume-nocopy,volume-driver=local,volume-opt=type=none"
          )
      )
    ).toBeTrue();
    expect(create[create.indexOf("--mount") + 1]).toBe(
      "type=bind,src=/var/lib/docker/volumes/shop_db/_data,dst=/v"
    );
    expect(create[create.indexOf("--log-driver") + 1]).toBe("none");
    expect(create[create.indexOf("--network") + 1]).toBe("none");
    const tar = fake.calls.find((argv) => argv.includes("-xpf")) ?? [];
    // By the ID its create returned, never by name.
    const helperId =
      fake.created.find(
        (entry) => entry.name === create[create.indexOf("--name") + 1]
      )?.id ?? "";
    expect(helperId).toMatch(/^[a-f0-9]{64}$/);
    expect(tar.slice(0, 4)).toEqual([
      "docker",
      "exec",
      "--interactive",
      helperId,
    ]);
    expect(fake.leftovers()).toEqual([]);
    expect(renderDataImportText(result)).toBe(
      [
        `Restored 1 volume from ${dir}:`,
        "  db  created  3 entries verified",
        "Skipped:",
        "  gone  no longer declared by this project",
        "  shared  external here, not managed by this project",
        "",
      ].join("\n")
    );
    // Docker names stay out of the result and the journal.
    const journalText = await readFile(
      dataImportJournalPath({
        hackHome: join(root, "home"),
        composeProject: PROJECT,
        key: "db",
      }),
      "utf8"
    );
    expect(`${JSON.stringify(result)}${journalText}`).not.toContain("shop_db");
  });

  test("an existing empty owned target is used as is", async () => {
    const dir = await writeBackup({ keys: ["db"] });
    const fake = engine();
    fake.volume("shop_db", { labels: OWNED("db"), content: "" });
    const result = await importProjectData(input(fake, dir));
    expect(result.volumes[0]?.target).toBe("empty");
    expect(fake.calls.some((argv) => argv[2] === "create")).toBeFalse();
    expect(fake.volumes.get("shop_db")?.content).toBe("rows-db");
  });

  test("foreign and non-empty targets refuse together, before any write", async () => {
    const dir = await writeBackup({ keys: ["db", "cache"] });
    const fake = engine();
    fake.volume("shop_db", { labels: {}, content: "precious" });
    fake.volume("shop_cache", { labels: OWNED("cache"), content: "live data" });
    const error = await caught(importProjectData(input(fake, dir)));
    expect(error.code).toBe("E_DATA_TARGET_CONFLICT");
    expect(error.message).toContain("hack data export");
    expect(error.detail).toEqual({
      conflicts: [
        { key: "db", reason: "foreign" },
        { key: "cache", reason: "not_empty" },
      ],
    });
    expect(writes(fake)).toEqual([]);
    expect(fake.volumes.get("shop_db")?.content).toBe("precious");
    expect(fake.volumes.get("shop_cache")?.content).toBe("live data");
    expect(await journal("cache")).toBeNull();
    expect(fake.leftovers()).toEqual([]);
  });
});

describe("interruption and recovery", () => {
  async function partial(opts: {
    readonly dir: string;
    readonly state: "started" | "failed" | "complete" | null;
    readonly label: string;
  }): Promise<FakeEngine> {
    if (opts.state) {
      await writeDataImportJournal({
        path: dataImportJournalPath({
          hackHome: join(root, "home"),
          composeProject: PROJECT,
          key: "db",
        }),
        journal: {
          backupId: await backupId(opts.dir),
          backup: opts.dir,
          key: "db",
          targetSha256: sha("shop_db"),
          state: opts.state,
        },
        now: NOW,
      });
    }
    const fake = engine();
    fake.volume("shop_db", {
      labels: { ...OWNED("db"), [DATA_IMPORT_SOURCE_LABEL]: opts.label },
      content: "rows-half",
    });
    return fake;
  }

  test("our own interrupted import is cleared and redone", async () => {
    const dir = await writeBackup({ keys: ["db"] });
    const fake = await partial({
      dir,
      state: "started",
      label: await backupId(dir),
    });
    const result = await importProjectData(input(fake, dir));
    expect(result.volumes[0]?.target).toBe("replaced-partial");
    const wipe = fake.calls.find((argv) => argv.includes("-delete")) ?? [];
    expect(wipe.slice(wipe.indexOf("find"))).toEqual([
      "find",
      "/v",
      "-mindepth",
      "1",
      "-delete",
    ]);
    expect(fake.volumes.get("shop_db")?.content).toBe("rows-db");
    expect((await journal("db"))?.state).toBe("complete");
  });

  test("a non-empty volume is never ours without both the label and an unfinished journal", async () => {
    const dir = await writeBackup({ keys: ["db"] });
    const id = await backupId(dir);
    for (const [state, label, reason] of [
      [null, id, "not_empty"],
      ["started", "another-backup", "not_empty"],
      // Completed from this backup earlier, but changed since.
      ["complete", id, "modified"],
    ] as const) {
      const fake = await partial({ dir, state, label });
      const error = await caught(importProjectData(input(fake, dir)));
      expect(error.code).toBe("E_DATA_TARGET_CONFLICT");
      expect(error.detail).toEqual({ conflicts: [{ key: "db", reason }] });
      expect(writes(fake)).toEqual([]);
      expect(fake.volumes.get("shop_db")?.content).toBe("rows-half");
      await rm(join(root, "home"), { recursive: true, force: true });
    }
  });

  test("a rerun after an interruption between targets verifies the done one and restores the rest", async () => {
    const dir = await writeBackup({ keys: ["db", "cache"] });
    const id = await backupId(dir);
    // As left by a run that completed db and stopped before cache started.
    await writeDataImportJournal({
      path: dataImportJournalPath({
        hackHome: join(root, "home"),
        composeProject: PROJECT,
        key: "db",
      }),
      journal: {
        backupId: id,
        backup: dir,
        key: "db",
        targetSha256: sha("shop_db"),
        state: "complete",
      },
      now: NOW,
    });
    const fake = engine();
    fake.volume("shop_db", {
      labels: { ...OWNED("db"), [DATA_IMPORT_SOURCE_LABEL]: id },
      content: "rows-db",
    });
    const result = await importProjectData(input(fake, dir));
    expect(
      result.volumes.map((volume) => [
        volume.key,
        volume.target,
        volume.outcome,
      ])
    ).toEqual([
      ["db", "verified-complete", "verified"],
      ["cache", "created", "restored"],
    ]);
    // db was only read; cache was created and restored.
    expect(
      writes(fake).map((argv) => argv.at(-1)?.slice(0, 20) ?? "")
    ).not.toContain("shop_db");
    expect(fake.volumes.get("shop_db")?.content).toBe("rows-db");
    expect(fake.volumes.get("shop_cache")?.content).toBe("rows-cache");
    expect((await journal("cache"))?.state).toBe("complete");
    expect(fake.leftovers()).toEqual([]);
  });

  test("a rerun when every target already matches writes nothing and succeeds", async () => {
    const dir = await writeBackup({ keys: ["db"] });
    const fake = engine();
    const first = await importProjectData(input(fake, dir));
    expect(first.volumes[0]?.outcome).toBe("restored");
    fake.calls = [];
    const again = await importProjectData(input(fake, dir));
    expect(again.volumes).toEqual([
      {
        key: "db",
        target: "verified-complete",
        outcome: "verified",
        entries: 3,
        excludedSockets: 0,
        contentDigest: sha("rows-db"),
      },
    ]);
    expect(writes(fake)).toEqual([]);
    expect(renderDataImportText(again)).toBe(
      [
        `Nothing to restore: all volumes already match this backup (${dir}):`,
        "  db  already matches this backup  3 entries verified",
        "",
      ].join("\n")
    );
  });

  test("a completed target changed after the import refuses, untouched", async () => {
    const dir = await writeBackup({ keys: ["db"] });
    const fake = engine();
    await importProjectData(input(fake, dir));
    const volume = fake.volumes.get("shop_db");
    if (volume) {
      volume.content = "rows-db-edited";
    }
    fake.calls = [];
    const error = await caught(importProjectData(input(fake, dir)));
    expect(error.code).toBe("E_DATA_TARGET_CONFLICT");
    expect(error.detail).toEqual({
      conflicts: [{ key: "db", reason: "modified" }],
    });
    expect(writes(fake)).toEqual([]);
    expect(fake.volumes.get("shop_db")?.content).toBe("rows-db-edited");
  });

  test("a complete journal of a different backup on a non-empty target refuses", async () => {
    const dir = await writeBackup({ keys: ["db"] });
    const other = await writeBackup({ keys: ["db"], name: "20261124T080000Z" });
    const manifest = JSON.parse(
      await readFile(join(other, "manifest.json"), "utf8")
    );
    await writeFile(
      join(other, "manifest.json"),
      JSON.stringify({ ...manifest, createdAt: "2026-11-24T08:00:00.000Z" })
    );
    const fake = engine();
    await importProjectData(input(fake, other));
    fake.calls = [];
    const error = await caught(importProjectData(input(fake, dir)));
    expect(error.detail).toEqual({
      conflicts: [{ key: "db", reason: "not_empty" }],
    });
    expect(writes(fake)).toEqual([]);
  });

  test("a completed target the user emptied afterwards refuses as modified, not restored again", async () => {
    const dir = await writeBackup({ keys: ["db"] });
    const fake = engine();
    await importProjectData(input(fake, dir));
    const volume = fake.volumes.get("shop_db");
    if (volume) {
      volume.content = "";
    }
    fake.calls = [];
    const error = await caught(importProjectData(input(fake, dir)));
    expect(error.detail).toEqual({
      conflicts: [{ key: "db", reason: "modified" }],
    });
    expect(writes(fake)).toEqual([]);
    expect(fake.volumes.get("shop_db")?.content).toBe("");
  });

  test("a volume empty in the backup verifies on rerun instead of being rewritten", async () => {
    const dir = await writeBackup({ keys: ["db"], contents: { db: "" } });
    const fake = engine();
    const first = await importProjectData(input(fake, dir));
    expect(first.volumes[0]?.outcome).toBe("restored");
    fake.calls = [];
    const again = await importProjectData(input(fake, dir));
    expect(again.volumes[0]).toMatchObject({
      key: "db",
      target: "verified-complete",
      outcome: "verified",
    });
    expect(writes(fake)).toEqual([]);
  });

  test("a digest mismatch marks the journal failed, leaves the volume, and a rerun replaces it", async () => {
    const dir = await writeBackup({ keys: ["db"] });
    const fake = engine();
    fake.extractAppends = "!";
    const error = await caught(importProjectData(input(fake, dir)));
    expect(error.code).toBe("E_UNEXPECTED");
    expect(error.message).toContain("Rerunning hack data import replaces");
    expect((await journal("db"))?.state).toBe("failed");
    expect(fake.volumes.get("shop_db")?.content).toBe("rows-db!");
    expect(fake.leftovers()).toEqual([]);

    fake.extractAppends = "";
    const result = await importProjectData(input(fake, dir));
    expect(result.volumes[0]?.target).toBe("replaced-partial");
    expect(fake.volumes.get("shop_db")?.content).toBe("rows-db");
    expect((await journal("db"))?.state).toBe("complete");
  });
});

describe("binding, deadlines and cleanup", () => {
  test("a volume created by someone else between the check and the create is never written", async () => {
    const dir = await writeBackup({ keys: ["db"] });
    for (const [labels, content] of [
      [{}, ""],
      [OWNED("db", "other"), "theirs"],
      // Our Compose labels but not this backup's source label.
      [OWNED("db"), ""],
    ] as const) {
      const fake = engine();
      fake.beforeVolumeCreate = (name) => {
        fake.volume(name, { labels: { ...labels }, content });
      };
      const error = await caught(importProjectData(input(fake, dir)));
      expect(error.code).toBe("E_DATA_TARGET_CONFLICT");
      expect(error.detail).toEqual({
        conflicts: [{ key: "db", reason: "changed" }],
      });
      expect(fake.calls.some((argv) => argv.includes("-xpf"))).toBeFalse();
      expect(fake.volumes.get("shop_db")?.content).toBe(content);
      expect(await journal("db")).toBeNull();
      expect(fake.leftovers()).toEqual([]);
    }
  });

  test("an empty target replaced after validation is not written", async () => {
    const dir = await writeBackup({ keys: ["db"] });
    const fake = engine();
    fake.volume("shop_db", { labels: OWNED("db"), content: "" });
    let swapped = false;
    fake.onExec = (_container, args) => {
      // After the read-only emptiness check, before the read-write hold.
      if (!swapped && args.includes("-quit")) {
        swapped = true;
        queueMicrotask(() => {
          fake.volumes.delete("shop_db");
          fake.volume("shop_db", { labels: OWNED("db"), content: "" });
        });
      }
    };
    const error = await caught(importProjectData(input(fake, dir)));
    expect(error.detail).toEqual({
      conflicts: [{ key: "db", reason: "changed" }],
    });
    expect(fake.calls.some((argv) => argv.includes("-xpf"))).toBeFalse();
    expect(fake.leftovers()).toEqual([]);
  });

  test("a stalled extract times out, marks the journal failed and removes the helper", async () => {
    const dir = await writeBackup({ keys: ["db"] });
    const fake = engine();
    const docker = fake.docker();
    const stalled = {
      ...docker,
      streamFromFile: async (
        opts: Parameters<typeof docker.streamFromFile>[0]
      ) => {
        await docker.streamFromFile(opts);
        return { exitCode: FAKE_TIMEOUT_EXIT, stdout: "", stderr: "" };
      },
    };
    const error = await caught(
      importProjectData({ ...input(fake, dir), docker: stalled })
    );
    expect(error.code).toBe("E_DOCKER_UNAVAILABLE");
    expect(error.detail).toEqual({ reason: "step_timeout", timeoutMs: 60_000 });
    expect((await journal("db"))?.state).toBe("failed");
    expect(fake.leftovers()).toEqual([]);
  });

  test("a helper removal Docker cannot confirm is reported", async () => {
    const dir = await writeBackup({ keys: ["db"] });
    const fake = engine();
    fake.onExec = (container, args) => {
      if (args.includes("-xpf")) {
        fake.rmFails.add(container);
      }
    };
    const error = await caught(importProjectData(input(fake, dir)));
    const [container] = fake.leftovers();
    expect(error.message).toContain(`docker rm -f ${container}`);
    expect(error.detail).toEqual({ cleanup: { container, removed: false } });
    expect((await journal("db"))?.state).toBe("started");
  });
});

describe("running refusal and the event fence", () => {
  test("a running project container or a container on a target refuses before any effect", async () => {
    const dir = await writeBackup({ keys: ["db"] });
    const cases: Record<string, string[]>[] = [
      { [`label=com.docker.compose.project=${PROJECT}`]: ["shop-web-1"] },
      { "volume=shop_db": ["adhoc"] },
    ];
    for (const running of cases) {
      const fake = engine();
      fake.running = running;
      const error = await caught(
        importProjectData(input(fake, dir, { downCommand: "hack down -p x" }))
      );
      expect(error.code).toBe("E_PROJECT_RUNNING");
      expect(error.message).toContain("`hack down -p x`");
      expect(writes(fake)).toEqual([]);
      expect(fake.volumes.size).toBe(0);
    }
  });

  test("a container that starts during the import keeps the journal unfinished", async () => {
    const dir = await writeBackup({ keys: ["db"] });
    const fake = engine();
    // Before: project + one volume filter (calls 0-1); after: from call 2.
    fake.runningFromCall = {
      call: 2,
      filter: `label=com.docker.compose.project=${PROJECT}`,
      names: ["shop-web-1"],
    };
    const error = await caught(importProjectData(input(fake, dir)));
    expect(error.code).toBe("E_PROJECT_RUNNING");
    expect((await journal("db"))?.state).toBe("started");
  });

  test("a foreign mount during the restore keeps the journal unfinished", async () => {
    const dir = await writeBackup({ keys: ["db"] });
    const fake = engine();
    fake.onExec = (_container, args) => {
      if (args.includes("-xpf")) {
        fake.events.mount("shop_db", "f".repeat(64));
        fake.events.start("f".repeat(64), "adhoc-writer");
      }
    };
    const error = await caught(importProjectData(input(fake, dir)));
    expect(error.code).toBe("E_PROJECT_RUNNING");
    expect(error.detail).toEqual({
      mounts: [{ volume: "db", container: "f".repeat(12) }],
    });
    expect((await journal("db"))?.state).toBe("started");
    expect(fake.events.open).toBeFalse();
  });
});

describe("helper containers are tracked by ID, never by name", () => {
  const markerNames = (fake: FakeEngine): string[] =>
    fake.calls
      .filter((argv) => argv[1] === "create" && !argv.includes("--mount"))
      .map((argv) => argv[argv.indexOf("--name") + 1] ?? "");

  test("a container reusing a removed marker's name and mounting a target is refused", async () => {
    const dir = await writeBackup({ keys: ["db"] });
    const fake = engine();
    let reuser: string | null = null;
    fake.onExec = (_container, args) => {
      if (args.includes("-xpf") && reuser === null) {
        // The start marker was removed before the restore; its name is free.
        const reused = markerNames(fake)[0] ?? "";
        expect(reused).toMatch(/^hack-data-import-[a-f0-9]{24}-start$/);
        reuser = fake.createForeign(reused);
        fake.events.mount("shop_db", reuser ?? "");
      }
    };
    const error = await caught(importProjectData(input(fake, dir)));
    expect(error.code).toBe("E_PROJECT_RUNNING");
    expect(reuser).toMatch(/^[a-f0-9]{64}$/);
    expect(error.detail).toEqual({
      mounts: [{ volume: "db", container: (reuser ?? "").slice(0, 12) }],
    });
    expect((await journal("db"))?.state).toBe("started");
  });

  test("an interrupt removes the live write hold by ID and spares a container that reused a removed marker's name", async () => {
    const dir = await writeBackup({ keys: ["db"] });
    const fake = engine();
    const keep = (): void => undefined;
    process.on("SIGINT", keep);
    const before = new Set(process.listeners("SIGINT"));
    let reuser: string | null = null;
    let live: string[] = [];
    let firstCall = 0;
    fake.onExec = (_container, args) => {
      if (args.includes("-xpf") && reuser === null) {
        reuser = fake.createForeign(markerNames(fake)[0] ?? "");
        // Live now: the target's reference, then the write hold.
        live = fake.created
          .filter((entry) => !entry.name.endsWith("-start"))
          .map((entry) => entry.id);
        firstCall = fake.calls.length;
        const handler = process
          .listeners("SIGINT")
          .find((listener) => !before.has(listener));
        (handler as () => void)();
      }
    };
    try {
      await importProjectData(input(fake, dir)).catch(() => undefined);
    } finally {
      process.off("SIGINT", keep);
    }
    expect(reuser).toMatch(/^[a-f0-9]{64}$/);
    const signalRm = fake.calls
      .slice(firstCall)
      .find((argv) => argv[1] === "rm");
    expect(live).toHaveLength(2);
    expect(signalRm).toEqual(["docker", "rm", "--force", ...live]);
    expect(fake.containers.has(reuser ?? "")).toBeTrue();
    for (const argv of fake.calls.filter((call) => call[1] === "rm")) {
      expect(argv).not.toContain(reuser);
      expect(argv).not.toContain(markerNames(fake)[0]);
    }
    expect(fake.leftovers()).toEqual([reuser ?? ""]);
  });
});

describe("container names never reach output", () => {
  // Not a credential: a recognizable stand-in for a managed value that a
  // service interpolates into `container_name: db-${TOKEN}`.
  const TOKEN = "managed-token-canary-2b9e";

  test("running and mount refusals list short IDs, not names", async () => {
    const dir = await writeBackup({ keys: ["db"] });
    const running = engine();
    running.running[`label=com.docker.compose.project=${PROJECT}`] = [
      `db-${TOKEN}`,
    ];
    const refused = await caught(importProjectData(input(running, dir)));
    expect(refused.code).toBe("E_PROJECT_RUNNING");
    expect(refused.detail).toEqual({ running: [fakePsId(`db-${TOKEN}`)] });

    const mounting = engine();
    mounting.onExec = (_container, args) => {
      if (args.includes("-xpf")) {
        const id = mounting.createForeign(`db-${TOKEN}`) ?? "";
        mounting.events.mount("shop_db", id);
      }
    };
    const mounted = await caught(
      importProjectData(input(mounting, dir, { hackHome: join(root, "h2") }))
    );
    expect(mounted.code).toBe("E_PROJECT_RUNNING");
    for (const error of [refused, mounted]) {
      expect(`${error.message}${JSON.stringify(error.detail)}`).not.toContain(
        TOKEN
      );
    }
  });
});

describe("foreign container starts during the import are inspected by ID", () => {
  let runs = 0;
  async function importWithForeignStart(
    mounts: readonly unknown[] | null
  ): Promise<{ id: string; error: HackCliError | null; state?: string }> {
    runs += 1;
    const dir = await writeBackup({ keys: ["db"], name: `b-${runs}` });
    const fake = engine();
    let id = "";
    fake.onExec = (_container, args) => {
      if (args.includes("-xpf") && id === "") {
        if (mounts === null) {
          id = "7".repeat(64);
          fake.events.start(id, "short-lived");
        } else {
          id = fake.createForeign("binder", mounts) ?? "";
        }
      }
    };
    const hackHome = join(root, `home-${runs}`);
    const error = await importProjectData(input(fake, dir, { hackHome })).then(
      () => null,
      (caughtError: unknown) => caughtError as HackCliError
    );
    return { id, error };
  }

  test("a bind of the target's Mountpoint, or a path inside it, keeps the journal unfinished", async () => {
    for (const source of [
      "/var/lib/docker/volumes/shop_db/_data",
      "/var/lib/docker/volumes/shop_db/_data/sub",
    ]) {
      const { id, error } = await importWithForeignStart([
        { Type: "bind", Source: source, Destination: "/x" },
      ]);
      expect({ source, detail: error?.detail }).toEqual({
        source,
        detail: { mounts: [{ volume: "db", container: id.slice(0, 12) }] },
      });
    }
  });

  test("unrelated mounts complete the import; a vanished start refuses closed", async () => {
    const unrelated = await importWithForeignStart([
      { Type: "bind", Source: "/srv/data", Destination: "/x" },
    ]);
    expect(unrelated.error).toBeNull();
    const vanished = await importWithForeignStart(null);
    expect(vanished.error?.code).toBe("E_PROJECT_RUNNING");
    expect(vanished.error?.detail).toEqual({
      unchecked: ["7".repeat(12)],
      reason: "unchecked_start",
    });
    expect(vanished.error?.message).toContain(
      "the restore is not marked complete"
    );
  });
});

describe("drivers and the import lock", () => {
  test("declared driver_opts or a non-local driver refuse before any change", async () => {
    const dir = await writeBackup({ keys: ["db", "cache"] });
    const fake = engine();
    fake.model = model({
      db: { name: "shop_db", driver_opts: { type: "nfs", o: "addr=x" } },
      cache: { name: "shop_cache", driver: "rexray" },
    });
    const error = await caught(importProjectData(input(fake, dir)));
    expect(error.code).toBe("E_DATA_TARGET_CONFLICT");
    expect(error.message).toContain("plain local volumes only");
    expect(error.detail).toEqual({
      conflicts: [
        { key: "db", reason: "unsupported_driver" },
        { key: "cache", reason: "unsupported_driver" },
      ],
    });
    expect(writes(fake)).toEqual([]);
    expect(fake.volumes.size).toBe(0);
  });

  test("an existing target with driver options refuses", async () => {
    const dir = await writeBackup({ keys: ["db"] });
    const fake = engine();
    fake.volume("shop_db", {
      labels: OWNED("db"),
      options: { type: "nfs" },
      content: "",
    });
    const error = await caught(importProjectData(input(fake, dir)));
    expect(error.detail).toEqual({
      conflicts: [{ key: "db", reason: "unsupported_driver" }],
    });
    expect(writes(fake)).toEqual([]);
  });

  test("a second import of the same project refuses while the first holds the lock", async () => {
    const dir = await writeBackup({ keys: ["db"] });
    const fake = engine();
    let error: HackCliError | undefined;
    await withDataImportLock({
      hackHome: join(root, "home"),
      composeProject: PROJECT,
      run: async () => {
        error = await caught(
          importProjectData(input(fake, dir, { lockTimeoutMs: 50 }))
        );
      },
    });
    expect(error?.code).toBe("E_LOCKED");
    expect(error?.message).toContain("Another hack data import");
    expect(fake.calls.some((argv) => argv[1] === "run")).toBeFalse();
    expect(fake.volumes.size).toBe(0);
    const result = await importProjectData(input(fake, dir));
    expect(result.volumes[0]?.target).toBe("created");
  });
});

describe("each target's identity is rechecked: Docker cannot pin a volume", () => {
  test("an existing empty target removed during the read-only check is never written or recreated", async () => {
    const dir = await writeBackup({ keys: ["db"] });
    const fake = engine();
    fake.volume("shop_db", { labels: OWNED("db"), content: "" });
    fake.onExec = (_container, args) => {
      if (args.includes("-quit")) {
        fake.forceRemoveVolume("shop_db");
      }
    };
    const error = await caught(importProjectData(input(fake, dir)));
    expect(error.detail).toEqual({
      conflicts: [{ key: "db", reason: "changed" }],
    });
    expect(fake.calls.some((argv) => argv.includes("-xpf"))).toBeFalse();
    expect(fake.volumes.has("shop_db")).toBeFalse();
    expect(await journal("db")).toBeNull();
  });

  test("a matching target removed while it is verified refuses instead of reporting it verified", async () => {
    const dir = await writeBackup({ keys: ["db"] });
    const fake = engine();
    await importProjectData(input(fake, dir));
    // Removed under the read-only hold: the digest of the emptied tree
    // could still be taken; the recheck refuses.
    fake.onExec = (_container, args) => {
      if (args.includes("-e")) {
        fake.forceRemoveVolume("shop_db");
      }
    };
    const error = await caught(importProjectData(input(fake, dir)));
    expect(error.detail).toEqual({
      conflicts: [{ key: "db", reason: "changed" }],
    });
    expect(fake.volumes.has("shop_db")).toBeFalse();
  });

  test("a target removed during the restore is not marked complete or recreated", async () => {
    // Docker lets the removal succeed under the bind; the extract then
    // lands in a deleted directory whose digest still matches the backup.
    const dir = await writeBackup({ keys: ["db"] });
    const fake = engine();
    fake.onExec = (_container, args) => {
      if (args.includes("-xpf")) {
        fake.forceRemoveVolume("shop_db");
      }
    };
    const error = await caught(importProjectData(input(fake, dir)));
    expect(error.code).toBe("E_PROJECT_RUNNING");
    expect(error.detail).toEqual({ key: "db", reason: "volume_changed" });
    expect(error.message).toContain("while it was being restored");
    expect((await journal("db"))?.state).toBe("started");
    expect(fake.volumes.has("shop_db")).toBeFalse();
  });

  test("a target removed, or replaced, after the restore and before completion is not marked complete", async () => {
    // `reported`: Docker's destroy/create events arrive; otherwise only the
    // identity recheck before completion sees it.
    for (const [replace, reported] of [
      [false, true],
      [true, true],
      [false, false],
      [true, false],
    ] as const) {
      const dir = await writeBackup({
        keys: ["db"],
        name: `${replace}-${reported}`,
      });
      const fake = engine();
      let restored = false;
      fake.onExec = (_container, args) => {
        if (args.includes("-xpf")) {
          restored = true;
        }
      };
      let removed = false;
      fake.onPs = () => {
        if (restored && !removed) {
          removed = true;
          if (!reported) {
            fake.events.deliverVolumeChanges = false;
          }
          fake.forceRemoveVolume("shop_db");
          if (replace) {
            fake.volume("shop_db", { labels: OWNED("db"), content: "rows-db" });
          }
        }
      };
      const hackHome = join(root, `h-${replace}-${reported}`);
      const error = await caught(
        importProjectData(input(fake, dir, { hackHome }))
      );
      expect({ replace, code: error.code, detail: error.detail }).toEqual({
        replace,
        code: "E_PROJECT_RUNNING",
        detail: { key: "db", reason: "volume_changed" },
      });
      expect(error.message).toContain(
        reported ? "Docker reported it" : "after it was restored"
      );
      const state = await readDataImportJournal(
        dataImportJournalPath({ hackHome, composeProject: PROJECT, key: "db" })
      );
      expect(state?.state).toBe("started");
    }
  });

  test("a container already running with a bind of an existing target's Mountpoint refuses before any write", async () => {
    const dir = await writeBackup({ keys: ["db"] });
    const fake = engine();
    fake.volume("shop_db", { labels: OWNED("db"), content: "" });
    const id = fake.runningContainer("pre-existing", [
      {
        Type: "bind",
        Source: "/var/lib/docker/volumes/shop_db/_data/sub",
        Destination: "/x",
      },
    ]);
    const error = await caught(importProjectData(input(fake, dir)));
    expect(error.code).toBe("E_PROJECT_RUNNING");
    expect(error.detail).toEqual({ running: [id.slice(0, 12)] });
    // No hold and no write (only the event-stream start marker ran).
    expect(
      fake.calls.some(
        (argv) => argv[1] === "create" && argv.includes("--mount")
      )
    ).toBeFalse();
    expect(fake.calls.some((argv) => argv.includes("-xpf"))).toBeFalse();
    expect(await journal("db")).toBeNull();
  });

  test("a running container with unrelated binds does not trip on a target that does not exist yet", async () => {
    // Absent targets are matched by name only: they have no Mountpoint.
    const dir = await writeBackup({ keys: ["db"] });
    const fake = engine();
    fake.runningContainer("unrelated", [
      { Type: "bind", Source: "/srv/app", Destination: "/app" },
    ]);
    const result = await importProjectData(input(fake, dir));
    expect(result.volumes[0]?.outcome).toBe("restored");
  });
});

describe("volume destroy and create events during the import", () => {
  test("import's own create of an absent target is not a replacement", async () => {
    const dir = await writeBackup({ keys: ["db"] });
    const fake = engine();
    const result = await importProjectData(input(fake, dir));
    expect(result.volumes[0]?.outcome).toBe("restored");
    // Its create really reached the window as an event.
    expect(
      fake.calls.some((argv) => argv[1] === "volume" && argv[2] === "create")
    ).toBeTrue();
    expect((await journal("db"))?.state).toBe("complete");
  });

  test("a same-second replacement of an existing target during the restore is not marked complete", async () => {
    // Same name, labels and (one-second resolution) CreatedAt: every
    // identity check passes; the extract lands in the replaced directory.
    const dir = await writeBackup({ keys: ["db"] });
    const fake = engine();
    fake.volume("shop_db", { labels: OWNED("db"), content: "" });
    const old = fake.volumes.get("shop_db");
    fake.onExec = (_container, args) => {
      if (args.includes("-xpf")) {
        fake.forceRemoveVolume("shop_db");
        fake.volume("shop_db", {
          labels: OWNED("db"),
          content: "",
          createdAt: old?.createdAt,
        });
      }
    };
    const error = await caught(importProjectData(input(fake, dir)));
    expect(error.code).toBe("E_PROJECT_RUNNING");
    expect(error.detail).toEqual({ key: "db", reason: "volume_changed" });
    expect((await journal("db"))?.state).toBe("started");
  });

  test("someone else's create of a target name after import's own is refused", async () => {
    const dir = await writeBackup({ keys: ["db"] });
    const fake = engine();
    let raced = false;
    fake.onExec = (_container, args) => {
      if (args.includes("-xpf") && !raced) {
        raced = true;
        // Destroyed and created again by someone else: our one create
        // accounts for one create event only.
        const ours = fake.volumes.get("shop_db");
        fake.forceRemoveVolume("shop_db");
        fake.volume("shop_db", {
          labels: ours?.labels ?? {},
          content: "",
          createdAt: ours?.createdAt,
        });
      }
    };
    const error = await caught(importProjectData(input(fake, dir)));
    expect(error.detail).toEqual({ key: "db", reason: "volume_changed" });
    expect((await journal("db"))?.state).toBe("started");
  });
});

describe("foreign volume mounts are judged by their backing storage", () => {
  test("a running container writing through an alias of a target refuses before any write", async () => {
    const dir = await writeBackup({ keys: ["db"] });
    const fake = engine();
    fake.volume("shop_db", { labels: OWNED("db"), content: "" });
    fake.volume("alias", {
      labels: {},
      content: "",
      options: {
        type: "none",
        o: "bind",
        device: "/var/lib/docker/volumes/shop_db/_data",
      },
    });
    const id = fake.runningContainer("alias-writer", [
      {
        Type: "volume",
        Name: "alias",
        Source: "/var/lib/docker/volumes/alias/_data",
        Destination: "/data",
      },
    ]);
    const error = await caught(importProjectData(input(fake, dir)));
    expect(error.code).toBe("E_PROJECT_RUNNING");
    expect(error.detail).toEqual({ running: [id.slice(0, 12)] });
    expect(fake.calls.some((argv) => argv.includes("-xpf"))).toBeFalse();
    expect(`${error.message}${JSON.stringify(error.detail)}`).not.toContain(
      "alias"
    );
  });

  test("a non-local volume mounted during the restore refuses closed", async () => {
    const dir = await writeBackup({ keys: ["db"] });
    const fake = engine();
    fake.volume("remote", {
      labels: {},
      content: "",
      driver: "rexray/ebs",
      options: null,
    });
    let id = "";
    fake.onExec = (_container, args) => {
      if (args.includes("-xpf") && id === "") {
        id =
          fake.createForeign("short-lived", [
            {
              Type: "volume",
              Name: "remote",
              Source: "/var/lib/docker/plugins/x",
              Destination: "/data",
            },
          ]) ?? "";
      }
    };
    const error = await caught(importProjectData(input(fake, dir)));
    expect(error.detail).toEqual({
      unchecked: [id.slice(0, 12)],
      reason: "unchecked_volume_backing",
    });
    expect((await journal("db"))?.state).toBe("started");
  });
});

describe("Docker references hold the targets", () => {
  test("a docker volume rm of an existing target during the restore is refused; the import completes", async () => {
    const dir = await writeBackup({ keys: ["db"] });
    const fake = engine();
    fake.volume("shop_db", { labels: OWNED("db"), content: "" });
    const removals: boolean[] = [];
    fake.onExec = (_container, args) => {
      if (args.includes("-xpf")) {
        removals.push(fake.removeVolume("shop_db"));
      }
    };
    const result = await importProjectData(input(fake, dir));
    expect(removals).toEqual([false]);
    expect(result.volumes[0]?.outcome).toBe("restored");
    expect((await journal("db"))?.state).toBe("complete");
    expect(fake.leftovers()).toEqual([]);
  });

  test("an existing target removed before its reference is refused, not written or recreated", async () => {
    // The reference's driver options make Docker refuse a missing name
    // instead of creating it.
    const dir = await writeBackup({ keys: ["db"] });
    const fake = engine();
    fake.volume("shop_db", { labels: OWNED("db"), content: "" });
    let removed = false;
    fake.onPs = () => {
      if (!removed) {
        removed = true;
        fake.removeVolume("shop_db");
      }
    };
    const error = await caught(importProjectData(input(fake, dir)));
    expect(error.detail).toEqual({
      conflicts: [{ key: "db", reason: "changed" }],
    });
    expect(fake.calls.some((argv) => argv.includes("-xpf"))).toBeFalse();
    expect(await journal("db")).toBeNull();
    // No volume of that name exists: import did not create one.
    expect(fake.volumes.has("shop_db")).toBeFalse();
    expect(fake.leftovers()).toEqual([]);
  });

  test("an unreconciled reference create gives the unknown cleanup outcome", async () => {
    const dir = await writeBackup({ keys: ["db"] });
    const fake = engine();
    fake.volume("shop_db", { labels: OWNED("db"), content: "" });
    // The engine loses the create's response, its event and its listing.
    fake.events.deliverContainerCreates = false;
    const real = fake.docker();
    let lost = false;
    const docker = {
      ...real,
      capture: async (
        argv: readonly string[],
        opts?: { readonly timeoutMs?: number }
      ) => {
        if (
          !lost &&
          argv[1] === "create" &&
          argv.some((arg) => arg.startsWith("type=volume,"))
        ) {
          lost = true;
          await real.capture(argv, opts);
          return { exitCode: FAKE_TIMEOUT_EXIT, stdout: "", stderr: "" };
        }
        if (
          (argv[2] === "inspect" &&
            argv.some((arg) => arg.includes(".Config.Labels"))) ||
          (argv[1] === "ps" && argv.includes("--all"))
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
    const error = await caught(
      importProjectData({ ...input(fake, dir), docker })
    );
    const [left] = fake.leftovers();
    const nonce =
      fake.containers.get(left ?? "")?.labels["io.hack.data-backup.nonce"] ??
      "";
    expect(nonce).toMatch(/^[a-f0-9]{32}$/);
    expect((error.detail as { cleanup?: unknown }).cleanup).toEqual({
      container: null,
      removed: false,
      outcome: "unknown",
      label: `io.hack.data-backup.nonce=${nonce}`,
      hackCommand: `hack data cleanup --nonce=${nonce}`,
    });
    expect(error.message).not.toContain("docker ps");
    expect(fake.calls.some((argv) => argv.includes("-xpf"))).toBeFalse();
    // The run's cleanup record stays for that cleanup.
    expect(
      await readFile(
        join(root, "home", "data-cleanup", `${nonce}.json`),
        "utf8"
      )
    ).toContain(nonce);
  });
});

describe("a timed-out create during the import", () => {
  /** The write-hold create times out; it lands during lookup `landAt`. */
  function timedOutHold(
    fake: FakeEngine,
    landAt: number | null,
    which: "hold" | "marker" = "hold"
  ) {
    const real = fake.docker();
    let pending: readonly string[] | null = null;
    let lookups = 0;
    return {
      ...real,
      engine: { host: "tcp://10.0.0.5:2376", context: null },
      hackCleanupCommand: (nonce: string) =>
        `hack data cleanup --branch=feature-x --nonce=${nonce}`,
      capture: async (
        argv: readonly string[],
        opts?: { readonly timeoutMs?: number }
      ) => {
        const isTarget =
          which === "marker"
            ? !argv.includes("--mount")
            : argv.some((arg) => arg.startsWith("type=bind,"));
        if (pending === null && argv[1] === "create" && isTarget) {
          pending = argv;
          return { exitCode: FAKE_TIMEOUT_EXIT, stdout: "", stderr: "" };
        }
        if (
          argv[2] === "inspect" &&
          argv.some((arg) => arg.includes(".Config.Labels"))
        ) {
          lookups += 1;
          if (pending !== null && lookups === landAt) {
            await real.capture(pending, opts);
          }
        }
        return await real.capture(argv, opts);
      },
    };
  }

  test("an unanswered timeout before the event watch is proven stays unknown, with hack data cleanup and no endpoint", async () => {
    // The start marker's create: no settle window can prove it will not land.
    const dir = await writeBackup({ keys: ["db"] });
    const fake = engine();
    const error = await caught(
      importProjectData({
        ...input(fake, dir),
        docker: timedOutHold(fake, null, "marker"),
      })
    );
    const cleanup = (error.detail as { cleanup: Record<string, string> })
      .cleanup;
    expect(cleanup.outcome).toBe("unknown");
    const nonce = cleanup.label?.split("=")[1] ?? "";
    expect(cleanup.hackCommand).toBe(
      `hack data cleanup --branch=feature-x --nonce=${nonce}`
    );
    expect("command" in cleanup).toBeFalse();
    const rendered = `${error.message}${JSON.stringify(error.detail)}`;
    expect(rendered).not.toContain("10.0.0.5");
    expect(rendered).not.toContain("DOCKER_HOST");
    expect(fake.calls.some((argv) => argv.includes("-xpf"))).toBeFalse();
  });

  test("an unanswered write-hold timeout settles in the window: the record is deleted", async () => {
    const dir = await writeBackup({ keys: ["db"] });
    const fake = engine();
    const error = await caught(
      importProjectData({
        ...input(fake, dir),
        docker: timedOutHold(fake, null),
      })
    );
    expect(JSON.stringify(error.detail ?? {})).not.toContain("unknown");
    expect(
      await readdir(join(root, "home", "data-cleanup")).catch(() => [])
    ).toEqual([]);
  });

  test("a timeout that a later lookup finds is removed; not unknown", async () => {
    const dir = await writeBackup({ keys: ["db"] });
    const fake = engine();
    const error = await caught(
      importProjectData({ ...input(fake, dir), docker: timedOutHold(fake, 2) })
    );
    expect(JSON.stringify(error.detail ?? {})).not.toContain("unknown");
    expect(fake.leftovers()).toEqual([]);
  });
});

describe("the import run's cleanup record", () => {
  test("is written before the first create, holds no endpoint, and is removed once the run is settled", async () => {
    const dir = await writeBackup({ keys: ["db"] });
    const fake = engine();
    const real = fake.docker();
    const records = join(root, "home", "data-cleanup");
    let atFirstCreate: string[] | null = null;
    let recordText = "";
    const docker = {
      ...real,
      engine: { host: "tcp://10.0.0.5:2376", context: null },
      capture: async (
        argv: readonly string[],
        opts?: { readonly timeoutMs?: number }
      ) => {
        if (atFirstCreate === null && argv[1] === "create") {
          const listed = await readdir(records).catch(() => [] as string[]);
          atFirstCreate = listed;
          recordText = await readFile(join(records, listed[0] ?? ""), "utf8");
        }
        return await real.capture(argv, opts);
      },
    };
    const result = await importProjectData({
      ...input(fake, dir),
      docker,
      envSelection: null,
    });
    expect(result.volumes[0]?.outcome).toBe("restored");
    expect(atFirstCreate).toHaveLength(1);
    expect(JSON.parse(recordText)).toMatchObject({
      command: "import",
      project: PROJECT,
      envName: null,
      envDefault: false,
      engine: { kind: "managed-host", overlay: null },
    });
    expect(recordText).not.toContain("10.0.0.5");
    expect(await readdir(records)).toEqual([]);
  });
});
