import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderDataImportText } from "../src/commands/data.ts";
import { HackCliError } from "../src/lib/cli-result.ts";
import type {
  DataBackupDocker,
  DataBackupProcessResult,
} from "../src/lib/data-backup-docker.ts";
import {
  DATA_IMPORT_SOURCE_LABEL,
  type DataImportInput,
  importProjectData,
} from "../src/lib/data-backup-import.ts";
import {
  dataImportJournalPath,
  readDataImportJournal,
  writeDataImportJournal,
} from "../src/lib/data-import-journal.ts";

const PROJECT = "shop";
const COMPOSE = ["docker", "compose", "-f", "/p/.hack/docker-compose.yml"];
const NOW = new Date("2026-11-24T10:00:00.000Z");

type FakeVolume = {
  labels: Record<string, string>;
  /** The volume's contents, as one string; "" is empty. */
  content: string;
};

type FakeState = {
  model: unknown;
  volumes: Map<string, FakeVolume>;
  running: Record<string, string[]>;
  /** Running names reported from the Nth `ps` call on (0-based). */
  runningFromCall?: { call: number; filter: string; names: string[] };
  /** Appended to a restored tree: its digest then differs. */
  corruptRestore?: string;
  calls: string[][];
  psCalls: number;
};

const sha = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

function ok(stdout = ""): DataBackupProcessResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function labelsFrom(argv: readonly string[]): Record<string, string> {
  const labels: Record<string, string> = {};
  argv.forEach((value, index) => {
    if (value === "--label") {
      const [key, ...rest] = (argv[index + 1] ?? "").split("=");
      labels[key ?? ""] = rest.join("=");
    }
  });
  return labels;
}

function mounted(argv: readonly string[]): string {
  const mount = argv[argv.indexOf("--volume") + 1] ?? "";
  return mount.slice(0, mount.indexOf(":"));
}

function fakeDocker(state: FakeState): DataBackupDocker {
  return {
    capture(argv) {
      state.calls.push([...argv]);
      const args = argv.slice(1);
      if (argv.slice(0, COMPOSE.length).join(" ") === COMPOSE.join(" ")) {
        return Promise.resolve(ok(JSON.stringify(state.model)));
      }
      if (args.join(" ") === "compose version --short") {
        return Promise.resolve(ok("2.29.7\n"));
      }
      if (args[0] === "volume" && args[1] === "inspect") {
        const name = argv.at(-1) ?? "";
        const volume = state.volumes.get(name);
        return Promise.resolve(
          volume
            ? ok(
                JSON.stringify({ name, driver: "local", labels: volume.labels })
              )
            : {
                exitCode: 1,
                stdout: "",
                stderr: `Error response from daemon: get ${name}: no such volume`,
              }
        );
      }
      if (args[0] === "volume" && args[1] === "create") {
        state.volumes.set(argv.at(-1) ?? "", {
          labels: labelsFrom(args.slice(2)),
          content: "",
        });
        return Promise.resolve(ok(`${argv.at(-1)}\n`));
      }
      if (args[0] === "ps") {
        const filter = args[args.indexOf("--filter") + 1] ?? "";
        const late = state.runningFromCall;
        const call = state.psCalls;
        state.psCalls += 1;
        const names = [
          ...(state.running[filter] ?? []),
          ...(late && late.filter === filter && call >= late.call
            ? late.names
            : []),
        ];
        return Promise.resolve(ok(names.map((n) => `${n}\n`).join("")));
      }
      if (args[0] === "events") {
        return Promise.resolve(ok(""));
      }
      if (args[0] === "run") {
        const volume = state.volumes.get(mounted(argv));
        if (!volume) {
          return Promise.resolve({ exitCode: 125, stdout: "", stderr: "" });
        }
        if (argv.includes("-quit")) {
          return Promise.resolve(ok(volume.content ? "/v/x\n" : ""));
        }
        if (argv.includes("-delete")) {
          volume.content = "";
          return Promise.resolve(ok());
        }
        return Promise.resolve(
          ok(
            `${JSON.stringify({
              algorithm: "hack.tree-digest.v1",
              entries: 3,
              excludedSockets: 0,
              digest: sha(volume.content),
            })}\n`
          )
        );
      }
      return Promise.resolve({ exitCode: 99, stdout: "", stderr: "" });
    },
    streamToFile: () => Promise.reject(new Error("import never archives")),
    async streamFromFile({ argv, path }) {
      state.calls.push([...argv]);
      const volume = state.volumes.get(mounted(argv));
      if (!volume) {
        return { exitCode: 125, stderr: "no volume" };
      }
      volume.content += `${await readFile(path, "utf8")}${state.corruptRestore ?? ""}`;
      return { exitCode: 0, stderr: "" };
    },
  };
}

