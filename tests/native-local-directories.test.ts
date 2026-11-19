import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyLocalDirectoriesPlan,
  applyNativeLocalDirectories,
} from "../src/backends/native-local-directories.ts";
import { prepareNativeProjectAdaptation } from "../src/backends/native-project-adaptation.ts";
import {
  type NativeProjectInput,
  prepareNativeProjectInput,
} from "../src/backends/native-project-input.ts";
import {
  localDirectoryVolumeName,
  planLocalDirectories,
} from "../src/lib/local-directories.ts";
import {
  NATIVE_LOCAL_DIRECTORIES_APPLIED_NOTICE,
  NATIVE_LOCAL_DIRECTORIES_CHANGED_NOTICE,
  reportNativeLocalDirectories,
  trackNativeLocalDirectories,
  warnLocalDirectoriesNotApplied,
} from "../src/lib/local-directories-project.ts";
import { findProjectContextAtRoot } from "../src/lib/project.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

const NODE_MODULES = localDirectoryVolumeName("node_modules");
const NEXT = localDirectoryVolumeName("apps/web/.next");

function compose(): Record<string, unknown> {
  return {
    services: {
      deps: { image: "oven/bun:1", volumes: ["..:/app"] },
      web: {
        image: "node:22",
        volumes: ["..:/app:ro", "../node_modules:/app/node_modules"],
      },
      db: { image: "postgres:17", volumes: ["data:/var/lib/postgresql/data"] },
    },
    volumes: { data: {} },
  };
}

test("the native model gets one declared volume per entry, mounted at each planned path", () => {
  const model = compose();
  applyLocalDirectoriesPlan({
    compose: model,
    plan: planLocalDirectories({
      compose: model,
      composeDir: "/work/app/.hack",
      projectRoot: "/work/app",
      entries: ["node_modules", "apps/web/.next"],
    }),
  });
  const services = model.services as Record<string, { volumes: unknown[] }>;
  expect(services.deps?.volumes).toEqual([
    "..:/app",
    { type: "volume", source: NODE_MODULES, target: "/app/node_modules" },
    { type: "volume", source: NEXT, target: "/app/apps/web/.next" },
  ]);
  // web's bind of node_modules itself is replaced (one mount per target),
  // keeping that bind's writable mode; .next inherits the read-only source.
  expect(services.web?.volumes).toEqual([
    "..:/app:ro",
    { type: "volume", source: NODE_MODULES, target: "/app/node_modules" },
    {
      type: "volume",
      source: NEXT,
      target: "/app/apps/web/.next",
      read_only: true,
    },
  ]);
  expect(services.db?.volumes).toEqual(["data:/var/lib/postgresql/data"]);
  // Plain declarations, no labels (native never applies volume labels).
  expect(model.volumes).toEqual({ data: {}, [NODE_MODULES]: {}, [NEXT]: {} });
});

test("an invalid setting refuses on native too", async () => {
  await expect(
    applyNativeLocalDirectories({
      compose: compose(),
      selection: {
        projectRoot: "/work/app",
        composeFile: "/work/app/.hack/docker-compose.yml",
        entries: [],
        error: "Project localDirectories must be a list.",
      },
    })
  ).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
});

async function project(config: unknown): Promise<{
  root: string;
  projectDir: string;
  composeFile: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "hack-native-local-dirs-"));
  roots.push(root);
  const projectDir = join(root, ".hack");
  await mkdir(projectDir, { recursive: true });
  const composeFile = join(projectDir, "docker-compose.yml");
  await writeFile(
    composeFile,
    "services:\n  web:\n    image: node:22\n    volumes:\n      - ..:/app\n"
  );
  await writeFile(
    join(projectDir, "hack.config.json"),
    `${JSON.stringify({ name: "native-local-dirs", dev_host: "native-local-dirs.hack", ...(config as object) })}\n`
  );
  return { root, projectDir, composeFile };
}

