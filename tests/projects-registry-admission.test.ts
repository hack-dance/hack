import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "../src/lib/guards.ts";
import { readProjectsRegistry } from "../src/lib/projects-registry.ts";

let fixture = "";
let registryDir = "";
let registryPath = "";
let lockPath = "";
let primary = "";
let env: Record<string, string | undefined>;
const children: Bun.Subprocess<"pipe", "pipe", "pipe">[] = [];
beforeEach(async () => {
  fixture = await realpath(
    await mkdtemp(join(tmpdir(), "hack-registry-admission-"))
  );
  registryDir = join(fixture, "registry");
  registryPath = join(registryDir, "projects.json");
  lockPath = `${registryPath}.lock`;
  primary = join(fixture, "primary");
  const home = join(fixture, "home");
  const state = join(fixture, "state");
  await Promise.all(
    [registryDir, home, state, join(primary, ".hack")].map((path) =>
      mkdir(path, { recursive: true })
    )
  );
  env = {
    ...process.env,
    HOME: home,
    HACK_HOME: state,
    HACK_GLOBAL_CONFIG_PATH: join(registryDir, "hack.config.json"),
  };
  await writeFile(
    join(primary, ".hack", "hack.config.json"),
    JSON.stringify({ name: "admission", dev_host: "admission.hack.local" })
  );
  await writeFile(
    join(primary, ".hack", "docker-compose.yml"),
    "services: {}\n"
  );
  await git(primary, ["init", "-b", "main"]);
  await git(primary, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "add",
    ".",
  ]);
  await git(primary, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "fixture",
  ]);
  await writeFile(
    registryPath,
    JSON.stringify({
      version: 1,
      projects: [
        {
          id: "retained-fixture-id",
          name: "admission",
          repoRoot: primary,
          projectDirName: ".hack",
          projectDir: join(primary, ".hack"),
          devHost: "admission.hack.local",
          createdAt: "2026-01-01T00:00:00Z",
          lastSeenAt: "2026-01-01T00:00:00Z",
        },
      ],
    })
  );
});
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
    await child.exited;
  }
  await rm(fixture, { recursive: true, force: true });
});

