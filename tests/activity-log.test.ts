import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseActivityLimit } from "../src/commands/activity.ts";
import {
  ACTIVITY_LINE_LIMIT,
  type ActivityRecord,
  appendActivityRecord,
  buildActivityRecord,
  encodeActivityRecord,
  noteActivityBranch,
  noteActivityFailedServices,
  parseActivityText,
  readActivity,
  recordActivity,
  resolveActivityOrigin,
  resolveRegisteredProjectName,
} from "../src/lib/activity-log.ts";
import { restoreEnv } from "./helpers/env.ts";

// ---------------------------------------------------------------------------
// HACK-2218: the activity log's writer and reader, on real files in a temp
// directory. No project, engine or Hack home of the contributor is touched.
// ---------------------------------------------------------------------------

const MODULE = resolve(import.meta.dir, "..", "src", "lib", "activity-log.ts");
let root = "";
let path = "";
let savedOrigin: string | undefined;
let savedHome: string | undefined;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "hack-activity-")));
  path = join(root, "home", "activity.jsonl");
  savedOrigin = process.env.HACK_ORIGIN;
  savedHome = process.env.HACK_HOME;
  restoreEnv("HACK_ORIGIN", undefined);
});

afterEach(async () => {
  restoreEnv("HACK_ORIGIN", savedOrigin);
  restoreEnv("HACK_HOME", savedHome);
  await rm(root, { recursive: true, force: true });
});

function record(
  overrides: Partial<Parameters<typeof buildActivityRecord>[0]> = {}
): ActivityRecord {
  return buildActivityRecord({
    action: "up",
    startedAt: Date.UTC(2026, 10, 14, 12, 0, 0),
    durationMs: 1234,
    project: "shop",
    branch: null,
    exitCode: 0,
    failedServices: [],
    ...overrides,
  });
}

test("records are single lines with the documented fields, newest first on read", async () => {
  await appendActivityRecord({ path, record: record({ project: "a" }) });
  await appendActivityRecord({
    path,
    record: record({ project: "b", action: "down", exitCode: 1 }),
  });
  const text = await readFile(path, "utf8");
  expect(text.split("\n")).toHaveLength(3);
  const first = JSON.parse(text.split("\n")[0] as string);
  expect(Object.keys(first).sort()).toEqual(
    [
      "action",
      "branch",
      "duration_ms",
      "failed_services",
      "origin",
      "outcome",
      "project",
      "ts",
      "v",
    ].sort()
  );
  const read = await readActivity({ path, limit: 10 });
  expect(read.map((entry) => entry.project)).toEqual(["b", "a"]);
  expect(read[0]?.outcome).toBe("failed");
  expect((await readActivity({ path, limit: 10, project: "a" })).length).toBe(
    1
  );
  expect((await readActivity({ path, limit: 1 })).length).toBe(1);
});

test("the file is created 0600; a loose existing file is tightened; a symlink is refused", async () => {
  await appendActivityRecord({ path, record: record() });
  expect((await lstat(path)).mode & 0o777).toBe(0o600);
  await chmod(path, 0o644);
  await appendActivityRecord({ path, record: record() });
  expect((await lstat(path)).mode & 0o777).toBe(0o600);

  const target = join(root, "elsewhere.txt");
  await writeFile(target, "untouched\n");
  const linked = join(root, "linked.jsonl");
  await symlink(target, linked);
  await expect(
    appendActivityRecord({ path: linked, record: record() })
  ).rejects.toThrow();
  expect(await readFile(target, "utf8")).toBe("untouched\n");
});

test("an existing owner-executable log is normalized to mode 0600", async () => {
  await appendActivityRecord({ path, record: record() });
  await chmod(path, 0o700);
  await appendActivityRecord({ path, record: record() });
  expect((await lstat(path)).mode & 0o7777).toBe(0o600);
});