test("prepared native input records the setting and adaptation applies it with or without an adaptation file", async () => {
  const fixture = await project({ localDirectories: ["node_modules"] });
  const input = await prepareNativeProjectInput({
    projectRoot: fixture.root,
    projectDir: fixture.projectDir,
    composeFile: fixture.composeFile,
  });
  expect(input.localDirectories).toEqual({
    projectRoot: fixture.root,
    composeFile: fixture.composeFile,
    entries: ["node_modules"],
  });
  const adapted = await prepareNativeProjectAdaptation({ input });
  const model = JSON.parse(adapted.normalizedComposeJson) as {
    services: { web: { volumes: unknown[] } };
    volumes: Record<string, unknown>;
  };
  expect(model.services.web.volumes).toEqual([
    "..:/app",
    { type: "volume", source: NODE_MODULES, target: "/app/node_modules" },
  ]);
  expect(model.volumes).toEqual({ [NODE_MODULES]: {} });

  const adaptationFile = join(fixture.projectDir, "native-adaptation.json");
  await writeFile(adaptationFile, JSON.stringify({ version: 1 }));
  const withFile = await prepareNativeProjectAdaptation({
    input,
    path: adaptationFile,
  });
  expect(withFile.normalizedComposeJson).toBe(adapted.normalizedComposeJson);
});

test("a project without the setting is left exactly as it was", async () => {
  const fixture = await project({});
  const input: NativeProjectInput = await prepareNativeProjectInput({
    projectRoot: fixture.root,
    projectDir: fixture.projectDir,
    composeFile: fixture.composeFile,
  });
  expect(input.localDirectories).toBeUndefined();
  expect(await prepareNativeProjectAdaptation({ input })).toBe(input);
});

test("adopted, authored and imported projects say the setting is not applied", async () => {
  const declared = await project({ localDirectories: ["node_modules"] });
  const lines: string[] = [];
  await warnLocalDirectoriesNotApplied({
    projectRoot: declared.root,
    kind: "authored or imported",
    warn: (line) => lines.push(line),
  });
  expect(lines).toEqual([
    "localDirectories is not applied to authored or imported projects on the native backend; services keep those directories on the shared source.",
  ]);
  const none = await project({});
  await warnLocalDirectoriesNotApplied({
    projectRoot: none.root,
    kind: "adopted",
    warn: (line) => lines.push(line),
  });
  expect(lines).toHaveLength(1);
});

test("native up refuses an invalid setting and prints the plan's notices in the foreground", async () => {
  const invalid = await project({ localDirectories: ["../outside"] });
  const invalidContext = await findProjectContextAtRoot({
    projectRoot: invalid.root,
  });
  await expect(
    reportNativeLocalDirectories({ project: invalidContext!, warn: () => {} })
  ).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });

  const fixture = await project({ localDirectories: ["node_modules"] });
  await writeFile(
    fixture.composeFile,
    "services:\n  web:\n    image: node:22\n    volumes:\n      - ..:/app\n      - deps:/app/node_modules\nvolumes:\n  deps: {}\n"
  );
  const context = await findProjectContextAtRoot({ projectRoot: fixture.root });
  const lines: string[] = [];
  await reportNativeLocalDirectories({
    project: context!,
    warn: (line) => lines.push(line),
  });
  expect(lines).toEqual([
    "localDirectories: service web already mounts /app/node_modules; that mount is kept for node_modules.",
  ]);
});

test("a workspace cache in the adaptation keeps its workspace paths, and native up does not refuse", async () => {
  const fixture = await project({
    localDirectories: ["node_modules", "apps/web/node_modules"],
  });
  await writeFile(
    fixture.composeFile,
    "services:\n  web:\n    image: node:22\n    volumes:\n      - ..:/app\n      - deps:/app/node_modules\n  worker:\n    image: node:22\n    volumes:\n      - ..:/app\nvolumes:\n  deps: {}\n"
  );
  const adaptationFile = join(fixture.projectDir, "native-adaptation.json");
  await writeFile(
    adaptationFile,
    JSON.stringify({
      version: 1,
      workspaceCache: {
        volume: "deps",
        root: "/app",
        workspaces: ["apps/web"],
      },
    })
  );
  const input = await prepareNativeProjectInput({
    projectRoot: fixture.root,
    projectDir: fixture.projectDir,
    composeFile: fixture.composeFile,
  });
  const adapted = await prepareNativeProjectAdaptation({
    input,
    path: adaptationFile,
  });
  const model = JSON.parse(adapted.normalizedComposeJson) as {
    services: { web: { volumes: unknown[] }; worker: { volumes: unknown[] } };
    volumes: Record<string, unknown>;
  };
  // worker does not use the cache, so both its paths get local volumes.
  const workspace = localDirectoryVolumeName("apps/web/node_modules");
  expect(model.services.worker.volumes).toEqual([
    "..:/app",
    { type: "volume", source: NODE_MODULES, target: "/app/node_modules" },
    { type: "volume", source: workspace, target: "/app/apps/web/node_modules" },
  ]);
  // deps is kept at the root, the workspace path belongs to the cache, and
  // localDirectories adds nothing of its own here.
  expect(model.services.web.volumes).toEqual([
    "..:/app",
    "deps:/app/node_modules",
    {
      type: "volume",
      source: "deps",
      target: "/app/apps/web/node_modules",
      read_only: false,
      volume: { subpath: ".hack-workspace-node-modules/apps/web" },
    },
  ]);
  expect(model.volumes).toEqual({
    deps: {},
    [NODE_MODULES]: {},
    [workspace]: {},
  });
});