function model(volumes: Record<string, unknown>, name = PROJECT): unknown {
  return { name, services: {}, volumes };
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hack-data-import-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A backup directory as export writes it; each tar holds `tar:<key>`. */
async function writeBackup(opts: {
  readonly keys: readonly string[];
  readonly composeProject?: string;
  readonly name?: string;
}): Promise<string> {
  const composeProject = opts.composeProject ?? PROJECT;
  const dir = join(root, "backups", opts.name ?? "20261124T090000Z");
  await mkdir(dir, { recursive: true });
  const volumes: unknown[] = [];
  for (const key of opts.keys) {
    const bytes = `tar:${key}`;
    await writeFile(join(dir, `${key}.tar`), bytes);
    volumes.push({
      key,
      name: `${composeProject}_${key}`,
      driver: "local",
      labels: {
        "com.docker.compose.project": composeProject,
        "com.docker.compose.volume": key,
      },
      file: `${key}.tar`,
      tarBytes: bytes.length,
      tarSha256: sha(bytes),
      entries: 3,
      excludedSockets: 0,
      contentDigest: sha(bytes),
    });
  }
  await writeFile(
    join(dir, "manifest.json"),
    `${JSON.stringify(
      {
        schema: "hack.data-backup.v1",
        project: composeProject,
        branch: null,
        composeProject,
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
  return createHash("sha256")
    .update(await readFile(join(dir, "manifest.json")))
    .digest("hex");
}

function baseState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    model: model({ db: { name: "shop_db" }, cache: { name: "shop_cache" } }),
    volumes: new Map(),
    running: {},
    calls: [],
    psCalls: 0,
    ...overrides,
  };
}

function input(
  state: FakeState,
  backupPath: string,
  extra: Partial<DataImportInput> = {}
) {
  return {
    docker: fakeDocker(state),
    composeArgs: COMPOSE,
    backupPath,
    hackHome: join(root, "home"),
    now: () => NOW,
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

function effects(state: FakeState): string[][] {
  return state.calls.filter(
    (argv) =>
      (argv[1] === "volume" && argv[2] === "create") ||
      (argv[1] === "run" && !argv.includes("-quit") && !argv.includes("-e"))
  );
}

function journal(key: string) {
  return readDataImportJournal(
    dataImportJournalPath({
      hackHome: join(root, "home"),
      composeProject: PROJECT,
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
    const state = baseState();
    const error = await caught(importProjectData(input(state, dir)));
    expect(error.code).toBe("E_BACKUP_INVALID");
    expect(error.message).toContain(".partial");
    expect(state.calls).toEqual([]);
  });

  test("a directory without manifest.json is refused", async () => {
    const dir = join(root, "empty");
    await mkdir(dir);
    const error = await caught(importProjectData(input(baseState(), dir)));
    expect(error.code).toBe("E_BACKUP_INVALID");
    expect(error.message).toContain("manifest.json");
  });

  test("a missing tar, a size or sha256 mismatch and a foreign schema are refused", async () => {
    const missing = await writeBackup({ keys: ["db"], name: "a" });
    await rm(join(missing, "db.tar"));
    const resized = await writeBackup({ keys: ["db"], name: "b" });
    await writeFile(join(resized, "db.tar"), "tar:db+");
    const altered = await writeBackup({ keys: ["db"], name: "c" });
    await writeFile(join(altered, "db.tar"), "tar:dX");
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
      [resized, "has 7 bytes"],
      [altered, "sha256"],
      [schema, "hack.data-backup.v1"],
    ] as const) {
      const state = baseState();
      const error = await caught(importProjectData(input(state, dir)));
      expect(error.code).toBe("E_BACKUP_INVALID");
      expect(error.message).toContain(words);
      expect(state.calls).toEqual([]);
    }
  });

  test("a backup of another Compose project needs a matching --from-project", async () => {
    const dir = await writeBackup({ keys: ["db"], composeProject: "shop-old" });
    const plain = await caught(importProjectData(input(baseState(), dir)));
    expect(plain.code).toBe("E_USAGE");
    expect(plain.message).toContain("--from-project shop-old");
    const wrong = await caught(
      importProjectData(input(baseState(), dir, { fromProject: "nope" }))
    );
    expect(wrong.code).toBe("E_USAGE");

    const state = baseState();
    const result = await importProjectData(
      input(state, dir, { fromProject: "shop-old" })
    );
    expect(result.sourceComposeProject).toBe("shop-old");
    expect(result.composeProject).toBe(PROJECT);
    expect(result.volumes.map((volume) => volume.name)).toEqual(["shop_db"]);
    expect(state.volumes.get("shop_db")?.content).toBe("tar:db");
  });
});

describe("targets", () => {
  test("an absent target is created with Compose's labels and the backup id, then verified", async () => {
    const dir = await writeBackup({ keys: ["db", "gone", "shared"] });
    const state = baseState({
      model: model({
        db: { name: "shop_db" },
        shared: { name: "team-shared", external: true },
      }),
    });
    const result = await importProjectData(input(state, dir));
    const id = await backupId(dir);
    expect(result).toEqual({
      backup: dir,
      backupId: id,
      sourceComposeProject: PROJECT,
      composeProject: PROJECT,
      volumes: [
        {
          key: "db",
          name: "shop_db",
          target: "created",
          entries: 3,
          excludedSockets: 0,
          contentDigest: sha("tar:db"),
        },
      ],
      skipped: [
        { key: "gone", reason: "undeclared" },
        { key: "shared", reason: "external" },
      ],
    });
    expect(state.volumes.get("shop_db")).toEqual({
      labels: {
        "com.docker.compose.project": PROJECT,
        "com.docker.compose.volume": "db",
        "com.docker.compose.version": "2.29.7",
        [DATA_IMPORT_SOURCE_LABEL]: id,
      },
      content: "tar:db",
    });
    // External and undeclared keys are never created, mounted or inspected.
    expect(
      state.calls.some((argv) => argv.includes("team-shared"))
    ).toBeFalse();
    expect((await journal("db"))?.state).toBe("complete");
    // The extract mounts read-write, takes stdin, and has no network.
    const tar = state.calls.find((argv) => argv.includes("-xpf")) ?? [];
    expect(tar[tar.indexOf("--volume") + 1]).toBe("shop_db:/v");
    expect(tar).toContain("--interactive");
    expect(tar[tar.indexOf("--network") + 1]).toBe("none");
    expect(tar).toContain("no-new-privileges");
    expect(renderDataImportText(result)).toBe(
      [
        `Restored 1 volume from ${dir}:`,
        "  db -> shop_db  created  3 entries verified",
        "Skipped:",
        "  gone  no longer declared by this project",
        "  shared  external here, not managed by this project",
        "",
      ].join("\n")
    );
  });

  test("an existing empty owned target is used as is", async () => {
    const dir = await writeBackup({ keys: ["db"] });
    const state = baseState({
      volumes: new Map([
        [
          "shop_db",
          {
            labels: {
              "com.docker.compose.project": PROJECT,
              "com.docker.compose.volume": "db",
            },
            content: "",
          },
        ],
      ]),
    });
    const result = await importProjectData(input(state, dir));
    expect(result.volumes[0]?.target).toBe("empty");
    expect(state.calls.some((argv) => argv[2] === "create")).toBeFalse();
    expect(state.volumes.get("shop_db")?.content).toBe("tar:db");
  });

  test("foreign and non-empty targets refuse together, before any effect", async () => {
    const dir = await writeBackup({ keys: ["db", "cache"] });
    const state = baseState({
      volumes: new Map<string, FakeVolume>([
        // Unlabelled and holding data, like a volume made by hand.
        ["shop_db", { labels: {}, content: "precious" }],
        [
          "shop_cache",
          {
            labels: {
              "com.docker.compose.project": PROJECT,
              "com.docker.compose.volume": "cache",
            },
            content: "live data",
          },
        ],
      ]),
    });
    const error = await caught(importProjectData(input(state, dir)));
    expect(error.code).toBe("E_DATA_TARGET_CONFLICT");
    expect(error.message).toContain("hack data export");
    expect(error.detail).toEqual({
      conflicts: [
        { key: "db", name: "shop_db", reason: "foreign" },
        { key: "cache", name: "shop_cache", reason: "not_empty" },
      ],
    });
    expect(effects(state)).toEqual([]);
    expect(state.volumes.get("shop_db")?.content).toBe("precious");
    expect(state.volumes.get("shop_cache")?.content).toBe("live data");
    expect(await journal("cache")).toBeNull();
  });
});

describe("interruption and recovery", () => {
  async function partialState(opts: {
    readonly dir: string;
    readonly journalState: "started" | "failed" | "complete" | null;
    readonly label: string;
  }): Promise<FakeState> {
    if (opts.journalState) {
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
          target: "shop_db",
          state: opts.journalState,
        },
        now: NOW,
      });
    }
    return baseState({
      volumes: new Map([
        [
          "shop_db",
          {
            labels: {
              "com.docker.compose.project": PROJECT,
              "com.docker.compose.volume": "db",
              [DATA_IMPORT_SOURCE_LABEL]: opts.label,
            },
            content: "tar:half",
          },
        ],
      ]),
    });
  }

  test("our own interrupted import is wiped and redone", async () => {
    const dir = await writeBackup({ keys: ["db"] });
    const state = await partialState({
      dir,
      journalState: "started",
      label: await backupId(dir),
    });
    const result = await importProjectData(input(state, dir));
    expect(result.volumes[0]?.target).toBe("replaced-partial");
    const wipe = state.calls.find((argv) => argv.includes("-delete")) ?? [];
    expect(wipe.slice(wipe.indexOf("/v"))).toEqual([
      "/v",
      "-mindepth",
      "1",
      "-delete",
    ]);
    expect(wipe[wipe.indexOf("--volume") + 1]).toBe("shop_db:/v");
    expect(state.volumes.get("shop_db")?.content).toBe("tar:db");
    expect((await journal("db"))?.state).toBe("complete");
  });

  test("a non-empty volume is never ours without both the label and an unfinished journal", async () => {
    const dir = await writeBackup({ keys: ["db"] });
    const id = await backupId(dir);
    for (const [journalState, label, reason] of [
      [null, id, "not_empty"],
      ["started", "another-backup", "not_empty"],
      ["complete", id, "already_imported"],
    ] as const) {
      const state = await partialState({ dir, journalState, label });
      const error = await caught(importProjectData(input(state, dir)));
      expect(error.code).toBe("E_DATA_TARGET_CONFLICT");
      expect(error.detail).toEqual({
        conflicts: [{ key: "db", name: "shop_db", reason }],
      });
      expect(effects(state)).toEqual([]);
      expect(state.volumes.get("shop_db")?.content).toBe("tar:half");
      await rm(join(root, "home"), { recursive: true, force: true });
    }
  });

  test("a digest mismatch marks the journal failed, leaves the volume, and a rerun replaces it", async () => {
    const dir = await writeBackup({ keys: ["db"] });
    const state = baseState({ corruptRestore: "!" });
    const error = await caught(importProjectData(input(state, dir)));
    expect(error.code).toBe("E_UNEXPECTED");
    expect(error.message).toContain("Rerunning hack data import replaces");
    expect((await journal("db"))?.state).toBe("failed");
    expect(state.volumes.get("shop_db")?.content).toBe("tar:db!");

    state.corruptRestore = undefined;
    const result = await importProjectData({
      ...input(state, dir),
      docker: fakeDocker(state),
    });
    expect(result.volumes[0]?.target).toBe("replaced-partial");
    expect(state.volumes.get("shop_db")?.content).toBe("tar:db");
    expect((await journal("db"))?.state).toBe("complete");
  });
});

describe("running refusal", () => {
  test("a running project container or a container on a target refuses before any effect", async () => {
    const dir = await writeBackup({ keys: ["db"] });
    const cases: Record<string, string[]>[] = [
      { [`label=com.docker.compose.project=${PROJECT}`]: ["shop-web-1"] },
      { "volume=shop_db": ["adhoc"] },
    ];
    for (const running of cases) {
      const state = baseState({ running });
      const error = await caught(
        importProjectData(input(state, dir, { downCommand: "hack down -p x" }))
      );
      expect(error.code).toBe("E_PROJECT_RUNNING");
      expect(error.message).toContain("`hack down -p x`");
      expect(effects(state)).toEqual([]);
      expect(state.volumes.size).toBe(0);
    }
  });

  test("a container that starts during the import keeps the journal unfinished", async () => {
    const dir = await writeBackup({ keys: ["db"] });
    const state = baseState({
      // Before: project + one volume filter (calls 0-1); after: from call 2.
      runningFromCall: {
        call: 2,
        filter: `label=com.docker.compose.project=${PROJECT}`,
        names: ["shop-web-1"],
      },
    });
    const error = await caught(importProjectData(input(state, dir)));
    expect(error.code).toBe("E_PROJECT_RUNNING");
    expect((await journal("db"))?.state).toBe("started");
  });
});