test("concurrent writers in separate processes never interleave lines", async () => {
  const writers = 8;
  const each = 40;
  // Long lines (many failed services) make interleaving visible if it happens.
  const services = Array.from(
    { length: 32 },
    (_, i) => `service-${i}-${"x".repeat(80)}`
  );
  const script = `
    const m = await import(${JSON.stringify(MODULE)});
    const id = Number(process.argv[1]);
    for (let i = 0; i < ${each}; i += 1) {
      await m.appendActivityRecord({
        path: ${JSON.stringify(path)},
        record: m.buildActivityRecord({
          action: "restart", startedAt: Date.now(), durationMs: i,
          project: "p" + id, branch: null, exitCode: 1,
          failedServices: ${JSON.stringify(services)},
        }),
      });
    }`;
  await mkdir(join(root, "home"));
  const children = Array.from({ length: writers }, (_, id) =>
    Bun.spawn([process.execPath, "-e", script, String(id)], {
      stdout: "ignore",
      stderr: "pipe",
    })
  );
  const codes = await Promise.all(children.map((child) => child.exited));
  expect(codes.every((code) => code === 0)).toBe(true);
  const text = await readFile(path, "utf8");
  const all = text.split("\n");
  expect(all.pop()).toBe("");
  // A writer that looks at the last byte while another append is still
  // being copied may start a fresh line: a blank line, never a split record.
  const lines = all.filter((line) => line.length > 0);
  expect(lines).toHaveLength(writers * each);
  for (const line of lines) {
    expect(() => JSON.parse(line)).not.toThrow();
  }
  const parsed = parseActivityText(text);
  expect(parsed).toHaveLength(writers * each);
  for (let id = 0; id < writers; id += 1) {
    expect(parsed.filter((entry) => entry.project === `p${id}`)).toHaveLength(
      each
    );
  }
  for (const line of lines) {
    expect(Buffer.byteLength(line) + 1).toBeLessThanOrEqual(
      ACTIVITY_LINE_LIMIT
    );
  }
});

test("rotation keeps exactly one generation and reads across it", async () => {
  const one = encodeActivityRecord(record()).byteLength;
  const rotateBytes = one * 5;
  for (let i = 0; i < 12; i += 1) {
    await appendActivityRecord({
      path,
      rotateBytes,
      record: record({ durationMs: i }),
    });
  }
  const current = await lstat(path);
  expect(current.size).toBeLessThanOrEqual(rotateBytes);
  expect((await lstat(`${path}.1`)).isFile()).toBe(true);
  expect(await lstat(`${path}.2`).catch(() => null)).toBeNull();
  const read = await readActivity({ path, limit: 100 });
  const durations = read.map((entry) => entry.duration_ms);
  // Newest first, continuous across the two files.
  expect(durations[0]).toBe(11);
  expect(durations).toEqual([...durations].sort((a, b) => b - a));
  expect(durations.length).toBeGreaterThanOrEqual(5);
  expect(durations.length).toBeLessThanOrEqual(10);
});

test("torn-line recovery keeps the entire append within the write-size limit", async () => {
  const base = record({
    project: "p",
    branch: "b",
    failedServices: Array.from({ length: 29 }, (_, index) =>
      String(index).padEnd(128, "s")
    ),
  });
  const padding =
    ACTIVITY_LINE_LIMIT - Buffer.byteLength(`${JSON.stringify(base)}\n`);
  expect(padding).toBeGreaterThanOrEqual(0);
  expect(padding).toBeLessThanOrEqual(254);
  const boundary = {
    ...base,
    project: "p".repeat(1 + Math.min(padding, 127)),
    branch: "b".repeat(1 + Math.max(0, padding - 127)),
  };
  expect(Buffer.byteLength(`${JSON.stringify(boundary)}\n`)).toBe(
    ACTIVITY_LINE_LIMIT
  );
  await mkdir(join(root, "home"));
  const torn = '{"torn":';
  await writeFile(path, torn, { mode: 0o600 });
  await appendActivityRecord({ path, record: boundary });
  const bytes = await readFile(path);
  expect(bytes.byteLength - Buffer.byteLength(torn)).toBeLessThanOrEqual(
    ACTIVITY_LINE_LIMIT
  );
  const entries = await readActivity({ path, limit: 10 });
  expect(entries).toHaveLength(1);
  expect(entries[0]?.project).toBe(boundary.project);
});

test("a torn last line is skipped on read, and the next record stays whole", async () => {
  await appendActivityRecord({ path, record: record({ project: "first" }) });
  await appendFile(path, '{"v":1,"ts":"2026-11-14T12:00:00.000Z","proj');
  expect(
    (await readActivity({ path, limit: 10 })).map((e) => e.project)
  ).toEqual(["first"]);
  await appendActivityRecord({ path, record: record({ project: "second" }) });
  expect(
    (await readActivity({ path, limit: 10 })).map((e) => e.project)
  ).toEqual(["second", "first"]);
  // Malformed or foreign lines in the middle are skipped too.
  await appendFile(path, 'not json\n{"v":99}\n');
  expect((await readActivity({ path, limit: 10 })).length).toBe(2);
});

test("missing files read as empty", async () => {
  expect(await readActivity({ path, limit: 10 })).toEqual([]);
});

test("origin comes from HACK_ORIGIN within a closed set", () => {
  expect(resolveActivityOrigin(undefined)).toBe("cli");
  expect(resolveActivityOrigin("app")).toBe("app");
  expect(resolveActivityOrigin(" agent ")).toBe("agent");
  expect(resolveActivityOrigin("autostart")).toBe("autostart");
  expect(resolveActivityOrigin("rm -rf /")).toBe("cli");
  process.env.HACK_ORIGIN = "app";
  expect(record().origin).toBe("app");
});