test("under --json, native localDirectories notices go to stderr, never stdout", async () => {
  const { nativeLocalDirectoriesWarn } = await import(
    "../src/commands/project.ts"
  );
  const out: string[] = [];
  const err: string[] = [];
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string) => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => {
    err.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    nativeLocalDirectoriesWarn(true)("localDirectories: a notice");
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
  expect(out).toEqual([]);
  expect(err).toEqual(["localDirectories: a notice\n"]);
});

test("a project configured in hack.toml gets its local directories on native too", async () => {
  const root = await mkdtemp(join(tmpdir(), "hack-native-local-dirs-toml-"));
  roots.push(root);
  const projectDir = join(root, ".hack");
  await mkdir(projectDir, { recursive: true });
  const composeFile = join(projectDir, "docker-compose.yml");
  await writeFile(
    composeFile,
    "services:\n  web:\n    image: node:22\n    volumes:\n      - ..:/app\n"
  );
  await writeFile(
    join(projectDir, "hack.toml"),
    'name = "toml-local-dirs"\ndev_host = "toml-local-dirs.hack"\nlocalDirectories = ["node_modules"]\n'
  );
  const input = await prepareNativeProjectInput({
    projectRoot: root,
    projectDir,
    composeFile,
  });
  expect(input.localDirectories?.entries).toEqual(["node_modules"]);
});

test("the pre-launch report leaves an authored project to its own dispatcher", async () => {
  const { reportNativeLocalDirectoriesBeforeLaunch } = await import(
    "../src/commands/project.ts"
  );
  const root = await mkdtemp(
    join(tmpdir(), "hack-native-local-dirs-authored-")
  );
  roots.push(root);
  await mkdir(join(root, ".hack"), { recursive: true });
  await writeFile(join(root, ".hack", "hack.project.json"), "{}\n");
  await expect(
    reportNativeLocalDirectoriesBeforeLaunch({
      ctx: { cwd: root } as never,
      path: root,
      project: undefined,
      json: true,
    })
  ).resolves.toBeUndefined();
});

test("an authored project with localDirectories only in hack.toml still gets the not-applied line", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "hack-native-local-dirs-authored-toml-")
  );
  roots.push(root);
  await mkdir(join(root, ".hack"), { recursive: true });
  await writeFile(join(root, ".hack", "hack.project.json"), "{}\n");
  await writeFile(
    join(root, ".hack", "hack.toml"),
    'name = "authored"\nlocalDirectories = ["node_modules"]\n'
  );
  const lines: string[] = [];
  await warnLocalDirectoriesNotApplied({
    projectRoot: root,
    kind: "authored or imported",
    warn: (line) => lines.push(line),
  });
  expect(lines).toHaveLength(1);
});

test("a run started with the setting is recorded, and a change says to restart until restart applies it", async () => {
  const fixture = await project({ localDirectories: ["node_modules"] });
  const context = (await findProjectContextAtRoot({
    projectRoot: fixture.root,
  }))!;
  const lines: string[] = [];
  const warn = (line: string) => lines.push(line);
  const record = join(
    fixture.projectDir,
    ".internal",
    "native-local-directories.json"
  );

  await trackNativeLocalDirectories({
    project: context,
    branch: null,
    mode: "start",
    warn,
  });
  expect(JSON.parse(await Bun.file(record).text())).toEqual({
    version: 1,
    instances: { "": [`web /app/node_modules ${NODE_MODULES}`] },
  });
  // Unchanged: up on the running project says nothing.
  await trackNativeLocalDirectories({
    project: context,
    branch: null,
    mode: "running",
    warn,
  });
  expect(lines).toEqual([]);

  // Add a directory while it runs.
  await writeFile(
    join(fixture.projectDir, "hack.config.json"),
    `${JSON.stringify({ name: "native-local-dirs", dev_host: "native-local-dirs.hack", localDirectories: ["node_modules", "dist"] })}\n`
  );
  await trackNativeLocalDirectories({
    project: context,
    branch: null,
    mode: "running",
    warn,
  });
  expect(lines).toEqual([NATIVE_LOCAL_DIRECTORIES_CHANGED_NOTICE]);
  // up on a running project records nothing, so restart still sees the change.
  await trackNativeLocalDirectories({
    project: context,
    branch: null,
    mode: "restart",
    warn,
  });
  expect(lines).toEqual([
    NATIVE_LOCAL_DIRECTORIES_CHANGED_NOTICE,
    NATIVE_LOCAL_DIRECTORIES_APPLIED_NOTICE,
  ]);
  // After the restart the record matches: quiet again. Another instance
  // started with the same plan has its own record and is quiet too.
  await trackNativeLocalDirectories({
    project: context,
    branch: null,
    mode: "running",
    warn,
  });
  await trackNativeLocalDirectories({
    project: context,
    branch: "feature",
    mode: "start",
    warn,
  });
  await trackNativeLocalDirectories({
    project: context,
    branch: "feature",
    mode: "running",
    warn,
  });
  expect(lines).toHaveLength(2);
});