async function git(cwd: string, args: readonly string[]) {
  const child = Bun.spawn(["git", "-C", cwd, ...args], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  expect(exitCode, stderr).toBe(0);
}
function child(
  operation: string,
  project = primary,
  nowIso = "2026-01-01T00:02:00Z"
) {
  const args =
    operation === "hold"
      ? [
          join(
            import.meta.dir,
            "fixtures/projects-registry-optional-worker.ts"
          ),
          registryDir,
          "hold",
        ]
      : [
          join(
            import.meta.dir,
            "fixtures/projects-registry-admission-worker.ts"
          ),
          registryDir,
          project,
          operation,
          nowIso,
        ];
  const process = Bun.spawn([Bun.argv[0] ?? "bun", ...args], {
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  children.push(process);
  return process;
}
async function boundary(process: ReturnType<typeof child>, expected: string) {
  const reader = process.stdout.getReader();
  try {
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(
      `${expected}\n`
    );
  } finally {
    reader.releaseLock();
  }
}
async function remaining(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        return text + decoder.decode();
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}
async function finish(process: ReturnType<typeof child>) {
  const [stdout, stderr, exitCode] = await Promise.all([
    remaining(process.stdout),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  expect({ stderr, exitCode }).toEqual({ stderr: "", exitCode: 0 });
  return stdout;
}
async function report(process: ReturnType<typeof child>) {
  const result: unknown = JSON.parse(await finish(process));
  if (!isRecord(result)) {
    throw new Error("Invalid registry admission report");
  }
  return result;
}
const untouched = {
  gitLaunches: 0,
  subprocesses: 0,
  bunWrites: 0,
  ownerOpens: 0,
  publications: 0,
  registryWrites: 0,
  mutations: [],
};

for (const occupied of [
  "live",
  "dead",
  "malformed",
  "symlink",
  "directory",
] as const) {
  test(`stale touch skips Git and all mutations for an occupied ${occupied} path`, async () => {
    if (occupied === "symlink") {
      await symlink("absent", lockPath);
    } else if (occupied === "directory") {
      await mkdir(lockPath);
    } else {
      let pid = process.pid;
      if (occupied === "dead") {
        const exited = Bun.spawn([process.execPath, "-e", "process.exit(0)"], {
          env,
          stdout: "ignore",
          stderr: "ignore",
        });
        await exited.exited;
        pid = exited.pid;
      }
      await writeFile(
        lockPath,
        occupied === "malformed" ? "invalid\n" : `${pid}\n`
      );
    }
    const bytes = await readFile(registryPath, "utf8");
    const before = await lstat(lockPath);
    expect(await report(child("touch"))).toMatchObject({
      ...untouched,
      result: null,
      error: null,
      observations: 1,
    });
    const after = await lstat(lockPath);
    expect([
      after.dev,
      after.ino,
      after.mode,
      after.size,
      after.mtimeMs,
      after.ctimeMs,
    ]).toEqual([
      before.dev,
      before.ino,
      before.mode,
      before.size,
      before.mtimeMs,
      before.ctimeMs,
    ]);
    expect(await readFile(registryPath, "utf8")).toBe(bytes);
    expect((await readdir(registryDir)).sort()).toEqual([
      "projects.json",
      "projects.json.lock",
    ]);
  });
}

test("direct optional admission refuses before config, realpath, mkdir or Git; required admission still attempts", async () => {
  await writeFile(lockPath, `${process.pid}\n`);
  const bytes = await readFile(registryPath, "utf8");
  expect(await report(child("optional"))).toMatchObject({
    ...untouched,
    result: null,
    observations: 1,
    configReads: 0,
    realpaths: 0,
    error: "Projects registry is busy; optional touch deferred",
  });
  const required = await report(child("required"));
  expect(required.gitLaunches).toBe(1);
  expect(required.realpaths).toBeGreaterThan(0);
  expect(required).toMatchObject({
    result: null,
    configReads: 1,
    projectRootResolutions: 1,
    projectDirResolutions: 1,
    ownerOpens: 1,
    publications: 1,
    registryWrites: 0,
  });
  expect(required.error).not.toBeNull();
  expect(required.error).not.toBe(
    "Projects registry is busy; optional touch deferred"
  );
  expect(await readFile(registryPath, "utf8")).toBe(bytes);
  expect(await readFile(lockPath, "utf8")).toBe(`${process.pid}\n`);
  expect((await readdir(registryDir)).sort()).toEqual([
    "projects.json",
    "projects.json.lock",
  ]);
});

test("already-aborted optional admission reaches no metadata or filesystem work", async () => {
  const bytes = await readFile(registryPath, "utf8");
  expect(await report(child("aborted"))).toMatchObject({
    ...untouched,
    result: null,
    observations: 0,
    configReads: 0,
    realpaths: 0,
    error: "cancelled before registry admission",
  });
  expect(await readFile(registryPath, "utf8")).toBe(bytes);
  expect(await readdir(registryDir)).toEqual(["projects.json"]);
});

test("uncontended primary refresh skips Git and renamed configuration still updates identity safely", async () => {
  const refreshed = await report(child("touch"));
  expect(refreshed).toMatchObject({
    result: { status: "updated" },
    error: null,
    registryWrites: 1,
    ownerOpens: 1,
    publications: 1,
    configReads: 1,
    projectRootResolutions: 1,
    projectDirResolutions: 1,
    registryReads: 2,
  });
  expect(refreshed.gitLaunches).toBe(0);
  await writeFile(
    join(primary, ".hack", "hack.config.json"),
    JSON.stringify({ name: "renamed_project", dev_host: "renamed.hack.local" })
  );
  expect(
    await report(child("touch", primary, "2026-01-01T00:02:01Z"))
  ).toMatchObject({
    result: { status: "updated" },
    error: null,
    gitLaunches: 1,
    ownerOpens: 1,
    publications: 1,
    registryWrites: 1,
    configReads: 1,
    projectRootResolutions: 1,
    projectDirResolutions: 1,
  });
  expect((await readProjectsRegistry({ registryPath })).projects).toEqual([
    expect.objectContaining({
      id: "retained-fixture-id",
      name: "renamed-project",
      devHost: "renamed.hack.local",
      lastSeenAt: "2026-01-01T00:02:01Z",
    }),
  ]);
  expect(await readdir(registryDir)).toEqual(["projects.json"]);
});

test("unborn stale primary refresh reuses one observation without Git", async () => {
  await git(primary, ["symbolic-ref", "HEAD", "refs/heads/unborn"]);
  expect(await report(child("touch"))).toMatchObject({
    result: { status: "updated" },
    error: null,
    gitLaunches: 0,
    ownerOpens: 1,
    publications: 1,
    configReads: 1,
    projectRootResolutions: 1,
    projectDirResolutions: 1,
    registryReads: 2,
    registryWrites: 1,
  });
  expect((await readProjectsRegistry({ registryPath })).projects).toEqual([
    expect.objectContaining({
      id: "retained-fixture-id",
      lastSeenAt: "2026-01-01T00:02:00Z",
    }),
  ]);
  expect(await readdir(registryDir)).toEqual(["projects.json"]);
});

test("a config change after touch observation is read by the next touch in the same process", async () => {
  const touch = child("pause-early-repeat");
  await boundary(touch, "observed-absent");
  await writeFile(
    join(primary, ".hack", "hack.config.json"),
    JSON.stringify({
      name: "changed_during_touch",
      dev_host: "changed.hack.local",
    })
  );
  touch.stdin.end();
  expect(await report(touch)).toMatchObject({
    firstResult: {
      status: "updated",
      project: {
        id: "retained-fixture-id",
        name: "admission",
        devHost: "admission.hack.local",
      },
    },
    result: {
      status: "updated",
      project: {
        id: "retained-fixture-id",
        name: "changed-during-touch",
        devHost: "changed.hack.local",
      },
    },
    error: null,
    gitLaunches: 1,
    configReads: 2,
    projectRootResolutions: 2,
    projectDirResolutions: 2,
    registryReads: 4,
    registryWrites: 2,
  });
  expect((await readProjectsRegistry({ registryPath })).projects).toEqual([
    expect.objectContaining({
      id: "retained-fixture-id",
      name: "changed-during-touch",
      devHost: "changed.hack.local",
      lastSeenAt: "2026-01-01T00:02:01.000Z",
    }),
  ]);
  expect(await readdir(registryDir)).toEqual(["projects.json"]);
});

test("public upsert observes config independently after its early admission check", async () => {
  const upsert = child("pause-optional");
  await boundary(upsert, "observed-absent");
  await writeFile(
    join(primary, ".hack", "hack.config.json"),
    JSON.stringify({ name: "public_update", dev_host: "public.hack.local" })
  );
  upsert.stdin.end();
  expect(await report(upsert)).toMatchObject({
    result: {
      status: "updated",
      project: {
        id: "retained-fixture-id",
        name: "public-update",
        devHost: "public.hack.local",
      },
    },
    error: null,
    configReads: 1,
    projectRootResolutions: 1,
    projectDirResolutions: 1,
    registryReads: 1,
    registryWrites: 1,
  });
  expect((await readProjectsRegistry({ registryPath })).projects).toEqual([
    expect.objectContaining({
      id: "retained-fixture-id",
      name: "public-update",
      devHost: "public.hack.local",
    }),
  ]);
});

test("touch rereads the locked registry and preserves an intervening real registration", async () => {
  const secondary = join(fixture, "secondary");
  await mkdir(join(secondary, ".hack"), { recursive: true });
  await writeFile(
    join(secondary, ".hack", "hack.config.json"),
    JSON.stringify({ name: "secondary" })
  );
  await writeFile(
    join(secondary, ".hack", "docker-compose.yml"),
    "services: {}\n"
  );
  await git(secondary, ["init", "-b", "main"]);

  const touch = child("pause-early");
  await boundary(touch, "observed-absent");
  expect(await report(child("optional", secondary))).toMatchObject({
    result: { status: "created" },
    error: null,
  });
  const registered = (
    await readProjectsRegistry({ registryPath })
  ).projects.find((project) => project.name === "secondary");
  expect(registered).toBeDefined();
  touch.stdin.end();
  expect(await report(touch)).toMatchObject({
    result: { status: "updated" },
    error: null,
    registryReads: 2,
    configReads: 1,
    projectRootResolutions: 1,
    projectDirResolutions: 1,
  });
  const projects = (await readProjectsRegistry({ registryPath })).projects;
  expect(projects).toHaveLength(2);
  expect(projects.find((project) => project.name === "secondary")).toEqual(
    registered
  );
  expect(
    projects.find((project) => project.id === "retained-fixture-id")?.lastSeenAt
  ).toBe("2026-01-01T00:02:00Z");
  expect(await readdir(registryDir)).toEqual(["projects.json"]);
});

test("uncontended linked-worktree touch preserves identity and records an actual branch change", async () => {
  const linked = join(fixture, "linked");
  await git(primary, ["worktree", "add", "-b", "feature/first", linked]);
  expect(await report(child("touch", linked))).toMatchObject({
    result: { status: "noop" },
    error: null,
    registryWrites: 1,
  });
  await git(linked, ["switch", "-c", "feature/changed"]);
  const changed = await report(child("touch", linked, "2026-01-01T00:02:01Z"));
  expect(changed).toMatchObject({
    result: { status: "noop" },
    error: null,
    registryWrites: 1,
  });
  expect(changed.gitLaunches).toBeGreaterThan(0);
  expect((await readProjectsRegistry({ registryPath })).projects).toEqual([
    expect.objectContaining({
      id: "retained-fixture-id",
      repoRoot: primary,
      worktrees: [
        {
          path: linked,
          branch: "feature/changed",
          lastSeenAt: "2026-01-01T00:02:01Z",
        },
      ],
    }),
  ]);
  expect(await readdir(registryDir)).toEqual(["projects.json"]);
});

for (const observation of ["early", "late"] as const) {
  test(`a writer arriving after the ${observation} absent observation is preserved`, async () => {
    const touch = child(`pause-${observation}`);
    await boundary(touch, "observed-absent");
    const owner = child("hold");
    await boundary(owner, "held");
    const receipt = await readFile(lockPath, "utf8");
    const bytes = await readFile(registryPath, "utf8");
    touch.stdin.end();
    const result = await report(touch);
    expect(result).toMatchObject({
      result: null,
      error: null,
      registryWrites: 0,
      ownerOpens: observation === "early" ? 0 : 1,
      publications: observation === "early" ? 0 : 1,
    });
    expect(result.gitLaunches).toBe(0);
    expect(await readFile(lockPath, "utf8")).toBe(receipt);
    expect(await readFile(registryPath, "utf8")).toBe(bytes);
    expect((await readdir(registryDir)).sort()).toEqual([
      "projects.json",
      "projects.json.lock",
    ]);
    owner.stdin.end();
    expect(await finish(owner)).toBe("");
    expect(await readdir(registryDir)).toEqual(["projects.json"]);
  });
}

test("an owner releasing after early occupied observation still safely defers stale touch", async () => {
  const owner = child("hold");
  await boundary(owner, "held");
  const touch = child("pause-early");
  await boundary(touch, "observed-occupied");
  const bytes = await readFile(registryPath, "utf8");
  owner.stdin.end();
  expect(await finish(owner)).toBe("");
  touch.stdin.end();
  expect(await report(touch)).toMatchObject({
    ...untouched,
    result: null,
    error: null,
    observations: 1,
  });
  expect(await readFile(registryPath, "utf8")).toBe(bytes);
  expect(await readdir(registryDir)).toEqual(["projects.json"]);
});

async function primaryEntry() {
  const entry = (await readProjectsRegistry({ registryPath })).projects[0];
  if (!entry) {
    throw new Error("Missing fixture primary registration");
  }
  return entry;
}

for (const change of [
  "removed",
  "retargeted",
  "renamed",
  "ambiguous-name",
  "ambiguous-directory",
  "root",
  "host",
  "directory-name",
  "invalid-time",
  "future-time",
] as const) {
  test(`locked primary proof rejects a ${change} registration and falls back outside the lock`, async () => {
    const entry = await primaryEntry();
    const otherRoot = join(fixture, "other");
    await mkdir(join(otherRoot, ".hack"), { recursive: true });
    await git(otherRoot, ["init", "-b", "other"]);
    const other = {
      ...entry,
      id: "other-id",
      name: "other",
      repoRoot: otherRoot,
      projectDir: join(otherRoot, ".hack"),
    };
    const changed = (() => {
      switch (change) {
        case "removed":
          return [];
        case "retargeted":
          return [{ ...other, name: entry.name }];
        case "renamed":
          return [{ ...entry, name: "intervening-name" }];
        case "ambiguous-name":
          return [entry, { ...other, name: entry.name }];
        case "ambiguous-directory":
          return [entry, { ...other, projectDir: entry.projectDir }];
        case "root":
          return [{ ...entry, repoRoot: otherRoot }];
        case "host":
          return [{ ...entry, devHost: "intervening.hack.local" }];
        case "directory-name":
          return [{ ...entry, projectDirName: ".dev" }];
        case "invalid-time":
          return [{ ...entry, lastSeenAt: "invalid" }];
        case "future-time":
          return [{ ...entry, lastSeenAt: "2026-01-01T00:03:00Z" }];
        default:
          throw new Error("Unknown primary proof control");
      }
    })();
    const touch = child("pause-early");
    await boundary(touch, "observed-absent");
    const changedBytes = JSON.stringify({ version: 1, projects: changed });
    await writeFile(registryPath, changedBytes);
    touch.stdin.end();
    const result = await report(touch);
    expect(result).toMatchObject({
      error: null,
      ownerOpens: 2,
      publications: 2,
      registryReads: 3,
      configReads: 1,
      projectRootResolutions: 1,
      projectDirResolutions: 1,
    });
    expect(result.gitStates).toEqual([
      {
        ownsLock: false,
        lockPresent: false,
        ownerFiles: 0,
        registryWrites: 0,
        publications: 1,
      },
      ...(change === "retargeted"
        ? [
            {
              ownsLock: true,
              lockPresent: true,
              ownerFiles: 0,
              registryWrites: 0,
              publications: 2,
            },
          ]
        : []),
    ]);
    if (
      ["retargeted", "ambiguous-name", "ambiguous-directory"].includes(change)
    ) {
      expect(result).toMatchObject({
        result: { status: "conflict" },
        registryWrites: 0,
      });
      expect(await readFile(registryPath, "utf8")).toBe(changedBytes);
    } else {
      expect(result).toMatchObject({
        result: { status: change === "removed" ? "created" : "updated" },
        registryWrites: 1,
      });
      const refreshed = await primaryEntry();
      expect(refreshed).toMatchObject({
        name: "admission",
        repoRoot: primary,
        projectDir: join(primary, ".hack"),
        projectDirName: ".hack",
        devHost: "admission.hack.local",
        lastSeenAt: "2026-01-01T00:02:00Z",
      });
      if (change !== "removed") {
        expect(refreshed.id).toBe(entry.id);
        expect(refreshed.createdAt).toBe(entry.createdAt);
      }
    }
    expect(await readdir(registryDir)).toEqual(["projects.json"]);
  });
}

test("a duplicate ID introduced after the hint cannot authorize a primary refresh", async () => {
  const entry = await primaryEntry();
  const touch = child("pause-fallback");
  await boundary(touch, "observed-absent");
  const bytes = JSON.stringify({
    version: 1,
    projects: [
      entry,
      {
        ...entry,
        name: "other",
        projectDir: join(fixture, "other", ".hack"),
        repoRoot: join(fixture, "other"),
      },
    ],
  });
  await writeFile(registryPath, bytes);
  touch.stdin.end();
  await boundary(touch, "before-fallback-git");
  expect(await readFile(registryPath, "utf8")).toBe(bytes);
  expect(await readdir(registryDir)).toEqual(["projects.json"]);
  // The existing full upsert does not validate duplicate IDs. Stop at its late
  // admission boundary, after proving that the new primary path refused to write.
  const owner = child("hold");
  await boundary(owner, "held");
  const receipt = await readFile(lockPath, "utf8");
  await writeFile(join(fixture, "state", "continue-git"), "continue");
  expect(await report(touch)).toMatchObject({
    result: null,
    error: null,
    gitLaunches: 1,
    ownerOpens: 1,
    publications: 1,
    registryWrites: 0,
    gitStates: [
      {
        ownsLock: false,
        lockPresent: false,
        ownerFiles: 0,
        registryWrites: 0,
        publications: 1,
      },
    ],
  });
  expect(await readFile(registryPath, "utf8")).toBe(bytes);
  expect(await readFile(lockPath, "utf8")).toBe(receipt);
  owner.stdin.end();
  expect(await finish(owner)).toBe("");
  expect(await readdir(registryDir)).toEqual(["projects.json"]);
});

test("fallback rereads the registry after an intervening real writer", async () => {
  const entry = await primaryEntry();
  const secondary = join(fixture, "secondary");
  await mkdir(join(secondary, ".hack"), { recursive: true });
  await writeFile(
    join(secondary, ".hack", "hack.config.json"),
    JSON.stringify({ name: "secondary" })
  );
  await git(secondary, ["init", "-b", "main"]);
  const touch = child("pause-fallback");
  await boundary(touch, "observed-absent");
  await writeFile(
    registryPath,
    JSON.stringify({
      version: 1,
      projects: [{ ...entry, name: "changed-between-reads" }],
    })
  );
  touch.stdin.end();
  await boundary(touch, "before-fallback-git");
  expect(await report(child("optional", secondary))).toMatchObject({
    result: { status: "created" },
    error: null,
  });
  const registered = (
    await readProjectsRegistry({ registryPath })
  ).projects.find((project) => project.name === "secondary");
  expect(registered).toBeDefined();
  await writeFile(join(fixture, "state", "continue-git"), "continue");
  expect(await report(touch)).toMatchObject({
    result: { status: "updated" },
    error: null,
    gitLaunches: 1,
    ownerOpens: 2,
    publications: 2,
    registryWrites: 1,
    registryReads: 3,
    gitStates: [
      {
        ownsLock: false,
        lockPresent: false,
        ownerFiles: 0,
        registryWrites: 0,
        publications: 1,
      },
    ],
  });
  const current = (await readProjectsRegistry({ registryPath })).projects;
  expect(current).toHaveLength(2);
  expect(current.find((project) => project.name === "secondary")).toEqual(
    registered
  );
  expect(current.find((project) => project.id === entry.id)).toMatchObject({
    name: "admission",
    lastSeenAt: "2026-01-01T00:02:00Z",
  });
  expect(await readdir(registryDir)).toEqual(["projects.json"]);
});

test("a concurrent fresh primary update coalesces without Git or another write", async () => {
  const touch = child("pause-early");
  await boundary(touch, "observed-absent");
  expect(
    await report(child("optional", primary, "2026-01-01T00:01:59Z"))
  ).toMatchObject({ result: { status: "updated" } });
  const bytes = await readFile(registryPath, "utf8");
  touch.stdin.end();
  expect(await report(touch)).toMatchObject({
    result: { status: "noop", project: { lastSeenAt: "2026-01-01T00:01:59Z" } },
    error: null,
    gitLaunches: 0,
    ownerOpens: 1,
    publications: 1,
    registryReads: 2,
    registryWrites: 0,
  });
  expect(await readFile(registryPath, "utf8")).toBe(bytes);
  expect(await readdir(registryDir)).toEqual(["projects.json"]);
});

test("primary refresh preserves live sibling metadata and removes missing sibling records without Git", async () => {
  const entry = await primaryEntry();
  const live = join(fixture, "live");
  await git(primary, ["worktree", "add", "-b", "feature/live", live]);
  const sibling = {
    path: live,
    branch: "feature/live",
    lastSeenAt: "2026-01-01T00:00:30Z",
  };
  await writeFile(
    registryPath,
    JSON.stringify({
      version: 1,
      projects: [
        {
          ...entry,
          worktrees: [
            sibling,
            {
              ...sibling,
              path: join(fixture, "missing"),
              branch: "feature/missing",
            },
          ],
        },
      ],
    })
  );
  expect(await report(child("touch"))).toMatchObject({
    result: { status: "updated" },
    error: null,
    gitLaunches: 0,
    ownerOpens: 1,
    publications: 1,
    registryWrites: 1,
  });
  expect(await primaryEntry()).toEqual({
    ...entry,
    lastSeenAt: "2026-01-01T00:02:00Z",
    worktrees: [sibling],
  });
  expect(await readdir(registryDir)).toEqual(["projects.json"]);
});

for (const operation of ["optional", "required"] as const) {
  test(`public ${operation} upsert retains metadata discovery for an unchanged primary`, async () => {
    expect(await report(child(operation))).toMatchObject({
      result: { status: "updated" },
      error: null,
      gitLaunches: 1,
      ownerOpens: 1,
      publications: 1,
      registryWrites: 1,
      registryReads: 1,
    });
    expect(await readdir(registryDir)).toEqual(["projects.json"]);
  });
}

for (const lastSeenAt of ["invalid", "2026-01-01T00:03:00Z", undefined]) {
  test(`primary refresh falls back for timestamp ${String(lastSeenAt)} before lock admission`, async () => {
    const entry = await primaryEntry();
    await writeFile(
      registryPath,
      JSON.stringify({ version: 1, projects: [{ ...entry, lastSeenAt }] })
    );
    expect(await report(child("touch"))).toMatchObject({
      result: { status: "updated" },
      error: null,
      gitLaunches: 1,
      ownerOpens: 1,
      publications: 1,
      registryWrites: 1,
      registryReads: 2,
    });
    expect((await primaryEntry()).lastSeenAt).toBe("2026-01-01T00:02:00Z");
    expect(await readdir(registryDir)).toEqual(["projects.json"]);
  });
}

test("legacy alias migration uses full upsert and preserves its identity", async () => {
  const entry = await primaryEntry();
  await writeFile(
    join(primary, ".hack", "hack.config.json"),
    JSON.stringify({ name: "legacy_project", dev_host: "admission.hack.local" })
  );
  await writeFile(
    registryPath,
    JSON.stringify({
      version: 1,
      projects: [{ ...entry, name: "legacy_project" }],
    })
  );
  expect(await report(child("touch"))).toMatchObject({
    result: { status: "updated" },
    error: null,
    gitLaunches: 1,
    ownerOpens: 1,
    publications: 1,
    registryWrites: 1,
    registryReads: 2,
  });
  expect(await primaryEntry()).toEqual({
    ...entry,
    name: "legacy-project",
    lastSeenAt: "2026-01-01T00:02:00Z",
  });
});