test("names that are not plain names are dropped, never written", () => {
  const built = record({
    project: "/home/user/secret-project",
    branch: "feature/../x",
    failedServices: ["web", "bad name", "a=b", "web"],
  });
  expect(built.project).toBeNull();
  expect(built.branch).toBeNull();
  expect(built.failed_services).toEqual(["web"]);
});

test("exit codes map to outcomes", () => {
  expect(record({ exitCode: 0 }).outcome).toBe("ok");
  expect(record({ exitCode: 1 }).outcome).toBe("failed");
  expect(record({ exitCode: 130 }).outcome).toBe("interrupted");
  expect(record({ exitCode: 143 }).outcome).toBe("interrupted");
});

test("recordActivity passes the result through and records noted failures", async () => {
  process.env.HACK_HOME = join(root, "home");
  try {
    const code = await recordActivity({
      action: "up",
      project: async () => "shop",
      run: async () => {
        noteActivityFailedServices(["db", "web"]);
        return 3;
      },
    });
    expect(code).toBe(3);
    const [entry] = await readActivity({ limit: 1 });
    expect(entry?.failed_services).toEqual(["db", "web"]);
    expect(entry?.outcome).toBe("failed");
    // An error passes through, and is recorded as a failure.
    await expect(
      recordActivity({
        action: "down",
        project: async () => "shop",
        run: async () => {
          throw new Error("boom");
        },
      })
    ).rejects.toThrow("boom");
    expect((await readActivity({ limit: 1 }))[0]?.action).toBe("down");
    // Outside an action, notes do nothing.
    noteActivityFailedServices(["x"]);
  } finally {
    restoreEnv("HACK_HOME", savedHome);
  }
});

test("a write failure never changes the result", async () => {
  // The Hack home is a file: the log cannot be created under it.
  await writeFile(join(root, "home"), "not a directory");
  process.env.HACK_HOME = join(root, "home");
  try {
    expect(
      await recordActivity({
        action: "up",
        project: async () => "shop",
        run: async () => 0,
      })
    ).toBe(0);
    expect(
      await recordActivity({
        action: "up",
        project: async () => {
          throw new Error("registry unreadable");
        },
        run: async () => 7,
      })
    ).toBe(7);
  } finally {
    restoreEnv("HACK_HOME", savedHome);
  }
});

test("--limit is a whole number in range", () => {
  expect(parseActivityLimit(undefined)).toBe(50);
  expect(parseActivityLimit("100")).toBe(100);
  for (const bad of ["0", "-1", "1.5", "abc", "10001", ""]) {
    expect(() => parseActivityLimit(bad)).toThrow();
  }
});

test("the recorded project is the registered name: selector aliases and linked worktrees resolve", async () => {
  const home = join(root, "home");
  const repo = join(root, "repo");
  const worktree = join(root, "elsewhere", "feature-wt");
  await mkdir(join(worktree, "src"), { recursive: true });
  await mkdir(join(repo, ".hack"), { recursive: true });
  await mkdir(home, { recursive: true });
  const seen = "2026-11-14T00:00:00.000Z";
  await writeFile(
    join(home, "projects.json"),
    JSON.stringify({
      version: 1,
      projects: [
        {
          id: "p1",
          name: "my-app",
          repoRoot: repo,
          projectDirName: ".hack",
          projectDir: join(repo, ".hack"),
          createdAt: seen,
          worktrees: [{ path: worktree, branch: "feature", lastSeenAt: seen }],
        },
      ],
    })
  );
  process.env.HACK_HOME = home;
  try {
    const name = (opts: {
      readonly path?: string;
      readonly project?: string;
      readonly cwd?: string;
    }) => resolveRegisteredProjectName({ ...opts, cwd: opts.cwd ?? root });
    expect(await name({ project: "my-app" })).toBe("my-app");
    // Alias spellings the --project selector accepts record the canonical name.
    expect(await name({ project: "My_App" })).toBe("my-app");
    expect(await name({ project: "other" })).toBeNull();
    expect(await name({ cwd: join(repo, ".hack") })).toBe("my-app");
    // A linked worktree outside the primary checkout.
    expect(await name({ cwd: join(worktree, "src") })).toBe("my-app");
    expect(await name({ path: worktree })).toBe("my-app");
    expect(await name({ cwd: join(root, "elsewhere") })).toBeNull();
    await recordActivity({
      action: "up",
      project: () => name({ project: "My_App" }),
      run: () => Promise.resolve(0),
    });
    expect(
      (await readActivity({ project: "My_App", limit: 10 })).map(
        (entry) => entry.project
      )
    ).toEqual(["my-app"]);
    // History remains selectable after the project leaves the registry.
    await writeFile(
      join(home, "projects.json"),
      JSON.stringify({ version: 1, projects: [] })
    );
    expect(
      (await readActivity({ project: "My_App", limit: 10 })).map(
        (entry) => entry.project
      )
    ).toEqual(["my-app"]);
    expect(await readActivity({ project: "", limit: 10 })).toEqual([]);
  } finally {
    restoreEnv("HACK_HOME", savedHome);
  }
});