test("a project that never used the setting writes no record", async () => {
  const fixture = await project({});
  const context = (await findProjectContextAtRoot({
    projectRoot: fixture.root,
  }))!;
  await trackNativeLocalDirectories({
    project: context,
    branch: null,
    mode: "start",
    warn: () => {},
  });
  expect(
    await Bun.file(
      join(fixture.projectDir, ".internal", "native-local-directories.json")
    ).exists()
  ).toBe(false);
});

test("a branch named like an Object property is an ordinary instance key", async () => {
  const fixture = await project({ localDirectories: ["node_modules"] });
  const context = (await findProjectContextAtRoot({
    projectRoot: fixture.root,
  }))!;
  const lines: string[] = [];
  for (const branch of ["constructor", "toString", "__proto__"]) {
    await trackNativeLocalDirectories({
      project: context,
      branch,
      mode: "start",
      warn: (line) => lines.push(line),
    });
    await trackNativeLocalDirectories({
      project: context,
      branch,
      mode: "running",
      warn: (line) => lines.push(line),
    });
  }
  expect(lines).toEqual([]);
  const record = JSON.parse(
    await Bun.file(
      join(fixture.projectDir, ".internal", "native-local-directories.json")
    ).text()
  ) as { instances: Record<string, unknown> };
  expect(Object.keys(record.instances).sort()).toEqual([
    "__proto__",
    "constructor",
    "toString",
  ]);
});

test("a damaged tracking record is ignored, not a reason to refuse", async () => {
  const fixture = await project({ localDirectories: ["node_modules"] });
  const context = (await findProjectContextAtRoot({
    projectRoot: fixture.root,
  }))!;
  const internal = join(fixture.projectDir, ".internal");
  await mkdir(internal, { recursive: true });
  for (const text of [
    '{"version":1,"instances":null}',
    '{"version":1,"instances":[]}',
    "not json",
  ]) {
    await writeFile(join(internal, "native-local-directories.json"), text);
    await expect(
      trackNativeLocalDirectories({
        project: context,
        branch: null,
        mode: "running",
        warn: () => {},
      })
    ).resolves.toBeUndefined();
  }
});

test("declaring the first directory while the project runs says to restart, and restart applies it", async () => {
  const fixture = await project({});
  const context = (await findProjectContextAtRoot({
    projectRoot: fixture.root,
  }))!;
  const lines: string[] = [];
  const warn = (line: string) => lines.push(line);
  // Started without the setting: no record.
  await trackNativeLocalDirectories({
    project: context,
    branch: null,
    mode: "start",
    warn,
  });
  await writeFile(
    join(fixture.projectDir, "hack.config.json"),
    `${JSON.stringify({ name: "native-local-dirs", dev_host: "native-local-dirs.hack", localDirectories: ["node_modules"] })}\n`
  );
  await trackNativeLocalDirectories({
    project: context,
    branch: null,
    mode: "running",
    warn,
  });
  await trackNativeLocalDirectories({
    project: context,
    branch: null,
    mode: "restart",
    warn,
  });
  await trackNativeLocalDirectories({
    project: context,
    branch: null,
    mode: "running",
    warn,
  });
  expect(lines).toEqual([
    NATIVE_LOCAL_DIRECTORIES_CHANGED_NOTICE,
    NATIVE_LOCAL_DIRECTORIES_APPLIED_NOTICE,
  ]);
});