test("a rotation between the reader's two opens never duplicates records", async () => {
  for (const [project, ms] of [
    ["old", 1],
    ["old", 2],
  ] as const) {
    await appendActivityRecord({
      path,
      record: record({ project, durationMs: ms }),
    });
  }
  await rename(path, `${path}.1`);
  for (const ms of [3, 4, 5]) {
    await appendActivityRecord({
      path,
      record: record({ project: "mid", durationMs: ms }),
    });
  }
  const read = await readActivity({
    path,
    limit: 100,
    // A writer rotates right after the reader opened the current file, then
    // appends to the new one.
    betweenOpens: async () => {
      await rename(path, `${path}.1`);
      await appendActivityRecord({
        path,
        record: record({ project: "new", durationMs: 6 }),
      });
    },
  });
  const durations = read.map((entry) => entry.duration_ms);
  expect(new Set(durations).size).toBe(durations.length);
  expect(durations).toEqual([6, 5, 4, 3]);
});

test("appends and rotation are serialized: a paused writer holds off the next one", async () => {
  let second: Promise<void> | null = null;
  let secondDone = false;
  await appendActivityRecord({
    path,
    record: record({ project: "first" }),
    afterOpen: async () => {
      second = appendActivityRecord({
        path,
        rotateBytes: 1,
        record: record({ project: "second" }),
      }).then(() => {
        secondDone = true;
      });
      await Bun.sleep(300);
      // The second writer (which would rotate) waits for the first's write.
      expect(secondDone).toBe(false);
    },
  });
  await second;
  expect(secondDone).toBe(true);
  // The second rotated after the first wrote: both are readable.
  expect(
    (await readActivity({ path, limit: 10 })).map((e) => e.project)
  ).toEqual(["second", "first"]);
});

test("without the lock, a record that landed in a retired file is appended again", async () => {
  await appendActivityRecord({ path, record: record({ project: "seed" }) });
  let release: (() => void) | null = null;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  // A writer that holds the lock for the whole test.
  const holder = appendActivityRecord({
    path,
    record: record({ project: "holder" }),
    afterOpen: () => held,
  });
  await Bun.sleep(50);
  await appendActivityRecord({
    path,
    lockWaitMs: 100,
    record: record({ project: "late" }),
    // Two rotations by other writers retire the file this one opened.
    afterOpen: async () => {
      await rename(path, `${path}.1`);
      await writeFile(path, "", { mode: 0o600 });
      await rename(path, `${path}.1`);
    },
  });
  (release as unknown as () => void)();
  await holder;
  const projects = (await readActivity({ path, limit: 10 })).map(
    (e) => e.project
  );
  expect(projects).toContain("late");
  expect(projects.filter((p) => p === "late")).toHaveLength(1);
});

test("rotation keeps a loose current file only after tightening it to 0600", async () => {
  await appendActivityRecord({ path, record: record({ project: "old" }) });
  await chmod(path, 0o644);
  await appendActivityRecord({
    path,
    rotateBytes: 1,
    record: record({ project: "new" }),
  });
  expect((await lstat(`${path}.1`)).mode & 0o777).toBe(0o600);
  expect((await lstat(path)).mode & 0o777).toBe(0o600);
  expect(
    (await readActivity({ path, limit: 10 })).map((e) => e.project)
  ).toEqual(["new", "old"]);
});

test("the reader returns only the known fields", async () => {
  await mkdir(join(root, "home"), { recursive: true });
  const line = JSON.stringify({
    ...record(),
    extra: "/somewhere/private",
  });
  await writeFile(path, `${line}\n`, { mode: 0o600 });
  const [entry] = await readActivity({ path, limit: 1 });
  expect(entry).toBeDefined();
  expect(Object.hasOwn(entry as object, "extra")).toBe(false);
});

test("a later branch note replaces an earlier one, and null records the base instance", async () => {
  process.env.HACK_HOME = join(root, "home");
  try {
    for (const [notes, expected] of [
      [["feature"], "feature"],
      // An implicit down reconciled to the old instance, or to the base one.
      [["renamed", "old-branch"], "old-branch"],
      [["renamed", null], null],
    ] as const) {
      await recordActivity({
        action: "down",
        branch: "explicit",
        project: async () => "shop",
        run: async () => {
          for (const note of notes) {
            noteActivityBranch(note);
          }
          return 0;
        },
      });
      expect((await readActivity({ limit: 1 }))[0]?.branch).toBe(expected);
    }
  } finally {
    restoreEnv("HACK_HOME", savedHome);
  }
});
